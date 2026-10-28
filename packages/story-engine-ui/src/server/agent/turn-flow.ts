/**
 * 写稿这一轮怎么走由服务端定，不由模型自由编排（外部审查 2026-10-28）。以前在工具边界一处处拦（出稿后停、出稿进行中拦），
 * 拦一处冒一处：模型先调定稿预览、再调出稿时两个都跑了（谁先进来谁跑）；出完稿又一口气读一圈、改账、出预览（第 22 章九分多钟）。
 * 现在两件事都是结构上定死的，换哪家模型都一样：
 * - 模型这一步要调哪些工具，执行前就记下（输出处理器 processOutputStep，框架先跑它、再执行工具）。这一步里有出稿 →
 *   只写这一章：同一步的别的工具一律不执行（不看先后），第二份出稿也不写。
 * - 稿写成了，这一步走完这一轮就结束（stopWhen）：一句结论、核账卡、作者要的定稿预览、下一步都由服务端出，
 *   和「写这一章」按钮同一套（user-actions 的 finishDraftTurn），不再让对话 AI 多说一轮（那一轮要等二三十秒，说的卡上都有）。
 *   没写成（被挡下、参数不对）不算，模型照常往下走、可以改了再调。
 * 没执行的工具如实报没做（ok:false + skipped，不抛错——抛错前端当服务出错，多挂一张「服务没响应」卡）。
 * 作者点的按钮（结构化动作）一次只做一件事，带着作者确认标记，不受影响。
 */
import type { RequestContext } from "@mastra/core/di";
import type { ProcessOutputStepArgs, Processor } from "@mastra/core/processors";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { isUserConfirmedTool, REQUEST_CONTEXT_TURN_STATE_KEY, type TurnState } from "./request-context.js";

export const DRAFT_TOOL = "generate_draft";

const WRAPPED = Symbol("turnFlow");

type Execute = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

export function turnStateOf(requestContext: RequestContext | undefined): TurnState | undefined {
  const value = requestContext?.get(REQUEST_CONTEXT_TURN_STATE_KEY);
  return value && typeof value === "object" ? (value as TurnState) : undefined;
}

/** 挂在对话 AI 上：每一步执行工具前记下这一步要调什么。 */
export const turnFlowProcessor = {
  id: "turn-flow",
  processOutputStep({ toolCalls, requestContext, messageList }: ProcessOutputStepArgs) {
    const state = turnStateOf(requestContext);
    if (state) state.stepTools = (toolCalls ?? []).map((call) => call.toolName);
    return messageList;
  },
} satisfies Processor<"turn-flow">;

/** stopWhen：稿写成的那一步走完，这一轮结束（框架每步走完问一次）。 */
export function endsAfterDraft(requestContext: RequestContext): () => boolean {
  return () => turnStateOf(requestContext)?.draftWritten !== undefined;
}

/** 模型这一轮的步骤走完了：之后服务端按流程接着出的（写完就出定稿预览这类）不再受这一轮的拦法管。 */
export function releaseTurnFlow(requestContext: RequestContext): void {
  requestContext.set(REQUEST_CONTEXT_TURN_STATE_KEY, {} satisfies TurnState);
}

function skipReason(state: TurnState, name: string): string | undefined {
  if (state.draftWritten) return "这一轮已经写过稿了，这一步先不做，等作者看完稿再说。";
  if (name === DRAFT_TOOL) return state.draftStarted ? "一轮只写一章，这一章这一轮先不写。" : undefined;
  return state.stepTools?.includes(DRAFT_TOOL) ? "这一轮在写工作稿，这一步先不做，等稿写完、作者看过再说。" : undefined;
}

/**
 * 出稿的结果：写成了（ok:true）记下章号、结果和作者要不要写完就出定稿预览。写好了但没换上（kept：写的途中作者改过稿、
 * 前文变了，AI 这版留在稿纸上等作者选）也算这一步走完：一句话说清就结束，不让模型再写一遍。
 */
function noteDraft(state: TurnState, output: unknown): void {
  const record = output as { readonly ok?: unknown; readonly chapter?: unknown; readonly thenPreview?: unknown; readonly kept?: unknown } | undefined;
  if ((record?.ok === true || (record?.kept !== undefined && record.kept !== null)) && typeof record?.chapter === "number") {
    state.draftWritten = { chapter: record.chapter, output, thenPreview: record.ok === true && record.thenPreview === true };
  } else {
    state.draftStarted = false;
  }
}

/**
 * 给工具套上这一轮的流程：该这一步做的才执行。出稿真开始执行才算「在写」（参数没过校验、工具没跑的不算，模型可以改了再调）。
 * 工具对象是模块里的单例、对话 AI 重建时会再套一次，所以套过的不再套。
 */
export function withTurnFlow<T extends Record<string, object>>(tools: T): T {
  for (const [name, tool] of Object.entries(tools)) {
    const target = tool as { execute?: Execute; [WRAPPED]?: true };
    if (target[WRAPPED] || typeof target.execute !== "function") continue;
    const original = target.execute;
    target.execute = async (input, context) => {
      const state = turnStateOf(context?.requestContext);
      if (!state || isUserConfirmedTool(context, name)) return original.call(tool, input, context);
      const skipped = skipReason(state, name);
      if (skipped) return { ok: false, skipped: true, summary: skipped };
      if (name !== DRAFT_TOOL) return original.call(tool, input, context);
      state.draftStarted = true;
      try {
        const output = await original.call(tool, input, context);
        noteDraft(state, output);
        return output;
      } catch (error) {
        state.draftStarted = false;
        throw error;
      }
    };
    target[WRAPPED] = true;
  }
  return tools;
}
