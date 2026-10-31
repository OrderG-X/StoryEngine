/**
 * 「记作者裁定」命令（作者档）：归并线索、作者收口、线索分量、「不是问题」、这条事实记错了、补记 / 改写一条事实、改天数、改梗概、
 * 东西并成一样 / 拆开 / 这条记错了 / 定到某章末在哪（P3b 设计 2.7）。
 * 一次可以记几条（作者点一次「确认改账」），整批一个事务：要么全记上，要么一条都不记——
 * 不会出现记了一半、重点按钮时后半截照旧依据执行的情况（写作版本 P1a 复核）。
 * 指向的线索或事实必须在投影里（含同一批前面几条记完之后的样子），不在就整批不记、如实说是第几条。
 */
import { z } from "zod";
import { DecisionInput, itemStateLinksOf, type AuthorDecision, type ItemPosition } from "../schema/decisions.js";
import { itemRefsOf, type ChapterLedger, type FactEntry, type ItemEntry } from "../schema/ledger.js";
import { itemResolver } from "../projection/items.js";
import { decisionsFileText, readAllLedgers, readCards, readDecisions } from "../store/book.js";
import { DECISIONS_PATH } from "../store/paths.js";
import { project } from "../projection/project.js";
import type { BookProjection } from "../projection/types.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

/** 一次最多记几条。 */
export const MAX_DECISIONS_PER_RECORD = 50;

export const DecisionRecordArgs = z.object({
  decisions: z.array(DecisionInput).min(1).max(MAX_DECISIONS_PER_RECORD),
});
export type DecisionRecordArgs = z.infer<typeof DecisionRecordArgs>;

export interface DecisionRecordResult {
  /** 记上的裁定编号，和参数里的顺序一样。 */
  readonly decisions: readonly string[];
}

const LABELS: Record<DecisionInput["type"], string> = {
  "thread.merge": "裁定：归并线索",
  "thread.close": "裁定：线索已收",
  "thread.weight": "裁定：线索分量",
  "issue.dismiss": "裁定：不是问题",
  "fact.retract": "裁定：事实记错了",
  "fact.expire": "裁定：事实不再成立",
  "fact.assert": "裁定：补记事实",
  "chapter.day": "裁定：改这一章的天数",
  "chapter.summary": "裁定：改这一章的梗概",
  "item.merge": "裁定：这几样是同一样东西",
  "item.split": "裁定：这几处是另一样东西",
  "item.retract": "裁定：东西这条记错了",
  "item.state": "裁定：东西到这章末在哪",
};

/** 一条东西条目（账单里的）。 */
function itemEntryOf(ledgers: readonly ChapterLedger[], id: string): { readonly chapter: number; readonly entry: ItemEntry | FactEntry } | undefined {
  for (const ledger of ledgers) {
    const entry = ledger.entries.find((item) => item.id === id);
    if (entry?.kind === "item" || (entry?.kind === "fact" && entry.subjectRef?.id !== undefined)) return { chapter: ledger.chapter, entry };
  }
  return undefined;
}

/** 拆开点名的那一处：在不在、现在是不是指着这样东西。 */
function positionPoints(ledgers: readonly ChapterLedger[], current: BookProjection, item: string, ref: ItemPosition, resolve: (raw: string, position: ItemPosition) => string): boolean {
  const found = itemEntryOf(ledgers, ref.entry);
  if (!found) return false;
  const { entry } = found;
  if (entry.kind === "fact") return ref.at === "subject" && entry.subjectRef?.id !== undefined && resolve(entry.subjectRef.id, ref) === item;
  const hit = itemRefsOf(entry).find((at) => at.at === ref.at && (at.index ?? undefined) === (ref.index ?? undefined));
  return hit !== undefined && current.items.some((view) => view.id === item) && resolve(hit.ref.id, ref) === item;
}

/** 东西的裁定在 current 上能不能记。 */
function itemRejectReason(current: BookProjection, ledgers: readonly ChapterLedger[], decisions: readonly AuthorDecision[], args: DecisionInput): { readonly code: string; readonly message: string } | undefined {
  const items = new Set(current.items.map((item) => item.id));
  const committed = (chapter: number) => current.chapters.some((item) => item.chapter === chapter);
  const resolve = itemResolver(decisions);
  const unknown = { code: "unknown_item", message: "这样东西已经不在了。" };
  switch (args.type) {
    case "item.merge":
      if (!items.has(args.into) || args.from.some((id) => !items.has(id) || id === args.into)) return { code: "unknown_item", message: "要并的东西有的已经不在了，没有并。" };
      return undefined;
    case "item.split":
      if (!items.has(args.item)) return unknown;
      if (args.refs.some((ref) => !positionPoints(ledgers, current, args.item, ref, resolve))) return { code: "unknown_entry", message: "要拆开的那几处有的已经不是这样东西了，没有拆。" };
      return undefined;
    case "item.retract":
      return itemEntryOf(ledgers, args.entry)?.entry.kind === "item" ? undefined : { code: "unknown_entry", message: "这条东西的记录已经不在了。" };
    case "item.state": {
      if (!items.has(args.item)) return unknown;
      if (!committed(args.chapter)) return { code: "unknown_chapter", message: `第 ${args.chapter} 章还没定稿，没法定这章末东西在哪。` };
      const refs = args.state.kind === "census" ? args.state.members.map((member) => member.id) : args.state.kind === "at" && args.state.to.kind === "inside" ? [args.state.to.ref.id] : [];
      if (refs.some((id) => !items.has(id) || id === args.item)) return { code: "unknown_item", message: "要装进去的东西有的已经不在了。" };
      // 关联的旧记法事实：在投影里、不晚于这一章（设计 2.6）。
      const facts = itemStateLinksOf(args).flatMap((link) => [...link.replaces, ...link.overlaps]);
      if (facts.some((id) => !current.facts.some((fact) => fact.id === id && fact.chapter <= args.chapter))) return { code: "unknown_fact", message: "要对上的那条旧事实已经不在了。" };
      return undefined;
    }
    case "fact.assert":
      return args.subjectId !== undefined && !items.has(args.subjectId) ? unknown : undefined;
    default:
      return undefined;
  }
}

/** 这一条在 current 上能不能记；不能就说为什么。 */
function rejectReason(current: BookProjection, args: DecisionInput): { readonly code: string; readonly message: string } | undefined {
  const threads = new Set(current.threads.map((thread) => thread.id));
  const committed = (chapter: number) => current.chapters.some((item) => item.chapter === chapter);
  if (args.type === "thread.merge") {
    if (!threads.has(args.into) || args.from.some((id) => !threads.has(id) || id === args.into)) {
      return { code: "unknown_thread", message: "要归并的线索有的已经不在了，没有归并。" };
    }
  }
  if ((args.type === "thread.close" || args.type === "thread.weight") && !threads.has(args.thread)) {
    return { code: "unknown_thread", message: "这条线索已经不在了。" };
  }
  if ((args.type === "fact.retract" || args.type === "fact.expire") && !current.facts.some((fact) => fact.id === args.fact)) {
    return { code: "unknown_fact", message: "这条事实已经不在了。" };
  }
  if (args.type === "chapter.day" && !committed(args.chapter)) {
    return { code: "unknown_chapter", message: `第 ${args.chapter} 章还没定稿，天数没法改。` };
  }
  if (args.type === "chapter.summary" && !committed(args.chapter)) {
    return { code: "unknown_chapter", message: `第 ${args.chapter} 章还没定稿，梗概没法改。` };
  }
  if (args.type === "fact.assert") {
    if (!committed(args.chapter)) return { code: "unknown_chapter", message: `第 ${args.chapter} 章还没定稿，事实没法算在那一章。` };
    if (args.corrects !== undefined && !current.facts.some((fact) => fact.id === args.corrects && fact.status !== "retracted")) {
      return { code: "unknown_fact", message: "要改的那条事实已经不在了。" };
    }
  }
  return undefined;
}

export const decisionRecord: WriteCommandSpec<DecisionRecordArgs, DecisionRecordResult> = {
  name: "decision.record",
  tier: "author",
  summary: "记作者裁定（一次一条或几条，整批要么全记上、要么都不记）。",
  args: DecisionRecordArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const [ledgers, existing, cards] = await Promise.all([readAllLedgers(context.bookDir), readDecisions(context.bookDir), readCards(context.bookDir)]);
    let max = 0;
    for (const decision of existing) {
      const seq = Number(decision.id.slice(2));
      if (decision.id.startsWith("d-") && Number.isInteger(seq) && seq > max) max = seq;
    }
    const decisions: AuthorDecision[] = [...existing];
    const recorded: string[] = [];
    for (const [index, input] of args.decisions.entries()) {
      // 每条按前面几条记完之后的样子核（先归并、再收口这类一批里前后相关的照样成）。
      const current = project({ ledgers, decisions, ...(cards ? { cards } : {}) });
      const rejected = rejectReason(current, input) ?? itemRejectReason(current, ledgers, decisions, input);
      if (rejected) {
        return fail(rejected.code, args.decisions.length > 1 ? `第 ${index + 1} 条：${rejected.message}这一批一条都没记。` : rejected.message);
      }
      max += 1;
      const decision = { ...input, id: `d-${max}`, at: context.now.toISOString() } as AuthorDecision;
      decisions.push(decision);
      recorded.push(decision.id);
    }
    const first = args.decisions[0] as DecisionInput;
    return {
      label: args.decisions.length > 1 ? `${LABELS[first.type]}等 ${args.decisions.length} 条` : LABELS[first.type],
      writes: [{ path: DECISIONS_PATH, content: decisionsFileText(decisions) }],
      changed: { decisions: true },
      result: { decisions: recorded },
    };
  },
};
