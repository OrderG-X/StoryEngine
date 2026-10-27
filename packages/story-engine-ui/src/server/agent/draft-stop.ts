/**
 * 出稿后这一轮停下（换题材长篇实跑第 22 章：模型出完稿又一口气并发调了十几个工具——改上一章天数、出定稿预览、
 * 读一圈设定，跑了九分多钟、一百多万 token，最后回了句不相干的话）。指令里早有「出稿落工作稿后必须停」，模型不总守；
 * 这里在工具边界守住：同一轮里出了稿，除了读、核账（同一稿重核走缓存，出核账卡用）、建议下一步，别的工具不执行，
 * 如实告诉模型这一步没做（ok:false + skipped，步骤显示「已停止」；不抛错——抛错前端当服务出错，多挂一张「服务没响应」卡）。
 * 模型把出稿和定稿预览并发着调时（第 26 章：出稿还没写完，定稿预览先跑了，报「还没有工作稿」还弹了定稿窗），
 * 出稿还在写的那会儿调进来的也一样拦下。
 * 作者点的按钮（结构化动作）一次只做一件事，带着作者确认标记，不受影响。
 */
import type { ToolExecutionContext } from "@mastra/core/tools";
import { isUserConfirmedTool, REQUEST_CONTEXT_TURN_STATE_KEY, type TurnState } from "./request-context.js";

/** 出稿后同一轮还能调的。 */
const AFTER_DRAFT_ALLOWED = new Set([
  "suggest_next_steps",
  "read_state_overview",
  "read_chapters_overview",
  "read_timeline",
  "read_foundation",
  "read_draft",
  "check_continuity",
]);

const WRAPPED = Symbol("draftStop");

type Execute = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

function turnState(context: ToolExecutionContext | undefined): TurnState | undefined {
  const value = context?.requestContext?.get(REQUEST_CONTEXT_TURN_STATE_KEY);
  return value && typeof value === "object" ? (value as TurnState) : undefined;
}

/** 这一轮已经写好的那一章（没出稿就是 undefined）。 */
export function draftWrittenThisTurn(context: ToolExecutionContext | undefined): number | undefined {
  return turnState(context)?.draftWritten;
}

/**
 * 给工具套上「出稿后停」：generate_draft 写着的时候、写成了之后，白名单外的工具都不执行、报没做。
 * 工具对象是模块里的单例、对话 AI 重建时会再套一次，所以套过的不再套。
 */
export function withDraftStop<T extends Record<string, object>>(tools: T): T {
  for (const [name, tool] of Object.entries(tools)) {
    const target = tool as { execute?: Execute; [WRAPPED]?: true };
    if (target[WRAPPED] || typeof target.execute !== "function" || AFTER_DRAFT_ALLOWED.has(name)) continue;
    const original = target.execute;
    target.execute = async (input, context) => {
      const state = turnState(context);
      const drafted = state?.draftWritten;
      if (!isUserConfirmedTool(context, name)) {
        if (drafted !== undefined) {
          return { ok: false, skipped: true, summary: `这一轮已经写好第 ${drafted} 章的工作稿，这一步先不做，等作者看完稿再说。` };
        }
        if ((state?.drafting ?? 0) > 0) {
          return { ok: false, skipped: true, summary: "这一轮正在写工作稿，这一步先不做，等稿写完、作者看过再说。" };
        }
      }
      if (name !== "generate_draft" || !state) return original.call(tool, input, context);
      state.drafting = (state.drafting ?? 0) + 1;
      try {
        const output = await original.call(tool, input, context);
        if ((output as { ok?: unknown } | undefined)?.ok === true) {
          const chapter = (output as { chapter?: unknown }).chapter;
          state.draftWritten = typeof chapter === "number" ? chapter : 0;
        }
        return output;
      } finally {
        state.drafting = (state.drafting ?? 1) - 1;
      }
    };
    target[WRAPPED] = true;
  }
  return tools;
}
