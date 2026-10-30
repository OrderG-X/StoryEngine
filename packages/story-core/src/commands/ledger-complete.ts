/**
 * 「补账」命令（作者档，写作版本 P2b 设计 3.2）：定稿时账没记上（pending）或没记全（partial）的那一章，换上作者在补账清单上确认的账单。
 *
 * 只换账单，正文一个字不动、定稿时间照原来的。在书锁里核：账单还是作者补账时看的那一份（原样哈希）、
 * 正文还是那次定稿的那版；任何一样变了（重定稿、撤销、恢复过、正文又改过）就不写、如实说。
 * 导入的章由后台通读记账补，这里不接。编号和重定稿同一套（ledger/identity.ts），旧号照占、上次开的线索接得上。
 */
import { z } from "zod";
import { EntryInput, type LedgerStatus } from "../schema/ledger.js";
import { readChapterLedgerFile, readChapterText, sha256 } from "../store/book.js";
import { chapterLedgerPath } from "../store/paths.js";
import { buildChapterLedger, type ChapterCommitResult } from "./chapter-commit.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

export const LedgerCompleteArgs = z.object({
  chapter: z.number().int().min(1),
  /** 补账时读到的那份账单的原样哈希。 */
  ledgerSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(EntryInput),
  /** 这次又有一步没成、只补了一部分。 */
  partial: z.object({ reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).min(1) }).optional(),
  acceptedBasis: z.string().min(1).optional(),
});
export type LedgerCompleteArgs = z.infer<typeof LedgerCompleteArgs>;

export interface LedgerCompleteResult {
  readonly chapter: number;
  readonly ledgerStatus: LedgerStatus;
  readonly recorded: number;
  readonly rejected: ChapterCommitResult["rejected"];
  readonly orphanedThreads: readonly string[];
}

export const ledgerComplete: WriteCommandSpec<LedgerCompleteArgs, LedgerCompleteResult> = {
  name: "ledger.complete",
  tier: "author",
  summary: "补账：给定稿时账没记上、没记全的一章换上补记的账单（正文不动）。",
  args: LedgerCompleteArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const { chapter } = args;
    const [file, text] = await Promise.all([readChapterLedgerFile(context.bookDir, chapter), readChapterText(context.bookDir, chapter)]);
    if (!file || text === undefined) return fail("not_committed", `第 ${chapter} 章还没定稿，没有账可补。`);
    if (file.sha256 !== args.ledgerSha256) return fail("ledger_changed", `第 ${chapter} 章的账在这之后变过（重新定稿、撤销或恢复过），这次补的账没写。`);
    const { ledger } = file;
    if (ledger.status === "ready") return fail("nothing_to_fill", `第 ${chapter} 章的账已经记上了，不用补。`);
    if (ledger.origin === "import") return fail("rereading", `第 ${chapter} 章是导入的，账由通读记账来记，不用在这里补。`);
    if (sha256(text) !== ledger.textSha256) return fail("text_changed", `第 ${chapter} 章定稿之后正文又改过，先重新定稿再补账。`);
    const built = await buildChapterLedger(context.bookDir, {
      chapter,
      text,
      entries: args.entries,
      now: context.now,
      origin: ledger.origin,
      committedAt: ledger.committedAt,
      ...(args.partial ? { shortfall: { status: "partial" as const, reasonCodes: args.partial.reasonCodes } } : {}),
      ...(args.acceptedBasis ? { acceptedBasis: args.acceptedBasis } : {}),
    });
    if (!built.ok) return built;
    return {
      label: `补账：第 ${chapter} 章`,
      writes: [{ path: chapterLedgerPath(chapter), content: `${JSON.stringify(built.ledger, null, 2)}\n` }],
      changed: { ledgers: [chapter] },
      result: { chapter, ledgerStatus: built.ledger.status, recorded: built.recorded, rejected: built.rejected, orphanedThreads: built.orphanedThreads },
    };
  },
};
