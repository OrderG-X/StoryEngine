/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿清单「确认定稿」、建议条、卡上的按钮）发来的明确指令，
 * 服务端直接执行，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 新操作、「接着做」「不要了」、等作者点的按钮都交给执行器（写作版本 P2a）；还没迁过来的（裁剪、撤销上一步）按工具名直接跑，
 * 事件协议与 agent 回合一致（tool-call / tool-result / text-delta），收尾文本确定性生成，不调模型。
 */
import type { RequestContext } from "@mastra/core/di";

import { isOperationId } from "../lib/operations/store.js";
import { markUserConfirmedTool } from "./request-context.js";
import type { InspectMode } from "../services/inspect-service.js";
import { PLAN_PROPOSE_KIND, readPlanProposeParams, type PlanProposeParams } from "../services/operations/recipes/plan-propose.js";
import { SETTINGS_CHANGE_KIND } from "../services/operations/recipes/settings-change.js";
import { LEDGER_CHANGE_KIND, MAX_LEDGER_CHANGES } from "../services/operations/recipes/ledger-change.js";
import { readLedgerRequest, type LedgerChangeRequest } from "../services/ledger-change/plan.js";
import { CANON_PROPOSE_KIND, canonInputOf, readCanonProposeParams, type CanonProposeInput } from "../services/operations/recipes/canon-propose.js";
import { COMMIT_PREPARE_KIND, readCommitPrepareParams, type CommitPrepareParams } from "../services/operations/recipes/commit-prepare.js";
import {
  isCandidateDecisionKind,
  isDraftEditMode,
  readCandidateDecisionParams,
  readDraftChangeParams,
  readDraftEditParams,
  type CandidateDecisionKind,
  type CandidateDecisionParams,
  type DraftChangeMode,
  type DraftChangeParams,
  type DraftEditMode,
  type DraftEditParams,
} from "../services/draft-change/params.js";
import { runOperationAction } from "./operation-turn.js";

/** 允许经按钮直接执行的工具（白名单；新增前想清楚它是否真需要绕过模型）。 */
export const USER_ACTION_TOOL_NAMES = [
  "prune_snapshots",
  "manage_snapshots",
] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];
/** 不走工具、服务端直接执行的作者命令（「撤销上一步」）。 */
const DIRECT_ACTION_NAMES = ["undo"] as const;

/**
 * 按钮交给执行器的（写作版本 P2a 契约第四节）：新操作（核账、审稿……）出按钮的时候就带好请求号和 issuedAt，点几次都是这一次；
 * 「接着做」「不要了」接着一次停着的操作。检查（inspect.run）、写稿和改稿（draft.change：写这一章 / 重写 / 接着往下写 /
 * 改这处 / 改掉这句 / 选中文字改写）、换上 / 不要 AI 稿（draft.adopt / draft.discard）、想走法（plan.propose）是操作，别的按钮随各自那一片迁过来。
 */
export type OperationAction =
  | {
    readonly kind: "new";
    readonly type: "inspect.run";
    readonly mode: InspectMode;
    readonly params: { readonly chapter: number; readonly fresh?: true };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  | {
    readonly kind: "new";
    readonly type: "draft.change";
    readonly mode: DraftChangeMode;
    readonly params: DraftChangeParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 改稿（片 2C）：核账卡「改这处 / 改掉这 N 处」= fix、AI 味卡「改掉这句 / 一键全修」= deai、选中文字改写 = revise（先给作者看）。 */
  | {
    readonly kind: "new";
    readonly type: "draft.change";
    readonly mode: DraftEditMode;
    readonly params: DraftEditParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 作者挑的 AI 稿（片 2D）：稿纸提示条「换成 AI 这版 / 不要了」、「另外几版」卡「用这版」。 */
  | {
    readonly kind: "new";
    readonly type: CandidateDecisionKind;
    readonly params: CandidateDecisionParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 想走法（片 2D）：稿纸上方「给我几种走法」「再来几种」。idea = 作者填的想法原话；avoid = 已经给过的走法名字。 */
  | {
    readonly kind: "new";
    readonly type: typeof PLAN_PROPOSE_KIND;
    readonly params: PlanProposeParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「认下」（片 3）：那次改设定里 AI 刚写进去的那几处算作者写的。accept = 那次改设定的操作号。 */
  | {
    readonly kind: "new";
    readonly type: typeof SETTINGS_CHANGE_KIND;
    readonly params: { readonly accept: string };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 作者在线索板 / 梗概上直接改账（片 3）：这几笔不再问，直接记（作者档、存档、可撤销）。 */
  | {
    readonly kind: "new";
    readonly type: typeof LEDGER_CHANGE_KIND;
    readonly mode: "author";
    readonly params: { readonly changes: readonly LedgerChangeRequest[] };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 核账卡「以第 N 章为准 / 以本章为准 / 以设定为准 / 以定论为准」、设定本「查前文」、定论卡「重新查」：查全书出定论卡。 */
  | {
    readonly kind: "new";
    readonly type: typeof CANON_PROPOSE_KIND;
    readonly mode: "pick" | "statement";
    readonly params: CanonProposeInput;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「定稿」「就这么短，照样定稿」：出这一章的定稿清单（allowShort 只认按钮）。 */
  | {
    readonly kind: "new";
    readonly type: typeof COMMIT_PREPARE_KIND;
    readonly params: CommitPrepareParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「接着做」；等作者点按钮的（「换上 / 再改一版」「确认改设定」「确认改账」「确认定稿」）带上是哪个按钮、点的哪个、划掉了哪几处、填的几栏。 */
  | {
    readonly kind: "resume";
    readonly opId: string;
    /** 填的几栏（定稿清单上作者改的天数）：只收形状对的，是不是卡上有的、在不在范围里由执行器对着待办核。 */
    readonly answer?: { readonly actionId: string; readonly decision: string; readonly excluded?: readonly string[]; readonly values?: Readonly<Record<string, number>> };
  }
  | { readonly kind: "cancel"; readonly opId: string };

/** 「确认裁剪」：把操作历史裁到最近 keep 条（缺省=引擎默认 200）。 */
export type UserAction =
  | OperationAction
  | { readonly toolName: "prune_snapshots"; readonly keep?: number }
  /** 「撤销上一步」按钮（重构 P4）：撤上一回合的写盘改动（同对话里说「撤销上一步」的 manage_snapshots op=undo）。 */
  | { readonly toolName: "undo" };

/** 清单一次最多划掉多少处（防异常请求体）。 */
const MAX_EXCLUDED = 500;
/** 按钮一次最多填几栏。 */
const MAX_VALUES = 8;

/** body.action 解析：缺省 → none（普通对话）；形状不对 → invalid（路由回 400，绝不静默当普通对话）。 */
export type ParsedUserAction =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "action"; readonly action: UserAction };

const INSPECT_MODES: readonly InspectMode[] = ["continuity", "quality", "review", "flavor"];
const MAX_DRAFT_DIRECTION = 2000;

/** 按钮带的请求号：出按钮时给的 UUID（字母数字和 `-_`，1～64 位）。 */
function readRequestKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : undefined;
}

/** 按钮交给执行器的动作（新操作 / 接着做 / 不要了）：形状不对一律 invalid，不当普通对话。 */
function parseOperationAction(record: Record<string, unknown>): ParsedUserAction {
  if (record.kind === "resume" || record.kind === "cancel") {
    const opId = typeof record.opId === "string" ? record.opId.trim() : "";
    if (!isOperationId(opId)) return { kind: "invalid", reason: "这次操作的号不对。" };
    if (record.kind === "resume" && record.answer !== undefined) {
      const answer = typeof record.answer === "object" && record.answer !== null ? record.answer as Record<string, unknown> : {};
      const actionId = typeof answer.actionId === "string" && /^[A-Za-z0-9:_-]{1,64}$/u.test(answer.actionId) ? answer.actionId : undefined;
      const decision = typeof answer.decision === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(answer.decision) ? answer.decision : undefined;
      if (!actionId || !decision) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
      // 划掉的几处（定论卡上每句的键）：只收形状对的，是不是卡上有的由执行器对着待办核。
      const excluded = answer.excluded === undefined ? [] : Array.isArray(answer.excluded) ? answer.excluded : undefined;
      if (!excluded || excluded.length > MAX_EXCLUDED || excluded.some((key) => typeof key !== "string" || !/^[A-Za-z0-9:_-]{1,40}$/u.test(key))) {
        return { kind: "invalid", reason: "划掉的那几处不对，请刷新后再点。" };
      }
      const rawValues = answer.values === undefined ? {} : typeof answer.values === "object" && answer.values !== null && !Array.isArray(answer.values) ? answer.values as Record<string, unknown> : undefined;
      const valueEntries = rawValues ? Object.entries(rawValues) : undefined;
      if (!valueEntries || valueEntries.length > MAX_VALUES || valueEntries.some(([key, value]) => !/^[A-Za-z0-9_]{1,32}$/u.test(key) || typeof value !== "number" || !Number.isInteger(value))) {
        return { kind: "invalid", reason: "填的数不对，请刷新后再点。" };
      }
      const values = Object.fromEntries(valueEntries) as Record<string, number>;
      return {
        kind: "action",
        action: {
          kind: "resume",
          opId,
          answer: { actionId, decision, ...(excluded.length > 0 ? { excluded: excluded as string[] } : {}), ...(valueEntries.length > 0 ? { values } : {}) },
        },
      };
    }
    return { kind: "action", action: { kind: record.kind, opId } };
  }
  if (record.kind !== "new") return { kind: "invalid", reason: "不支持的操作。" };
  if (record.type !== "inspect.run" && record.type !== "draft.change" && record.type !== PLAN_PROPOSE_KIND && record.type !== SETTINGS_CHANGE_KIND && record.type !== LEDGER_CHANGE_KIND && record.type !== CANON_PROPOSE_KIND && record.type !== COMMIT_PREPARE_KIND && !isCandidateDecisionKind(record.type)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {};
  const requestKey = readRequestKey(record.requestKey);
  const issuedAt = typeof record.issuedAt === "string" && record.issuedAt.length <= 40 && Number.isFinite(Date.parse(record.issuedAt)) ? record.issuedAt : undefined;
  if (!requestKey || !issuedAt) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
  const stamp = { requestKey, issuedAt: new Date(Date.parse(issuedAt)).toISOString() };
  if (record.type === SETTINGS_CHANGE_KIND) {
    // 按钮只有「认下」这一种（改设定本身是对话 AI 交的；作者自己改走设定本）。
    const accept = typeof params.accept === "string" && isOperationId(params.accept) ? params.accept : undefined;
    if (!accept) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
    return { kind: "action", action: { kind: "new", type: SETTINGS_CHANGE_KIND, params: { accept }, ...stamp } };
  }
  if (record.type === LEDGER_CHANGE_KIND) {
    // 按钮只有作者直接改这一种（对话 AI 提的改账停着等「确认改账」，点的是 resume）。
    const items = Array.isArray(params.changes) ? params.changes : [];
    const changes = items.map(readLedgerRequest);
    if (record.mode !== "author" || items.length === 0 || items.length > MAX_LEDGER_CHANGES || changes.some((item) => item === undefined)) {
      return { kind: "invalid", reason: "改账内容不对，请刷新后再点。" };
    }
    return { kind: "action", action: { kind: "new", type: LEDGER_CHANGE_KIND, mode: "author", params: { changes: changes as LedgerChangeRequest[] }, ...stamp } };
  }
  if (record.type === CANON_PROPOSE_KIND) {
    const canon = readCanonProposeParams("button", params, typeof record.mode === "string" ? record.mode : undefined);
    if ("invalid" in canon) return { kind: "invalid", reason: canon.invalid };
    return { kind: "action", action: { kind: "new", type: CANON_PROPOSE_KIND, mode: canon.mode, params: canonInputOf(canon), ...stamp } };
  }
  if (record.type === COMMIT_PREPARE_KIND) {
    const commit = readCommitPrepareParams("button", params);
    if ("invalid" in commit) return { kind: "invalid", reason: "缺少有效章号。" };
    return { kind: "action", action: { kind: "new", type: COMMIT_PREPARE_KIND, params: commit, ...stamp } };
  }
  const chapter = params.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return { kind: "invalid", reason: "缺少有效章号。" };
  if (isCandidateDecisionKind(record.type)) {
    const decision = readCandidateDecisionParams(record.type, params);
    if (!decision) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
    return { kind: "action", action: { kind: "new", type: record.type, params: decision, ...stamp } };
  }
  if (record.type === PLAN_PROPOSE_KIND) {
    const plan = readPlanProposeParams(params);
    if (!plan) return { kind: "invalid", reason: "缺少有效章号。" };
    return { kind: "action", action: { kind: "new", type: PLAN_PROPOSE_KIND, params: plan, ...stamp } };
  }
  if (record.type === "draft.change" && isDraftEditMode(record.mode)) {
    const edit = readDraftEditParams(record.mode, params);
    if (!edit) return { kind: "invalid", reason: "要改的地方不对。" };
    return { kind: "action", action: { kind: "new", type: "draft.change", mode: edit.mode, params: edit, ...stamp } };
  }
  if (record.type === "draft.change") {
    // 方向是作者在稿纸上挑的走法、按钮带来的原话：太长的截到 2000 字（和原来「写这一章」按钮同一口径）。
    const direction = typeof params.direction === "string" ? params.direction.trim().slice(0, MAX_DRAFT_DIRECTION) : undefined;
    const read = readDraftChangeParams(record.mode, { ...params, ...(direction !== undefined ? { direction } : {}) });
    if (!read) return { kind: "invalid", reason: "不认识要怎么写这一章。" };
    return { kind: "action", action: { kind: "new", type: "draft.change", mode: read.mode, params: read.params, ...stamp } };
  }
  const mode = record.mode as InspectMode;
  if (!INSPECT_MODES.includes(mode)) return { kind: "invalid", reason: "不认识要做哪种检查。" };
  return {
    kind: "action",
    action: {
      kind: "new",
      type: "inspect.run",
      mode,
      params: { chapter, ...(mode === "continuity" && params.fresh === true ? { fresh: true as const } : {}) },
      ...stamp,
    },
  };
}

export function parseUserAction(raw: unknown): ParsedUserAction {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: "动作格式不对。" };
  const record = raw as Record<string, unknown>;
  if (record.kind !== undefined) return parseOperationAction(record);
  const toolName = record.toolName;
  if (typeof toolName !== "string" || ![...USER_ACTION_TOOL_NAMES, ...DIRECT_ACTION_NAMES].includes(toolName as never)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  if (toolName === "undo") return { kind: "action", action: { toolName: "undo" } };
  if (toolName === "manage_snapshots") return { kind: "invalid", reason: "不支持的操作。" };
  const rawKeep = typeof record.keep === "string" ? Number(record.keep.trim()) : record.keep;
  if (rawKeep === undefined || rawKeep === null || rawKeep === "") return { kind: "action", action: { toolName: "prune_snapshots" } };
  if (typeof rawKeep !== "number" || !Number.isInteger(rawKeep) || rawKeep < 0) {
    return { kind: "invalid", reason: "保留条数不对。" };
  }
  return { kind: "action", action: { toolName: "prune_snapshots", ...(rawKeep > 0 ? { keep: rawKeep } : {}) } };
}

export type UserActionToolExecutor = (
  toolName: UserActionToolName,
  input: Record<string, unknown>,
  requestContext: RequestContext,
) => Promise<unknown>;

/**
 * 执行一次用户结构化动作并把结果按 agent 回合同款事件推给前端。
 * 工具抛错 → tool-error + 如实文案（绝不静默）；标记只在本次执行期间存在，结束即清。
 */
export async function runUserAction(args: {
  readonly action: UserAction;
  readonly requestContext: RequestContext;
  readonly executeTool: UserActionToolExecutor;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  readonly scrubError: (error: unknown) => string;
  /** 书目录（交给执行器的操作要它）。 */
  readonly projectDir?: string;
  /** 作者断开了（关页、网断）：交给执行器的操作照跑，只是不再转发。 */
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { action } = args;
  if ("kind" in action) {
    if (!args.projectDir) {
      const scrubbed = args.scrubber.push("没有打开的书，这一步没做。");
      if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
      return;
    }
    await runOperationAction({
      action,
      projectDir: args.projectDir,
      sendEvent: args.sendEvent,
      scrubber: args.scrubber,
      signal: args.signal ?? new AbortController().signal,
    });
    return;
  }
  if (action.toolName === "prune_snapshots") {
    await runPruneAction({ ...args, action });
    return;
  }
  await runUndoAction(args);
}

interface PruneLikeOutput {
  readonly ok?: unknown;
  readonly summary?: unknown;
}

/** 「确认裁剪」按钮：服务端直接真裁（带用户确认标记），结果按 agent 回合同款事件推给前端。 */
async function runPruneAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "prune_snapshots" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-prune_snapshots-${Date.now()}`;
  const input = { confirm: true, ...(action.keep ? { keep: action.keep } : {}) };
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const flush = (): void => {
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "prune_snapshots", args: input });
  let output: unknown;
  markUserConfirmedTool(args.requestContext, "prune_snapshots");
  try {
    output = await args.executeTool("prune_snapshots", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "prune_snapshots", error: message, retryable: true });
    emitText(`裁剪操作历史没有完成：${message}。历史没有被改动，可以再点一次「确认裁剪」重试。`);
    flush();
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "prune_snapshots", output });
  const result = output as PruneLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.ok === true ? "操作历史已裁剪。" : "操作历史没有裁剪。";
  emitText(summary);
  flush();
}

/** 「撤销上一步」按钮：同对话里的撤销（manage_snapshots op=undo，优先整回合回退），回执照实说。 */
async function runUndoAction(args: Omit<Parameters<typeof runUserAction>[0], "action">): Promise<void> {
  const toolCallId = `user-action-manage_snapshots-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "manage_snapshots", args: { op: "undo" } });
  let output: unknown;
  try {
    output = await args.executeTool("manage_snapshots", { op: "undo" }, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "manage_snapshots", error: message, retryable: true });
    emitText(`没撤销成：${message}。什么都没改，可以再点一次「撤销上一步」。`);
    return;
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "manage_snapshots", output });
  const result = output as { readonly undone?: unknown; readonly summary?: unknown } | undefined;
  emitText(typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.undone === true ? "撤销好了。" : "没有可以撤销的改动。");
}
