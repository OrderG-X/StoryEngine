/**
 * 「定稿」命令（作者档）：把一章正文和它的账单一起写进真相。
 *
 * 参数里的条目是作者在定稿清单上留下的那些（记账员的草案、作者勾掉的已去掉）。
 * 核心再核一遍（和预览同一个 checkEntries），核不上的如实列进结果、不写；能核上的分配编号写进账单。
 *
 * 重定稿同一章：整份账单换掉。编号尽量沿用上次的（同一条事实、同一条线索编号不变），
 * 后文对它们的推进、推翻才接得上；上次开的线索这次没了、后文又引用过它的，结果里如实列出。
 */
import { z } from "zod";
import { ChapterLedger, CHAPTER_LEDGER_SCHEMA, EntryInput, type LedgerEntry } from "../schema/ledger.js";
import { readAllLedgers, readDecisions, sha256 } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath } from "../store/paths.js";
import { project } from "../projection/project.js";
import { checkEntries, type RejectedEntry } from "../review/check.js";
import { nameKey } from "../text/quote.js";
import { fail } from "./runner.js";
import type { CommandFailure, WriteCommandSpec } from "./types.js";

export const ChapterCommitArgs = z.object({
  chapter: z.number().int().min(1),
  /** 定稿的完整正文（含标题行），原样写进 chapters/NNNN.md。 */
  text: z.string().refine((value) => value.trim().length > 0, "正文是空的"),
  entries: z.array(EntryInput),
});
export type ChapterCommitArgs = z.infer<typeof ChapterCommitArgs>;

export interface ChapterCommitResult {
  readonly chapter: number;
  /** 记进账单的条数。 */
  readonly recorded: number;
  /** 没记上的（给作者看 message）。 */
  readonly rejected: readonly Pick<RejectedEntry, "index" | "reason" | "message">[];
  /** 是不是重定稿。 */
  readonly recommitted: boolean;
  /** 重定稿后不见了、但后文引用过的线索标题（后文的推进现在没有来处，要作者看）。 */
  readonly orphanedThreads: readonly string[];
}

/** 判断「同一条」的键：只认写法完全一样，不猜意思。 */
function entryKey(entry: EntryInput | LedgerEntry): string {
  switch (entry.kind) {
    case "summary":
      return "summary";
    case "time":
      return "time";
    case "presence":
      return `presence|${nameKey(entry.name)}|${nameKey(entry.nameUsed)}`;
    case "fact":
      return [
        "fact",
        entry.nature,
        nameKey(entry.subject ?? ""),
        nameKey(entry.attribute ?? ""),
        nameKey(entry.value ?? ""),
        entry.nature === "event" ? nameKey(entry.text) : "",
      ].join("|");
    case "thread":
      return entry.op === "open" ? `thread|open|${nameKey(entry.title ?? "")}` : `thread|${entry.op}|${entry.thread ?? ""}|${nameKey(entry.note)}`;
  }
}

/** 编号里最大的序号（`c3-7` → 7）。 */
function maxSeq(ids: readonly string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const seq = Number(id.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max;
}

/** 一章新账单拼好了（还没写盘）。 */
export interface BuiltChapterLedger {
  readonly ok: true;
  readonly ledger: ChapterLedger;
  readonly rejected: ChapterCommitResult["rejected"];
  readonly previous: ChapterLedger | undefined;
  readonly orphanedThreads: readonly string[];
}

/**
 * 给一章拼新账单：核条目（和预览同一个 checkEntries）→ 分配编号（重记同一章时尽量沿用上次的）→ 校验整份账单。
 * 「定稿」和「通读记账」共用：两者只差 origin。
 */
export async function buildChapterLedger(
  bookDir: string,
  input: { readonly chapter: number; readonly text: string; readonly entries: readonly EntryInput[]; readonly now: Date; readonly origin: "commit" | "reread" },
): Promise<BuiltChapterLedger | CommandFailure> {
  const [ledgers, decisions] = await Promise.all([readAllLedgers(bookDir), readDecisions(bookDir)]);
  const previous = ledgers.find((ledger) => ledger.chapter === input.chapter);
  const before = project({ ledgers: ledgers.filter((ledger) => ledger.chapter < input.chapter), decisions });
  const checked = checkEntries(input.entries, input.text, before);

  const entryPrefix = `c${input.chapter}-`;
  const threadPrefix = `t${input.chapter}-`;
  const previousEntries = previous?.entries ?? [];
  const previousIdByKey = new Map<string, string>();
  for (const entry of previousEntries) if (!previousIdByKey.has(entryKey(entry))) previousIdByKey.set(entryKey(entry), entry.id);
  const previousOpens = previousEntries.filter((entry) => entry.kind === "thread" && entry.op === "open");
  const previousOpenThreadByTitle = new Map(previousOpens.map((entry) => [entryKey(entry), entry.kind === "thread" ? entry.thread : ""]));
  const previousOpenThreadIds = new Set(previousOpens.map((entry) => (entry.kind === "thread" ? entry.thread : "")));

  let nextEntry = maxSeq(previousEntries.map((entry) => entry.id), entryPrefix);
  let nextThread = maxSeq([...previousOpenThreadIds], threadPrefix);
  const usedIds = new Set<string>();
  const usedThreads = new Set<string>();
  const entries: LedgerEntry[] = [];
  for (const { entry } of checked.accepted) {
    const key = entryKey(entry);
    const reuse = previousIdByKey.get(key);
    const id = reuse && !usedIds.has(reuse) ? reuse : `${entryPrefix}${(nextEntry += 1)}`;
    usedIds.add(id);
    if (entry.kind === "thread" && entry.op === "open") {
      const keep = entry.thread && previousOpenThreadIds.has(entry.thread) && !usedThreads.has(entry.thread)
        ? entry.thread
        : previousOpenThreadByTitle.get(key);
      const thread = keep && !usedThreads.has(keep) ? keep : `${threadPrefix}${(nextThread += 1)}`;
      usedThreads.add(thread);
      entries.push({ ...entry, id, thread });
    } else if (entry.kind === "thread") {
      entries.push({ ...entry, id, thread: entry.thread as string });
    } else {
      entries.push({ ...entry, id } as LedgerEntry);
    }
  }

  const ledger = ChapterLedger.safeParse({
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter: input.chapter,
    textSha256: sha256(input.text),
    committedAt: input.now.toISOString(),
    origin: input.origin,
    entries,
  });
  if (!ledger.success) return fail("ledger_invalid", "这一章的账单没拼成，没有记上。", ledger.error.issues);

  // 上次开的线索这次没了，后文还引用着它：如实列出来。
  const lost = new Set([...previousOpenThreadIds].filter((thread) => !usedThreads.has(thread)));
  const orphanedThreads: string[] = [];
  if (lost.size > 0) {
    const referenced = new Set<string>();
    for (const later of ledgers) {
      if (later.chapter <= input.chapter) continue;
      for (const entry of later.entries) if (entry.kind === "thread" && lost.has(entry.thread)) referenced.add(entry.thread);
    }
    for (const entry of previousOpens) {
      if (entry.kind === "thread" && referenced.has(entry.thread)) orphanedThreads.push(entry.title ?? entry.note);
    }
  }

  return {
    ok: true,
    ledger: ledger.data,
    rejected: checked.rejected.map(({ index, reason, message }) => ({ index, reason, message })),
    previous,
    orphanedThreads,
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
    const built = await buildChapterLedger(context.bookDir, { ...args, now: context.now, origin: "commit" });
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
        recorded: built.ledger.entries.length,
        rejected: built.rejected,
        recommitted: built.previous !== undefined,
        orphanedThreads: built.orphanedThreads,
      },
    };
  },
};
