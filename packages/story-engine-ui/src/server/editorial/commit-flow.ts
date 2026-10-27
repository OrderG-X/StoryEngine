/**
 * 定稿编排（重构 P3）：预览 → 定稿清单 → 作者确认 → 「定稿」命令。
 *
 *   prepareChapterCommit：读真相 → 投影（算到上一章）→ 记账员交账单 → checkEntries 核原句 → classifyForReview 分流
 *                         → 存预览票（条目、正文哈希）→ 返回清单（要你看的 / 自动记下的 / 没记上的 / 这章是第几天）
 *   confirmChapterCommit：取票 → 正文哈希对得上 → 减掉作者去掉的、套上作者改的天数 → chapter.commit（幂等键 = 票号）
 *
 * 一次定稿只调一次模型（补笔记另算）；确认时不再调模型。清单上给人看的只有名字、标题、原句，不带任何编号。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHAPTER_LEDGER_SCHEMA,
  chapterCommit,
  checkEntries,
  classifyForReview,
  nameKey,
  project,
  readBookSnapshot,
  runCommand,
  sha256,
  type BookEvent,
  type BookProjection,
  type ChapterCommitResult,
  type ChapterLedger,
  type ClassifiedEntry,
  type CommandFailure,
  type EntryInput,
  type LedgerEntry,
  type ReviewReason,
  type ThreadInput,
  type TimeBasis,
  type TimeInput,
} from "@actalk/story-core";
import type { KeeperDrop } from "./keeper-parse.js";
import { runLedgerKeeper, type QuoteRepair } from "./ledger-keeper.js";
import type { ReaderWaited } from "./reader-progress.js";
import { writeAtomically, type BrainCallModel, type ColdCoverage } from "./reader-window.js";

// —— 预览票 ——

/**
 * 预览票认的正文指纹：换行统一、行尾空白去掉、连续空行并成一个后的 sha256。
 * 稿纸重新载入时会把多余的空段落收掉再存一遍（字一个没动），不能因为这个就让作者重新预览。
 */
export function draftFingerprint(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd());
  return sha256(lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim());
}

export interface PreviewTicket {
  readonly id: string;
  readonly chapter: number;
  /** 预览时正文的指纹（见 draftFingerprint）。 */
  readonly textSha256: string;
  /** 核过的条目（清单上的序号 = 这里的下标）。 */
  readonly entries: readonly EntryInput[];
  /** 要作者看的条目下标。 */
  readonly reviewIndexes: readonly number[];
  /** 默认不写、作者勾上才写的条目下标（和前文不会变的事实对不上、要推翻前文不会变的事实）。 */
  readonly optInIndexes?: readonly number[];
  readonly createdAt: string;
}

export interface TicketStore {
  put(ticket: PreviewTicket): Promise<void>;
  get(id: string): Promise<PreviewTicket | undefined>;
}

export function memoryTicketStore(): TicketStore {
  const tickets = new Map<string, PreviewTicket>();
  return {
    async put(ticket) {
      tickets.set(ticket.id, ticket);
    },
    async get(id) {
      return tickets.get(id);
    },
  };
}

const TICKET_ID = /^[0-9a-f]{16}$/u;

/** 存到一个目录里（进程重启后确认定稿也不用重新调模型）。票只是缓存，不算真相，丢了就重新预览。 */
export function fileTicketStore(dir: string): TicketStore {
  const memory = memoryTicketStore();
  return {
    async put(ticket) {
      await memory.put(ticket);
      await writeAtomically(join(dir, `${ticket.id}.json`), `${JSON.stringify(ticket)}\n`);
    },
    async get(id) {
      if (!TICKET_ID.test(id)) return undefined;
      const cached = await memory.get(id);
      if (cached) return cached;
      try {
        return JSON.parse(await readFile(join(dir, `${id}.json`), "utf-8")) as PreviewTicket;
      } catch {
        return undefined;
      }
    },
  };
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
}

export interface NotRecorded {
  /** quote_not_in_text / unknown_thread / unknown_fact / shape / duplicate（核对没过），parse（记账员交的格式不对），adjusted（改过）。 */
  readonly code: string;
  readonly label: string;
  readonly reason: string;
}

export interface CommitPreview {
  readonly ok: true;
  readonly ticket: string;
  readonly chapter: number;
  readonly recommit: boolean;
  readonly review: readonly CommitItem[];
  readonly auto: readonly CommitItem[];
  /** 没记上的：原句对不上、指向前文没有的、记账员交的格式不对的。 */
  readonly notRecorded: readonly NotRecorded[];
  /** 记上了但改过的（比如缺字段的事实按「发生过的事」记）。 */
  readonly adjusted: readonly NotRecorded[];
  readonly time: {
    readonly day: number;
    readonly dayEnd: number;
    readonly basis: TimeBasis | "missing";
    readonly weekday?: number;
    readonly timeOfDay?: string;
    /** 天数是估的（记账员没给时间），要作者确认或改。 */
    readonly needsConfirm: boolean;
    /**
     * 重定稿、记账员这次看的天数和上次定稿记的不一样（一样就没有）。
     * kept：上次那条时间的原句还在正文里，照上次的记，other 是记账员这次看成的；
     * 没 kept：那句改没了，按这次的记，other 是上次定稿记的。
     */
    readonly sinceLast?: { readonly kept: boolean; readonly otherDay: number; readonly otherDayEnd: number };
  };
  /** 重定稿：这章上次开的、后文还接着的线索，这次没记上、上次的原句也没了（定稿后它们没了开头）。 */
  readonly lostThreads?: readonly string[];
  readonly omittedThreads: number;
  readonly omittedFacts: number;
  /** 第一遍有原句对不上、请记账员重摘过一次（几条、救回几条）。 */
  readonly quoteRepair?: QuoteRepair;
  readonly cold?: ColdCoverage;
  readonly waited?: ReaderWaited;
}

export type PrepareFailureCode = "book_unsettled" | "not_imported" | "chapter_gap" | "keeper_failed" | "empty_text";

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

function entryLabel(entry: EntryInput, before: BookProjection): string {
  switch (entry.kind) {
    case "summary":
      return `梗概：${entry.text}`;
    case "time": {
      const parts: string[] = [];
      if (entry.daysSincePrevious !== undefined) parts.push(entry.daysSincePrevious === 0 ? "和上一章同一天" : `离上一章隔 ${entry.daysSincePrevious} 天`);
      if (entry.daysInChapter !== undefined) parts.push(`本章内过了 ${entry.daysInChapter} 天`);
      if (entry.timeOfDay) parts.push(entry.timeOfDay);
      return `时间：${parts.join("，") || "见原句"}${entry.basis === "text" ? "（正文明写）" : "（按前后文判断）"}`;
    }
    case "presence": {
      const alias = nameKey(entry.name) === nameKey(entry.nameUsed) ? "" : `（正文叫「${entry.nameUsed}」）`;
      return `出场：${entry.name}${alias}${entry.viewpoint ? "，视角人物" : ""}`;
    }
    case "fact":
      return `事实（${NATURE_LABELS[entry.nature]}）：${entry.text}`;
    case "thread": {
      if (entry.op === "open") return `新开${THREAD_TYPE_LABELS[entry.type ?? "question"]}：${entry.title ?? entry.note}`;
      const title = before.threads.find((thread) => thread.id === entry.thread || thread.mergedFrom.includes(entry.thread ?? ""))?.title ?? "一条线索";
      return `${entry.op === "close" ? "收口" : "推进"}「${title}」：${entry.note}`;
    }
  }
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
      case "time-estimated":
        return { code, text: "天数是估的" };
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
      const chapters = out.get(entry.thread) ?? [];
      if (!chapters.includes(ledger.chapter)) chapters.push(ledger.chapter);
      out.set(entry.thread, chapters);
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

/** 用核过的条目拼一份临时账单，算出「定稿后」这一章是第几天（只用来展示）。 */
function previewDay(ledgers: readonly ChapterLedger[], chapter: number, entries: readonly EntryInput[], textSha: string) {
  const draft: ChapterLedger = {
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter,
    textSha256: textSha,
    committedAt: new Date(0).toISOString(),
    origin: "commit",
    entries: entries.map((entry, index) =>
      entry.kind === "thread" && entry.op === "open"
        ? ({ ...entry, id: `preview-${index}`, thread: `preview-t${index}` } as LedgerEntry)
        : ({ ...entry, id: `preview-${index}` } as LedgerEntry),
    ),
  };
  const after = project({ ledgers: [...ledgers.filter((ledger) => ledger.chapter < chapter), draft], decisions: [] }, { upTo: chapter });
  return after.chapters.find((view) => view.chapter === chapter);
}

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
  const covered = new Set<string>();
  for (const { entry } of checked.accepted) {
    if (entry.kind !== "thread" || entry.op !== "open") continue;
    if (entry.thread) covered.add(entry.thread);
    for (const last of lastOpens) if (nameKey(last.title ?? "") === nameKey(entry.title ?? "")) covered.add(last.thread);
  }
  const later = new Set(ledgers
    .filter((ledger) => ledger.chapter > chapter)
    .flatMap((ledger) => ledger.entries.flatMap((entry) => (entry.kind === "thread" ? [entry.thread] : []))));
  let nextIndex = Math.max(-1, ...checked.accepted.map((item) => item.index), ...checked.rejected.map((item) => item.index)) + 1;
  const accepted = [...checked.accepted];
  const folded = new Set<Rejected[number]>();
  const lost: string[] = [];
  for (const last of lastOpens) {
    if (covered.has(last.thread)) continue;
    const mentions = checked.rejected.filter((item) => item.entry.kind === "thread" && item.entry.op !== "open" && item.entry.thread === last.thread);
    const title = last.title ?? last.note;
    const candidates: EntryInput[] = [
      ...mentions.flatMap((item) => (item.entry.kind === "thread"
        ? [{ kind: "thread", review: "auto", op: "open", type: last.type ?? "question", title, note: item.entry.note, quote: item.entry.quote, thread: last.thread } satisfies ThreadInput]
        : [])),
      ...(mentions.length > 0 || later.has(last.thread) ? [withoutId(last)] : []),
    ];
    const reopened = candidates.map((entry) => checkEntries([entry], text, before).accepted[0]?.entry).find((entry) => entry !== undefined);
    if (reopened) {
      accepted.push({ index: nextIndex++, entry: reopened });
      for (const item of mentions) folded.add(item);
    } else if (later.has(last.thread)) {
      lost.push(title);
    }
  }
  return { accepted, rejected: checked.rejected.filter((item) => !folded.has(item)), lost };
}

function withoutId(entry: LedgerEntry): EntryInput {
  const { id: _id, ...rest } = entry;
  return rest as EntryInput;
}

/**
 * 重定稿时天数照上次定稿的记（作者长篇实跑 2026-10-27：第 5 章改一个错字重定稿，记账员这次把第二天清早看成当天，
 * 第 6～7 天成了第 5～6 天，后面 45 章跟着挪一天，清单上只露出这一章的天数）。
 * 上次那条时间的原句还在正文里就照上次的；和记账员这次看的不一样时两边都给作者看，作者改天数照旧管用。
 */
function keepLastDay(
  ledgers: readonly ChapterLedger[],
  chapter: number,
  previous: readonly LedgerEntry[],
  accepted: Accepted,
  text: string,
  before: BookProjection,
  textSha: string,
): { readonly accepted: Accepted; readonly sinceLast: NonNullable<CommitPreview["time"]["sinceLast"]> } | undefined {
  const last = previewDay(ledgers, chapter, previous.map(withoutId), textSha);
  const now = previewDay(ledgers, chapter, accepted.map((item) => item.entry), textSha);
  if (!last || !now || (last.day === now.day && last.dayEnd === now.dayEnd)) return undefined;
  const lastTime = previous.find((entry) => entry.kind === "time");
  const carried = lastTime ? checkEntries([withoutId(lastTime)], text, before).accepted[0]?.entry : undefined;
  if (!carried) return { accepted, sinceLast: { kept: false, otherDay: last.day, otherDayEnd: last.dayEnd } };
  const at = accepted.findIndex((item) => item.entry.kind === "time");
  const next = at >= 0
    ? accepted.map((item, index) => (index === at ? { index: item.index, entry: carried } : item))
    : [...accepted, { index: Math.max(-1, ...accepted.map((item) => item.index)) + 1, entry: carried }];
  return { accepted: next, sinceLast: { kept: true, otherDay: now.day, otherDayEnd: now.dayEnd } };
}

export interface PrepareInput {
  readonly bookDir: string;
  readonly chapter: number;
  /** 要定稿的完整正文（含标题行）。 */
  readonly text: string;
  readonly callModel: BrainCallModel;
  readonly tickets: TicketStore;
  /** 设定卡上已有的人名（还没在账单里出场过的也算认识，不当新面孔）。 */
  readonly knownNames?: readonly string[];
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 记账员原始输出（考卷、排查用）。 */
  readonly onRawOutput?: (text: string) => void;
  readonly now?: () => Date;
}

export async function prepareChapterCommit(input: PrepareInput): Promise<CommitPreview | PrepareFailure> {
  if (input.text.trim().length === 0) return { ok: false, code: "empty_text", reason: "正文是空的，没有可定稿的" };
  const snapshot = await readBookSnapshot(input.bookDir);
  if (snapshot.unsettled) return { ok: false, code: "book_unsettled", reason: "这本书正在写盘，稍等几秒再定稿" };
  const committed = snapshot.ledgers.map((ledger) => ledger.chapter);
  // 有定稿正文却一份账单都没有 = 老书还没导入：先导入，不然导入会因为「已经有账单」做不了。
  if (committed.length === 0 && snapshot.textHashes.size > 0) {
    return { ok: false, code: "not_imported", reason: "这本书的账还没导进新格式，先导入再定稿" };
  }
  const last = committed.length > 0 ? Math.max(...committed) : 0;
  if (input.chapter > last + 1) {
    return { ok: false, code: "chapter_gap", reason: `第 ${last + 1} 章到第 ${input.chapter - 1} 章还没定稿，先定稿前面的章` };
  }
  const before = project(snapshot, { upTo: input.chapter - 1 });
  const previous = snapshot.ledgers.find((ledger) => ledger.chapter === input.chapter)?.entries ?? [];
  const reopenable = previous
    .flatMap((entry) => (entry.kind === "thread" && entry.op === "open"
      ? [{ thread: entry.thread, type: entry.type ?? "question", title: entry.title ?? entry.note, note: entry.note }]
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
    ...(input.onRawOutput ? { onRawOutput: input.onRawOutput } : {}),
  });
  const extra = { ...(keeper.cold ? { cold: keeper.cold } : {}), ...(keeper.waited ? { waited: keeper.waited } : {}) };
  if (!keeper.ok) return { ok: false, code: "keeper_failed", reason: keeper.reason, ...extra };

  const textSha = sha256(input.text);
  const checked = checkEntries(keeper.parsed.entries, input.text, before);
  const recommit = committed.includes(input.chapter);
  const opens = recommit ? keepLastOpens(snapshot.ledgers, input.chapter, previous, checked, input.text, before) : undefined;
  const kept = recommit ? keepLastDay(snapshot.ledgers, input.chapter, previous, opens?.accepted ?? checked.accepted, input.text, before, textSha) : undefined;
  const accepted = kept?.accepted ?? opens?.accepted ?? checked.accepted;
  const rejected = opens?.rejected ?? checked.rejected;
  // 重定稿：这章上次定稿时作者认过的出场人物不再当「第一次出场」问一遍（真跑：改两个错字重定稿，又问老郑、刀疤军官是谁）。
  const confirmedNames = previous.flatMap((entry) => (entry.kind === "presence" ? [entry.name] : []));
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
    ...("quote" in item.entry && item.entry.quote ? { quote: item.entry.quote } : {}),
    reasons: reasonTexts(item, before, resolve, later),
    optIn: optIn(item),
  });
  const entries = accepted.map((item) => item.entry);
  const day = previewDay(snapshot.ledgers, input.chapter, entries, textSha);
  const ticket: PreviewTicket = {
    id: randomBytes(8).toString("hex"),
    chapter: input.chapter,
    textSha256: draftFingerprint(input.text),
    entries,
    reviewIndexes: plan.review.map((item) => position.get(item.index) ?? -1),
    optInIndexes: plan.review.filter(optIn).map((item) => position.get(item.index) ?? -1),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  await input.tickets.put(ticket);
  return {
    ok: true,
    ticket: ticket.id,
    chapter: input.chapter,
    recommit,
    review: plan.review.map(toItem),
    auto: plan.auto.map(toItem),
    notRecorded: [
      ...rejected.map((item) => ({ code: item.reason, label: entryLabel(item.entry, before), reason: item.message })),
      ...keeper.parsed.drops.map((drop) => ({ code: "parse", label: dropLabel(drop), reason: drop.reason })),
    ],
    adjusted: keeper.parsed.adjusted.map((drop) => ({ code: "adjusted", label: dropLabel(drop), reason: drop.reason })),
    time: {
      day: day?.day ?? 1,
      dayEnd: day?.dayEnd ?? 1,
      basis: day?.dayBasis ?? "missing",
      ...(day?.weekday !== undefined ? { weekday: day.weekday } : {}),
      ...(day?.timeOfDay !== undefined ? { timeOfDay: day.timeOfDay } : {}),
      needsConfirm: plan.timeMissing || day?.dayBasis === "missing" || day?.dayBasis === "estimated" || kept?.sinceLast !== undefined,
      ...(kept?.sinceLast ? { sinceLast: kept.sinceLast } : {}),
    },
    ...(opens && opens.lost.length > 0 ? { lostThreads: opens.lost } : {}),
    omittedThreads: keeper.omittedThreads,
    omittedFacts: keeper.omittedFacts,
    ...(keeper.quoteRepair ? { quoteRepair: keeper.quoteRepair } : {}),
    ...extra,
  };
}

// —— 确认 ——

export interface ConfirmInput {
  readonly bookDir: string;
  readonly ticket: string;
  /** 现在要定稿的正文：和预览时的哈希对不上（作者又改过）就不定稿。 */
  readonly text: string;
  /** 作者去掉的清单序号。 */
  readonly excluded?: readonly unknown[];
  /** 作者勾上的「默认不写」条目序号（见 CommitItem.optIn）。 */
  readonly optedIn?: readonly unknown[];
  /** 作者改的「故事第几天」。 */
  readonly day?: unknown;
  /** 作者改的「到第几天」（这一章跨天；没给或不比 day 大＝就这一天）。 */
  readonly dayEnd?: unknown;
  readonly tickets: TicketStore;
  /** 写盘前存撤销点（失败就不写）。 */
  readonly snapshot?: (label: string, command: string) => Promise<void>;
  readonly emit?: (event: BookEvent) => void;
  readonly now?: () => Date;
}

export type ConfirmOutcome =
  | { readonly ok: true; readonly result: ChapterCommitResult; readonly version: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** 序号宽进：数字或数字字符串，非负整数才收。 */
function indexOf(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function confirmChapterCommit(input: ConfirmInput): Promise<ConfirmOutcome> {
  const ticket = await input.tickets.get(input.ticket);
  if (!ticket) return { ok: false, code: "ticket_missing", reason: "这次预览已经过期了，请重新点「定稿」预览一次" };
  if (draftFingerprint(input.text) !== ticket.textSha256) {
    return { ok: false, code: "text_changed", reason: "预览之后正文又改过，请重新点「定稿」预览一次" };
  }
  const optedIn = new Set((input.optedIn ?? []).map(indexOf).filter((index) => index !== undefined));
  const excluded = new Set([
    ...(input.excluded ?? []).map(indexOf).filter((index) => index !== undefined),
    // 默认不写的，作者没勾上就不写。
    ...(ticket.optInIndexes ?? []).filter((index) => !optedIn.has(index)),
  ]);
  const review = new Set(ticket.reviewIndexes);
  const day = indexOf(input.day);
  const dayEnd = indexOf(input.dayEnd);
  const span = day !== undefined && dayEnd !== undefined && dayEnd > day ? dayEnd - day : undefined;
  const entries: EntryInput[] = [];
  let timeSet = false;
  ticket.entries.forEach((entry, index) => {
    if (excluded.has(index)) return;
    if (entry.kind === "time" && day !== undefined && day >= 1) {
      // 作者改了天数：这一条改成作者定的，星期、时段、原句照留。章内过了几天也照作者填的「到第几天」——
      // 只填一天（或两头一样）就是这一天，记账员记的跨天一并去掉（P6 第 7 步：不然改完还是「第 N～N+1 天」，改不掉）；
      // 跨天的章改了头一天、两头都填（长篇实跑：第 24 章改成第 21 天，章里第二天那段丢了，后面的章跟着错一天）。
      const { daysSincePrevious: _drop, daysInChapter: _span, ...rest } = entry;
      entries.push({ ...rest, basis: "author", day, ...(span ? { daysInChapter: span } : {}), review: "author" } satisfies TimeInput);
      timeSet = true;
      return;
    }
    // 作者在清单上看过的，记成作者确认过。
    entries.push(review.has(index) ? { ...entry, review: "author" } : entry);
  });
  if (!timeSet && day !== undefined && day >= 1) entries.push({ kind: "time", review: "author", basis: "author", day, ...(span ? { daysInChapter: span } : {}) });

  const outcome = await runCommand(
    input.bookDir,
    chapterCommit,
    { chapter: ticket.chapter, text: input.text, entries },
    {
      caller: "author",
      idempotencyKey: `chapter-commit:${ticket.id}`,
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      ...(input.emit ? { emit: input.emit } : {}),
      ...(input.now ? { now: input.now } : {}),
    },
  );
  if (!outcome.ok) return { ok: false, code: outcome.code, reason: (outcome as CommandFailure).message };
  return { ok: true, result: outcome.result, version: outcome.version, replayed: outcome.replayed };
}
