/**
 * 定稿编排（重构 P3；写作版本 P2a 片 4A 起是执行器 commit.prepare 的两步，配方在 services/operations/recipes/commit-prepare.ts）：
 *
 *   prepareChapterCommit：读真相 → 投影（算到上一章）→ 记账员交账单 → checkEntries 核原句 → classifyForReview 分流
 *                         → 返回清单（要你看的 / 自动记下的 / 没记上的 / 这章的时间）+ 预览票（条目、正文指纹、依据；存在操作的检查点里）
 *   commitEntriesOf：照票减掉作者去掉的、加上作者改的天数（和记账员记的时间并存，写作版本 P3 设计 2.5）→ 交给「定稿」命令的条目（配方带着预览时的依据交命令：
 *                    预览之后前面的章、账、设定、裁定有一样变了，核心不写、如实说哪里变了）
 *
 * 一次定稿只调一次模型（补笔记另算）；确认时不再调模型。清单上给人看的只有名字、标题、原句，不带任何编号。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  boundaryText,
  chapterSource,
  chapterTextPath,
  checkEntries,
  classifyForReview,
  declarationOf,
  declarationsOf,
  knownEntries,
  ledgerOf,
  locateQuote,
  nameKey,
  offsetText,
  presenceName,
  project,
  readBookSnapshot,
  relativeDaysText,
  segmentText,
  sha256,
  threadOf,
  TIME_MODEL,
  timelineTable,
  timeRoleOf,
  type BookProjection,
  type BookSnapshot,
  type ChapterLedger,
  type ClassifiedEntry,
  type DayInput,
  type DayRange,
  type EntryInput,
  type EntryKind,
  type LedgerEntry,
  type ReviewReason,
  type LedgerScene,
  type ThreadInput,
  type TimeConflictView,
  type TimeInput,
  type TimelineRow,
  type TimeOffset,
  type TruthBasis,
} from "@actalk/story-core";
import type { KeeperDrop } from "./keeper-parse.js";
import { runLedgerKeeper, type QuoteRepair } from "./ledger-keeper.js";
import type { ReaderWaited } from "./reader-progress.js";
import type { BrainCallModel, ColdCoverage } from "./reader-window.js";

// —— 预览票 ——

/**
 * 预览票认的正文指纹：换行统一、行尾空白去掉、连续空行并成一个后的 sha256。
 * 稿纸重新载入时会把多余的空段落收掉再存一遍（字一个没动），不能因为这个就让作者重新预览。
 */
export function draftFingerprint(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd());
  return sha256(lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim());
}

/** 预览票：定稿要记的条目和预览时的样子（存在 commit.prepare 那一步的检查点里，作者点「确认定稿」时照它定）。 */
export interface PreviewTicket {
  readonly chapter: number;
  /** 预览时正文的指纹（见 draftFingerprint）。 */
  readonly textSha256: string;
  /** 核过的条目（清单上的序号 = 这里的下标）。 */
  readonly entries: readonly EntryInput[];
  /** 要作者看的条目下标。 */
  readonly reviewIndexes: readonly number[];
  /** 默认不写、作者勾上才写的条目下标（和前文不会变的事实对不上、要推翻前文不会变的事实）。 */
  readonly optInIndexes: readonly number[];
  /** 预览时读到的真相：条目、天数都是照它算的。 */
  readonly basis: TruthBasis;
  readonly createdAt: string;
}

// —— 清单 ——

export interface CommitItem {
  /** 清单上的序号（作者去掉某条时回传它）。 */
  readonly index: number;
  readonly kind: EntryInput["kind"];
  /** 一行说明：只有名字、标题、内容，不带编号。 */
  readonly label: string;
  /** 原句。 */
  readonly quote?: string;
  /** 为什么要你看（自动记下的为空）。 */
  readonly reasons: readonly { readonly code: ReviewReason; readonly text: string }[];
  /** 默认不写，作者勾上才写：会改掉前文「不会变」的事实，不能默认替作者改；重定稿时收掉后文还在接着的线索。 */
  readonly optIn: boolean;
  /** 并进这一行的其余序号（同一句说明推进几条线索，清单上只列一行；去掉这行就一起去掉）。 */
  readonly merged?: readonly number[];
}

export interface NotRecorded {
  /** quote_not_in_text / unknown_thread / unknown_fact / shape / duplicate（核对没过），parse（记账员交的格式不对），adjusted（改过）。 */
  readonly code: string;
  readonly label: string;
  readonly reason: string;
}

export interface CommitPreview {
  readonly ok: true;
  readonly ticket: PreviewTicket;
  readonly chapter: number;
  /** 这章原来有记了条目的账，这次会换掉（原来是账待记的不算）。 */
  readonly recommit: boolean;
  readonly review: readonly CommitItem[];
  readonly auto: readonly CommitItem[];
  /** 没记上的：原句对不上、指向前文没有的、记账员交的格式不对的。 */
  readonly notRecorded: readonly NotRecorded[];
  /** 记上了但改过的（比如缺字段的事实按「发生过的事」记）。 */
  readonly adjusted: readonly NotRecorded[];
  readonly time: PreviewTime;
  /** 重定稿：这章上次开的、后文还接着的线索，这次没记上、上次的原句也没了（定稿后它们没了开头）。 */
  readonly lostThreads?: readonly string[];
  readonly omittedThreads: number;
  readonly omittedFacts: number;
  /** 第一遍有原句对不上、请记账员重摘过一次（几条、救回几条）。 */
  readonly quoteRepair?: QuoteRepair;
  /** 补摘那一步没成、因此没记上的条目是哪几类（定稿时账记成「没记全」、写明缺这几类）；没成却一条都没拒 = 不给，当全部没记全。 */
  readonly missingKinds?: readonly EntryKind[];
  readonly cold?: ColdCoverage;
  readonly waited?: ReaderWaited;
}

/** 定稿后这一章的时间（清单最前那一行）。 */
export interface PreviewTime {
  /** 和时间表同一行：开头、结尾第几天（区间；不知道就没有）、离上一个当下章多久、星期、时段、依据（带上已有的作者裁定，T7）。 */
  readonly row: TimelineRow;
  /** 记账员记上了这章的时间（没记上 = 正文里没认出时间）。 */
  readonly recorded: boolean;
  /** 记账员这次怎么判的本章开头：正文明写 / 按前后文判断（没写开头、说不出就没有）。 */
  readonly declared?: "text" | "judged";
  /** 本章不在当下线上的段（清单上一行）：说法 + 首句。 */
  readonly segments: readonly { readonly text: string; readonly quote: string }[];
  /** 要作者看：没记上时间、是哪天不知道、和上次定稿不一样、和作者定的对不上。 */
  readonly needsConfirm: boolean;
  /**
   * 重定稿、这次的天数和上次定稿记的不一样（一样、有一边不知道就没有）。
   * kept：上次那条时间的原句还在正文里，照上次的记，other 是记账员这次看成的；
   * 没 kept：那句改没了，按这次的记，other 是上次定稿记的。
   */
  readonly sinceLast?: { readonly kept: boolean; readonly other: { readonly start?: DayRange; readonly end?: DayRange } };
  /** 作者定的天数和记账员记的对不上（设计 2.5，只说两边不能同时成立，不判谁对）。 */
  readonly conflicts: readonly Pick<TimeConflictView, "kind" | "authorDay" | "expected">[];
}

export type PrepareFailureCode = "book_unsettled" | "basis_changed" | "not_imported" | "chapter_gap" | "keeper_failed" | "empty_text";

export interface PrepareFailure {
  readonly ok: false;
  readonly code: PrepareFailureCode;
  readonly reason: string;
  readonly cold?: ColdCoverage;
  readonly waited?: ReaderWaited;
}

const KIND_LABELS: Record<string, string> = { summary: "梗概", time: "时间", presence: "出场人物", facts: "事实", threads: "线索" };
const THREAD_TYPE_LABELS = { question: "悬念", intent: "打算", goal: "目标" } as const;
const NATURE_LABELS = { hard: "不会变", state: "会变", event: "发生过的事" } as const;

/** 「facts 第 3 条」→「一条事实」；认得出是哪条的带上名字：「线索「谁在敲门」」。 */
function dropLabel(drop: KeeperDrop): string {
  const head = drop.where.split(/[ .]/u)[0] ?? "";
  const kind = KIND_LABELS[head] ?? "记录";
  return drop.name ? `${kind}「${drop.name}」` : `一条${kind}`;
}

/** 名字 → 投影里的主体键（别称归到已确立名字）。 */
function subjectResolver(before: BookProjection): (name: string) => string {
  const aliasToKey = new Map<string, string>();
  for (const member of before.cast) {
    aliasToKey.set(member.key, member.key);
    for (const alias of member.aliases) aliasToKey.set(nameKey(alias), member.key);
  }
  return (name) => aliasToKey.get(nameKey(name)) ?? nameKey(name);
}

/** 一处相对的说法：按天说的「过了 1 天」「往回 2 天」；按月、年的原样；看换天规矩才定的两种都说。 */
function relativeText(value: { readonly offset?: TimeOffset; readonly byBoundary?: Parameters<typeof boundaryText>[0] }): string {
  if (value.byBoundary) return boundaryText(value.byBoundary);
  if (!value.offset) return "说不准";
  return value.offset.unit === "day" ? relativeDaysText({ lo: value.offset.min, hi: value.offset.max }) : offsetText(value.offset);
}

/** 记账员记的这一章的时间（清单「没记上的」那几行用；天数那一行看 PreviewTime）。 */
function timeEntryLabel(entry: TimeInput): string {
  const parts: string[] = [];
  if (entry.start === undefined) parts.push("整章不在当下线上");
  else if (entry.start === "unknown") parts.push("离上一个当下章多久说不准");
  else parts.push(`离上一个当下章${relativeText(entry.start)}${entry.start.basis === "text" ? "（正文明写）" : "（按前后文判断）"}`);
  if (entry.sameDay) parts.push("本章同一天");
  if (entry.dayChanges?.length) parts.push(`本章里换了 ${entry.dayChanges.length} 次天`);
  if (entry.start !== undefined && entry.segments?.length) parts.push(`${entry.segments.length} 段不在当下`);
  if (entry.timeOfDay) parts.push(entry.timeOfDay);
  return parts.join("，");
}

const dayInputText = (entry: DayInput): string =>
  entry.dayEnd !== undefined && entry.dayEnd > entry.day ? `故事第 ${entry.day} 天到第 ${entry.dayEnd} 天` : `故事第 ${entry.day} 天`;

function entryLabel(entry: EntryInput, before: BookProjection): string {
  switch (entry.kind) {
    case "summary":
      return `梗概：${entry.text}`;
    case "time":
      return `时间：${timeEntryLabel(entry)}`;
    case "day":
      return `你定的天数：${dayInputText(entry)}`;
    case "presence": {
      const alias = nameKey(entry.name) === nameKey(entry.nameUsed) ? "" : `（正文叫「${entry.nameUsed}」）`;
      return `出场：${entry.name}${alias}${entry.viewpoint ? "，视角人物" : ""}`;
    }
    case "fact":
      // 人物嘴里说的单独标出来：不顶替现状，作者一眼看得出（设计第 3 节）。
      return entry.source?.kind === "character_claim"
        ? `事实（${entry.source.speaker ?? "人物"}说的）：${entry.text}`
        : `事实（${NATURE_LABELS[entry.nature]}）：${entry.text}`;
    case "thread": {
      if (entry.op === "open") return `新开${THREAD_TYPE_LABELS[entry.type ?? "question"]}：${entry.title ?? entry.note}`;
      return `${entry.op === "close" ? "收口" : "推进"}「${threadTitle(entry, before)}」：${entry.note}`;
    }
  }
}

/** 清单上那一行给的原句：时间给开头那句（没写开头、说不出就没有）。 */
function entryQuote(entry: EntryInput): string | undefined {
  if (entry.kind === "time") return entry.start && entry.start !== "unknown" ? entry.start.quote || undefined : undefined;
  return "quote" in entry && entry.quote ? entry.quote : undefined;
}

function threadTitle(entry: ThreadInput, before: BookProjection): string {
  return before.threads.find((thread) => thread.id === entry.thread || thread.mergedFrom.includes(entry.thread ?? ""))?.title ?? "一条线索";
}

/**
 * 自动记下的推进 / 收口：记账员一条写了几条线索，同一句说明拆成几行、清单上一字不差连出两三遍
 * （换题材长篇实跑：前 21 章里 7 章这样）。同一动作、同一说明、同一原句的并成一行，标题并排列。
 */
function mergeSameNote(items: readonly ClassifiedEntry[], toItem: (item: ClassifiedEntry) => CommitItem, before: BookProjection): CommitItem[] {
  const rows: { item: CommitItem; entry: ClassifiedEntry["entry"]; titles: string[]; merged: number[] }[] = [];
  const byNote = new Map<string, (typeof rows)[number]>();
  for (const classified of items) {
    const item = toItem(classified);
    const { entry } = classified;
    if (entry.kind !== "thread" || entry.op === "open" || item.optIn) {
      rows.push({ item, entry, titles: [], merged: [] });
      continue;
    }
    const key = [entry.op, entry.note, entry.quote].join("\u0000");
    const title = threadTitle(entry, before);
    const row = byNote.get(key);
    if (row) {
      if (!row.titles.includes(title)) row.titles.push(title);
      row.merged.push(item.index);
      continue;
    }
    const fresh = { item, entry, titles: [title], merged: [] };
    byNote.set(key, fresh);
    rows.push(fresh);
  }
  return rows.map(({ item, entry, titles, merged }) => {
    if (merged.length === 0 || entry.kind !== "thread") return item;
    const label = `${entry.op === "close" ? "收口" : "推进"}${titles.map((title) => `「${title}」`).join("")}：${entry.note}`;
    return { ...item, label, merged };
  });
}

function reasonTexts(
  item: ClassifiedEntry,
  before: BookProjection,
  resolve: (name: string) => string,
  later: ReadonlyMap<string, readonly number[]> = new Map(),
): CommitItem["reasons"] {
  const { entry } = item;
  return item.reasons.map((code) => {
    switch (code) {
      case "hard-conflict": {
        if (entry.kind !== "fact") return { code, text: "和前文对不上" };
        const key = resolve(entry.subject ?? "");
        const earlier = before.facts.find(
          (fact) => fact.nature === "hard" && fact.status === "current" && fact.subjectKey === key && fact.attributeKey === nameKey(entry.attribute ?? ""),
        );
        return { code, text: earlier ? `和前文对不上：第 ${earlier.chapter} 章记的是「${earlier.text}」` : "和前文对不上" };
      }
      case "replaces-fact": {
        if (entry.kind !== "fact") return { code, text: "推翻了前文的一条事实" };
        const old = (entry.replaces ?? []).map((id) => before.facts.find((fact) => fact.id === id)).filter((fact) => fact !== undefined);
        const list = old.map((fact) => `第 ${fact.chapter} 章「${fact.text}」`).join("、");
        return { code, text: list ? `推翻前文：${list}` : "推翻了前文的一条事实" };
      }
      case "closes-thread": {
        const after = entry.kind === "thread" ? later.get(entry.thread ?? "") : undefined;
        return after
          ? { code, text: `后文第 ${after.join("、")} 章还在接着这条：这里收了，后面就接不上，默认不记` }
          : { code, text: "收掉这条线索后，它就不再提醒了" };
      }
      case "new-character":
        return { code, text: "第一次出场的人物；要是已有人物的新称呼，去掉这条告诉我是谁" };
    }
  });
}

/**
 * 重定稿时，后文哪几章还在接着哪条线索（推进、收口）。换题材长篇实跑 2026-10-28：第 4 章改一个词重定稿，
 * 记账员把第 5～11 章还在推进的「算清欠债」报成了收口——照记的话这条在第 4 章就收了，后面那几章接不上。
 */
function laterThreadTouches(ledgers: readonly ChapterLedger[], chapter: number): ReadonlyMap<string, readonly number[]> {
  const out = new Map<string, number[]>();
  for (const ledger of [...ledgers].sort((a, b) => a.chapter - b.chapter)) {
    if (ledger.chapter <= chapter) continue;
    for (const entry of ledger.entries) {
      if (entry.kind !== "thread" || entry.op === "open") continue;
      const chapters = out.get(threadOf(entry)) ?? [];
      if (!chapters.includes(ledger.chapter)) chapters.push(ledger.chapter);
      out.set(threadOf(entry), chapters);
    }
  }
  return out;
}

/** 收口的线索后文还在接着：默认不记，作者勾上才记。 */
function closesLaterThread(item: ClassifiedEntry, later: ReadonlyMap<string, readonly number[]>): boolean {
  return item.entry.kind === "thread" && item.entry.op === "close" && later.has(item.entry.thread ?? "");
}

/** 会改掉前文「不会变」的事实：和它对不上，或者明写要推翻它（定稿时默认不写、要作者勾；通读记账不写）。 */
export function touchesHardFact(item: ClassifiedEntry, before: BookProjection): boolean {
  if (item.reasons.includes("hard-conflict")) return true;
  if (!item.reasons.includes("replaces-fact") || item.entry.kind !== "fact") return false;
  return (item.entry.replaces ?? []).some((id) => before.facts.find((fact) => fact.id === id)?.nature === "hard");
}

type Truth = Pick<BookSnapshot, "ledgers" | "decisions" | "cards">;

/**
 * 用核过的条目拼一份临时账单，算出「定稿后」这一章的时间（只用来展示）：带上已有的作者裁定和换天规矩（T7），
 * 和定稿后时间表、概况上那一行是同一个算法。
 */
function previewTime(truth: Truth, chapter: number, entries: readonly EntryInput[], text: string): { readonly row: TimelineRow; readonly conflicts: PreviewTime["conflicts"]; readonly segments: readonly string[] } | undefined {
  const draft = ledgerOf({
    chapter,
    text,
    entries: entries.map((entry, index) =>
      entry.kind === "thread" && entry.op === "open" ? { ...entry, id: `preview-${index}`, thread: `preview-t${index}` } : { ...entry, id: `preview-${index}` },
    ),
  });
  const after = project({ ledgers: [...truth.ledgers.filter((ledger) => ledger.chapter < chapter), draft], decisions: truth.decisions, cards: truth.cards }, { upTo: chapter });
  const row = timelineTable(after, chapter).find((item) => item.chapter === chapter);
  if (!row) return undefined;
  const conflicts = after.timeConflicts.filter((conflict) => conflict.chapter === chapter).map(({ kind, authorDay, expected }) => ({ kind, authorDay, expected }));
  return { row, conflicts, segments: row.segments };
}

const sameRange = (a: DayRange | undefined, b: DayRange | undefined): boolean => a?.lo === b?.lo && a?.hi === b?.hi;
const known = (range: DayRange | undefined): boolean => range !== undefined && (range.lo !== undefined || range.hi !== undefined);

type Accepted = ReturnType<typeof checkEntries>["accepted"];
type Rejected = ReturnType<typeof checkEntries>["rejected"];

/**
 * 重定稿时这章上次开的线索别丢（作者长篇实跑 2026-10-27：第 5 章改错字重定稿，记账员把本章开的「刀疤军官为何放行」
 * 报成了推进，核不上被拒；照这样定稿，它就没了开头，第 45 章的收口接不上）。
 * 这次没记成本章开的：记账员这次还提到它（推进、收口）就按它这次说的记成开；没提、但后文接着它，上次那条原句还在就照上次的开；
 * 原句也没了，如实告诉作者。
 */
function keepLastOpens(
  ledgers: readonly ChapterLedger[],
  chapter: number,
  previous: readonly LedgerEntry[],
  checked: { readonly accepted: Accepted; readonly rejected: Rejected },
  text: string,
  before: BookProjection,
): { readonly accepted: Accepted; readonly rejected: Rejected; readonly lost: readonly string[] } {
  const lastOpens = previous.flatMap((entry) => (entry.kind === "thread" && entry.op === "open" ? [entry] : []));
  // 这次沿用了哪些：和核心分编号同一个口径，只认记账员写明的旧线索号（标题、原句一样都不算，P2b 出口复核第 1 条）。
  const covered = new Set<string>();
  for (const { entry } of checked.accepted) {
    if (entry.kind === "thread" && entry.op === "open" && entry.thread) covered.add(entry.thread);
  }
  const later = new Set(ledgers
    .filter((ledger) => ledger.chapter > chapter)
    .flatMap((ledger) => ledger.entries.flatMap((entry) => (entry.kind === "thread" ? [threadOf(entry)] : []))));
  let nextIndex = Math.max(-1, ...checked.accepted.map((item) => item.index), ...checked.rejected.map((item) => item.index)) + 1;
  const accepted = [...checked.accepted];
  const folded = new Set<Rejected[number]>();
  const lost: string[] = [];
  for (const last of lastOpens) {
    const lastThread = threadOf(last);
    if (covered.has(lastThread)) continue;
    const mentions = checked.rejected.filter((item) => item.entry.kind === "thread" && item.entry.op !== "open" && item.entry.thread === lastThread);
    const title = last.title ?? last.note;
    const lastDeclared = declarationOf(last);
    const candidates: EntryInput[] = [
      ...mentions.flatMap((item) => (item.entry.kind === "thread"
        ? [{ kind: "thread", review: "auto", op: "open", type: last.type ?? "question", title, note: item.entry.note, quote: item.entry.quote, thread: lastThread } satisfies ThreadInput]
        : [])),
      ...((mentions.length > 0 || later.has(lastThread)) && lastDeclared ? [lastDeclared] : []),
    ];
    const reopened = candidates.map((entry) => checkEntries([entry], text, before).accepted[0]?.entry).find((entry) => entry !== undefined);
    if (reopened) {
      accepted.push({ index: nextIndex++, entry: reopened });
      for (const item of mentions) folded.add(item);
    } else if (later.has(lastThread)) {
      lost.push(title);
    }
  }
  return { accepted, rejected: checked.rejected.filter((item) => !folded.has(item)), lost };
}

/** 时间声明里的原句：开头那句、换天那句、段的首末句。 */
function timeQuotes(time: TimeInput): string[] {
  return [
    ...(time.start && time.start !== "unknown" ? [time.start.quote] : []),
    ...(time.dayChanges ?? []).flatMap((change) => (change.quote ? [change.quote] : [])),
    ...(time.segments ?? []).flatMap((segment) => [segment.firstQuote, segment.lastQuote]),
  ];
}

/** 这句原句落在的整句（一句或几句连着）：找不到、不止一处就没有。 */
function wholeSentences(quote: string, text: string): string | undefined {
  const source = chapterSource(0, text);
  const at = locateQuote(quote, source)?.units;
  if (!at) return undefined;
  return source.units.filter((unit) => unit.id >= at.from && unit.id <= at.to).map((unit) => text.slice(unit.start, unit.end)).join("");
}

/**
 * 重定稿时天数照上次定稿的记（作者长篇实跑 2026-10-27：第 5 章改一个错字重定稿，记账员这次把第二天清早看成当天，
 * 第 6～7 天成了第 5～6 天，后面 45 章跟着挪一天，清单上只露出这一章的天数）。
 * 上次那条时间的原句（开头那句、换天那句、段的首末句）所在的整句都没改就照上次的；和这次看的不一样时两边都给作者看，作者改天数照旧管用。
 * 比整句、不只看原句还在不在（P3a 改早章：作者在「这天下午，……」前面加了「过了两天，」，原句还在，天数却照上次的没挪）；
 * 上次定稿的正文读不到、对不上账单时只看原句还在不在。
 */
function keepLastDay(
  truth: Truth,
  chapter: number,
  previous: PreviousRecord,
  accepted: Accepted,
  text: string,
  before: BookProjection,
  lastText: string | undefined,
): { readonly accepted: Accepted; readonly sinceLast: NonNullable<PreviewTime["sinceLast"]> } | undefined {
  const last = previewTime(truth, chapter, declarationsOf(previous), text)?.row;
  const now = previewTime(truth, chapter, accepted.map((item) => item.entry), text)?.row;
  // 有一边是哪天不知道（前面有章账待记、说不准）：没得比，照这次的记。
  if (!last || !now || !known(last.start) || !known(now.start)) return undefined;
  if (sameRange(last.start, now.start) && sameRange(last.end, now.end)) return undefined;
  const lastTime = declarationsOf(previous).find((entry) => entry.kind === "time");
  const unchanged = lastTime?.kind === "time" && (lastText === undefined || timeQuotes(lastTime).every((quote) => {
    const was = wholeSentences(quote, lastText);
    return was !== undefined && was === wholeSentences(quote, text);
  }));
  const carried = lastTime && unchanged ? checkEntries([lastTime], text, before).accepted[0]?.entry : undefined;
  const other = (row: TimelineRow) => ({ ...(row.start ? { start: row.start } : {}), ...(row.end ? { end: row.end } : {}) });
  if (!carried) return { accepted, sinceLast: { kept: false, other: other(last) } };
  const at = accepted.findIndex((item) => item.entry.kind === "time");
  const next = at >= 0
    ? accepted.map((item, index) => (index === at ? { index: item.index, entry: carried } : item))
    : [...accepted, { index: Math.max(-1, ...accepted.map((item) => item.index)) + 1, entry: carried }];
  return { accepted: next, sinceLast: { kept: true, other: other(now) } };
}

/** 重定稿时作者上次在清单上定的天数照留（作者的，不是记账员的；记账员这次记的照样记，对不上由投影列出来）。 */
function keepAuthorDay(previous: PreviousRecord, accepted: Accepted): Accepted {
  const authorDay = declarationsOf(previous).find((entry): entry is DayInput & { id: string } => entry.kind === "day");
  if (!authorDay || accepted.some((item) => item.entry.kind === "day")) return accepted;
  const { id: _id, ...entry } = authorDay;
  return [...accepted, { index: Math.max(-1, ...accepted.map((item) => item.index)) + 1, entry }];
}

export interface PrepareInput {
  readonly bookDir: string;
  readonly chapter: number;
  /** 要定稿的完整正文（含标题行）。 */
  readonly text: string;
  readonly callModel: BrainCallModel;
  /**
   * 调用方读字数下限、人物名单这些材料之前取的依据（book/truth-basis.ts，第 8 轮复核 V4），记进票里。
   * 这里读到的真相和它对不上（取完之后书上有写）就不出票，请调用方重新预览。
   */
  readonly basis: TruthBasis;
  /** 设定卡上已有的人名（还没在账单里出场过的也算认识，不当新面孔）。 */
  readonly knownNames?: readonly string[];
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 补笔记时当场最多新生成几个卷节点（缺省不限）。 */
  readonly maxVolumeBuilds?: number;
  /** 记账员原始输出（考卷、排查用）。 */
  readonly onRawOutput?: (text: string) => void;
  readonly now?: () => Date;
}

/** 这章上次记下的（条目，和读回时间声明要的段、时间格式）。 */
interface PreviousRecord {
  readonly entries: readonly LedgerEntry[];
  readonly scenes?: readonly LedgerScene[];
  readonly timeModel?: typeof TIME_MODEL;
  /** 上次记账员记的时间读得全（老的账待记 carry 没带那套时间：只有作者定的天数）。 */
  readonly timeComplete: boolean;
}

/**
 * 这章上次记下的条目（沿用线索、天数、认过的人都照它）。账待记的那份是空的：照它带着的 carry 里最近那版
 * （carry 里上一份账单的条目排在前面；梗概只留最前那条）。
 * 时间照 carry 带的最近那套（作者定的天数、记账员的时间、段、格式原样，出口复核 R6；作者定的天数是最近那次整套的，
 * 见核心 carriedTime）。老账的 carry 没带那套：记账员的时间读不全，只留作者定的天数（认得的条目里每头排最前的那条；
 * 按 P3 的读法：作者给了结尾才有结尾），时间不拿来比（见 prepareChapterCommit）。
 */
function lastRecorded(ledger: ChapterLedger | undefined): PreviousRecord {
  if (!ledger) return { entries: [], timeComplete: true };
  if (ledger.status !== "pending") return { entries: ledger.entries, scenes: ledger.scenes, ...(ledger.timeModel ? { timeModel: ledger.timeModel } : {}), timeComplete: true };
  const time = ledger.previous?.carry.time;
  const authorRoles = new Set<string>();
  let summary = false;
  const entries = knownEntries(ledger).filter((entry) => {
    if (entry.kind === "time") {
      if (time || entry.relation !== "at") return false;
      const role = timeRoleOf(entry);
      if (authorRoles.has(role)) return false;
      authorRoles.add(role);
      return true;
    }
    if (entry.kind !== "summary") return true;
    if (summary) return false;
    summary = true;
    return true;
  });
  if (!time) return { entries, timeModel: TIME_MODEL, timeComplete: false };
  return { entries: [...entries, ...time.entries], scenes: time.scenes, ...(time.timeModel ? { timeModel: time.timeModel } : {}), timeComplete: true };
}

/** 上次定稿的正文（盘上那份，和账单记的哈希对得上才算）。 */
async function committedText(bookDir: string, ledger: ChapterLedger | undefined): Promise<string | undefined> {
  if (!ledger) return undefined;
  const text = await readFile(join(bookDir, chapterTextPath(ledger.chapter)), "utf-8").catch(() => undefined);
  return text !== undefined && sha256(text) === ledger.textSha256 ? text : undefined;
}

export async function prepareChapterCommit(input: PrepareInput): Promise<CommitPreview | PrepareFailure> {
  if (input.text.trim().length === 0) return { ok: false, code: "empty_text", reason: "正文是空的，没有可定稿的" };
  const snapshot = await readBookSnapshot(input.bookDir);
  if (snapshot.unsettled) return { ok: false, code: "book_unsettled", reason: "这本书正在写盘，稍等几秒再定稿" };
  if (snapshot.basis.digest !== input.basis.digest) return { ok: false, code: "basis_changed", reason: "预览的途中书里有地方改过，请重新预览一次" };
  const committed = snapshot.ledgers.map((ledger) => ledger.chapter);
  // 有定稿正文却一份账单都没有 = 老书还没导入：先导入，不然导入会因为「已经有账单」做不了。
  if (committed.length === 0 && snapshot.textHashes.size > 0) {
    return { ok: false, code: "not_imported", reason: "这本书的账还没导进新格式，先导入再定稿" };
  }
  const last = committed.length > 0 ? Math.max(...committed) : 0;
  if (input.chapter > last + 1) {
    const gap = last + 1 === input.chapter - 1 ? `第 ${last + 1} 章` : `第 ${last + 1} 章到第 ${input.chapter - 1} 章`;
    return { ok: false, code: "chapter_gap", reason: `${gap}还没定稿，先定稿前面的章` };
  }
  const before = project(snapshot, { upTo: input.chapter - 1 });
  const current = snapshot.ledgers.find((ledger) => ledger.chapter === input.chapter);
  const record = lastRecorded(current);
  const previous = record.entries;
  const reopenable = previous
    .flatMap((entry) => (entry.kind === "thread" && entry.op === "open"
      ? [{ thread: threadOf(entry), type: entry.type ?? "question", title: entry.title ?? entry.note, note: entry.note }]
      : []));
  const keeper = await runLedgerKeeper({
    projectDir: input.bookDir,
    chapter: input.chapter,
    draft: input.text,
    before,
    ...(reopenable.length > 0 ? { reopenable } : {}),
    callModel: input.callModel,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
    ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    ...(input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {}),
    ...(input.onRawOutput ? { onRawOutput: input.onRawOutput } : {}),
  });
  const extra = { ...(keeper.cold ? { cold: keeper.cold } : {}), ...(keeper.waited ? { waited: keeper.waited } : {}) };
  if (!keeper.ok) return { ok: false, code: "keeper_failed", reason: keeper.reason, ...extra };

  const textSha = sha256(input.text);
  const checked = checkEntries(keeper.parsed.entries, input.text, before);
  const recommit = committed.includes(input.chapter);
  const opens = recommit ? keepLastOpens(snapshot.ledgers, input.chapter, previous, checked, input.text, before) : undefined;
  const withAuthorDay = recommit ? keepAuthorDay(record, opens?.accepted ?? checked.accepted) : checked.accepted;
  // 读不全上次记账员记的时间（老的账待记）：不比，照这次的记。
  const kept = recommit && record.timeComplete ? keepLastDay(snapshot, input.chapter, record, withAuthorDay, input.text, before, await committedText(input.bookDir, current)) : undefined;
  const accepted = kept?.accepted ?? withAuthorDay;
  const rejected = opens?.rejected ?? checked.rejected;
  const missingKinds = keeper.quoteRepair?.failed
    ? [...new Set(rejected.filter((item) => item.reason === "quote_not_in_text").map((item): EntryKind => (item.entry.kind === "day" ? "time" : item.entry.kind)))]
    : [];
  // 重定稿：这章上次定稿时作者认过的出场人物不再当「第一次出场」问一遍（真跑：改两个错字重定稿，又问老郑、刀疤军官是谁）。
  const confirmedNames = previous.flatMap((entry) => (entry.kind === "presence" ? [presenceName(entry)] : []));
  const knownNames = [...(input.knownNames ?? []), ...confirmedNames];
  const plan = classifyForReview(accepted, before, { chapter: input.chapter, ...(knownNames.length > 0 ? { knownNames } : {}) });
  // 清单序号 = 核过的条目里的下标。
  const position = new Map(accepted.map((item, index) => [item.index, index]));
  const resolve = subjectResolver(before);
  const later = recommit ? laterThreadTouches(snapshot.ledgers, input.chapter) : new Map<string, readonly number[]>();
  const optIn = (item: ClassifiedEntry): boolean => touchesHardFact(item, before) || closesLaterThread(item, later);
  const toItem = (item: ClassifiedEntry): CommitItem => ({
    index: position.get(item.index) ?? -1,
    kind: item.entry.kind,
    label: entryLabel(item.entry, before),
    ...(entryQuote(item.entry) ? { quote: entryQuote(item.entry) } : {}),
    reasons: reasonTexts(item, before, resolve, later),
    optIn: optIn(item),
  });
  const entries = accepted.map((item) => item.entry);
  const time = previewTime(snapshot, input.chapter, entries, input.text);
  const ticket: PreviewTicket = {
    chapter: input.chapter,
    textSha256: draftFingerprint(input.text),
    entries,
    reviewIndexes: plan.review.map((item) => position.get(item.index) ?? -1),
    optInIndexes: plan.review.filter(optIn).map((item) => position.get(item.index) ?? -1),
    basis: input.basis,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  return {
    ok: true,
    ticket,
    chapter: input.chapter,
    recommit: recommit && current?.status !== "pending",
    review: plan.review.map(toItem),
    auto: mergeSameNote(plan.auto, toItem, before),
    notRecorded: [
      ...rejected.map((item) => ({ code: item.reason, label: entryLabel(item.entry, before), reason: item.message })),
      ...keeper.parsed.drops.map((drop) => ({ code: "parse", label: dropLabel(drop), reason: drop.reason })),
    ],
    adjusted: keeper.parsed.adjusted.map((drop) => ({ code: "adjusted", label: dropLabel(drop), reason: drop.reason })),
    time: previewTimeOf(time, entries, plan.timeMissing, kept?.sinceLast, input.chapter),
    ...(opens && opens.lost.length > 0 ? { lostThreads: opens.lost } : {}),
    omittedThreads: keeper.omittedThreads,
    omittedFacts: keeper.omittedFacts,
    ...(keeper.quoteRepair ? { quoteRepair: keeper.quoteRepair } : {}),
    ...(missingKinds.length > 0 ? { missingKinds } : {}),
    ...extra,
  };
}

/** 清单最前那一行。临时账单拼不出来（不该发生）按不知道给，照样请作者看。 */
function previewTimeOf(
  time: ReturnType<typeof previewTime>,
  entries: readonly EntryInput[],
  timeMissing: boolean,
  sinceLast: PreviewTime["sinceLast"],
  chapter: number,
): PreviewTime {
  const row: TimelineRow = time?.row ?? { chapter, presentLine: "unknown", weekdayDerived: false, basis: "unknown", presumed: false, segments: [], afterUnknown: false };
  const declared = entries.find((entry): entry is TimeInput => entry.kind === "time");
  const startBasis = declared?.start && declared.start !== "unknown" ? declared.start.basis : undefined;
  const segments = (declared?.segments ?? []).map((segment, index) => ({ text: time?.segments[index] ?? segmentText(segment), quote: segment.firstQuote }));
  const conflicts = time?.conflicts ?? [];
  const unknownDay = row.presentLine !== false && !known(row.start);
  return {
    row,
    recorded: declared !== undefined,
    ...(startBasis ? { declared: startBasis } : {}),
    segments,
    needsConfirm: timeMissing || unknownDay || row.basis === "presumed" || sinceLast !== undefined || conflicts.length > 0,
    ...(sinceLast ? { sinceLast } : {}),
    conflicts,
  };
}

// —— 确认 ——

/** 作者在清单上的选择：去掉的、勾上的「默认不写」条目序号，改的天数。 */
export interface CommitChoices {
  /** 作者去掉的清单序号。 */
  readonly excluded?: readonly number[];
  /** 作者勾上的「默认不写」条目序号（见 CommitItem.optIn）。 */
  readonly optedIn?: readonly number[];
  /** 作者改的「故事第几天」（本章开头）。 */
  readonly day?: number;
  /** 作者填的「到第几天」：给了才记结尾（和 day 一样 = 明确就这一天）；没给按记账员记的章内跨度推（设计 2.5，T4）。 */
  readonly dayEnd?: number;
}

/**
 * 照票和作者的选择算出交给「定稿」命令的条目：去掉作者去掉的、默认不写的没勾就不写；作者改了天数就加一条作者定的天数
 * （换掉票里原有的那条），记账员记的时间原样留着——两样分开存、一起核，对不上由投影列给作者（设计 2.5）。
 */
export function commitEntriesOf(ticket: PreviewTicket, choices: CommitChoices): EntryInput[] {
  const optedIn = new Set(choices.optedIn ?? []);
  const excluded = new Set([
    ...(choices.excluded ?? []),
    // 默认不写的，作者没勾上就不写。
    ...ticket.optInIndexes.filter((index) => !optedIn.has(index)),
  ]);
  const review = new Set(ticket.reviewIndexes);
  const day = choices.day !== undefined && choices.day >= 1 ? choices.day : undefined;
  const entries: EntryInput[] = [];
  ticket.entries.forEach((entry, index) => {
    if (excluded.has(index)) return;
    if (entry.kind === "day" && day !== undefined) return;
    // 作者在清单上看过的，记成作者确认过。
    entries.push(review.has(index) ? { ...entry, review: "author" } : entry);
  });
  if (day !== undefined) {
    const dayEnd = choices.dayEnd !== undefined && choices.dayEnd >= day ? choices.dayEnd : undefined;
    entries.push({ kind: "day", review: "author", day, ...(dayEnd !== undefined ? { dayEnd } : {}) } satisfies DayInput);
  }
  return entries;
}
