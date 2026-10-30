/**
 * 「定稿」命令（作者档）：把一章正文和它的账单一起写进真相。
 *
 * 参数里的条目是作者在定稿清单上留下的那些（记账员的草案、作者勾掉的已去掉）。
 * 核心再核一遍（和预览同一个 checkEntries），核不上的如实列进结果、不写；能核上的分配编号写进账单。
 * 记账没成、作者点了「先定正文、账待记」：`ledger.status = pending`、条目空，同一事务写正文和待记的账单（P2b 设计 3.1）；
 * 记账员有一步没成、这几条因此没记：`partial`，原因写进 coverage。
 *
 * 重定稿同一章：整份账单换掉。编号照 ledger/identity.ts 沿用（同一条事实、同一条线索编号不变，旧号不挪给别的条目），
 * 后文对它们的推进、推翻才接得上；上次开的线索这次没了、后文又引用过它的，结果里如实列出。
 */
import { z } from "zod";
import { EntryInput, threadOf, type ChapterLedger, type LedgerStatus } from "../schema/ledger.js";
import { chapterSource, newLedger, storeEntry } from "../ledger/entries.js";
import { assignIds, previousOf } from "../ledger/identity.js";
import { readAllLedgers, readChapterLedgerFile, readDecisions, sha256 } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath } from "../store/paths.js";
import { project } from "../projection/project.js";
import { checkEntries, type RejectedEntry } from "../review/check.js";
import { fail } from "./runner.js";
import type { CommandFailure, WriteCommandSpec } from "./types.js";

const reasonCode = z.string().regex(/^[a-z][a-z0-9_]*$/u);

/** 账没记全时交的：pending = 账待记（条目必须空）；partial = 记账员有一步没成、记了一部分。原因用代码。 */
export const LedgerShortfall = z.object({
  status: z.enum(["pending", "partial"]),
  reasonCodes: z.array(reasonCode).min(1),
});
export type LedgerShortfall = z.infer<typeof LedgerShortfall>;

export const ChapterCommitArgs = z.object({
  chapter: z.number().int().min(1),
  /** 定稿的完整正文（含标题行），原样写进 chapters/NNNN.md。 */
  text: z.string().refine((value) => value.trim().length > 0, "正文是空的"),
  entries: z.array(EntryInput),
  /** 不给 = 账记全了（ready）。 */
  ledger: LedgerShortfall.optional(),
  /** 作者点确认时依据的摘要。 */
  acceptedBasis: z.string().min(1).optional(),
});
export type ChapterCommitArgs = z.infer<typeof ChapterCommitArgs>;

export interface ChapterCommitResult {
  readonly chapter: number;
  /** 正文定了（定稿命令成了就是 true；给界面分清「正文定了、账没记上」）。 */
  readonly textCommitted: true;
  /** 这章的账记到什么程度。 */
  readonly ledgerStatus: LedgerStatus;
  /** 记进账单的条数。 */
  readonly recorded: number;
  /** 没记上的（给作者看 message）。 */
  readonly rejected: readonly Pick<RejectedEntry, "index" | "reason" | "message">[];
  /** 是不是重定稿。 */
  readonly recommitted: boolean;
  /** 重定稿后不见了、但后文引用过的线索标题（后文的推进现在没有来处，要作者看）。 */
  readonly orphanedThreads: readonly string[];
}

/** 一章新账单拼好了（还没写盘）。 */
export interface BuiltChapterLedger {
  readonly ok: true;
  readonly ledger: ChapterLedger;
  readonly rejected: ChapterCommitResult["rejected"];
  readonly previous: ChapterLedger | undefined;
  readonly orphanedThreads: readonly string[];
  /** 记上的条数（一条声明算一条：时间存成两条也算一条）。 */
  readonly recorded: number;
}

/**
 * 给一章拼新账单：核条目（和预览同一个 checkEntries）→ 分配编号（重记同一章时照旧账沿用）→ 校验整份账单。
 * 「定稿」「通读记账」「补账」共用：差在 origin、记到什么程度、定稿时间留不留原来的。
 */
export async function buildChapterLedger(
  bookDir: string,
  input: {
    readonly chapter: number;
    readonly text: string;
    readonly entries: readonly EntryInput[];
    readonly now: Date;
    readonly origin: "commit" | "reread";
    readonly shortfall?: LedgerShortfall;
    /** 补账：定稿时间照原来的（只换账，正文还是那次定的）。 */
    readonly committedAt?: string;
    readonly acceptedBasis?: string;
  },
): Promise<BuiltChapterLedger | CommandFailure> {
  const pending = input.shortfall?.status === "pending";
  if (pending && input.entries.length > 0) return fail("bad_args", "账待记的定稿不该带条目。");
  const [ledgers, decisions, file] = await Promise.all([readAllLedgers(bookDir), readDecisions(bookDir), readChapterLedgerFile(bookDir, input.chapter)]);
  const previous = file?.ledger;
  const before = project({ ledgers: ledgers.filter((ledger) => ledger.chapter < input.chapter), decisions });
  const checked = pending ? { accepted: [], rejected: [] } : checkEntries(input.entries, input.text, before);
  const accepted = checked.accepted.map((item) => item.entry);
  const assigned = assignIds(input.chapter, previous, accepted);
  const source = chapterSource(input.chapter, input.text);
  const entries = accepted.flatMap((entry, index) => storeEntry(entry, assigned.ids[index]!, source));
  const carried = previousOf(previous, file?.sha256);

  const ledger = newLedger({
    chapter: input.chapter,
    textSha256: sha256(input.text),
    committedAt: input.committedAt ?? input.now.toISOString(),
    origin: input.origin,
    entries,
    status: input.shortfall?.status ?? "ready",
    coverage: { rejectedCount: checked.rejected.length, reasonCodes: [...(input.shortfall?.reasonCodes ?? [])] },
    ...(input.acceptedBasis ? { acceptedBasis: input.acceptedBasis } : {}),
    ...(carried ? { previous: carried } : {}),
  });
  if (!ledger.success) return fail("ledger_invalid", "这一章的账单没拼成，没有记上。", ledger.error.issues);

  // 认得的旧开线索这次没了，后文还引用着它：如实列出来。
  const lost = new Set(assigned.droppedOpens.map(threadOf));
  const orphanedThreads: string[] = [];
  if (lost.size > 0) {
    const referenced = new Set<string>();
    for (const later of ledgers) {
      if (later.chapter <= input.chapter) continue;
      for (const entry of later.entries) if (entry.kind === "thread" && lost.has(threadOf(entry))) referenced.add(threadOf(entry));
    }
    for (const entry of assigned.droppedOpens) {
      if (referenced.has(threadOf(entry))) orphanedThreads.push(entry.title ?? entry.note);
    }
  }

  return {
    ok: true,
    ledger: ledger.data,
    rejected: checked.rejected.map(({ index, reason, message }) => ({ index, reason, message })),
    previous,
    orphanedThreads,
    recorded: checked.accepted.length,
  };
}

export const chapterCommit: WriteCommandSpec<ChapterCommitArgs, ChapterCommitResult> = {
  name: "chapter.commit",
  tier: "author",
  summary: "定稿一章：写入正文和这一章的账单。",
  args: ChapterCommitArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const built = await buildChapterLedger(context.bookDir, {
      chapter: args.chapter,
      text: args.text,
      entries: args.entries,
      now: context.now,
      origin: "commit",
      ...(args.ledger ? { shortfall: args.ledger } : {}),
      ...(args.acceptedBasis ? { acceptedBasis: args.acceptedBasis } : {}),
    });
    if (!built.ok) return { ...built, message: built.code === "ledger_invalid" ? "这一章的账单没拼成，没有定稿。" : built.message };
    return {
      label: `定稿：第 ${args.chapter} 章`,
      writes: [
        { path: chapterTextPath(args.chapter), content: args.text },
        { path: chapterLedgerPath(args.chapter), content: `${JSON.stringify(built.ledger, null, 2)}\n` },
      ],
      changed: { chapters: [args.chapter], ledgers: [args.chapter] },
      result: {
        chapter: args.chapter,
        textCommitted: true,
        ledgerStatus: built.ledger.status,
        recorded: built.recorded,
        rejected: built.rejected,
        recommitted: built.previous !== undefined,
        orphanedThreads: built.orphanedThreads,
      },
    };
  },
};
