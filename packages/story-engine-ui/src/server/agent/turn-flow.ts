/**
 * 写稿这一轮怎么走由服务端定，不由模型自由编排（外部审查 2026-10-28）。以前在工具边界一处处拦（出稿后停、出稿进行中拦），
 * 拦一处冒一处：模型先调定稿预览、再调出稿时两个都跑了（谁先进来谁跑）；出完稿又一口气读一圈、改账、出预览（第 22 章九分多钟）。
 * 现在三件事都是结构上定死的，换哪家模型都一样：
 * - 模型这一步要调哪些工具，执行前就记下（输出处理器 processOutputStep，框架先跑它、再执行工具）。这一步里有出稿 →
 *   只写这一章：同一步的别的工具一律不执行（不看先后），第二份出稿也不写。
 * - 出稿跑过，下一步只放出「建议下一步」（processInputStep 收窄 activeTools）：模型只能转述结果、给作者出选项。
 *   框架没按 activeTools 收窄、模型照样调了别的，工具边界也不执行。
 * - 收尾那一步走完这一轮就结束（stopWhen）。核账卡、作者要的写完出定稿预览（出稿带 thenPreview）由服务端接着出。
 * 没执行的工具如实报没做（ok:false + skipped，不抛错——抛错前端当服务出错，多挂一张「服务没响应」卡）。
 * 作者点的按钮（结构化动作）一次只做一件事，带着作者确认标记，不受影响。
 */
import type { RequestContext } from "@mastra/core/di";
import type { ProcessInputStepArgs, ProcessInputStepResult, ProcessOutputStepArgs, Processor } from "@mastra/core/processors";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { isUserConfirmedTool, REQUEST_CONTEXT_TURN_STATE_KEY, type TurnState } from "./request-context.js";

export const DRAFT_TOOL = "generate_draft";
export const CLOSING_TOOL = "suggest_next_steps";

const WRAPPED = Symbol("turnFlow");

type Execute = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

export function turnStateOf(requestContext: RequestContext | undefined): TurnState | undefined {
  const value = requestContext?.get(REQUEST_CONTEXT_TURN_STATE_KEY);
  return value && typeof value === "object" ? (value as TurnState) : undefined;
}

/** 挂在对话 AI 上：每一步执行工具前记下这一步要调什么；出稿跑过的下一步只放出「建议下一步」。 */
export const turnFlowProcessor = {
  id: "turn-flow",
  processInputStep({ requestContext }: ProcessInputStepArgs): ProcessInputStepResult | undefined {
    const state = turnStateOf(requestContext);
    if (!state?.draftStarted) return undefined;
    state.closing = true;
    return { activeTools: [CLOSING_TOOL] };
  },
  processOutputStep({ toolCalls, requestContext, messageList }: ProcessOutputStepArgs) {
    const state = turnStateOf(requestContext);
    if (state) state.stepTools = (toolCalls ?? []).map((call) => call.toolName);
    return messageList;
  },
} satisfies Processor<"turn-flow">;

/** stopWhen：出稿后的收尾那一步走完，这一轮结束（框架每步走完问一次）。 */
export function endsAfterDraftClosing(requestContext: RequestContext): () => boolean {
  return () => turnStateOf(requestContext)?.closing === true;
}

function skipReason(state: TurnState, name: string): string | undefined {
  if (state.closing) return name === CLOSING_TOOL ? undefined : "这一轮已经写过稿了，这一步先不做，等作者看完稿再说。";
  if (name === DRAFT_TOOL) return state.draftStarted ? "一轮只写一章，这一章这一轮先不写。" : undefined;
  return state.stepTools?.includes(DRAFT_TOOL) ? "这一轮在写工作稿，这一步先不做，等稿写完、作者看过再说。" : undefined;
}

/**
 * 给工具套上这一轮的流程：该这一步做的才执行。出稿真开始执行才算「写过稿」（参数没过校验、工具没跑的不算，模型可以改了再调）。
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
      if (name === DRAFT_TOOL) state.draftStarted = true;
      return original.call(tool, input, context);
    };
    target[WRAPPED] = true;
  }
  return tools;
}
