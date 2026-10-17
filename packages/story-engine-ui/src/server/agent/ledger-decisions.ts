/**
 * 改账（重构 P3 起）：手动改账是「作者裁定」，只有作者点了「确认改账」按钮才记（新核心的作者档命令）。
 *
 *   对话 AI 调 manage_ledger → planLedgerChange 把要改什么翻成裁定草案（指向的事实 / 线索按编号或原话查准，
 *   查不准就如实说、列候选，绝不猜）→ 界面出「确认改账」按钮 → 作者点了 → applyLedgerDecisions 存一个撤销点、
 *   逐条记裁定 → 重生成老格式镜像。
 *
 * 老代码直接改 story/*.json 的那套（edit_fact_ledger / resolve_thread / group_related_leads / clean_legacy_threads /
 * set_foreshadowing_importance）在新核心下会被镜像盖掉（删了等于没删），已整体换成这里。
 */
import {
  decisionRecord,
  DecisionInput,
  nameKey,
  projectBook,
  runCommand,
  sha256,
  type BookProjection,
  type FactView,
  type ThreadView,
} from "@actalk/story-core";

import { ensureBookOnCore } from "../legacy-mirror/ensure.js";
import { syncLegacyMirror } from "../legacy-mirror/sync.js";
import { createSnapshot } from "../lib/snapshot.js";

/** 一次最多改几条（按钮带着裁定走，防一次塞太多看不清）。 */
export const MAX_DECISIONS_PER_CHANGE = 20;

export interface LedgerChangeRequest {
  readonly op: "add" | "update" | "remove" | "supersede" | "resolve" | "clean" | "group" | "importance";
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
}

/** 一份待作者确认的改账：按钮原样带回。 */
export interface LedgerChangeProposal {
  readonly key: string;
  readonly decisions: readonly DecisionInput[];
  /** 给作者看的每一条（只有名字 / 原话，没有编号）。 */
  readonly lines: readonly string[];
}

export type LedgerPlanOutcome =
  | ({ readonly ok: true } & LedgerChangeProposal)
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
  const key = `ledger:${sha256(JSON.stringify(decisions)).slice(0, 12)}:${Date.now().toString(36)}`;
  return { ok: true, key, decisions, lines };
}

/** 把一次改账请求翻成裁定草案。不写盘（老书没接上新核心时会先导入，导入前存撤销点）。 */
export async function planLedgerChange(projectDir: string, request: LedgerChangeRequest): Promise<LedgerPlanOutcome> {
  if (request.op === "clean") {
    return fail(
      "not_needed",
      "新账本只记带原句的线索，不再有要清的碎片；讲同一件事的几条线索可以归并（说出要并的几条，第一条留下）。",
    );
  }
  const onCore = await ensureBookOnCore(projectDir, { snapshot: (label) => createSnapshot(projectDir, label).then(() => undefined) });
  if (!onCore.ok) return fail("not_on_core", `这本书的账还没接到新格式上：${onCore.reason}`);
  const view = await projectBook(projectDir);
  if (view.chapters.length === 0) return fail("no_chapters", "还没有定稿的章，账本是空的；先定稿一章再改账。");
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

export interface LedgerApplyOutcome {
  readonly ok: boolean;
  /** 记上了几条。 */
  readonly applied: number;
  readonly summary: string;
}

/** 作者点了「确认改账」：存一个撤销点，逐条记裁定（幂等：点两次只记一次），再重生成老格式镜像。 */
export async function applyLedgerDecisions(projectDir: string, input: { readonly key: string; readonly decisions: readonly unknown[]; readonly label?: string }): Promise<LedgerApplyOutcome> {
  const decisions: DecisionInput[] = [];
  for (const raw of input.decisions.slice(0, MAX_DECISIONS_PER_CHANGE)) {
    const parsed = DecisionInput.safeParse(raw);
    if (!parsed.success) return { ok: false, applied: 0, summary: "没改账：按钮带的改账内容不完整，请让 AI 重新提一次。" };
    decisions.push(parsed.data);
  }
  if (decisions.length === 0) return { ok: false, applied: 0, summary: "没改账：按钮里没有要改的内容。" };
  try {
    await createSnapshot(projectDir, `agent:manage_ledger${input.label ? `:${input.label.slice(0, 40)}` : ""}`);
  } catch (error) {
    return { ok: false, applied: 0, summary: `没改账：没能先存撤销点（${error instanceof Error ? error.message : String(error)}），这次一条都没记。` };
  }
  let applied = 0;
  let replayed = 0;
  const failures: string[] = [];
  for (const [index, decision] of decisions.entries()) {
    const outcome = await runCommand(projectDir, decisionRecord, decision, { caller: "author", idempotencyKey: `${input.key}:${index}` });
    if (outcome.ok) {
      if (outcome.replayed) replayed += 1;
      else applied += 1;
    } else {
      failures.push(outcome.message);
    }
  }
  const mirror = await syncLegacyMirror(projectDir);
  if (!mirror.ok) console.warn(`[manage_ledger] 改账后重生成老格式镜像没成：${mirror.reason}`);
  const parts = [
    applied > 0 ? `账改好了（${applied} 条），改前已存档，可撤销。` : replayed > 0 ? "这次改账刚才已经记过了，没有重复记。" : "没改账。",
    ...(failures.length > 0 ? [`有 ${failures.length} 条没记上：${failures.slice(0, 3).join("；")}`] : []),
    ...(mirror.ok ? [] : ["（老格式资料没同步上，下次打开书会补；裁定本身已经记好。）"]),
  ];
  return { ok: failures.length === 0 && applied + replayed > 0, applied, summary: parts.join(" ") };
}
