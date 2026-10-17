/**
 * 「记一条作者裁定」命令（作者档）：归并线索、作者收口、线索分量、「不是问题」、这条事实记错了、补记 / 改写一条事实。
 * 指向的线索或事实必须在现在的投影里，不在就不记、如实说。
 */
import { DecisionInput, type AuthorDecision } from "../schema/decisions.js";
import { decisionsFileText, readAllLedgers, readDecisions } from "../store/book.js";
import { DECISIONS_PATH } from "../store/paths.js";
import { project } from "../projection/project.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

export interface DecisionRecordResult {
  readonly decision: string;
}

const LABELS: Record<DecisionInput["type"], string> = {
  "thread.merge": "裁定：归并线索",
  "thread.close": "裁定：线索已收",
  "thread.weight": "裁定：线索分量",
  "issue.dismiss": "裁定：不是问题",
  "fact.retract": "裁定：事实记错了",
  "fact.expire": "裁定：事实不再成立",
  "fact.assert": "裁定：补记事实",
};

export const decisionRecord: WriteCommandSpec<DecisionInput, DecisionRecordResult> = {
  name: "decision.record",
  tier: "author",
  summary: "记一条作者裁定。",
  args: DecisionInput,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const [ledgers, decisions] = await Promise.all([readAllLedgers(context.bookDir), readDecisions(context.bookDir)]);
    const current = project({ ledgers, decisions });
    const threads = new Set(current.threads.map((thread) => thread.id));
    if (args.type === "thread.merge") {
      if (!threads.has(args.into) || args.from.some((id) => !threads.has(id) || id === args.into)) {
        return fail("unknown_thread", "要归并的线索有的已经不在了，没有归并。");
      }
    }
    if ((args.type === "thread.close" || args.type === "thread.weight") && !threads.has(args.thread)) {
      return fail("unknown_thread", "这条线索已经不在了。");
    }
    if ((args.type === "fact.retract" || args.type === "fact.expire") && !current.facts.some((fact) => fact.id === args.fact)) {
      return fail("unknown_fact", "这条事实已经不在了。");
    }
    if (args.type === "fact.assert") {
      if (!current.chapters.some((chapter) => chapter.chapter === args.chapter)) {
        return fail("unknown_chapter", `第 ${args.chapter} 章还没定稿，事实没法算在那一章。`);
      }
      if (args.corrects !== undefined && !current.facts.some((fact) => fact.id === args.corrects && fact.status !== "retracted")) {
        return fail("unknown_fact", "要改的那条事实已经不在了。");
      }
    }
    let max = 0;
    for (const decision of decisions) {
      const seq = Number(decision.id.slice(2));
      if (decision.id.startsWith("d-") && Number.isInteger(seq) && seq > max) max = seq;
    }
    const decision = { ...args, id: `d-${max + 1}`, at: context.now.toISOString() } as AuthorDecision;
    return {
      label: LABELS[args.type],
      writes: [{ path: DECISIONS_PATH, content: decisionsFileText([...decisions, decision]) }],
      changed: { decisions: true },
      result: { decision: decision.id },
    };
  },
};
