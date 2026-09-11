import { mkdir, rm, rmdir } from "node:fs/promises";

import {
  HOME_TEST_TMP_ROOT,
  claimTestRunRoot,
  sweepStaleTestTmp,
  testRunRoot,
} from "./server/lib/home-test-tmp.js";

/**
 * 全局清理兜底：按 vitest 进程隔离的运行级清理（run 目录语义见 home-test-tmp.ts）。
 *
 * 为什么需要：临时目录收敛在 `~/.story-engine-test-tmp` 隐藏基目录下，但个别路由测试
 * （如 character-matrix-preview / chat-sessions）没有逐个 afterEach 清理自己建的目录，
 * 会在 run 目录里越堆越多，需要运行级兜底。
 *
 * 为什么不能整体 rm -rf 基目录（2026-09-11 并行 flake 治理）：同机第二个 vitest 进程
 * 起来/收工时会把别的进程在飞 fixture 连根拔。因此 setup 认领本进程独立 run 目录并注入
 * worker（fork 池 spawn 时展开 process.env，worker 全部继承），teardown 只删自己那份；
 * 基目录卫生由 setup 时的陈年残留时限清扫 + teardown 后的空基目录顺手回收维持。
 */
export async function setup(): Promise<void> {
  const runRoot = claimTestRunRoot();
  await mkdir(runRoot, { recursive: true });
  await sweepStaleTestTmp();
}

export async function teardown(): Promise<void> {
  // 只删本进程 setup 认领的那份 run 目录，绝不动基目录里其他（并行）运行的目录。
  await rm(testRunRoot(), { recursive: true, force: true });
  // 基目录已空（无其他并行运行在飞）则顺手收掉，保住「home 零堆积」目标；
  // 非空则 rmdir 自然失败（ENOTEMPTY），忽略。
  await rmdir(HOME_TEST_TMP_ROOT).catch(() => {});
}
