/**
 * 每请求 projectDir 的注入与读取——单一约定，工具与路由共用。
 *
 * Mastra v1.42 的 per-request 依赖注入用 `RequestContext`（@mastra/core/di）。
 * 路由层为每个请求 `buildProjectRequestContext(projectDir)`，通过
 * `agent.stream(messages, { requestContext })` 传入；工具 execute 的第二个参数
 * `context.requestContext` 即可读回。把 key 收敛到这里，避免各处拼字符串拼错。
 */
import { RequestContext } from "@mastra/core/di";
import type { ToolExecutionContext } from "@mastra/core/tools";

export const REQUEST_CONTEXT_PROJECT_DIR_KEY = "projectDir";
/**
 * 用户当前在前端打开/停留的章号。注入它让工具在 LLM 没明确给章号时回退到「用户当前章」，
 * 而不是引擎推断的最新章（H3：回看旧章说『续写/入库』不应对最新章动手）。
 */
export const REQUEST_CONTEXT_CURRENT_CHAPTER_KEY = "currentChapter";
/**
 * 出稿流式增量回调（每段正文 delta）。路由层注入一个把 delta 转成 SSE 事件的 sink，
 * generate_draft 工具把它穿给 writer client → 正文逐字流到前端编辑器。缺失=不流式（向后兼容）。
 */
export const REQUEST_CONTEXT_DRAFT_DELTA_SINK_KEY = "draftDeltaSink";
/**
 * 本轮用户原话。写盘工具用它做确定性「本轮意图门」：模型想调写盘工具时，
 * 必须能在用户最新一轮里找到对应写入意图；缺失则向后兼容放行。
 */
export const REQUEST_CONTEXT_USER_TURN_TEXT_KEY = "userTurnText";

/**
 * 服从补做互锁（长跑复测 #23）：missingWarrantsRetry 强制补做的工具名。
 * 该路已由 isCombinedPreviewConfirmRequest + detectMissingExecutionForRequest 在用户原话上验证过
 * 写入意图——工具层意图门再对同一段文本做一次匹配是重复裁决，且两套词表一旦有分歧就会出现
 * 「服务端强制调用 → 门拦下未授权」的自相矛盾（真机实锤：预览通过就定稿的补做 apply 被门拦）。
 * 标记了就放行；未标记的普通/A1 谎报重做调用仍走门的全文匹配（A1 的强制工具由声称文本反推，
 * 用户未必授权过，必须继续受门约束）。
 */
export const REQUEST_CONTEXT_FORCED_RETRY_TOOL_KEY = "forcedRetryTool";

/** 标记「本次调用是组合授权验证过的服务端强制补做」。 */
export function markForcedRetryTool(context: RequestContext | undefined, toolName: string | undefined): void {
  context?.set(REQUEST_CONTEXT_FORCED_RETRY_TOOL_KEY, toolName);
}

/** 工具层：读强制补做标记；与工具名一致才视为「本次强制即授权」。 */
export function isForcedRetryTool(context: ToolExecutionContext | undefined, toolName: string): boolean {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_FORCED_RETRY_TOOL_KEY);
  return raw === toolName;
}

export type DraftDeltaSink = (payload: { readonly chapter: number; readonly text: string }) => void;

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 路由层：把当前请求的 projectDir（+ 可选 currentChapter）包成 RequestContext，喂给 agent.stream/generate。
 * currentChapter 非正整数时不注入（由工具各自的默认行为兜底）。
 */
export function buildProjectRequestContext(
  projectDir: string,
  currentChapter?: number,
  draftDeltaSink?: DraftDeltaSink,
  userTurnText?: string,
): RequestContext {
  const entries: [string, unknown][] = [[REQUEST_CONTEXT_PROJECT_DIR_KEY, projectDir]];
  if (isPositiveInt(currentChapter)) entries.push([REQUEST_CONTEXT_CURRENT_CHAPTER_KEY, currentChapter]);
  if (draftDeltaSink) entries.push([REQUEST_CONTEXT_DRAFT_DELTA_SINK_KEY, draftDeltaSink]);
  if (typeof userTurnText === "string" && userTurnText.trim()) entries.push([REQUEST_CONTEXT_USER_TURN_TEXT_KEY, userTurnText]);
  return new RequestContext(entries);
}

/** 工具层：从 execute 的 context 里读出当前请求的 projectDir（缺失返回 undefined，由调用方决定如何处理）。 */
export function readProjectDirFromContext(context: ToolExecutionContext | undefined): string | undefined {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_PROJECT_DIR_KEY);
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/** 工具层：读出用户当前所在章号（缺失/非法返回 undefined）。 */
export function readCurrentChapterFromContext(context: ToolExecutionContext | undefined): number | undefined {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_CURRENT_CHAPTER_KEY);
  return isPositiveInt(raw) ? raw : undefined;
}

/** 工具层：读出出稿流式 sink（缺失返回 undefined→不流式）。 */
export function readDraftDeltaSinkFromContext(context: ToolExecutionContext | undefined): DraftDeltaSink | undefined {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_DRAFT_DELTA_SINK_KEY);
  return typeof raw === "function" ? (raw as DraftDeltaSink) : undefined;
}

/** 工具层：读出本轮用户原话（缺失/空白返回 undefined）。 */
export function readUserTurnTextFromContext(context: ToolExecutionContext | undefined): string | undefined {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_USER_TURN_TEXT_KEY);
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/**
 * 工具层：解析本次操作的有效章号。优先用 LLM 明确给的 inputChapter；它没给时回退到用户当前章；
 * 两者都没有返回 undefined（由调用方决定是报错还是用引擎默认）。
 */
export function resolveChapterFromInputOrContext(
  inputChapter: number | undefined,
  context: ToolExecutionContext | undefined,
): number | undefined {
  if (isPositiveInt(inputChapter)) return inputChapter;
  return readCurrentChapterFromContext(context);
}
