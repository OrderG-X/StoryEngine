/**
 * 整本恢复的计划（写作版本 P2a 片 4B，设计 8.2）：按存档树算——存档有、内容不同 → 写；存档没有、现在有 → 删。
 * 冻结的是整个撤销范围的摘要：应用时（history.apply）在书锁里重新枚举、重算，一样才写；多了、少了、变了任何一个就重算、重新确认。
 * 范围外的（操作、候选、恢复稿、控制文件、回执、镜像）不动。只读：不写盘、不拿锁。
 */
import { fail } from "../commands/runner.js";
import type { CommandFailure } from "../commands/types.js";
import { sha256Bytes } from "../store/transaction.js";
import type { PlannedChange } from "./revert.js";
import { HistoryFileError, HistoryStore, rangeDigestOf, readUndoableFiles, textOf, type HistoryReader } from "./store.js";

export interface RestorePlan {
  readonly ok: true;
  readonly changes: readonly PlannedChange[];
  /** 计划时整个撤销范围的摘要。 */
  readonly rangeDigest: string;
}

export async function planRestore(bookDir: string, tree: string, reader: HistoryReader): Promise<RestorePlan | CommandFailure> {
  const store = new HistoryStore(reader);
  try {
    const target = await store.list(tree);
    if (!target) return fail("tree_gone", "这份存档已经裁掉了，恢复不了。");
    const files = await readUndoableFiles(bookDir);
    const current = new Map([...files].map(([path, bytes]) => [path, store.pin(bytes)]));
    const changes: PlannedChange[] = [];
    for (const path of [...new Set([...target.keys(), ...current.keys()])].sort()) {
      const wanted = target.get(path);
      if (wanted === current.get(path)) continue;
      const now = files.get(path);
      changes.push({ path, expect: now === undefined ? null : sha256Bytes(now), content: wanted === undefined ? null : textOf(await store.bytes(wanted, path), path) });
    }
    return { ok: true, changes, rangeDigest: rangeDigestOf(files) };
  } catch (error) {
    if (error instanceof HistoryFileError) return fail(error.code, error.message, { path: error.path });
    throw error;
  }
}
