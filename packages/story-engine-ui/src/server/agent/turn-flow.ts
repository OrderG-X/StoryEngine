/**
 * 交操作这一轮怎么走由服务端定，不由模型自由编排（外部审查 2026-10-28；写作版本 P2a 契约第三节）。以前在工具边界一处处拦（出稿后停、出稿进行中拦），
 * 拦一处冒一处：模型先调定稿预览、再调出稿时两个都跑了（谁先进来谁跑）；出完稿又一口气读一圈、改账、出预览（第 22 章九分多钟）。
 * 现在是结构上定死的，换哪家模型都一样：
 * - 模型这一步要调哪些工具，执行前就记下（输出处理器 processOutputStep，框架先跑它、再执行工具）。
 * - 交操作（写稿 change_draft、检查 run_check 这类提交工具）：这一步里只有它一件写的事才交；同一步还有别的写（或又交一件）→
 *   整步不明（ambiguous_plan），一件都不做，模型改成一件再交。交上、受理了，这一步走完这一轮就结束：正文流、进度、结论、
 *   核账卡、定稿预览、下一步都由服务端按操作记录出（operation-turn），不再让对话 AI 多说一轮。没受理（被挡下、参数不对）
 *   模型照常往下走、可以改了再交。读的工具同一步照常执行。混合期（P2a 片 1～4）还没迁成操作的写工具也算「写」。
 * 没执行的工具如实报没做（ok:false + skipped，不抛错——抛错前端当服务出错，多挂一张「服务没响应」卡）。
 * 作者点的按钮（结构化动作）一次只做一件事，带着作者确认标记，不受影响。
 */
import type { RequestContext } from "@mastra/core/di";
import type { ProcessOutputStepArgs, Processor } from "@mastra/core/processors";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { isUserConfirmedTool, REQUEST_CONTEXT_TURN_STATE_KEY, type TurnState } from "./request-context.js";
import { SUBMIT_TOOL_NAMES } from "./tools/op-tools.js";

/** 不写书的工具：同一步里有它们不算「好几件写的事」。其余都算写（混合期还没迁成操作的写工具也算）。 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_state_overview",
  "read_chapters_overview",
  "read_timeline",
  "read_foundation",
  "read_draft",
  "read_operation",
  "web_search",
  "suggest_next_steps",
]);

const AMBIGUOUS_PLAN = "这一步同时要做好几件写的事，一件都没做：一次只交一件，交完这一轮就停。";

/** 这一步交了操作、又还有别的写（或交了两件）：整步不明。 */
function ambiguousStep(stepTools: readonly string[] | undefined): boolean {
  const writes = (stepTools ?? []).filter((name) => !READ_ONLY_TOOLS.has(name));
  return writes.length > 1 && writes.some((name) => SUBMIT_TOOL_NAMES.has(name));
}

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

/** stopWhen：交的操作受理了的那一步走完，这一轮结束（框架每步走完问一次）。 */
export function endsByFlow(requestContext: RequestContext): () => boolean {
  return () => turnStateOf(requestContext)?.operationAccepted !== undefined;
}

/** 模型这一轮的步骤走完了：之后服务端按流程接着出的（写完就出定稿预览这类）不再受这一轮的拦法管。 */
export function releaseTurnFlow(requestContext: RequestContext): void {
  requestContext.set(REQUEST_CONTEXT_TURN_STATE_KEY, {} satisfies TurnState);
}

function skipReason(state: TurnState, name: string): { readonly summary: string; readonly code?: string } | undefined {
  if (READ_ONLY_TOOLS.has(name)) return undefined;
  if (state.operationAccepted) return { summary: "这一轮已经交了一件事，这一步先不做，等它做完、作者看过再说。" };
  return ambiguousStep(state.stepTools) ? { summary: AMBIGUOUS_PLAN, code: "ambiguous_plan" } : undefined;
}

/** 交操作的结果：受理了（回执带 accepted + 操作号）记下，这一步走完这一轮就结束。没受理的模型照常往下走。 */
function noteSubmission(state: TurnState, output: unknown): void {
  const receipt = output as { readonly accepted?: unknown; readonly opId?: unknown } | undefined;
  if (receipt?.accepted === true && typeof receipt.opId === "string") state.operationAccepted = { opId: receipt.opId };
}

/**
 * 给工具套上这一轮的流程：该这一步做的才执行。
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
      if (skipped) return { ok: false, skipped: true, ...(skipped.code ? { code: skipped.code } : {}), summary: skipped.summary };
      if (!SUBMIT_TOOL_NAMES.has(name)) return original.call(tool, input, context);
      const output = await original.call(tool, input, context);
      noteSubmission(state, output);
      return output;
    };
    target[WRAPPED] = true;
  }
  return tools;
}
