/**
 * StoryEngine 桌面壳（MVP·任务②）。
 *
 * 形态（研究拍板 + 阶段0 地基）：Electron 主进程**同进程** import 独立 server
 * （@actalk/story-engine-ui 的 dist-server/server.mjs：connect 全路由 + Mastra agent + sirv 静态前端），
 * 固定端口（userData/server-port.json）只听 127.0.0.1，窗口 loadURL 连它。无 preload/无 IPC——前端全走 localhost HTTP，
 * 和浏览器里跑一模一样（改动面最小）。
 *
 * why 固定端口：localStorage 按 origin（host:port）隔离，端口漂移=书架/主题等前端持久化全清零；
 * 固定端口换取跨重启的 origin 稳定。仍仅回环 + request-guard 把关，可发现性提升可接受。
 *
 * 路径约定（任务①）：不注入 SE_DATA_DIR/SE_BOOKS_DIR——沿用默认 ~/.story-engine 与 ~/StoryEngine-NG，
 * 开发机与桌面包读同一份数据、老用户零迁移。distDir 必须显式传（standalone-entry 的 import.meta.url
 * 默认推断在 asar 里会断——研究已标）。
 */
import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";

import { app, BrowserWindow, dialog, Menu, shell } from "electron";

import { readStoredPort, writeStoredPortAtomically } from "./server-port.mjs";

const require = createRequire(import.meta.url);

export { readStoredPort };

/**
 * 应用名（P11）：菜单、关于、日志目录都显示「StoryEngine」，不再露出包名 story-engine-desktop。
 * 改名会把默认的 userData 挪到 appData/StoryEngine——先记下原来的再钉回去，
 * 老用户的书架、主题（localStorage）和端口文件都在原处，一样不丢。--user-data-dir 显式给的照用。
 */
const USER_DATA_DIR = app.getPath("userData");
app.setName("StoryEngine");
app.setPath("userData", USER_DATA_DIR);
// 测试时用 --user-data-dir 隔开的那份，日志也跟着隔开，别写进真日志目录。
if (app.commandLine.hasSwitch("user-data-dir")) app.setAppLogsPath(join(USER_DATA_DIR, "logs"));
else app.setAppLogsPath();

/** 只开一个：再双击图标就把已开的窗叫到前面，别起第二个服务抢同一批书。 */
const GOT_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!GOT_SINGLE_INSTANCE_LOCK) app.quit();

/** 日志文件（P11）：主进程和同进程的服务端都往这写；超过 2MB 轮一次，只留上一份。 */
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

function setUpLogFile() {
  const dir = app.getPath("logs");
  const file = join(dir, "main.log");
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, join(dir, "main.old.log"));
  } catch {
    return;
  }
  const stream = createWriteStream(file, { flags: "a" });
  stream.on("error", () => {});
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      stream.write(`${new Date().toISOString()} [${level}] ${format(...args)}\n`);
    };
  }
  process.on("uncaughtException", (error) => console.error("[desktop] 未接住的异常：", error));
  process.on("unhandledRejection", (reason) => console.error("[desktop] 未接住的 Promise 拒绝：", reason));
  console.log(`[desktop] StoryEngine ${app.getVersion()} 启动（${process.platform}-${process.arch}，Electron ${process.versions.electron}）`);
}

if (GOT_SINGLE_INSTANCE_LOCK) setUpLogFile();

function serverPortPath() {
  return join(app.getPath("userData"), "server-port.json");
}

/** 从 userData 读上次实际绑定端口；文件缺失/损坏/非法 → null（调用方回退随机）。 */
async function loadStoredPort() {
  try {
    const raw = await readFile(serverPortPath(), "utf-8");
    return readStoredPort(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    console.warn(`[desktop] 读取 server-port.json 失败，回退随机端口：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 把实际绑定端口写回 userData，供下次启动复用同一 origin（localStorage 稳定）。
 * P2（2026-10-02）：改为 tmp + rename 原子写（见 server-port.mjs writeStoredPortAtomically）——直接 writeFile 写一半
 * 被杀/断电会留半截 JSON，下次启动解析失败 → 回退随机端口 → origin 漂移 → 书架/主题等 localStorage 整体清零。
 */
async function persistServerPort(port) {
  try {
    await mkdir(dirname(serverPortPath()), { recursive: true });
    await writeStoredPortAtomically(serverPortPath(), port);
  } catch (error) {
    console.warn(`[desktop] 写入 server-port.json 失败（不影响本次运行）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 定位 UI 包根目录（dist/ 与 dist-server/ 都在其下）；开发工作区与打包后的 node_modules 布局都适用。 */
function resolveUiPackageDir() {
  return dirname(require.resolve("@actalk/story-engine-ui/package.json"));
}

/** 全局数据目录（与 server 端 data-dirs.ts 同一约定：SE_DATA_DIR 覆盖，默认 ~/.story-engine）。 */
function resolveDataDir() {
  const env = process.env.SE_DATA_DIR?.trim();
  return env ? env : join(homedir(), ".story-engine");
}

/**
 * 随包 git：装了包就有快照/撤销，不要求作者自装 git。
 * Windows 用 MinGit；Mac（P11）用 dugite-native 的精简版——它自己推断不出安装位置，
 * 得显式给 GIT_EXEC_PATH / GIT_TEMPLATE_DIR，否则子命令会回落到系统那个只会弹「安装命令行工具」的壳。
 * 找到就设 SE_GIT_PATH（用户显式设过则不覆盖），server 的快照与健康探针据此解析。
 */
function wireBundledGit() {
  if (process.env.SE_GIT_PATH?.trim()) return;
  if (process.platform === "win32") {
    const bundled = join(app.getAppPath(), "vendor", "mingit", "cmd", "git.exe");
    if (existsSync(bundled)) {
      process.env.SE_GIT_PATH = bundled;
      console.log(`[desktop] 使用随包 git：${bundled}`);
    }
    return;
  }
  if (process.platform === "darwin") {
    const root = join(app.getAppPath(), "vendor", "git");
    const bundled = join(root, "bin", "git");
    if (!existsSync(bundled)) return;
    process.env.SE_GIT_PATH = bundled;
    process.env.GIT_EXEC_PATH = join(root, "libexec", "git-core");
    process.env.GIT_TEMPLATE_DIR = join(root, "share", "git-core", "templates");
    console.log(`[desktop] 使用随包 git：${bundled}`);
  }
}

/** 给服务端的「关于」用：版本、第三方许可文件、日志目录（P11）。 */
function exposeAppInfo() {
  process.env.SE_APP_VERSION = app.getVersion();
  process.env.SE_LOGS_DIR = app.getPath("logs");
  const notices = join(app.getAppPath(), "THIRD_PARTY_NOTICES.txt");
  if (existsSync(notices)) process.env.SE_NOTICES_PATH = notices;
  // 不往外报遥测。
  process.env.MASTRA_TELEMETRY_DISABLED = "1";
}

/** 中文菜单（P11）：Mac 顶栏 + Windows 窗口菜单。打包后不给刷新 / 开发者工具。 */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const devItems = app.isPackaged ? [] : [{ type: "separator" }, { role: "reload", label: "重新载入" }, { role: "toggleDevTools", label: "开发者工具" }];
  const openNotices = () => {
    const notices = process.env.SE_NOTICES_PATH;
    if (notices) void shell.openPath(notices);
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [{
        label: "StoryEngine",
        submenu: [
          { role: "about", label: "关于 StoryEngine" },
          { type: "separator" },
          { role: "hide", label: "隐藏 StoryEngine" },
          { role: "hideOthers", label: "隐藏其他" },
          { role: "unhide", label: "全部显示" },
          { type: "separator" },
          { role: "quit", label: "退出 StoryEngine" },
        ],
      }]
      : [{ label: "文件", submenu: [{ role: "quit", label: "退出" }] }]),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴为纯文本" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        ...devItems,
      ],
    },
    {
      label: "窗口",
      submenu: isMac
        ? [{ role: "minimize", label: "最小化" }, { role: "zoom", label: "缩放" }, { type: "separator" }, { role: "front", label: "前置全部窗口" }]
        : [{ role: "minimize", label: "最小化" }, { role: "close", label: "关闭" }],
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        { label: "打开日志文件夹", click: () => void shell.openPath(app.getPath("logs")) },
        { label: "第三方软件许可", enabled: Boolean(process.env.SE_NOTICES_PATH), click: openNotices },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({
    applicationName: "StoryEngine",
    applicationVersion: app.getVersion(),
    version: "",
    credits: "第三方软件许可见「帮助 → 第三方软件许可」。",
  });
}

/**
 * 把预置配置整套**事务式**拷入数据目录：逐文件「先拷到同目录临时名，再 rename 就位」，
 * 全部就位才算成功。为什么必须回滚：播种门槛是全有全无（见 seedPresetModelConfig），
 * 若中途失败（磁盘满/权限等）留下半套文件，下次启动会因「已有配置」永久跳过补种，
 * 用户拿到静默残缺的配置（评审发现）。所以任何一步失败都删掉本次已就位的目标与
 * 残留临时文件，让数据目录回到「三件全缺」、下次启动可重新播种；回滚中的删除失败
 * 可忽略（尽力清理），原始错误照抛给上层弹窗退出。
 * 无 electron 依赖（纯 node:fs），导出仅为可独立测试。
 */
export async function copyPresetModelConfigTransactionally(presetDir, dataDir, names) {
  const tempOf = (name) => join(dataDir, `${name}.seed-tmp`);
  const placed = [];
  try {
    for (const name of names) {
      const temp = tempOf(name);
      const target = join(dataDir, name);
      await copyFile(join(presetDir, name), temp);
      // secrets 在临时名阶段就收紧权限，避免以最终名短暂暴露为默认权限
      if (name === "model-secrets.json") await chmod(temp, 0o600).catch(() => {});
      await rename(temp, target);
      placed.push(target);
    }
  } catch (error) {
    for (const leftover of [...placed, ...names.map((name) => tempOf(name))]) {
      await unlink(leftover).catch(() => {});
    }
    throw error;
  }
}

/**
 * 内测预置模型配置播种（构建期用 --with-model-preset 注入，公测版不带）：
 * **全有全无**——仅当数据目录里三件（settings/secrets/task-assignments）全部不存在时，
 * 才把 preset-model-config/ 整套事务式拷入（失败自动回滚，见上）；只要用户已有任意
 * 一件就全部跳过，避免包内 key 与用户半套配置混在一起（审计 #12 加固）。
 * secrets 落盘即 0600；绝不覆盖已有文件。
 */
async function seedPresetModelConfig() {
  const presetDir = join(app.getAppPath(), "preset-model-config");
  if (!existsSync(presetDir)) return;
  const dataDir = resolveDataDir();
  const names = ["model-settings.json", "model-secrets.json", "task-assignments.json"];
  const existing = names.filter((name) => existsSync(join(dataDir, name)));
  if (existing.length > 0) {
    console.log(
      `[desktop] 跳过预置配置播种：数据目录已有 ${existing.join("、")}，避免与用户配置混成半套`,
    );
    return;
  }
  const toCopy = names.filter((name) => existsSync(join(presetDir, name)));
  if (toCopy.length === 0) return;
  await mkdir(dataDir, { recursive: true });
  await copyPresetModelConfigTransactionally(presetDir, dataDir, toCopy);
  console.log(`[desktop] 首启播种预置配置：${toCopy.join("、")}`);
}

/** @type {import("@actalk/story-engine-ui/server").StandaloneServerHandle | undefined} */
let serverHandle;

async function startServer() {
  const uiDir = resolveUiPackageDir();
  const { createStandaloneServer } = await import("@actalk/story-engine-ui/server");
  const distDir = join(uiDir, "dist");
  const preferredPort = await loadStoredPort();
  // 有合法上次端口就先试；占用/失败则回退 port:0 让系统分配，再把实际 port 写回。
  const tryPorts = preferredPort != null ? [preferredPort, 0] : [0];
  let lastError;
  for (const port of tryPorts) {
    try {
      serverHandle = await createStandaloneServer({
        distDir,
        host: "127.0.0.1",
        port,
      });
      break;
    } catch (error) {
      lastError = error;
      if (port !== 0) {
        console.warn(
          `[desktop] 端口 ${port} 不可用，回退随机端口：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (!serverHandle) throw lastError ?? new Error("本地服务启动失败");
  // StandaloneServerHandle.port = 实际绑定端口（含 port:0 时系统分配的值）
  await persistServerPort(serverHandle.port);
  console.log(`[desktop] server 已启动：${serverHandle.url}`);
  return serverHandle;
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#131211", // 改版深色底（与 se-tokens --bg 一致），避免加载白闪
    title: "StoryEngine",
    webPreferences: {
      // 前端全走 localhost HTTP，无需 Node 能力——保持默认最小权限面。
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  // 外链（http/https 且非本机 server）交给系统浏览器，别在壳里开新窗。
  const isExternal = (target) => /^https?:/iu.test(target) && !target.startsWith(serverHandle?.url ?? url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternal(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  // 窗口本身只许待在本机服务上：点到外链（或被页面带走）一律拦下，外链交给系统浏览器。
  win.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(serverHandle?.url ?? url)) return;
    event.preventDefault();
    if (isExternal(target)) void shell.openExternal(target);
  });
  // 页面进程崩了：记下来，自动重载一次（草稿每次改动都已存盘）。
  let reloadedAfterCrash = false;
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] 页面进程退出：${details.reason}（exitCode ${details.exitCode}）`);
    if (details.reason === "clean-exit" || reloadedAfterCrash || win.isDestroyed()) return;
    reloadedAfterCrash = true;
    win.webContents.reload();
  });
  void win.loadURL(url);
  return win;
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  if (!GOT_SINGLE_INSTANCE_LOCK) return;
  try {
    wireBundledGit();
    exposeAppInfo();
    buildMenu();
    await seedPresetModelConfig();
    const handle = await startServer();
    createWindow(handle.url);
    app.on("activate", () => {
      // macOS dock 点击重开窗（server 还活着，直接连）。
      if (BrowserWindow.getAllWindows().length === 0 && serverHandle) createWindow(serverHandle.url);
    });
  } catch (error) {
    // 起服失败绝不静默：弹框说明后退出（没有 server 的窗口毫无意义）。
    console.error("[desktop] 本地服务启动失败：", error);
    dialog.showErrorBox(
      "StoryEngine 启动失败",
      `本地服务启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  // 三平台统一：关最后一个窗就退出（写作应用没有无窗后台常驻的理由）。
  app.quit();
});

/** 退出时 server.close 的在飞请求宽限（keepalive 保存还在写盘时多等一下），到期强制断开既有连接（含 SSE）。 */
const QUIT_CLOSE_GRACE_MS = 1_000;
/** 退出兜底总时限：无论 close 是否回调，到点必退——Cmd+Q 永远不能被任何连接挂死。 */
const QUIT_HARD_DEADLINE_MS = 4_000;

let quitting = false;
app.on("before-quit", (event) => {
  // 审查 #4：退出前给前端 pagehide 的 keepalive 保存留一点时间抵达 server，并让 server 排空在途写盘请求，
  // 再真正退出——否则关窗即杀进程，最后一次未落盘的编辑会丢。首次拦截退出、短暂宽限后放行。
  // P2（2026-10-02）：agent 流式出稿是 SSE 长连接，裸 server.close() 要等它自然结束 → Cmd+Q 挂死。
  // 现在 close({ graceMs }) 会主动断开既有连接；外面再套一道硬时限兜底，任何情况下都退得出去。
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  let done = false;
  const quitOnce = () => {
    if (done) return;
    done = true;
    app.quit();
  };
  const finish = () => {
    const closing = serverHandle ? serverHandle.close({ graceMs: QUIT_CLOSE_GRACE_MS }) : Promise.resolve();
    void closing.catch(() => {}).finally(quitOnce);
    setTimeout(quitOnce, QUIT_HARD_DEADLINE_MS);
  };
  // 400ms 宽限：keepalive 请求已在 pagehide 时同步派发，这里只需等它抵达 + server 处理。
  setTimeout(finish, 400);
});
