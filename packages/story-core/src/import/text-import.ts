/**
 * 「导入已写的书」命令（作者档）：把作者切好的章节写进一本空书——每章正文 + 一份空账单（origin = import）。
 *
 * 导完马上是一致的状态：N 章都定稿了，账还没记。账由记账员通读时一章一章换上（`ledger.reread`）。
 * 书里已经有正文或账单就拒绝，绝不覆盖。撤销 = 恢复导入前的快照。
 */
import { z } from "zod";
import { CHAPTER_LEDGER_SCHEMA, ChapterLedger } from "../schema/ledger.js";
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
    const writes = args.chapters.flatMap((item, index) => {
      const chapter = index + 1;
      const text = serialChapterFile(chapter, item.title, item.body);
      const ledger = ChapterLedger.parse({ schema: CHAPTER_LEDGER_SCHEMA, chapter, textSha256: sha256(text), committedAt, origin: "import", entries: [] });
      return [
        { path: chapterTextPath(chapter), content: text },
        { path: chapterLedgerPath(chapter), content: `${JSON.stringify(ledger, null, 2)}\n` },
      ];
    });
    const chapters = args.chapters.map((_, index) => index + 1);
    return {
      label: `导入 ${chapters.length} 章`,
      writes,
      changed: { chapters, ledgers: chapters },
      result: { chapters: chapters.length },
    };
  },
};
