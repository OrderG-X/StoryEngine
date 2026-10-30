/**
 * 改账的规划（写作版本 P2a 片 3B，从 agent/ledger-decisions.ts 挪来）：一次改账请求翻成裁定草案。
 * 只算草案、不写盘；作者点「确认改账」才由 ledger.change 操作按作者档记下（见 recipes/ledger-change.ts）。
 */
import { DecisionInput, isExact, nameKey, type BookProjection, type FactView, type ThreadView } from "@actalk/story-core";
import { storySpanText } from "../../book/story-timeline.js";

/** 一次最多改几条（卡上摆得下、看得清）。 */
export const MAX_DECISIONS_PER_CHANGE = 20;

export const LEDGER_OPS = ["add", "update", "remove", "supersede", "resolve", "group", "importance", "day", "keepDay", "summary"] as const;
export type LedgerEditOp = (typeof LEDGER_OPS)[number];

export interface LedgerChangeRequest {
  readonly op: LedgerEditOp;
  readonly id?: string;
  readonly chapter?: number;
  readonly text?: string;
  readonly targetText?: string;
  readonly query?: string;
  readonly importance?: "major" | "normal" | "minor";
  readonly nature?: "hard" | "state" | "event";
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  /** group：几组线索，每组第一条留下、其余并进去。 */
  readonly groups?: readonly (readonly string[])[];
  /** day：这一章是故事第几天（到第几天）。 */
  readonly day?: number;
  readonly dayEnd?: number;
}

export type LedgerPlanOutcome =
  | { readonly ok: true; readonly decisions: readonly DecisionInput[]; readonly lines: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly reason: string };

const WEIGHT_LABELS = { major: "大伏笔（不许丢）", normal: "普通线索", minor: "小线索（停多久都不提醒）" } as const;

function quoteText(text: string, max = 40): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `「${flat.length > max ? `${flat.slice(0, max)}…` : flat}」`;
}

function lookup<T>(items: readonly T[], ref: string, idOf: (item: T) => string, textOf: (item: T) => string, what: string):
  | { readonly ok: true; readonly item: T }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  const trimmed = ref.trim();
  const byId = items.find((item) => idOf(item) === trimmed);
  if (byId) return { ok: true, item: byId };
  const key = nameKey(trimmed);
  if (!key) return { ok: false, code: "missing_target", reason: `没说是哪一条${what}。` };
  const exact = items.filter((item) => nameKey(textOf(item)) === key);
  if (exact.length === 1) return { ok: true, item: exact[0] as T };
  const partial = exact.length > 1 ? exact : items.filter((item) => nameKey(textOf(item)).includes(key));
  if (partial.length === 1) return { ok: true, item: partial[0] as T };
  if (partial.length === 0) return { ok: false, code: "not_found", reason: `账里没找到${quoteText(trimmed)}这条${what}。` };
  const shown = partial.slice(0, 5).map((item) => quoteText(textOf(item))).join("、");
  return { ok: false, code: "ambiguous", reason: `${quoteText(trimmed)}对得上 ${partial.length} 条${what}：${shown}${partial.length > 5 ? " 等" : ""}，请说清是哪一条。` };
}

const findFact = (view: BookProjection, ref: string) =>
  lookup(view.facts.filter((fact) => fact.status !== "retracted"), ref, (fact) => fact.id, (fact) => fact.text, "事实");
const findThread = (view: BookProjection, ref: string, includeClosed = true) =>
  lookup(view.threads.filter((thread) => includeClosed || thread.status !== "closed"), ref, (thread) => thread.id, (thread) => thread.title, "线索");

function fail(code: string, reason: string): LedgerPlanOutcome {
  return { ok: false, code, reason };
}

function proposal(decisions: DecisionInput[], lines: string[]): LedgerPlanOutcome {
  return { ok: true, decisions, lines };
}

/**
 * 一次改账请求翻成裁定（在一份投影上算，不写盘）。指向的事实 / 线索按编号或原话查准，查不准如实说、列候选，绝不猜。
 */
export function planOnView(view: BookProjection, request: LedgerChangeRequest): LedgerPlanOutcome {
  const latest = view.upTo;

  switch (request.op) {
    case "add": {
      if (!request.text?.trim()) return fail("missing_text", "要记的事实是什么？请说一句具体可核对的话。");
      const chapter = request.chapter ?? latest;
      if (!view.chapters.some((item) => item.chapter === chapter)) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，事实没法记在那一章。`);
      const structured = Boolean(request.subject && request.attribute && request.value);
      const nature = request.nature && request.nature !== "event" && structured ? request.nature : "event";
      return proposal(
        [{
          type: "fact.assert",
          chapter,
          nature,
          ...(structured ? { subject: request.subject, attribute: request.attribute, value: request.value } : {}),
          text: request.text.trim(),
        } as DecisionInput],
        [`在第 ${chapter} 章补记一条事实：${quoteText(request.text, 60)}${request.nature && request.nature !== "event" && !structured ? "（没说清谁、哪方面、是什么，先按「发生过的事」记）" : ""}`],
      );
    }
    case "update": {
      if (!request.id && !request.targetText) return fail("missing_target", "要改哪一条事实？");
      if (!request.text?.trim()) return fail("missing_text", "要改成什么？");
      const found = findFact(view, request.id ?? request.targetText ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      const old: FactView = found.item;
      const structured = old.nature !== "event" && old.subject && old.attribute;
      return proposal(
        [{
          type: "fact.assert",
          chapter: old.chapter,
          nature: structured ? old.nature : "event",
          ...(structured ? { subject: old.subject, attribute: old.attribute, value: request.value?.trim() || old.value } : {}),
          text: request.text.trim(),
          corrects: old.id,
        } as DecisionInput],
        [`把第 ${old.chapter} 章的事实${quoteText(old.text)}改成${quoteText(request.text, 60)}`],
      );
    }
    case "remove": {
      const found = findFact(view, request.id ?? request.targetText ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      return proposal([{ type: "fact.retract", fact: found.item.id }], [`删掉第 ${found.item.chapter} 章记错的事实${quoteText(found.item.text)}`]);
    }
    case "supersede": {
      const found = findFact(view, request.id ?? request.targetText ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      const chapter = request.chapter ?? latest;
      if (chapter <= found.item.chapter) return fail("bad_chapter", `那条事实是第 ${found.item.chapter} 章记的，「从第几章起不再成立」要在它之后。`);
      if (found.item.status !== "current") return fail("not_current", `${quoteText(found.item.text)}已经不成立了，不用再标。`);
      return proposal(
        [{ type: "fact.expire", fact: found.item.id, chapter }],
        [`事实${quoteText(found.item.text)}从第 ${chapter} 章起不再成立`],
      );
    }
    case "resolve": {
      if (!request.query?.trim() && !request.id) return fail("missing_target", "要收哪一条？请说出那条线索的标题或关键词。");
      const found = findThread(view, request.id ?? request.query ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      const thread: ThreadView = found.item;
      if (thread.status === "closed") return fail("already_closed", `线索「${thread.title}」已经收了（第 ${thread.closedAt} 章）。`);
      const chapter = request.chapter ?? latest;
      return proposal([{ type: "thread.close", thread: thread.id, chapter }], [`把线索「${thread.title}」记为第 ${chapter} 章已收`]);
    }
    case "keepDay": {
      // 作者定的天数和按记下的推出来的对不上：以作者定的为准（记「不是问题」裁定，以后不再提；两边的账都不动）。
      const chapter = request.chapter ?? latest;
      const conflicts = view.timeConflicts.filter((conflict) => conflict.chapter === chapter);
      if (conflicts.length === 0) return fail("unchanged", `第 ${chapter} 章你定的天数和记下的没有对不上的，不用改。`);
      return proposal(
        conflicts.map((conflict) => ({ type: "issue.dismiss", issue: conflict.key })),
        conflicts.map((conflict) => `第 ${chapter} 章以你定的第 ${conflict.authorDay} 天为准`),
      );
    }
    case "day": {
      const chapter = request.chapter ?? latest;
      const current = view.chapters.find((item) => item.chapter === chapter);
      if (!current) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，天数定稿时在清单上改。`);
      if (!request.day || request.day < 1) return fail("missing_day", `第 ${chapter} 章该是故事第几天？`);
      const day = request.day;
      if (request.dayEnd !== undefined && request.dayEnd < day) return fail("bad_day", `到第 ${request.dayEnd} 天比第 ${day} 天还早，请说清这一章是第几天到第几天。`);
      // 给了结尾才记结尾（和开头一样 = 明确就这一天）；只说开头的，结尾按这章里换天推（写作版本 P3 设计 2.5，T4：不再吞掉）。
      const dayEnd = request.dayEnd;
      const days = (from: number, to: number | undefined) => (to !== undefined && to > from ? `第 ${from} 天到第 ${to} 天` : `第 ${from} 天`);
      const { start, end } = current.time;
      const sameStart = isExact(start) && start.lo === day;
      if (sameStart && (dayEnd === undefined || (isExact(end) && end.lo === dayEnd))) {
        return fail("unchanged", `第 ${chapter} 章记的就是故事${storySpanText(current.time) ?? days(day, dayEnd)}，不用改。`);
      }
      const was = storySpanText(current.time);
      const from = was ? `从故事${was}` : "";
      return proposal(
        [{ type: "chapter.day", chapter, day, ...(dayEnd !== undefined ? { dayEnd } : {}) }],
        [`第 ${chapter} 章${from}改记为${from ? "" : "故事"}${days(day, dayEnd)}`],
      );
    }
    case "summary": {
      const chapter = request.chapter ?? latest;
      const current = view.chapters.find((item) => item.chapter === chapter);
      if (!current) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，梗概定稿时在清单上看。`);
      const text = request.text?.trim();
      if (!text) return fail("missing_text", `第 ${chapter} 章的梗概要改成什么？`);
      if (current.summary === text) return fail("unchanged", `第 ${chapter} 章的梗概就是这样，不用改。`);
      return proposal([{ type: "chapter.summary", chapter, text }], [`第 ${chapter} 章的梗概改成：${text}`]);
    }
    case "importance": {
      const ref = request.id ?? request.query;
      if (!ref || !request.importance) return fail("missing_target", "调大小要知道是哪一条、调成大伏笔还是小线索。");
      const found = findThread(view, ref);
      if (!found.ok) return fail(found.code, found.reason);
      return proposal(
        [{ type: "thread.weight", thread: found.item.id, weight: request.importance }],
        [`线索「${found.item.title}」定为${WEIGHT_LABELS[request.importance]}`],
      );
    }
    case "group": {
      const groups = (request.groups ?? []).filter((group) => group.length > 0);
      if (groups.length === 0) {
        return fail("missing_target", "要归并哪几条？先看开着的线索，把讲同一件事的几条一起给出（第一条留下，其余并进去）。");
      }
      const decisions: DecisionInput[] = [];
      const lines: string[] = [];
      const used = new Set<string>();
      for (const group of groups) {
        const resolved: ThreadView[] = [];
        for (const ref of group) {
          const found = findThread(view, ref);
          if (!found.ok) return fail(found.code, found.reason);
          if (!resolved.some((thread) => thread.id === found.item.id)) resolved.push(found.item);
        }
        const [into, ...from] = resolved;
        if (!into || from.length === 0) return fail("too_few", "每组至少要两条不同的线索才能归并。");
        if ([into, ...from].some((thread) => used.has(thread.id))) return fail("overlap", "同一条线索出现在两组里，请分清各组。");
        for (const thread of [into, ...from]) used.add(thread.id);
        decisions.push({ type: "thread.merge", from: from.map((thread) => thread.id), into: into.id });
        lines.push(`把 ${from.map((thread) => `「${thread.title}」`).join("")}并进「${into.title}」`);
      }
      if (decisions.length > MAX_DECISIONS_PER_CHANGE) return fail("too_many", `一次最多归并 ${MAX_DECISIONS_PER_CHANGE} 组，请分几次。`);
      return proposal(decisions, lines);
    }
  }
}


/** 一批改账请求一起算：各条的裁定、给作者看的话接起来；算不成的如实列进「没改成」（同一条裁定只记一次）。 */
export function planLedgerRequests(view: BookProjection, requests: readonly LedgerChangeRequest[]): {
  readonly decisions: readonly DecisionInput[];
  readonly lines: readonly string[];
  readonly notDone: readonly string[];
} {
  const decisions: DecisionInput[] = [];
  const lines: string[] = [];
  const notDone: string[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const planned = planOnView(view, request);
    if (!planned.ok) {
      notDone.push(planned.reason.endsWith("。") ? planned.reason.slice(0, -1) : planned.reason);
      continue;
    }
    const fresh = planned.decisions.filter((decision) => {
      const key = JSON.stringify(decision);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) continue;
    if (decisions.length + fresh.length > MAX_DECISIONS_PER_CHANGE) {
      notDone.push(`一次最多改 ${MAX_DECISIONS_PER_CHANGE} 条，${planned.lines.join("；")}这次没算上，分几次改`);
      continue;
    }
    decisions.push(...fresh);
    lines.push(...planned.lines);
  }
  return { decisions, lines, notDone };
}

/** 按钮、记录里带的裁定读回来（核心的格式校验）；不对的整批不收。 */
export function readDecisions(raw: unknown): readonly DecisionInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DECISIONS_PER_CHANGE) return undefined;
  const decisions: DecisionInput[] = [];
  for (const item of raw) {
    const parsed = DecisionInput.safeParse(item);
    if (!parsed.success) return undefined;
    decisions.push(parsed.data);
  }
  return decisions;
}

const MAX_TEXT_CHARS = 2000;
const IMPORTANCE = ["major", "normal", "minor"] as const;
const NATURES = ["hard", "state", "event"] as const;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT_CHARS) : undefined);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const oneOf = <T extends string>(items: readonly T[], value: unknown): T | undefined => items.find((item) => item === value);

/** 一条改账请求读回来（交来的参数、记录里存的）：op 不认识是 undefined；别的字段形状不对就当没给（planOnView 如实说缺什么）。 */
export function readLedgerRequest(raw: unknown): LedgerChangeRequest | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const op = oneOf(LEDGER_OPS, value.op);
  if (!op) return undefined;
  const groups = Array.isArray(value.groups)
    ? value.groups
      .map((group) => (Array.isArray(group) ? group.map(text).filter((item): item is string => item !== undefined) : []))
      .filter((group) => group.length > 0)
      .slice(0, MAX_DECISIONS_PER_CHANGE)
    : [];
  const fields: Record<string, unknown> = {
    id: text(value.id),
    chapter: positive(value.chapter),
    text: text(value.text),
    targetText: text(value.targetText),
    query: text(value.query),
    importance: oneOf(IMPORTANCE, value.importance),
    nature: oneOf(NATURES, value.nature),
    subject: text(value.subject),
    attribute: text(value.attribute),
    value: text(value.value),
    day: positive(value.day),
    dayEnd: positive(value.dayEnd),
    ...(op === "group" ? { groups } : {}),
  };
  return { op, ...Object.fromEntries(Object.entries(fields).filter(([, item]) => item !== undefined)) } as LedgerChangeRequest;
}
