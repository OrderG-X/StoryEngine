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
  type TimeBasis,
  type TimeInput,
} from "@actalk/story-core";
import type { KeeperDrop } from "./keeper-parse.js";
import { runLedgerKeeper } from "./ledger-keeper.js";
import type { ReaderWaited } from "./reader-progress.js";
import { writeAtomically, type BrainCallModel, type ColdCoverage } from "./reader-window.js";

// —— 预览票 ——

export interface PreviewTicket {
  readonly id: string;
  readonly chapter: number;
  readonly textSha256: string;
  /** 核过的条目（清单上的序号 = 这里的下标）。 */
  readonly entries: readonly EntryInput[];
  /** 要作者看的条目下标。 */
  readonly reviewIndexes: readonly number[];
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
  };
  readonly omittedThreads: number;
  readonly omittedFacts: number;
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

/** 「facts 第 3 条」→「事实」。 */
function dropLabel(drop: KeeperDrop): string {
  const head = drop.where.split(/[ .]/u)[0] ?? "";
  return `一条${KIND_LABELS[head] ?? "记录"}`;
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

function reasonTexts(item: ClassifiedEntry, before: BookProjection, resolve: (name: string) => string): CommitItem["reasons"] {
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
      case "closes-thread":
        return { code, text: "收掉这条线索后，它就不再提醒了" };
      case "new-character":
        return { code, text: "第一次出场的人物；要是已有人物的新称呼，去掉这条告诉我是谁" };
      case "time-estimated":
        return { code, text: "天数是估的" };
    }
  });
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
  const keeper = await runLedgerKeeper({
    projectDir: input.bookDir,
    chapter: input.chapter,
    draft: input.text,
    before,
    callModel: input.callModel,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
    ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    ...(input.onRawOutput ? { onRawOutput: input.onRawOutput } : {}),
  });
  const extra = { ...(keeper.cold ? { cold: keeper.cold } : {}), ...(keeper.waited ? { waited: keeper.waited } : {}) };
  if (!keeper.ok) return { ok: false, code: "keeper_failed", reason: keeper.reason, ...extra };

  const checked = checkEntries(keeper.parsed.entries, input.text, before);
  const plan = classifyForReview(checked.accepted, before, { chapter: input.chapter, ...(input.knownNames ? { knownNames: input.knownNames } : {}) });
  // 清单序号 = 核过的条目里的下标。
  const position = new Map(checked.accepted.map((item, index) => [item.index, index]));
  const resolve = subjectResolver(before);
  const toItem = (item: ClassifiedEntry): CommitItem => ({
    index: position.get(item.index) ?? -1,
    kind: item.entry.kind,
    label: entryLabel(item.entry, before),
    ...("quote" in item.entry && item.entry.quote ? { quote: item.entry.quote } : {}),
    reasons: reasonTexts(item, before, resolve),
  });
  const entries = checked.accepted.map((item) => item.entry);
  const textSha = sha256(input.text);
  const day = previewDay(snapshot.ledgers, input.chapter, entries, textSha);
  const ticket: PreviewTicket = {
    id: randomBytes(8).toString("hex"),
    chapter: input.chapter,
    textSha256: textSha,
    entries,
    reviewIndexes: plan.review.map((item) => position.get(item.index) ?? -1),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  await input.tickets.put(ticket);
  return {
    ok: true,
    ticket: ticket.id,
    chapter: input.chapter,
    recommit: committed.includes(input.chapter),
    review: plan.review.map(toItem),
    auto: plan.auto.map(toItem),
    notRecorded: [
      ...checked.rejected.map((item) => ({ code: item.reason, label: entryLabel(item.entry, before), reason: item.message })),
      ...keeper.parsed.drops.map((drop) => ({ code: "parse", label: dropLabel(drop), reason: drop.reason })),
    ],
    adjusted: keeper.parsed.adjusted.map((drop) => ({ code: "adjusted", label: dropLabel(drop), reason: drop.reason })),
    time: {
      day: day?.day ?? 1,
      dayEnd: day?.dayEnd ?? 1,
      basis: day?.dayBasis ?? "missing",
      ...(day?.weekday !== undefined ? { weekday: day.weekday } : {}),
      ...(day?.timeOfDay !== undefined ? { timeOfDay: day.timeOfDay } : {}),
      needsConfirm: plan.timeMissing || day?.dayBasis === "missing" || day?.dayBasis === "estimated",
    },
    omittedThreads: keeper.omittedThreads,
    omittedFacts: keeper.omittedFacts,
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
  /** 作者改的「故事第几天」。 */
  readonly day?: unknown;
  readonly tickets: TicketStore;
  /** 写盘前存撤销点（失败就不写）。 */
  readonly snapshot?: (label: string) => Promise<void>;
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
  if (sha256(input.text) !== ticket.textSha256) {
    return { ok: false, code: "text_changed", reason: "预览之后正文又改过，请重新点「定稿」预览一次" };
  }
  const excluded = new Set((input.excluded ?? []).map(indexOf).filter((index) => index !== undefined));
  const review = new Set(ticket.reviewIndexes);
  const day = indexOf(input.day);
  const entries: EntryInput[] = [];
  let timeSet = false;
  ticket.entries.forEach((entry, index) => {
    if (excluded.has(index)) return;
    if (entry.kind === "time" && day !== undefined && day >= 1) {
      // 作者改了天数：这一条改成作者定的，星期、时段、原句照留。
      const { daysSincePrevious: _drop, ...rest } = entry;
      entries.push({ ...rest, basis: "author", day, review: "author" } satisfies TimeInput);
      timeSet = true;
      return;
    }
    // 作者在清单上看过的，记成作者确认过。
    entries.push(review.has(index) ? { ...entry, review: "author" } : entry);
  });
  if (!timeSet && day !== undefined && day >= 1) entries.push({ kind: "time", review: "author", basis: "author", day });

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
