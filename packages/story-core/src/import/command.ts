/**
 * 「导入老书」命令（作者档）：读老书的数据文件，生成每章的导入账单（origin = import）。
 *
 * 只新增 `ledger/chapters/`，老文件一个字节都不碰；撤销 = 恢复导入前的快照（或删掉 ledger/）。
 * 已经有账单的书不导，直接失败——不覆盖作者已经确认过的账。
 */
import { z } from "zod";
import type { AuthorDecision } from "../schema/decisions.js";
import { decisionsFileText, listChapterTexts, readAllLedgers, readChapterText, readDecisions } from "../store/book.js";
import { chapterLedgerPath, DECISIONS_PATH } from "../store/paths.js";
import { fail } from "../commands/runner.js";
import type { WriteCommandSpec } from "../commands/types.js";
import { buildImportLedgers, type ImportAdjustment, type ImportCounts } from "./build.js";
import { readLegacyData, type ImportSkip } from "./legacy.js";

export const BookImportArgs = z.object({});
export type BookImportArgs = z.infer<typeof BookImportArgs>;

export interface BookImportResult {
  readonly counts: ImportCounts & { readonly expiries: number; readonly majorThreads: number };
  readonly skipped: readonly ImportSkip[];
  readonly adjusted: readonly ImportAdjustment[];
}

export const bookImport: WriteCommandSpec<BookImportArgs, BookImportResult> = {
  name: "book.import",
  tier: "author",
  summary: "把老书的账导入成每章账单（只新增，不改老文件）。",
  args: BookImportArgs,
  snapshot: true,
  idempotent: true,
  async plan(context) {
    if ((await readAllLedgers(context.bookDir)).length > 0) {
      return fail("already_imported", "这本书已经有账单了，不再导入。");
    }
    const chapters = await listChapterTexts(context.bookDir);
    if (chapters.length === 0) return fail("no_chapters", "这本书还没有定稿的章节，没什么可导入的。");
    const texts = new Map<number, string>();
    for (const chapter of chapters) {
      const text = await readChapterText(context.bookDir, chapter);
      if (text !== undefined) texts.set(chapter, text);
    }
    const legacy = await readLegacyData(context.bookDir);
    const at = context.now.toISOString();
    const built = buildImportLedgers(legacy, texts, at);
    const writes = built.ledgers.map((ledger) => ({ path: chapterLedgerPath(ledger.chapter), content: `${JSON.stringify(ledger, null, 2)}\n` }));
    const decisionInputs: Omit<AuthorDecision, "id" | "at">[] = [
      ...built.expiries.map((expiry) => ({ type: "fact.expire" as const, fact: expiry.fact, chapter: expiry.chapter, note: "老书导入：旧账在这章作废了它" })),
      ...built.majorThreads.map((thread) => ({ type: "thread.weight" as const, thread, weight: "major" as const })),
    ];
    if (decisionInputs.length > 0) {
      const existing = await readDecisions(context.bookDir);
      const decisions = decisionInputs.map((input, index) => ({ ...input, id: `d-${existing.length + index + 1}`, at }) as AuthorDecision);
      writes.push({ path: DECISIONS_PATH, content: decisionsFileText([...existing, ...decisions]) });
    }
    return {
      label: "导入老书的账",
      writes,
      changed: { ledgers: built.ledgers.map((ledger) => ledger.chapter), ...(decisionInputs.length > 0 ? { decisions: true } : {}) },
      result: {
        counts: { ...built.counts, expiries: built.expiries.length, majorThreads: built.majorThreads.length },
        skipped: built.skipped,
        adjusted: built.adjusted,
      },
    };
  },
};
