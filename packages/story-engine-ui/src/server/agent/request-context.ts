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
 * 作者在这段对话窗口里说过的话（user 消息原文，旧→新）。重构 P4 起只用来「找原句」：
 * 模型转述作者的话（如出稿的 chapterGoal）时，核对它确实出自作者之口。不用来猜意图。
 */
export const REQUEST_CONTEXT_AUTHOR_WORDS_KEY = "authorWords";

/**
 * 用户显式确认的工具（结构化动作，2026-10-07 拆补丁塔）：用户在界面上点了「确认定稿」这类按钮，
 * 前端发结构化动作、服务端直接执行对应工具——按钮点击本身就是授权，工具层见此标记才真写盘。
 * 只由 agent-chat 的结构化动作通道设置；模型自己发起的调用永远不带它。
 */
export const REQUEST_CONTEXT_USER_CONFIRMED_TOOL_KEY = "userConfirmedTool";

/**
 * R7.2：上一个有写盘回合的首个快照（该回合第一次写盘前）+ 该回合写盘处数。
 * 前端从 turnSnapshots[0] 带来；undo 工具优先按它整回合回退（作者说「撤销上一步」指上一回合全部改动）。
 */
export const REQUEST_CONTEXT_LAST_TURN_UNDO_HINT_KEY = "lastTurnUndoHint";

export interface LastTurnUndoHint {
  /** git commit id（40 位十六进制）。 */
  readonly snapshotId: string;
  /** 上一回合写盘改动的处数（turnSnapshots 条数）。 */
  readonly changes: number;
}

/** 容错解析：snapshotId 必须是 40 位十六进制 commit id，changes 必须是正整数；其余（缺省/非法）一律 undefined。 */
export function parseLastTurnUndoHint(raw: unknown): LastTurnUndoHint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const snapshotId = record.snapshotId;
  const changes = record.changes;
  if (typeof snapshotId !== "string" || !/^[0-9a-f]{40}$/u.test(snapshotId)) return undefined;
  if (typeof changes !== "number" || !Number.isInteger(changes) || changes < 1) return undefined;
  return { snapshotId, changes };
}

/** 标记「本次执行是用户点按钮确认过的」（undefined 清除）。 */
export function markUserConfirmedTool(context: RequestContext | undefined, toolName: string | undefined): void {
  context?.set(REQUEST_CONTEXT_USER_CONFIRMED_TOOL_KEY, toolName);
}

/** 工具层：本次调用是否为用户按钮确认（工具名一致才算）。 */
export function isUserConfirmedTool(context: ToolExecutionContext | undefined, toolName: string): boolean {
  return context?.requestContext?.get(REQUEST_CONTEXT_USER_CONFIRMED_TOOL_KEY) === toolName;
}

/**
 * 出稿流式 sink：text = 正文增量；phase = 出稿进行到哪一步（plan 拟章纲 / write 写正文，text 为空串）。
 * 拟章纲要一两分钟、这期间稿纸是空的，作者得知道 AI 在干什么。
 */
export type DraftDeltaSink = (payload: { readonly chapter: number; readonly text: string; readonly phase?: "plan" | "write" }) => void;

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 路由层：把当前请求的 projectDir（+ 可选 currentChapter / lastTurnUndoHint）包成 RequestContext，
 * 喂给 agent.stream/generate。currentChapter 非正整数时不注入（由工具各自的默认行为兜底）。
 */
export function buildProjectRequestContext(
  projectDir: string,
  currentChapter?: number,
  draftDeltaSink?: DraftDeltaSink,
  authorWords?: readonly string[],
  lastTurnUndoHint?: LastTurnUndoHint,
): RequestContext {
  const entries: [string, unknown][] = [[REQUEST_CONTEXT_PROJECT_DIR_KEY, projectDir]];
  if (isPositiveInt(currentChapter)) entries.push([REQUEST_CONTEXT_CURRENT_CHAPTER_KEY, currentChapter]);
  if (draftDeltaSink) entries.push([REQUEST_CONTEXT_DRAFT_DELTA_SINK_KEY, draftDeltaSink]);
  const words = (authorWords ?? []).filter((text) => typeof text === "string" && text.trim());
  if (words.length > 0) entries.push([REQUEST_CONTEXT_AUTHOR_WORDS_KEY, words]);
  if (lastTurnUndoHint) entries.push([REQUEST_CONTEXT_LAST_TURN_UNDO_HINT_KEY, lastTurnUndoHint]);
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

/** 工具层：读出作者在这段对话里说过的话（缺失返回 undefined——不是对话通道调的，如按钮直达）。 */
export function readAuthorWordsFromContext(context: ToolExecutionContext | undefined): readonly string[] | undefined {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_AUTHOR_WORDS_KEY);
  if (!Array.isArray(raw)) return undefined;
  const words = raw.filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  return words.length > 0 ? words : undefined;
}

/** 工具层：读出「上一个有写盘回合的首个快照」锚点（缺失/形状不对返回 undefined，undo 走默认逐步回退）。 */
export function readLastTurnUndoHintFromContext(context: ToolExecutionContext | undefined): LastTurnUndoHint | undefined {
  const raw = context?.requestContext?.get(REQUEST_CONTEXT_LAST_TURN_UNDO_HINT_KEY);
  return parseLastTurnUndoHint(raw);
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
