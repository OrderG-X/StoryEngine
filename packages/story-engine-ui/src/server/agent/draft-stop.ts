/**
 * 出稿后这一轮停下（换题材长篇实跑第 22 章：模型出完稿又一口气并发调了十几个工具——改上一章天数、出定稿预览、
 * 读一圈设定，跑了九分多钟、一百多万 token，最后回了句不相干的话）。指令里早有「出稿落工作稿后必须停」，模型不总守；
 * 这里在工具边界守住：同一轮里出了稿，除了读、核账（同一稿重核走缓存，出核账卡用）、建议下一步，别的工具不执行，
 * 如实告诉模型这一步没做。作者点的按钮（结构化动作）一次只做一件事，带着作者确认标记，不受影响。
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
 * 给工具套上「出稿后停」：generate_draft 写成了就在这一轮的状态上记一笔；记过之后，白名单外的工具直接报没执行。
 * 工具对象是模块里的单例、对话 AI 重建时会再套一次，所以套过的不再套。
 */
export function withDraftStop<T extends Record<string, object>>(tools: T): T {
  for (const [name, tool] of Object.entries(tools)) {
    const target = tool as { execute?: Execute; [WRAPPED]?: true };
    if (target[WRAPPED] || typeof target.execute !== "function" || AFTER_DRAFT_ALLOWED.has(name)) continue;
    const original = target.execute;
    target.execute = async (input, context) => {
      const drafted = draftWrittenThisTurn(context);
      if (drafted !== undefined && !isUserConfirmedTool(context, name)) {
        throw new Error(`这一轮已经写好第 ${drafted} 章的工作稿，这一步先不做，等作者看完稿再说。`);
      }
      const output = await original.call(tool, input, context);
      if (name === "generate_draft" && (output as { ok?: unknown } | undefined)?.ok === true) {
        const chapter = (output as { chapter?: unknown }).chapter;
        const state = turnState(context);
        if (state) state.draftWritten = typeof chapter === "number" ? chapter : 0;
      }
      return output;
    };
    target[WRAPPED] = true;
  }
  return tools;
}
