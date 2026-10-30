/**
 * 「导入已写的书」命令（作者档）：把作者切好的章节写进一本空书——每章正文 + 一份账待记的账单（origin = import、pending）。
 *
 * 导完马上是一致的状态：N 章都定稿了，账还没记。账由记账员通读时一章一章换上（`ledger.reread`）。
 * 书里已经有正文或账单就拒绝，绝不覆盖。撤销 = 恢复导入前的快照。
 */
import { z } from "zod";
import { newLedger } from "../ledger/entries.js";
import { listChapterTexts, readAllLedgers, sha256 } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath } from "../store/paths.js";
import { serialChapterFile } from "../text/serial-split.js";
import { fail } from "../commands/runner.js";
import type { WriteCommandSpec } from "../commands/types.js";

/** 一次最多导多少章（再多就分卷导，不然一次事务太大）。 */
export const TEXT_IMPORT_MAX_CHAPTERS = 5000;

export const BookImportTextArgs = z.object({
  chapters: z
    .array(z.object({
      title: z.string().max(200),
      body: z.string().refine((value) => value.trim().length > 0, "这一章没有正文"),
    }))
    .min(1, "一章都没有")
    .max(TEXT_IMPORT_MAX_CHAPTERS, `一次最多导 ${TEXT_IMPORT_MAX_CHAPTERS} 章`),
});
export type BookImportTextArgs = z.infer<typeof BookImportTextArgs>;

export interface BookImportTextResult {
  readonly chapters: number;
}

export const bookImportText: WriteCommandSpec<BookImportTextArgs, BookImportTextResult> = {
  name: "book.importText",
  tier: "author",
  summary: "把作者已经写好的章节导进一本空书（每章正文 + 空账单，账由记账员通读时记）。",
  args: BookImportTextArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const [ledgers, texts] = await Promise.all([readAllLedgers(context.bookDir), listChapterTexts(context.bookDir)]);
    if (ledgers.length > 0 || texts.length > 0) return fail("book_not_empty", "这本书里已经有章节了，不往里导。");
    const committedAt = context.now.toISOString();
    const writes: { path: string; content: string }[] = [];
    for (const [index, item] of args.chapters.entries()) {
      const chapter = index + 1;
      const text = serialChapterFile(chapter, item.title, item.body);
      // 账待记：通读记账（ledger.reread）一章一章换上。
      const ledger = newLedger({ chapter, textSha256: sha256(text), committedAt, origin: "import", entries: [], status: "pending", coverage: { reasonCodes: ["imported_text"] } });
      if (!ledger.success) return fail("ledger_invalid", `第 ${chapter} 章的账单没拼成，没有导入。`, ledger.error.issues);
      writes.push(
        { path: chapterTextPath(chapter), content: text },
        { path: chapterLedgerPath(chapter), content: `${JSON.stringify(ledger.data, null, 2)}\n` },
      );
    }
    const chapters = args.chapters.map((_, index) => index + 1);
    return {
      label: `导入 ${chapters.length} 章`,
      writes,
      changed: { chapters, ledgers: chapters },
      result: { chapters: chapters.length },
    };
  },
};
