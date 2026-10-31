/**
 * 「改已定稿的章名」命令（作者档，2026-10-22 真机试写）：定稿前忘了起章名，定稿后稿纸锁了、章名点不动，
 * 作者没有路可走，章节栏永远「未命名」。
 *
 * 只换定稿正文第一行的「# 章名」，正文一个字不动；账单里的正文指纹和证据的版本跟着换（不然投影会当成「定稿后改过正文」）。
 * 这一章还有工作稿的，工作稿的章名一起换（章节栏、书架先看工作稿的章名）。账单条目一条不动，不用重新记账。
 */
import { z } from "zod";
import { ChapterLedger } from "../schema/ledger.js";
import { chapterSource, relocateEvidence, relocateScenes } from "../ledger/entries.js";
import { readChapterLedger, readChapterText, sha256 } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath, draftPath } from "../store/paths.js";
import { composeDraftFile, parseDraftFile, readDraft } from "../draft/draft.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";
import type { TxWrite } from "../store/transaction.js";

export const ChapterRetitleArgs = z.object({
  chapter: z.number().int().min(1),
  title: z.string(),
});
export type ChapterRetitleArgs = z.infer<typeof ChapterRetitleArgs>;

export interface ChapterRetitleResult {
  readonly chapter: number;
  readonly title: string;
  /** 原来就是这个章名，什么都没写。 */
  readonly unchanged: boolean;
}

export const chapterRetitle: WriteCommandSpec<ChapterRetitleArgs, ChapterRetitleResult> = {
  name: "chapter.retitle",
  tier: "author",
  summary: "改已定稿那一章的章名（正文和账单条目不动）。",
  args: ChapterRetitleArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const title = args.title.replace(/\s+/gu, " ").trim();
    if (!title) return fail("empty_title", "章名是空的，没有改。");
    const [text, ledger, draft] = await Promise.all([
      readChapterText(context.bookDir, args.chapter),
      readChapterLedger(context.bookDir, args.chapter),
      readDraft(context.bookDir, args.chapter),
    ]);
    if (text === undefined || ledger === undefined) return fail("not_committed", `第 ${args.chapter} 章还没定稿，章名在稿纸上直接改。`);
    const label = `改章名：第 ${args.chapter} 章`;
    const nextText = composeDraftFile({ title, body: parseDraftFile(text).body });
    const writes: TxWrite[] = [];
    if (nextText !== text) {
      // 证据跟着换到新一版正文（章名行不切句，句号不变）。
      const source = chapterSource(args.chapter, nextText);
      const next = ChapterLedger.parse({
        ...ledger,
        textSha256: sha256(nextText),
        entries: ledger.entries.map((entry) => relocateEvidence(entry, source)),
        scenes: relocateScenes(ledger.scenes, source),
      });
      writes.push(
        { path: chapterTextPath(args.chapter), content: nextText },
        { path: chapterLedgerPath(args.chapter), content: `${JSON.stringify(next, null, 2)}\n` },
      );
    }
    const draftWrites = draft && draft.title !== title ? [{ path: draftPath(args.chapter), content: composeDraftFile({ title, body: draft.body }) }] : [];
    if (writes.length === 0 && draftWrites.length === 0) {
      return { label, writes: [], changed: {}, result: { chapter: args.chapter, title, unchanged: true } };
    }
    return {
      label,
      writes: [...writes, ...draftWrites],
      changed: {
        ...(writes.length > 0 ? { chapters: [args.chapter], ledgers: [args.chapter] } : {}),
        ...(draftWrites.length > 0 ? { drafts: [args.chapter] } : {}),
      },
      result: { chapter: args.chapter, title, unchanged: false },
    };
  },
};
