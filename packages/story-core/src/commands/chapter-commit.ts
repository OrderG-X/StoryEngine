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
 * 东西（P3b 设计 2.4、3.3）：东西条目（含主体是东西的事实）有没收的，这章东西那类就算没记全（partial，missingKinds 含 item）；
 * 上次头回写到的东西这次没认上、后文还用着它的，结果里如实列出。
 */
import { z } from "zod";
import { EntryInput, EntryKind, ItemRefInput, itemRefsOf, threadOf, type ChapterLedger, type LedgerStatus } from "../schema/ledger.js";
import { chapterSource, newLedger, storeEntry } from "../ledger/entries.js";
import { assignIds, previousOf } from "../ledger/identity.js";
import { readAllLedgers, readCards, readChapterLedgerFile, readDecisions, sha256 } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath } from "../store/paths.js";
import { project } from "../projection/project.js";
import { checkEntries, itemRefsOfInput, type RejectedEntry } from "../review/check.js";
import { fail } from "./runner.js";
import type { CommandFailure, WriteCommandSpec } from "./types.js";

const reasonCode = z.string().regex(/^[a-z][a-z0-9_]*$/u);

/**
 * 账没记全时交的：pending = 账待记（条目必须空）；partial = 记账员有一步没成、记了一部分。原因用代码。
 * missingKinds（partial）：哪几类因此没记全；不给 = 不知道缺哪类，读的时候当全部没记全（missingKindsOf）。
 * missingItems（缺东西那类时）：只缺这几样（没记上的条目都认得出指哪几样）；不给 = 整章东西当没记全（itemGapOf）。
 */
export const LedgerShortfall = z.object({
  status: z.enum(["pending", "partial"]),
  reasonCodes: z.array(reasonCode).min(1),
  missingKinds: z.array(EntryKind).min(1).optional(),
  missingItems: z.array(ItemRefInput).optional(),
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
  /** 重定稿后这章上次头回写到、这次没认上，后文还用着的东西名字（后文接着它的现在没有出处，要作者看）。 */
  readonly orphanedItems: readonly string[];
}

/** 一章新账单拼好了（还没写盘）。 */
export interface BuiltChapterLedger {
  readonly ok: true;
  readonly ledger: ChapterLedger;
  readonly rejected: ChapterCommitResult["rejected"];
  readonly previous: ChapterLedger | undefined;
  readonly orphanedThreads: readonly string[];
  readonly orphanedItems: readonly string[];
  /** 记上的条数（一条声明算一条：时间存成几条也算一条）。 */
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
  const [ledgers, decisions, file, cards] = await Promise.all([
    readAllLedgers(bookDir),
    readDecisions(bookDir),
    readChapterLedgerFile(bookDir, input.chapter),
    readCards(bookDir),
  ]);
  const previous = file?.ledger;
  const before = project({ ledgers: ledgers.filter((ledger) => ledger.chapter < input.chapter), decisions, ...(cards ? { cards } : {}) });
  const checked = pending ? { accepted: [], rejected: [] } : checkEntries(input.entries, input.text, before);
  const accepted = checked.accepted.map((item) => item.entry);
  const source = chapterSource(input.chapter, input.text);
  const assigned = assignIds(input.chapter, previous, accepted);
  const stored = accepted.map((entry, index) => storeEntry(entry, assigned.ids[index]!, source));
  const entries = stored.flatMap((item) => item.entries);
  const scenes = stored.flatMap((item) => item.scenes);
  const carried = previousOf(previous, file?.sha256);
  // 东西条目有没收的：这章东西那类没记全（引用它的、按它算的去向都可能缺），不当记全了；带东西的事实没收再缺事实。
  const itemMissing = new Set<"item" | "fact">();
  for (const { entry } of checked.rejected) {
    if (entry.kind === "item") itemMissing.add("item");
    if (entry.kind === "fact" && entry.item !== undefined) itemMissing.add("item").add("fact");
  }
  const shortfall = itemShortfall(input.shortfall, [...itemMissing], missingItemRefs(checked.rejected.map((item) => item.entry)));
  const missingItems = shortfall?.status === "partial" && shortfall.missingKinds?.includes("item") ? storedMissingItems(shortfall.missingItems, assigned.itemTags, input.entries) : undefined;

  const ledger = newLedger({
    chapter: input.chapter,
    textSha256: sha256(input.text),
    committedAt: input.committedAt ?? input.now.toISOString(),
    origin: input.origin,
    entries,
    scenes,
    status: shortfall?.status ?? "ready",
    coverage: {
      rejectedCount: checked.rejected.length,
      reasonCodes: [...(shortfall?.reasonCodes ?? [])],
      ...(shortfall?.status === "partial" && shortfall.missingKinds ? { missingKinds: [...new Set(shortfall.missingKinds)] } : {}),
      ...(missingItems ? { missingItems } : {}),
    },
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

  // 上次头回写到的东西这次没认上，后文还用着它（任何位置）：如实列出来。
  const lostItems = new Set(assigned.droppedItems.map((entry) => entry.itemRef.id));
  const orphanedItems: string[] = [];
  if (lostItems.size > 0) {
    const used = new Set<string>();
    for (const later of ledgers) {
      if (later.chapter <= input.chapter) continue;
      for (const entry of later.entries) {
        if (entry.kind === "item") for (const { ref } of itemRefsOf(entry)) if (lostItems.has(ref.id)) used.add(ref.id);
        if (entry.kind === "fact" && entry.subjectRef?.id !== undefined && lostItems.has(entry.subjectRef.id)) used.add(entry.subjectRef.id);
      }
    }
    for (const entry of assigned.droppedItems) if (used.has(entry.itemRef.id)) orphanedItems.push(entry.itemRef.mention ?? "");
  }

  return {
    ok: true,
    ledger: ledger.data,
    rejected: checked.rejected.map(({ index, reason, message }) => ({ index, reason, message })),
    previous,
    orphanedThreads,
    orphanedItems,
    recorded: checked.accepted.length,
  };
}

/**
 * 东西条目有没收的时这章记到什么程度：本来记全了 → 没记全、缺这几类；本来就没记全且写明了缺哪几类 → 加上这几类；
 * 没写明缺哪几类（当全部）、账待记的照旧。items：缺东西那类时只缺这几样（不给 = 整章东西），和原来写明的合起来，有一边是整章就是整章。
 */
export function itemShortfall(shortfall: LedgerShortfall | undefined, missing: readonly EntryKind[], items?: readonly ItemRefInput[]): LedgerShortfall | undefined {
  if (missing.length === 0) return shortfall;
  if (shortfall?.status === "pending" || (shortfall && !shortfall.missingKinds)) return shortfall;
  const had = shortfall?.missingKinds?.includes("item") === true;
  const before = had ? (shortfall?.missingItems ?? "all") : [];
  const adding = missing.includes("item") ? (items ?? "all") : [];
  const scope = before === "all" || adding === "all" ? undefined : [...before, ...adding];
  const kinds = [...new Set([...(shortfall?.missingKinds ?? []), ...missing])];
  return {
    status: "partial",
    reasonCodes: [...new Set([...(shortfall?.reasonCodes ?? []), "item_rejected"])],
    missingKinds: kinds,
    ...(scope && kinds.includes("item") ? { missingItems: scope } : {}),
  };
}

/**
 * 没记上的这几条缺的是哪几样东西（P3b 设计 2.4）：每条都认得出指哪几样 → 那几样（本章新写到、没认上的那样不算：它没进账，别的东西不受影响）；
 * 有一条说不出指哪样 → undefined（整章东西当没记全）。不是东西、不带东西的条目不算。
 */
export function missingItemRefs(entries: readonly EntryInput[]): ItemRefInput[] | undefined {
  const out: ItemRefInput[] = [];
  for (const entry of entries) {
    if (entry.kind === "item" && entry.op === "appear") continue;
    if (entry.kind !== "item" && !(entry.kind === "fact" && entry.item)) continue;
    const refs = itemRefsOfInput(entry);
    if (refs.length === 0) return undefined;
    for (const ref of refs) out.push("id" in ref ? { id: ref.id } : { tag: ref.tag });
  }
  return out;
}

/**
 * 只缺哪几样落到账上的编号：本批标签换成发的号；标签是本批写到、没认上的那样 → 不算（它没进账）；
 * 标签本批没写到（说不出指哪样）→ undefined（整章东西当没记全）。前文的编号原样存，读的时候认不得同样当整章。
 */
function storedMissingItems(refs: readonly ItemRefInput[] | undefined, itemTags: ReadonlyMap<string, string>, entries: readonly EntryInput[]): string[] | undefined {
  if (!refs) return undefined;
  const declared = new Set(entries.flatMap((entry) => (entry.kind === "item" && entry.op === "appear" && entry.tag ? [entry.tag] : [])));
  const out = new Set<string>();
  for (const ref of refs) {
    if ("id" in ref) out.add(ref.id);
    else if (itemTags.has(ref.tag)) out.add(itemTags.get(ref.tag) as string);
    else if (!declared.has(ref.tag)) return undefined;
  }
  return [...out].sort();
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
        orphanedItems: built.orphanedItems,
      },
    };
  },
};
