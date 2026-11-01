/**
 * 「通读记账」命令（作者档：作者点「导入」才会启动通读，AI 调不了）：给一章已定稿的正文换上记账员通读时记的账单。
 *
 * 和「定稿」的区别：正文一个字不动（没有正文、没有账单的章不记）；账单 origin = reread；不打快照——
 * 一轮通读几百章，撤销点在整轮开跑前打一次。编号分配和重定稿同一套（buildChapterLedger），后文的推进接得上。
 */
import { z } from "zod";
import { EntryInput, ItemRefInput } from "../schema/ledger.js";
import { readChapterLedger, readChapterText } from "../store/book.js";
import { chapterLedgerPath } from "../store/paths.js";
import { buildChapterLedger, itemShortfall, type ChapterCommitResult } from "./chapter-commit.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

export const LedgerRereadArgs = z.object({
  chapter: z.number().int().min(1),
  entries: z.array(EntryInput),
  /** 记账员交来的东西条目有没记上的（解析掉的、核不上的、等作者看没记的）：这章缺哪几类（P3b 设计 2.4）。 */
  itemMissing: z.array(z.enum(["item", "fact"])).min(1).optional(),
  /** 缺东西那类时只缺这几样（没记上的条目都认得出指哪几样）；不给 = 整章东西当没记全。 */
  missingItems: z.array(ItemRefInput).optional(),
});
export type LedgerRereadArgs = z.infer<typeof LedgerRereadArgs>;

export interface LedgerRereadResult {
  readonly chapter: number;
  readonly recorded: number;
  readonly rejected: ChapterCommitResult["rejected"];
}

export const ledgerReread: WriteCommandSpec<LedgerRereadArgs, LedgerRereadResult> = {
  name: "ledger.reread",
  tier: "author",
  summary: "通读记账：给一章已定稿的正文换上记账员记的账单（正文不动）。",
  args: LedgerRereadArgs,
  snapshot: false,
  idempotent: true,
  async plan(context, args) {
    const [text, previous] = await Promise.all([readChapterText(context.bookDir, args.chapter), readChapterLedger(context.bookDir, args.chapter)]);
    if (text === undefined || previous === undefined) return fail("not_committed", `第 ${args.chapter} 章还没定稿，没有可重记的账。`);
    const shortfall = itemShortfall(undefined, args.itemMissing ?? [], args.missingItems);
    const built = await buildChapterLedger(context.bookDir, {
      chapter: args.chapter,
      text,
      entries: args.entries,
      now: context.now,
      origin: "reread",
      ...(shortfall ? { shortfall } : {}),
    });
    if (!built.ok) return built;
    return {
      label: `通读记账：第 ${args.chapter} 章`,
      writes: [{ path: chapterLedgerPath(args.chapter), content: `${JSON.stringify(built.ledger, null, 2)}\n` }],
      changed: { ledgers: [args.chapter] },
      result: { chapter: args.chapter, recorded: built.recorded, rejected: built.rejected },
    };
  },
};
