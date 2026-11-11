/**
 * 定稿编排（重构 P3；写作版本 P2a 片 4A 起是执行器 commit.prepare 的一步，配方在 services/operations/recipes/commit-prepare.ts）：
 *
 *   prepareChapterCommit：读真相 → 投影（算到上一章）→ 记账员交账单 → checkEntries 核原句 → 重定稿沿用上次的线索、东西、天数
 *                         → 预览票（条目、正文指纹、依据；存在操作的检查点里）
 *   commitEntriesOf：照票去掉不写的那几条 → 交给「定稿」命令的条目（配方带着记账时的依据交命令：
 *                    之后前面的章、账、设定、裁定有一样变了，核心不写、如实说哪里变了）
 *
 * 一次定稿只调一次记账员（补笔记另算）。安静账房（2026-11-03）：账不再列成清单给作者勾，记下的都能撤。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  boundaryText,
  chapterSource,
  chapterTextPath,
  checkEntries,
  classifyForReview,
  decisionItemIds,
  declarationOf,
  declarationsOf,
  itemRefsOf,
  knownEntries,
  ledgerOf,
  locateQuote,
  rejectedItemMissing,
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
  type ItemInput,
  type ItemPlaceInput,
  type ItemRefInput,
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
import { itemIssueTexts, itemTexts, type ItemTexts } from "../book/item-views.js";
import { reopenableItems } from "./keeper-context.js";
import { droppedItemRefs, type KeeperDrop } from "./keeper-parse.js";
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

/** 预览票：定稿要记的条目（存在 commit.prepare 记账那一步的检查点里，定稿时照它定）。 */
export interface PreviewTicket {
  readonly chapter: number;
  /** 记账时正文的指纹（见 draftFingerprint）。 */
  readonly textSha256: string;
  /** 核过的条目。 */
  readonly entries: readonly EntryInput[];
  /** 不写的条目下标：会改掉前文「不会变」的事实、重定稿时收掉后文还接着的线索（不替作者改前文）。 */
  readonly optInIndexes: readonly number[];
  /** 记账时读到的真相：条目、天数都是照它算的。 */
  readonly basis: TruthBasis;
  readonly createdAt: string;
}

/** 记好的账：票，和定稿时账记没记全要的几样（安静账房：清单不给作者看了，只留定稿要用的）。 */
export interface CommitPreview {
  readonly ok: true;
  readonly ticket: PreviewTicket;
  readonly chapter: number;
  /** 有东西的条目没记上（核不上、格式不对）：这章东西那类（和连带的事实）记成没记全（P3b 设计 2.4）。 */
  readonly itemMissing?: readonly EntryKind[];
  /** 缺东西那类时只缺这几样（没记上的条目都认得出指哪几样）；不给 = 整章东西当没记全。 */
  readonly itemMissingRefs?: readonly ItemRefInput[];
  /** 记账员交的、核不上（原句对不上、格式不对）没交给定稿的条数（回执里如实说一句）。 */
  readonly notRecorded?: number;
  /** 第一遍有原句对不上、请记账员重摘过一次（几条、救回几条）。 */
  readonly quoteRepair?: QuoteRepair;
  /** 补摘那一步没成、因此没记上的条目是哪几类（定稿时账记成「没记全」、写明缺这几类）；没成却一条都没拒 = 不给，当全部没记全。 */
  readonly missingKinds?: readonly EntryKind[];
  readonly cold?: ColdCoverage;
  readonly waited?: ReaderWaited;
  /** 记东西那遍的章末对一遍没成（原因）：东西照第一遍记的，不算缺账，操作记录里如实留一句（P4b 2.4）。 */
  readonly itemCheckFailed?: string;
}

export type PrepareFailureCode = "book_unsettled" | "basis_changed" | "not_imported" | "chapter_gap" | "keeper_failed" | "empty_text";

export interface PrepareFailure {
  readonly ok: false;
  readonly code: PrepareFailureCode;
  readonly reason: string;
  readonly cold?: ColdCoverage;
  readonly waited?: ReaderWaited;
}

/** 两处「只缺这几样」合起来：有一处说不出（undefined）就是整章。 */
export function unionItemRefs(a: readonly ItemRefInput[] | undefined, b: readonly ItemRefInput[] | undefined): ItemRefInput[] | undefined {
  return a && b ? [...a, ...b] : undefined;
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
 * 用核过的条目拼一份临时账单，算出「定稿后」这一章那一行时间（重定稿比天数用）：带上已有的作者裁定和换天规矩（T7），
 * 和定稿后时间表上那一行是同一个算法。
 */
function previewRow(truth: Truth, chapter: number, entries: readonly EntryInput[], text: string): TimelineRow | undefined {
  const draft = ledgerOf({
    chapter,
    text,
    entries: entries.map((entry, index) =>
      entry.kind === "thread" && entry.op === "open" ? { ...entry, id: `preview-${index}`, thread: `preview-t${index}` } : { ...entry, id: `preview-${index}` },
    ),
  });
  const after = project({ ledgers: [...truth.ledgers.filter((ledger) => ledger.chapter < chapter), draft], decisions: truth.decisions, cards: truth.cards }, { upTo: chapter });
  return timelineTable(after, chapter).find((item) => item.chapter === chapter);
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

/**
 * 重定稿时这章上次头回写到的东西别丢（P3b 设计 3.3，和线索同一套）：记账员这次写明了 P 号的就沿用；没写、但后文还用着它的，
 * 上次那条头回写到的原句还在就照上次的记；原句也没了，如实告诉作者（后文还有它自己的记录 = 首见挪后；没有 = 那几处没了出处）。
 */
function keepLastAppears(
  snapshot: BookSnapshot,
  chapter: number,
  previous: readonly LedgerEntry[],
  checked: { readonly accepted: Accepted; readonly rejected: Rejected },
  text: string,
  before: BookProjection,
): { readonly accepted: Accepted; readonly lost: readonly { readonly name: string; readonly proved: boolean }[] } {
  const lastAppears = reopenableItems(previous);
  const covered = new Set(checked.accepted.flatMap(({ entry }) => (entry.kind === "item" && entry.op === "appear" && entry.reuse ? [entry.reuse] : [])));
  // 后文怎么用着它：用到（任何位置，作者裁定指着它也算）/ 自己的记录（主体是它的条目、事实）。设定卡、拆出它的裁定也算它还在。
  const used = new Set<string>(decisionItemIds(snapshot.decisions));
  const proved = new Set<string>([...(snapshot.cards?.cards ?? []).filter((card) => card.kind === "item").map((card) => card.id)]);
  for (const ledger of snapshot.ledgers) {
    if (ledger.chapter <= chapter) continue;
    for (const entry of ledger.entries) {
      if (entry.kind === "item") {
        for (const { at, ref } of itemRefsOf(entry)) {
          used.add(ref.id);
          if (at === "item") proved.add(ref.id);
        }
      }
      if (entry.kind === "fact" && entry.subjectRef?.id !== undefined) {
        used.add(entry.subjectRef.id);
        proved.add(entry.subjectRef.id);
      }
    }
  }
  let nextIndex = Math.max(-1, ...checked.accepted.map((item) => item.index), ...checked.rejected.map((item) => item.index)) + 1;
  const accepted = [...checked.accepted];
  const lost: { name: string; proved: boolean }[] = [];
  for (const last of lastAppears) {
    if (covered.has(last.item) || !used.has(last.item)) continue;
    const declared = previous.find((entry) => entry.kind === "item" && entry.op === "appear" && entry.itemRef.id === last.item);
    const lastDeclared = declared ? declarationOf(declared) : undefined;
    const kept = lastDeclared ? checkEntries([lastDeclared], text, before).accepted[0]?.entry : undefined;
    if (kept) accepted.push({ index: nextIndex++, entry: kept });
    else lost.push({ name: last.name || "一样东西", proved: proved.has(last.item) });
  }
  return { accepted, lost };
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
 * 上次那条时间的原句（开头那句、换天那句、段的首末句）所在的整句都没改就照上次的（返回换好的条目），否则照这次记的（undefined）。
 * 比整句、不只看原句还在不在（P3a 改早章：作者在「这天下午，……」前面加了「过了两天，」，原句还在，天数却照上次的没挪）。
 * 比的是记那套时间时的正文（时间条目原句所在的版本）：那版读不到（盘上的正文改过、这中间先定了正文账待记、文件没了）
 * 就证明不了那几句没改，不照上次的（出口复核第 5 轮 R11）。作者要改天数在对话里说（change_ledger 的 day）。
 */
function keepLastDay(
  truth: Truth,
  chapter: number,
  previous: PreviousRecord,
  accepted: Accepted,
  text: string,
  before: BookProjection,
  lastText: string | undefined,
): Accepted | undefined {
  const last = previewRow(truth, chapter, declarationsOf(previous), text);
  const now = previewRow(truth, chapter, accepted.map((item) => item.entry), text);
  // 有一边是哪天不知道（前面有章账待记、说不准）：没得比，照这次的记。
  if (!last || !now || !known(last.start) || !known(now.start)) return undefined;
  if (sameRange(last.start, now.start) && sameRange(last.end, now.end)) return undefined;
  const lastTime = declarationsOf(previous).find((entry) => entry.kind === "time");
  const unchanged = lastTime?.kind === "time" && lastText !== undefined && timeQuotes(lastTime).every((quote) => {
    const was = wholeSentences(quote, lastText);
    return was !== undefined && was === wholeSentences(quote, text);
  });
  const carried = lastTime && unchanged ? checkEntries([lastTime], text, before).accepted[0]?.entry : undefined;
  if (!carried) return undefined;
  const at = accepted.findIndex((item) => item.entry.kind === "time");
  const next = at >= 0
    ? accepted.map((item, index) => (index === at ? { index: item.index, entry: carried } : item))
    : [...accepted, { index: Math.max(-1, ...accepted.map((item) => item.index)) + 1, entry: carried }];
  return next;
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

/**
 * 上次记那套时间时的正文：记账员的时间条目引的都是同一版（证据里的正文哈希），盘上那份正好是这版才算。
 * 账待记那次换了正文、时间是从更早那份带过来的，盘上的就不是那版。
 */
async function timeText(bookDir: string, chapter: number, record: PreviousRecord): Promise<string | undefined> {
  const revisions = new Set(record.entries.flatMap((entry) => (entry.kind === "time" && entry.relation !== "at" ? entry.evidence.map((item) => item.revision) : [])));
  if (revisions.size !== 1) return undefined;
  const [revision] = revisions;
  const text = await readFile(join(bookDir, chapterTextPath(chapter)), "utf-8").catch(() => undefined);
  return text !== undefined && sha256(text) === revision ? text : undefined;
}

/**
 * 这章现在能不能按顺序定：老书还没导入、前面还有章没定稿就定不了。定稿配方在核账、问作者之前先查这个（不白花核账的钱）。
 */
export function commitOrderProblem(
  snapshot: Pick<BookSnapshot, "ledgers" | "textHashes">,
  chapter: number,
): { readonly code: "not_imported" | "chapter_gap"; readonly reason: string } | undefined {
  const committed = snapshot.ledgers.map((ledger) => ledger.chapter);
  // 有定稿正文却一份账单都没有 = 老书还没导入：先导入，不然导入会因为「已经有账单」做不了。
  if (committed.length === 0 && snapshot.textHashes.size > 0) {
    return { code: "not_imported", reason: "这本书的账还没导进新格式，先导入再定稿" };
  }
  const last = committed.length > 0 ? Math.max(...committed) : 0;
  if (chapter > last + 1) {
    const gap = last + 1 === chapter - 1 ? `第 ${last + 1} 章` : `第 ${last + 1} 章到第 ${chapter - 1} 章`;
    return { code: "chapter_gap", reason: `${gap}还没定稿，先定稿前面的章` };
  }
  return undefined;
}

export async function prepareChapterCommit(input: PrepareInput): Promise<CommitPreview | PrepareFailure> {
  if (input.text.trim().length === 0) return { ok: false, code: "empty_text", reason: "正文是空的，没有可定稿的" };
  const snapshot = await readBookSnapshot(input.bookDir);
  if (snapshot.unsettled) return { ok: false, code: "book_unsettled", reason: "这本书正在写盘，稍等几秒再定稿" };
  if (snapshot.basis.digest !== input.basis.digest) return { ok: false, code: "basis_changed", reason: "预览的途中书里有地方改过，请重新预览一次" };
  const order = commitOrderProblem(snapshot, input.chapter);
  if (order) return { ok: false, ...order };
  const committed = snapshot.ledgers.map((ledger) => ledger.chapter);
  const before = project(snapshot, { upTo: input.chapter - 1 });
  const current = snapshot.ledgers.find((ledger) => ledger.chapter === input.chapter);
  const record = lastRecorded(current);
  const previous = record.entries;
  const reopenable = previous
    .flatMap((entry) => (entry.kind === "thread" && entry.op === "open"
      ? [{ thread: threadOf(entry), type: entry.type ?? "question", title: entry.title ?? entry.note, note: entry.note }]
      : []));
  const reopenItems = reopenableItems(record.entries);
  const keeper = await runLedgerKeeper({
    projectDir: input.bookDir,
    chapter: input.chapter,
    draft: input.text,
    before,
    ...(reopenable.length > 0 ? { reopenable } : {}),
    ...(reopenItems.length > 0 ? { reopenItems } : {}),
    callModel: input.callModel,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
    ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    ...(input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {}),
    ...(input.onRawOutput ? { onRawOutput: input.onRawOutput } : {}),
  });
  const extra = { ...(keeper.cold ? { cold: keeper.cold } : {}), ...(keeper.waited ? { waited: keeper.waited } : {}) };
  if (!keeper.ok) return { ok: false, code: "keeper_failed", reason: keeper.reason, ...extra };

  const checked = checkEntries(keeper.parsed.entries, input.text, before);
  const recommit = committed.includes(input.chapter);
  const opens = recommit ? keepLastOpens(snapshot.ledgers, input.chapter, previous, checked, input.text, before) : undefined;
  const appears = recommit ? keepLastAppears(snapshot, input.chapter, previous, opens ?? checked, input.text, before) : undefined;
  const withAuthorDay = recommit ? keepAuthorDay(record, appears?.accepted ?? opens?.accepted ?? checked.accepted) : checked.accepted;
  // 读不全上次记账员记的时间（老的账待记）：不比，照这次的记。
  const kept = recommit && record.timeComplete ? keepLastDay(snapshot, input.chapter, record, withAuthorDay, input.text, before, await timeText(input.bookDir, input.chapter, record)) : undefined;
  const accepted = kept ?? withAuthorDay;
  const rejected = opens?.rejected ?? checked.rejected;
  // 有东西的条目没记上（核不上、格式不对的整条丢）：这章东西那类没记全；带东西的事实只缺事实（和核心定稿同一把尺子，P4b 2.1）。
  const missing = rejectedItemMissing(rejected.map((item) => item.entry));
  const itemMissing = new Set<EntryKind>(missing.kinds);
  for (const drop of keeper.parsed.drops) if (drop.kind) itemMissing.add(drop.kind);
  const itemMissingRefs = unionItemRefs(missing.items, droppedItemRefs(keeper.parsed.drops));
  const missingKinds = keeper.quoteRepair?.failed
    ? [...new Set(rejected.filter((item) => item.reason === "quote_not_in_text").map((item): EntryKind => (item.entry.kind === "day" ? "time" : item.entry.kind)))]
    : [];
  // 不写的（会改掉前文不会变的事实、重定稿时收掉后文还接着的线索）：只在规则挑出来要看的条目里找，和原来清单上「默认不写」同一把尺子。
  const plan = classifyForReview(accepted, before, { chapter: input.chapter });
  const position = new Map(accepted.map((item, index) => [item.index, index]));
  const later = recommit ? laterThreadTouches(snapshot.ledgers, input.chapter) : new Map<string, readonly number[]>();
  const optIn = (item: ClassifiedEntry): boolean => touchesHardFact(item, before) || closesLaterThread(item, later);
  const ticket: PreviewTicket = {
    chapter: input.chapter,
    textSha256: draftFingerprint(input.text),
    entries: accepted.map((item) => item.entry),
    optInIndexes: plan.review.filter(optIn).map((item) => position.get(item.index) ?? -1),
    basis: input.basis,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  return {
    ok: true,
    ticket,
    chapter: input.chapter,
    ...(itemMissing.size > 0 ? { itemMissing: [...itemMissing], ...(itemMissingRefs ? { itemMissingRefs } : {}) } : {}),
    ...(rejected.length > 0 ? { notRecorded: rejected.length } : {}),
    ...(keeper.quoteRepair ? { quoteRepair: keeper.quoteRepair } : {}),
    ...(missingKinds.length > 0 ? { missingKinds } : {}),
    ...(keeper.itemCheck?.failed ? { itemCheckFailed: keeper.itemCheck.failed } : {}),
    ...extra,
  };
}

// —— 定稿 ——

/** 照票算出交给「定稿」命令的条目：不写的那几条去掉，其余照记（安静账房：不再有作者逐条勾的清单）。 */
export function commitEntriesOf(ticket: PreviewTicket): EntryInput[] {
  const skipped = new Set(ticket.optInIndexes);
  return ticket.entries.filter((_, index) => !skipped.has(index));
}
