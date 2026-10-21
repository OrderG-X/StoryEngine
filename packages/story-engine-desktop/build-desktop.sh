#!/usr/bin/env bash
# 桌面包一键构建（任务③ + 预置/捆绑增强）。用法：
#   ./build-desktop.sh                                  # mac dmg（默认，干净版）
#   ./build-desktop.sh --win                            # Windows NSIS exe（自动捆绑 MinGit）
#   ./build-desktop.sh --mac --with-model-preset        # 内测预置版：把本机模型配置（含 key！）打进包
#   STAGING=/tmp/xx ./build-desktop.sh ...              # 自定义 staging 目录（须过安全校验，见下）
#
# 流程：UI build:desktop（vite build + esbuild 打 server）→ pnpm deploy 产扁平生产
# node_modules（--legacy --prod --config.node-linker=hoisted，裸 deploy 会产 .pnpm 软链、
# 打包必坏——研究实测）→ [--win 捆 MinGit] → [--with-model-preset 注入本机模型配置] →
# electron-builder 在 staging 上出包 → 产物拷到本包 dist-electron/ → EXIT 时删 staging。
# Electron/MinGit 均走 npmmirror（GitHub 直连国内常被掐）；MinGit 下载/缓存均按官方 SHA-256 校验。
#
# STAGING 安全（审计 #10）：默认 mktemp 私有目录；若用 env 覆盖，rm -rf 前拒绝 /、
# $HOME、仓库根及其祖先，且已存在的非空目录必须带本脚本哨兵文件才允许删。
# 产物目录：packages/story-engine-desktop/dist-electron/{clean,with-model-preset}/
# （进 .gitignore，不进仓库；两种安全级别永久分开）。
#
# ⚠️ --with-model-preset 安全须知：
#   - key 只在**构建这一刻**从 ~/.story-engine 拷进 staging，绝不进 git 仓库；
#   - staging 在成功/失败后都会清掉，避免明文 secrets 残留 /tmp；
#   - 装出来的包任何人都能提取 key——只发给信得过的内测者；
#   - 公开发布前必须：①不带此 flag 重新出包；②到服务商后台**作废这批 key**（老安装包里的
#     key 永远收不回来，换 key 才是真正的清除）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP_DIR="$ROOT/packages/story-engine-desktop"
OUT_ROOT="$DESKTOP_DIR/dist-electron"
OUT_DIR=""
STAGING_MARKER=".se-desktop-staging-marker"
MINGIT_VERSION="2.49.1"
# 官方 SHA-256（git-for-windows v2.49.1.windows.1 release 正文 + GitHub asset digest）：
# https://github.com/git-for-windows/git/releases/tag/v2.49.1.windows.1
MINGIT_SHA256="3934292e3467ef4402770a966190112950203b4f3be6d58c37e80bd85bce8ee9"
MINGIT_URL="https://registry.npmmirror.com/-/binary/git-for-windows/v${MINGIT_VERSION}.windows.1/MinGit-${MINGIT_VERSION}-64-bit.zip"
MINGIT_CACHE="/tmp/mingit-${MINGIT_VERSION}-64.zip"
# Mac 随包 git（P11）：没装苹果开发者工具的 Mac 上系统 git 只是个壳，一调就弹「安装命令行工具」，
# 存档 / 撤销整条链用不了。取 GitHub Desktop 用的 dugite-native（自包含、只依赖系统库），
# 进包时只留 git 本体 + 模板（git 内建命令就够快照用，约 7MB；凭据管理器、git-lfs 等 140MB 不要）。
# 官方 SHA-256 来自同一 release 的 .sha256 文件；npmmirror 没有这个镜像，国内拉不动可设 SE_MACGIT_URL。
MACGIT_TAG="v2.53.0-4"
MACGIT_ASSET="dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz"
MACGIT_SHA256="f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe"
MACGIT_URL="${SE_MACGIT_URL:-https://github.com/desktop/dugite-native/releases/download/${MACGIT_TAG}/${MACGIT_ASSET}}"
MACGIT_CACHE="/tmp/${MACGIT_ASSET}"
SECRET_BUNDLE_ACK="I_UNDERSTAND_KEYS_ARE_EXTRACTABLE"
CLEAN_SECRET_PROBE=""
BUILDER_CONFIG=""

TARGET="--mac"
WITH_PRESET=0
for arg in "$@"; do
  case "$arg" in
    --mac|--win) TARGET="$arg" ;;
    --with-model-preset) WITH_PRESET=1 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

# 必须用全局 pnpm 11+（--legacy 是 pnpm 10+ 的 deploy 选项）；corepack 钉的是 9.15，认不得该选项。
PNPM="pnpm"

# ---------- T1：STAGING 路径解析与误删防护 ----------

# 把路径收成绝对、规范化形式。目标尚不存在时用父目录 pwd -P + basename；再不行用 python。
resolve_abs_path() {
  local raw="$1"
  if [ -z "$raw" ]; then
    echo "STAGING 不能为空" >&2
    return 1
  fi
  # 拒绝相对路径（避免依赖 cwd 误伤）
  case "$raw" in
    /*) ;;
    *)
      echo "STAGING 必须是绝对路径，拒绝相对路径：$raw" >&2
      return 1
      ;;
  esac
  if [ -d "$raw" ]; then
    (cd "$raw" && pwd -P)
    return 0
  fi
  local parent base parent_resolved
  parent="$(dirname -- "$raw")"
  base="$(basename -- "$raw")"
  if [ -d "$parent" ]; then
    parent_resolved="$(cd "$parent" && pwd -P)"
    # 去掉尾部斜杠后拼接
    echo "${parent_resolved%/}/$base"
    return 0
  fi
  # 父目录也不存在：用 python 做 abspath+normpath（不要求路径已存在）
  python3 -c 'import os,sys; print(os.path.normpath(os.path.abspath(sys.argv[1])))' "$raw"
}

# candidate 是否等于 protected，或是 protected 的祖先（rm candidate 会把 protected 一起干掉）。
is_same_or_ancestor_of() {
  local candidate="$1"
  local protected="$2"
  candidate="${candidate%/}"
  protected="${protected%/}"
  [ -z "$candidate" ] && candidate="/"
  [ -z "$protected" ] && protected="/"
  if [ "$candidate" = "/" ]; then
    return 0
  fi
  if [ "$candidate" = "$protected" ]; then
    return 0
  fi
  case "$protected" in
    "$candidate"/*) return 0 ;;
  esac
  return 1
}

# 校验 STAGING 是否允许被本脚本 rm -rf。拒绝危险路径；已存在非空目录须带哨兵。
assert_staging_safe_to_rm() {
  local staging="$1"
  local home_abs root_abs

  if [ -z "$staging" ]; then
    echo "STAGING 校验失败：路径为空" >&2
    return 1
  fi
  case "$staging" in
    /*) ;;
    *)
      echo "STAGING 校验失败：必须是绝对路径（当前：${staging}）" >&2
      return 1
      ;;
  esac

  home_abs="$(resolve_abs_path "$HOME")" || return 1
  root_abs="$(resolve_abs_path "$ROOT")" || return 1
  staging="$(resolve_abs_path "$staging")" || return 1

  # 拒绝 /、$HOME、仓库根本身，以及会把它们一并删掉的祖先路径
  if [ "$staging" = "/" ] \
    || is_same_or_ancestor_of "$staging" "$home_abs" \
    || is_same_or_ancestor_of "$staging" "$root_abs"; then
    # ${} 必须带花括号：macOS bash 3.2 会把紧随的全角括号字节吞进变量名（set -u 下直接炸）。
    echo "STAGING 校验失败：拒绝危险路径「${staging}」（不可为 /、\$HOME、仓库根或其祖先）。" >&2
    return 1
  fi

  if [ -d "$staging" ]; then
    # 非空且无哨兵 → 拒绝（防止误删用户目录里的既有内容）
    if [ -n "$(ls -A "$staging" 2>/dev/null || true)" ]; then
      if [ ! -f "$staging/$STAGING_MARKER" ]; then
        echo "STAGING 校验失败：「${staging}」已存在且非空，但缺少哨兵文件 ${STAGING_MARKER}——拒绝删除以免误伤。" >&2
        return 1
      fi
    fi
  fi

  # 把规范化路径写回调用方（通过全局 STAGING）
  STAGING="$staging"
  return 0
}

prepare_staging() {
  if [ -n "${STAGING:-}" ]; then
    assert_staging_safe_to_rm "$STAGING" || exit 1
  else
    STAGING="$(mktemp -d /tmp/se-desktop-staging.XXXXXX)"
  fi
}

safe_rm_staging() {
  assert_staging_safe_to_rm "$STAGING" || exit 1
  rm -rf "$STAGING"
}

cleanup_staging_on_exit() {
  # 成功/失败都清 staging，避免 model-secrets 明文残留（审计 #12 加固）
  if [ -n "${STAGING:-}" ] && [ -d "$STAGING" ]; then
    if [ -f "$STAGING/$STAGING_MARKER" ]; then
      rm -rf "$STAGING"
      echo "已清理 staging：$STAGING"
    fi
  fi
}

# ---------- T3：MinGit SHA-256 ----------

file_sha256() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    echo "找不到 shasum 或 sha256sum，无法校验随包 git 的完整性" >&2
    exit 1
  fi
}

# 用法：verify_vendor_cache <缓存文件> <期望 SHA-256> <名字>。下载后与复用缓存前都验——镜像 / 缓存污染都不能进包。
verify_vendor_cache() {
  local cache="$1" expected="$2" label="$3" actual
  if [ ! -s "$cache" ]; then
    echo "${label} 缓存不存在或为空：$cache" >&2
    exit 1
  fi
  actual="$(file_sha256 "$cache")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$cache"
    echo "${label} 哈希不匹配（期望 ${expected}，实际 ${actual}）。缓存可能被污染，已删除，请重跑构建重新下载。" >&2
    exit 1
  fi
}

# ---------- T4：密钥预置与干净包发布门 ----------

validate_preset_bundle_request() {
  local src="$1"
  local file missing
  if [ "$WITH_PRESET" != "1" ]; then
    return 0
  fi
  if [ "${SE_ALLOW_SECRET_BUNDLE:-}" != "$SECRET_BUNDLE_ACK" ]; then
    echo "拒绝预置密钥包：必须显式设置 SE_ALLOW_SECRET_BUNDLE=${SECRET_BUNDLE_ACK}。密钥可从安装包中提取。" >&2
    return 1
  fi
  missing=""
  for file in model-settings.json model-secrets.json task-assignments.json; do
    if [ ! -f "$src/$file" ]; then
      missing="$file"
    fi
  done
  if [ -n "$missing" ]; then
    echo "拒绝预置密钥包：缺少必需文件 $src/$missing（三件必须齐全，不能静默打残包）。" >&2
    return 1
  fi
}

assert_clean_staging_has_no_preset() {
  local staging="$1"
  if [ -e "$staging/preset-model-config" ]; then
    echo "干净包检查失败：staging 已含 preset-model-config，拒绝继续。" >&2
    return 1
  fi
}

prepare_builder_config() {
  BUILDER_CONFIG="$STAGING/electron-builder.yml"
  if [ "$WITH_PRESET" != "1" ]; then
    return 0
  fi

  BUILDER_CONFIG="$STAGING/electron-builder-with-model-preset.yml"
  awk '
    /^[[:space:]]*-[[:space:]]*"!preset-model-config\/\*\*"[[:space:]]*$/ { next }
    { print }
    /^productName:[[:space:]]*/ {
      print "artifactName: \"${productName}-${version}-${arch}-with-model-preset.${ext}\""
    }
  ' "$STAGING/electron-builder.yml" > "$BUILDER_CONFIG"
}

assert_artifact_name_for_mode() {
  local artifact="$1"
  local base
  base="$(basename -- "$artifact")"
  if [ "$WITH_PRESET" = "1" ]; then
    case "$base" in
      *-with-model-preset.dmg|*-with-model-preset.exe) return 0 ;;
      *) echo "预置包产物名缺少 -with-model-preset 后缀：$base" >&2; return 1 ;;
    esac
  fi
  case "$base" in
    *-with-model-preset.dmg|*-with-model-preset.exe)
      echo "干净包不得使用预置密钥包文件名：$base" >&2
      return 1
      ;;
  esac
}

prepare_mode_output_dir() {
  local mode
  if [ "$WITH_PRESET" = "1" ]; then
    mode="with-model-preset"
  else
    mode="clean"
  fi
  OUT_DIR="$OUT_ROOT/$mode"
  # OUT_DIR only ever resolves to one of the two fixed children above. Clear the
  # current mode so the final listing represents this run, while preserving the
  # other mode for deliberate internal distribution/history.
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"
}

list_current_mode_artifacts() {
  find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' \) -print
}

# 扫描 electron-builder 最终生成的 unpacked app，而不是只看构建输入。
# clean probe 被故意放进配置排除目录；若 files 规则失效，它会出现在最终 app 中并让构建失败。
scan_clean_packaged_output() {
  local output_dir="$1"
  local probe="$2"
  local roots root status found
  if [ -z "$probe" ]; then
    echo "干净包扫描失败：安全探针为空，无法证明排除规则生效。" >&2
    return 1
  fi
  roots="$(find "$output_dir" -type d \( -name '*.app' -o -name '*-unpacked' \) -prune 2>/dev/null || true)"
  if [ -z "$roots" ]; then
    echo "干净包扫描失败：未找到 electron-builder 的 unpacked app，无法做最终内容核验。" >&2
    return 1
  fi
  found=0
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    found=1
    set +e
    grep -R -F -q -- "$probe" "$root" 2>/dev/null
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      echo "干净包扫描失败：最终 app 含密钥探针，preset-model-config 排除规则已失效。" >&2
      return 1
    fi
    if [ "$status" -ne 1 ]; then
      echo "干净包扫描失败：无法完整读取最终 app（$root）。" >&2
      return 1
    fi
  done <<EOF
$roots
EOF
  if [ "$found" -ne 1 ]; then
    echo "干净包扫描失败：没有可扫描的最终 app。" >&2
    return 1
  fi
}

# ---------- 主流程 ----------

PRESET_SRC="${SE_DATA_DIR:-$HOME/.story-engine}"
validate_preset_bundle_request "$PRESET_SRC"

prepare_staging

# 内部测试钩子：只验证 STAGING 规则后退出（不构建、不真删有哨兵的目录）
if [ "${SE_DESKTOP_VALIDATE_STAGING_ONLY:-}" = "1" ]; then
  echo "STAGING 校验通过：$STAGING"
  # 默认 mktemp 出的空目录顺手收掉，避免测一次留一个空壳
  if [ -d "$STAGING" ] && [ -z "$(ls -A "$STAGING" 2>/dev/null || true)" ]; then
    rmdir "$STAGING" 2>/dev/null || true
  fi
  exit 0
fi

trap cleanup_staging_on_exit EXIT

echo "① 构建 UI 前端 + 独立 server 产物…"
cd "$ROOT/packages/story-engine-ui"
"$PNPM" run build:desktop

echo "② pnpm deploy 产扁平生产依赖 → $STAGING"
cd "$ROOT"
safe_rm_staging
"$PNPM" --filter story-engine-desktop deploy --legacy --prod --config.node-linker=hoisted "$STAGING"
cp "$DESKTOP_DIR/electron-builder.yml" "$STAGING/"
# 哨兵：标记「这是本脚本的 staging」，下次/退出清理才允许 rm -rf
touch "$STAGING/$STAGING_MARKER"

if [ "$TARGET" = "--win" ]; then
  echo "③ 捆绑 MinGit ${MINGIT_VERSION}（Windows 快照/撤销免装 git；官方 SHA-256 校验）…"
  if [ ! -s "$MINGIT_CACHE" ]; then
    curl -fL --retry 3 -o "$MINGIT_CACHE" "$MINGIT_URL"
  fi
  verify_vendor_cache "$MINGIT_CACHE" "$MINGIT_SHA256" "MinGit"
  mkdir -p "$STAGING/vendor/mingit"
  unzip -qo "$MINGIT_CACHE" -d "$STAGING/vendor/mingit"
  test -f "$STAGING/vendor/mingit/cmd/git.exe" || { echo "MinGit 解包异常：缺 cmd/git.exe" >&2; exit 1; }
else
  echo "③ 捆绑精简 git ${MACGIT_TAG}（Mac 快照/撤销不靠系统 git；官方 SHA-256 校验）…"
  if [ ! -s "$MACGIT_CACHE" ]; then
    curl -fL --retry 3 -o "$MACGIT_CACHE" "$MACGIT_URL"
  fi
  verify_vendor_cache "$MACGIT_CACHE" "$MACGIT_SHA256" "dugite-native git"
  MACGIT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/se-macgit.XXXXXX")"
  tar -xzf "$MACGIT_CACHE" -C "$MACGIT_TMP"
  VENDOR_GIT="$STAGING/vendor/git"
  mkdir -p "$VENDOR_GIT/bin" "$VENDOR_GIT/libexec/git-core" "$VENDOR_GIT/share/git-core"
  cp "$MACGIT_TMP/bin/git" "$VENDOR_GIT/bin/git"
  # git 跑子命令（gc 等）时先找 GIT_EXEC_PATH 下的 git；缺了会顺 PATH 摸到系统那个壳，所以这里也放一份。
  cp "$MACGIT_TMP/bin/git" "$VENDOR_GIT/libexec/git-core/git"
  cp -R "$MACGIT_TMP/share/git-core/templates" "$VENDOR_GIT/share/git-core/"
  # git 是 GPLv2：原样随包、不改，附上源码去处。
  cat > "$VENDOR_GIT/NOTICE.txt" <<NOTICE
本目录是未经修改的 Git ${MACGIT_TAG}（dugite-native 构建，只取了 git 本体和模板），按 GNU GPL v2 授权。
StoryEngine 只把它当独立程序调用来做存档和撤销。
Git 源码：https://github.com/git/git
构建脚本与对应源码：https://github.com/desktop/dugite-native/releases/tag/${MACGIT_TAG}
GPL v2 全文：https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
NOTICE
  rm -rf "$MACGIT_TMP"
  "$VENDOR_GIT/bin/git" --version >/dev/null || { echo "精简 git 跑不起来：$VENDOR_GIT/bin/git" >&2; exit 1; }
fi

# 第三方许可清单（P11）：生产依赖 + 打进前端包的几个开发依赖；关于页和「帮助 → 第三方软件许可」打开它。
UI_MODULES="$ROOT/packages/story-engine-ui/node_modules"
node "$DESKTOP_DIR/gen-notices.mjs" "$STAGING/THIRD_PARTY_NOTICES.txt" "$STAGING/node_modules" \
  "$UI_MODULES/class-variance-authority" "$UI_MODULES/clsx" "$UI_MODULES/lucide-react" "$UI_MODULES/tailwind-merge" "$UI_MODULES/tailwindcss"

if [ "$WITH_PRESET" = "1" ]; then
  echo "⚠️  预置 key 将明文进包：请确认是专用低限额 key，内测结束后作废"
  echo "④ 注入内测预置模型配置（含 API key，只发信得过的人；公开前必须换 key 重打包）…"
  mkdir -p "$STAGING/preset-model-config"
  for f in model-settings.json model-secrets.json task-assignments.json; do
    cp "$PRESET_SRC/$f" "$STAGING/preset-model-config/"
    echo "   + $f"
  done
else
  assert_clean_staging_has_no_preset "$STAGING"
  CLEAN_SECRET_PROBE="SE_CLEAN_BUILD_SECRET_PROBE_$(date +%s)_$$"
  mkdir -p "$STAGING/preset-model-config"
  printf '{"apiKey":"%s"}\n' "$CLEAN_SECRET_PROBE" > "$STAGING/preset-model-config/model-secrets.json"
fi

prepare_builder_config

# ${} 必须带花括号：macOS bash 3.2 会把紧随的全角括号字节吞进变量名（set -u 下直接炸）。
echo "⑤ electron-builder 出包（${TARGET}）…"
cd "$STAGING"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
  "$ROOT/node_modules/.pnpm/node_modules/.bin/electron-builder" "$TARGET" --config "$BUILDER_CONFIG"

if [ "$WITH_PRESET" = "0" ]; then
  scan_clean_packaged_output "$STAGING/dist-electron" "$CLEAN_SECRET_PROBE"
fi

# Electron / Chromium 许可原文必须在 Mac 应用包里（afterExtract 钩子抄的），第三方许可清单里这么写着。
if [ "$TARGET" = "--mac" ]; then
  for lic in LICENSE.electron.txt LICENSES.chromium.html; do
    if [ -z "$(find "$STAGING/dist-electron" -path "*.app/Contents/Resources/$lic" -print -quit)" ]; then
      echo "构建产物断言失败：Mac 应用包里缺 $lic（afterExtract 钩子没生效）。" >&2
      exit 1
    fi
  done
  # 整个应用包得封好签名（ad-hoc 也行），否则下载后 macOS 报「已损坏」。
  MAC_APP="$(find "$STAGING/dist-electron" -maxdepth 2 -name '*.app' -print -quit)"
  if ! codesign --verify --deep --strict "$MAC_APP" 2>/dev/null; then
    echo "构建产物断言失败：Mac 应用包签名不完整（$MAC_APP）。" >&2
    codesign --verify --deep --strict "$MAC_APP" >&2 || true
    exit 1
  fi
fi

prepare_mode_output_dir
echo "⑥ 拷贝产物到当前模式输出目录 → $OUT_DIR"
# 只搬安装包，避免把 builder 中间文件长期留在仓库旁；逐个计数，
# 零匹配必须报错——否则「构建看似成功、产物是空的」会静默混进发包流程（评审发现）。
ARTIFACTS_COPIED=0
while IFS= read -r artifact; do
  assert_artifact_name_for_mode "$artifact"
  cp -f "$artifact" "$OUT_DIR/"
  ARTIFACTS_COPIED=$((ARTIFACTS_COPIED + 1))
done < <(find "$STAGING/dist-electron" -maxdepth 1 \( -name '*.dmg' -o -name '*.exe' \))
if [ "$ARTIFACTS_COPIED" -eq 0 ]; then
  echo "构建产物断言失败：$STAGING/dist-electron 里没有本次构建的 dmg/exe——electron-builder 可能没真正出包，请检查上方日志。" >&2
  exit 1
fi

echo "✅ 产物（本次拷贝 ${ARTIFACTS_COPIED} 个）：$OUT_DIR/"
list_current_mode_artifacts
