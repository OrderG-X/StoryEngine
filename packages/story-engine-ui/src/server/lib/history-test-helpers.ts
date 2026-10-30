/**
 * 单测：不经操作直接把书整本恢复到一个存档（核心 history.apply，和 history.change 恢复同一份计划和写回，纪元换成新的）。
 * 要「书被整本恢复过」这个前提的测试用（哪怕正跑在别的操作的模型调用里）；作者真点的恢复走 history.change 操作，在它的配方测试里。
 */
import { randomUUID } from "node:crypto";
import { historyApply, planRestore, runCommand, withBookLock } from "@actalk/story-core";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import { withGitHistoryReader } from "./history-reader.js";
import { coreSnapshotFor, snapshotInfoOf } from "./snapshot.js";
import { resyncWordStats } from "./word-stats.js";

/** 恢复到这个存档；回改了的路径。 */
export async function restoreForTest(projectDir: string, snapshotId: string): Promise<readonly string[]> {
  const info = await snapshotInfoOf(projectDir, snapshotId);
  if (!info) throw new Error(`存档不在：${snapshotId}`);
  return withBookLock(projectDir, async () => {
    const plan = await withGitHistoryReader(projectDir, (reader) => planRestore(projectDir, info.tree, reader));
    if (!plan.ok) throw new Error(plan.message);
    if (plan.changes.length === 0) return [];
    const result = await runCommand(projectDir, historyApply, {
      kind: "restore",
      label: "恢复（单测）",
      target: { snapshot: snapshotId },
      changes: plan.changes.map((change) => ({ ...change })),
      rangeDigest: plan.rangeDigest,
    }, { caller: "author", snapshot: coreSnapshotFor(projectDir), idempotencyKey: `test-restore:${randomUUID()}` });
    if (!result.ok) throw new Error(result.message);
    await syncLegacyMirror(projectDir);
    await resyncWordStats(projectDir);
    return result.result.paths;
  });
}
