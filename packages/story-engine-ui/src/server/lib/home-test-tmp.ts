/**
 * 测试专用临时目录助手。
 *
 * 为什么不用 os.tmpdir()：`isSafeProjectPath`（见 project-io.ts）要求项目路径落在 $HOME 下，
 * 而 tmpdir() 在 macOS 解析到 /var/folders/...、Linux 到 /tmp(=/private/tmp)，都会被守卫判为
 * 「不安全路径」而返回 400。凡是经 guardProjectPath 的路由测试，其项目目录只能建在 home 内。
 *
 * 为什么要这个助手：过去各测试直接 `mkdtemp(join(homedir(), "..."))`，把几十个临时目录散落在
 * 用户 home 根目录，既污染又不好清理（偶发失败还会漏下空壳）。这里统一收敛到一个隐藏基目录，
 * 既继续满足守卫（仍在 $HOME 下、不落在 UNSAFE 段），又便于一键清理、不再脏 home 根。
 *
 * 为什么再分一层 run 目录（2026-09-11，并行 flake 治理）：同机多个 vitest 进程并行跑测试时，
 * 旧实现让每个进程的 globalSetup 对基目录整体 rm -rf——另一个进程的在飞 fixture 会被连根拔
 * （ENOTEMPTY / 半建半删 / git stat 噪音的 flake 根因）。现在每个 vitest 进程在 setup 时认领
 * 一个独立 run 目录（run-<pid>-<时间戳>）并经 env 注入本进程的所有 worker，teardown 只删
 * 自己那份，绝不动别的进程的目录；基目录本身的卫生靠 setup 时按 mtime 时限清扫陈年残留维持。
 */
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 所有 home 内测试临时目录的统一隐藏基目录，安全可整体删除。 */
export const HOME_TEST_TMP_ROOT = join(homedir(), ".story-engine-test-tmp");

/** globalSetup 向本进程 worker 注入「本次运行专属 run 目录」的环境变量名（见 test-global-setup.ts）。 */
export const TEST_RUN_ROOT_ENV = "STORY_ENGINE_TEST_RUN_ROOT";

/**
 * 陈年残留判定时限：setup 时只清扫 mtime 早于此的基目录条目。在飞运行的 run 目录会持续
 * mkdtemp 直接子目录、mtime 始终新鲜，时限远大于任何一次测试运行时长，绝不误删并行进程。
 */
export const TEST_TMP_STALE_TTL_MS = 6 * 60 * 60 * 1000;

function ownTestRunRoot(): string {
  return join(HOME_TEST_TMP_ROOT, `run-${process.pid}-${Date.now()}`);
}

/**
 * 本次测试运行的临时根目录：globalSetup 注入的 run 目录优先；未注入（非 vitest 入口直跑、
 * 池实现不传递 env）退化为本进程独立 run 目录。两种口径都保证同机并行 vitest 进程互不踩踏。
 */
export function testRunRoot(): string {
  return process.env[TEST_RUN_ROOT_ENV] ?? ownTestRunRoot();
}

/**
 * 为本 vitest 进程认领一个独立 run 目录并注入 env（fork worker 继承 process.env，见
 * test-global-setup.ts），返回该路径。仅供 globalSetup setup 调用，不建目录。
 */
export function claimTestRunRoot(): string {
  const runRoot = ownTestRunRoot();
  process.env[TEST_RUN_ROOT_ENV] = runRoot;
  return runRoot;
}

/**
 * 在「本次运行专属 run 目录」下创建一个唯一临时目录并返回其绝对路径。
 * 用法与 `mkdtemp(join(homedir(), prefix))` 等价，但落点收敛、过 guardProjectPath、
 * 且并行 vitest 进程之间目录互不相交。
 */
export async function makeHomeTempDir(prefix: string): Promise<string> {
  const runRoot = testRunRoot();
  await mkdir(runRoot, { recursive: true });
  return mkdtemp(join(runRoot, prefix));
}

/**
 * 清扫基目录下的陈年条目（旧扁平布局时代的残留 + 异常退出运行留下的 run 目录）：
 * 只按 mtime 时限删、不按名字挑，在飞并行运行的目录 mtime 新鲜、天然豁免。
 * 尽力而为：单条目与并行进程竞态（抢先删除/重建）失败不影响其余条目。
 */
export async function sweepStaleTestTmp(ttlMs = TEST_TMP_STALE_TTL_MS): Promise<void> {
  const entries = await readdir(HOME_TEST_TMP_ROOT, { withFileTypes: true }).catch(() => null);
  if (!entries) return; // 基目录不存在：没什么可扫
  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    const entryPath = join(HOME_TEST_TMP_ROOT, entry.name);
    try {
      const stats = await lstat(entryPath);
      if (now - stats.mtimeMs >= ttlMs) await rm(entryPath, { recursive: true, force: true });
    } catch { /* 并行进程抢先删/建，忽略 */ }
  }));
}
