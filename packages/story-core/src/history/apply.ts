/**
 * history.apply —— 撤销一次操作、整本恢复到一份存档（写作版本 P2a 片 4B，设计 8.1 / 8.2）：照算好的计划写回 / 删掉文件，
 * 每个都核现在还是计划时的样子（不是就不写、如实说，调用方重算）；整本恢复另核整个撤销范围的摘要。
 * 普通写命令：写前打存档（撤销一笔撤销靠它）、换写入代次、换工作稿纪元；整本恢复另换书的纪元（撤销不换）。
 * 带了范围摘要的（整本恢复必带）另核整个撤销范围还是计划时的样子：算好之后哪里改过（多了新的引用者）就不写。
 * 回执记它实际覆盖的前像（effects），再撤它就换回那份。
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fail } from "../commands/runner.js";
import type { WriteCommandSpec } from "../commands/types.js";
import type { ChangeSet } from "../schema/book.js";
import { bookEpochWrite, opBookEpoch } from "../store/control.js";
import { CARDS_PATH, chapterFromFileName, DECISIONS_PATH, draftChapterOfPath, isUndoablePath, planChapterOfPath } from "../store/paths.js";
import { sha256Bytes, type TxWrite } from "../store/transaction.js";
import { HISTORY_APPLY_COMMAND } from "./revert.js";
import { ledgerChapterOfPath, rangeDigestOf, readUndoableFiles } from "./store.js";

export const HistoryApplyArgs = z.object({
  kind: z.enum(["revert", "restore"]),
  /** 历史里显示的（「撤销：定稿 第 3 章」）。 */
  label: z.string().trim().min(1),
  /** 撤的是哪次 / 恢复到哪份（原样记进结果，之后认「被撤过」用）。 */
  target: z.record(z.string(), z.unknown()),
  changes: z.array(z.object({ path: z.string().min(1), expect: z.string().nullable(), content: z.string().nullable() })),
  /** 计划时整个撤销范围的摘要（整本恢复必须带；撤销带了也核：算好之后哪里改过都重算）。 */
  rangeDigest: z.string().min(1).optional(),
});
export type HistoryApplyArgs = z.infer<typeof HistoryApplyArgs>;

export interface HistoryApplyResult {
  readonly kind: "revert" | "restore";
  readonly target: Readonly<Record<string, unknown>>;
  /** 写回 / 删掉了哪些文件。 */
  readonly paths: readonly string[];
}

async function currentSha(bookDir: string, path: string): Promise<string | null> {
  try {
    if (!(await lstat(join(bookDir, path))).isFile()) return "not-a-file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return sha256Bytes(await readFile(join(bookDir, path)));
}

const chapterOfTextPath = (path: string): number | undefined =>
  path.startsWith("chapters/") && path.endsWith(".md") ? chapterFromFileName(path.slice("chapters/".length)) : undefined;

function changeSetOf(paths: readonly string[]): ChangeSet {
  const pick = (of: (path: string) => number | undefined): number[] => [...new Set(paths.flatMap((path) => of(path) ?? []))].sort((a, b) => a - b);
  const chapters = pick(chapterOfTextPath);
  const ledgers = pick(ledgerChapterOfPath);
  const drafts = pick(draftChapterOfPath);
  const plans = pick(planChapterOfPath);
  return {
    ...(chapters.length > 0 ? { chapters } : {}),
    ...(ledgers.length > 0 ? { ledgers } : {}),
    ...(drafts.length > 0 ? { drafts } : {}),
    ...(plans.length > 0 ? { plans } : {}),
    ...(paths.includes(DECISIONS_PATH) ? { decisions: true } : {}),
    ...(paths.includes(CARDS_PATH) ? { cards: true } : {}),
  };
}

export const historyApply: WriteCommandSpec<HistoryApplyArgs, HistoryApplyResult> = {
  name: HISTORY_APPLY_COMMAND,
  tier: "ai-direct",
  summary: "撤销一次操作、整本恢复到一份存档：照算好的计划写回、删掉文件，每个都核现在的样子。",
  args: HistoryApplyArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    if (args.kind === "restore" && !args.rangeDigest) return fail("invalid_args", "整本恢复缺范围摘要，没有恢复。");
    if (args.rangeDigest && rangeDigestOf(await readUndoableFiles(context.bookDir)) !== args.rangeDigest) {
      return fail("range_changed", "算好之后书里又有地方改过，这次一处都没动。重新算一次。");
    }
    const seen = new Set<string>();
    const writes: TxWrite[] = [];
    for (const change of args.changes) {
      const path = change.path;
      if (!isUndoablePath(path) || seen.has(path)) return fail("invalid_args", "计划里有不该动的文件，没有执行。", { path });
      seen.add(path);
      if ((await currentSha(context.bookDir, path)) !== change.expect) {
        return fail("changed_since_plan", "算好之后这一份又改过，这次一处都没动。重新算一次。", { path });
      }
      writes.push(change.content === null ? { path, delete: true } : { path, content: change.content });
    }
    const paths = [...seen];
    // 整本恢复换书的纪元：在操作里换成这次操作认得出的那个（它自己照常收尾，别的操作对不上）。
    if (args.kind === "restore" && writes.length > 0) writes.push(bookEpochWrite(context.now, context.op ? opBookEpoch(context.op.opId) : undefined));
    return {
      label: args.label,
      writes,
      changed: changeSetOf(paths),
      result: { kind: args.kind, target: args.target, paths },
      freshDraftEpoch: true,
    };
  },
};
