/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿预览卡 / 建议条「确认定稿」）发来的明确指令，
 * 服务端直接执行对应工具，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 事件协议与 agent 回合完全一致（tool-call / tool-result / text-delta），前端投影零分叉：
 * 入库 delta 卡、撤销快照、草稿以 committed 态载入都照旧走。收尾文本与下一步选项确定性生成，不调模型。
 */
import type { RequestContext } from "@mastra/core/di";

import { isOperationId } from "../lib/operations/store.js";
import { applyFoundationDecision } from "./foundation-decisions.js";
import { applyLedgerDecisions, MAX_DECISIONS_PER_CHANGE } from "./ledger-decisions.js";
import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";
import { markUserConfirmedTool } from "./request-context.js";
import { parseSettleAction, runSettleAction, type SettleUserAction } from "./settle-actions.js";
import type { InspectMode } from "../services/inspect-service.js";
import { PLAN_PROPOSE_KIND, readPlanProposeParams, type PlanProposeParams } from "../services/operations/recipes/plan-propose.js";
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
import {
  humanizeToolNames,
  resolveNextDraftTarget,
  writeNextChoice,
  type NextDraftTarget,
  type NextStepChoice,
} from "./next-steps.js";
import { runOperationAction } from "./operation-turn.js";

export {
  checkChapterAction,
  continueChoice,
  humanizeToolNames,
  newDraftAction,
  newOperationAction,
  nextDraftChapterAfter,
  readCommittedChapterNumbers,
  writeNextChoice,
  type NextDraftTarget,
  type NextStepChoice,
} from "./next-steps.js";

/** 允许经按钮直接执行的工具（白名单；新增前想清楚它是否真需要绕过模型）。 */
export const USER_ACTION_TOOL_NAMES = [
  "commit_apply",
  "prune_snapshots",
  "commit_preview",
  "manage_snapshots",
] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];
/** 不走工具、服务端直接执行的作者命令（重构 P3：「确认改账」= 记作者裁定；P4：「确认改设定」；P12：定论预览 / 改齐）。 */
const DIRECT_ACTION_NAMES = ["ledger_decision", "foundation_decision", "undo", "settle_preview", "settle_apply"] as const;

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
  /** 「接着做」；等作者点按钮的（「换上 / 再改一版」）带上是哪个按钮、点的哪个。 */
  | { readonly kind: "resume"; readonly opId: string; readonly answer?: { readonly actionId: string; readonly decision: string } }
  | { readonly kind: "cancel"; readonly opId: string };

/** 「确认定稿」：定这一章。「确认裁剪」：把操作历史裁到最近 keep 条（缺省=引擎默认 200）。 */
export type UserAction =
  | OperationAction
  | {
    readonly toolName: "commit_apply";
    readonly chapter: number;
    readonly previewToken?: string;
    /** 作者在定稿预览的账本清单上去掉的条目 id（这些不写进账本）。 */
    readonly excluded?: readonly string[];
    /** 作者改的「第几天」。 */
    readonly dayOverride?: number;
    /** 作者改的「到第几天」（这一章跨天）。 */
    readonly dayEndOverride?: number;
  }
  | { readonly toolName: "prune_snapshots"; readonly keep?: number }
  /** 「定稿」按钮：只读，生成定稿预览（登记票据、列账本清单），不经模型判断。allowShort=「就这么短，照样定稿」：这一章不拿字数下限挡。 */
  | { readonly toolName: "commit_preview"; readonly chapter: number; readonly allowShort?: true }
  /** 「撤销上一步」按钮（重构 P4）：撤上一回合的写盘改动（同对话里说「撤销上一步」的 manage_snapshots op=undo）。 */
  | { readonly toolName: "undo" }
  /**
   * 「确认改账」按钮（重构 P3）：manage_ledger 提的裁定草案原样带回，服务端按作者档命令记下（幂等键 = key）。
   * decisions 在服务端执行前逐条按裁定 schema 校验。
   */
  | { readonly toolName: "ledger_decision"; readonly key: string; readonly decisions: readonly unknown[]; readonly label?: string; readonly basis?: string }
  /**
   * 「确认改设定」按钮（重构 P4）：foundation_write 被拦下的那次写入（删角色 / 覆盖已确立设定）原样带回，
   * 服务端按入参 schema 校验后带作者确认执行（点两次只做一次 = key）。
   */
  | { readonly toolName: "foundation_decision"; readonly key: string; readonly input: Readonly<Record<string, unknown>>; readonly label?: string; readonly basis?: string }
  /** 核账卡「以第 N 章为准」等（P12）：出定论预览（只读）；定论卡「确认」：按票号一次改齐（作者档、可撤销）。 */
  | SettleUserAction;

/** 账本清单一次最多去掉多少条（防异常请求体）。 */
const MAX_EXCLUDED = 500;

/** body.action 解析：缺省 → none（普通对话）；形状不对 → invalid（路由回 400，绝不静默当普通对话）。 */
export type ParsedUserAction =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "action"; readonly action: UserAction };

/** 按钮标识最长多少字：一轮里提了几次改账 / 改设定，界面并成一个按钮，标识是几次的拼起来（「+」隔开）。 */
const MAX_ACTION_KEY_LENGTH = 600;

/** 按钮带的依据摘要（写作版本 P1a）：原样带给执行那步取回核对；不是字符串、太长的当没带（执行时如实说按钮旧了）。 */
function basisOf(record: Record<string, unknown>): { readonly basis?: string } {
  const basis = typeof record.basis === "string" ? record.basis.trim() : "";
  return basis && basis.length <= 128 ? { basis } : {};
}

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
      return { kind: "action", action: { kind: "resume", opId, answer: { actionId, decision } } };
    }
    return { kind: "action", action: { kind: record.kind, opId } };
  }
  if (record.kind !== "new") return { kind: "invalid", reason: "不支持的操作。" };
  if (record.type !== "inspect.run" && record.type !== "draft.change" && record.type !== PLAN_PROPOSE_KIND && !isCandidateDecisionKind(record.type)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {};
  const chapter = params.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return { kind: "invalid", reason: "缺少有效章号。" };
  const requestKey = readRequestKey(record.requestKey);
  const issuedAt = typeof record.issuedAt === "string" && record.issuedAt.length <= 40 && Number.isFinite(Date.parse(record.issuedAt)) ? record.issuedAt : undefined;
  if (!requestKey || !issuedAt) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
  const stamp = { requestKey, issuedAt: new Date(Date.parse(issuedAt)).toISOString() };
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
  if (toolName === "ledger_decision") {
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || key.length > MAX_ACTION_KEY_LENGTH) return { kind: "invalid", reason: "改账按钮缺少有效标识。" };
    if (!Array.isArray(record.decisions) || record.decisions.length === 0) return { kind: "invalid", reason: "改账内容不对。" };
    if (record.decisions.length > MAX_DECISIONS_PER_CHANGE) {
      return { kind: "invalid", reason: `一次最多改 ${MAX_DECISIONS_PER_CHANGE} 条账，这次有 ${record.decisions.length} 条，请让 AI 分几次提。` };
    }
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
    return { kind: "action", action: { toolName: "ledger_decision", key, decisions: record.decisions, ...(label ? { label } : {}), ...basisOf(record) } };
  }
  if (toolName === "foundation_decision") {
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || key.length > MAX_ACTION_KEY_LENGTH) return { kind: "invalid", reason: "改设定按钮缺少有效标识。" };
    const input = record.input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { kind: "invalid", reason: "改设定内容不对。" };
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
    return {
      kind: "action",
      action: { toolName: "foundation_decision", key, input: input as Record<string, unknown>, ...(label ? { label } : {}), ...basisOf(record) },
    };
  }
  if (toolName === "undo") return { kind: "action", action: { toolName: "undo" } };
  if (toolName === "settle_preview" || toolName === "settle_apply") {
    const parsed = parseSettleAction(record);
    return "invalid" in parsed ? { kind: "invalid", reason: parsed.invalid } : { kind: "action", action: parsed.action };
  }
  if (toolName === "manage_snapshots") return { kind: "invalid", reason: "不支持的操作。" };
  if (toolName === "prune_snapshots") {
    const rawKeep = typeof record.keep === "string" ? Number(record.keep.trim()) : record.keep;
    if (rawKeep === undefined || rawKeep === null || rawKeep === "") return { kind: "action", action: { toolName: "prune_snapshots" } };
    if (typeof rawKeep !== "number" || !Number.isInteger(rawKeep) || rawKeep < 0) {
      return { kind: "invalid", reason: "保留条数不对。" };
    }
    return { kind: "action", action: { toolName: "prune_snapshots", ...(rawKeep > 0 ? { keep: rawKeep } : {}) } };
  }
  const chapter = typeof record.chapter === "string" ? Number(record.chapter.trim()) : record.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
    return { kind: "invalid", reason: "缺少有效章号。" };
  }
  if (toolName === "commit_preview") return { kind: "action", action: { toolName: "commit_preview", chapter, ...(record.allowShort === true ? { allowShort: true as const } : {}) } };
  const previewToken = typeof record.previewToken === "string" && record.previewToken.trim()
    ? record.previewToken.trim()
    : undefined;
  const excluded = Array.isArray(record.excluded)
    ? [...new Set(record.excluded.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 200).map((id) => id.trim()))].slice(0, MAX_EXCLUDED)
    : [];
  const dayOf = (raw: unknown): number | undefined => {
    const value = typeof raw === "string" ? Number(raw.trim()) : raw;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : undefined;
  };
  const dayOverride = dayOf(record.dayOverride);
  const dayEndOverride = dayOverride === undefined ? undefined : dayOf(record.dayEndOverride);
  return {
    kind: "action",
    action: {
      toolName: "commit_apply",
      chapter,
      ...(previewToken ? { previewToken } : {}),
      ...(excluded.length > 0 ? { excluded } : {}),
      ...(dayOverride !== undefined ? { dayOverride } : {}),
      ...(dayEndOverride !== undefined ? { dayEndOverride } : {}),
    },
  };
}

interface CommitApplyLikeOutput {
  readonly committed?: unknown;
  readonly summary?: unknown;
  readonly chapter?: unknown;
  readonly threadMaintenanceHint?: unknown;
}

/**
 * 定稿动作收尾的下一步选项（确定性）：成功 → 写下一章（+线索堆积时清理）；未成 → 重新预览。
 * next（R7.7）：推荐写的「下一章」默认还是 N+1（旧行为，无书目录信息时），
 * 有书目录时由调用方传写作前沿章（第一个没定稿的章），重定旧章后不再推荐回去写旧章；那章已有工作稿就推荐核它。
 */
export function commitApplyNextSteps(
  chapter: number,
  output: CommitApplyLikeOutput | undefined,
  next: NextDraftTarget = { chapter: chapter + 1, hasDraft: false },
): { readonly question: string; readonly choices: readonly NextStepChoice[] } {
  if (output?.committed === true) {
    return {
      question: `第 ${chapter} 章定稿了，接下来？`,
      choices: [
        { ...writeNextChoice(next), recommended: true },
        ...(output.threadMaintenanceHint === "escalated"
          ? [{ label: "归并线索", intent: "看看开着的线索里有没有讲同一件事的，提一份归并方案给我确认" }]
          : []),
      ],
    };
  }
  return {
    question: `第 ${chapter} 章还没定稿，接下来？`,
    choices: [{
      label: "重新预览",
      intent: `生成第 ${chapter} 章定稿预览`,
      recommended: true,
      action: { toolName: "commit_preview", chapter },
    }],
  };
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
  /** 项目目录（编辑部 R4.6 建议项用：定稿后判占位主角卡要不要给改名建议）；缺省不给建议，行为不变。 */
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
      previewCommit: (chapter) => runCommitPreviewAction({ ...args, action: { toolName: "commit_preview", chapter } }),
    });
    return;
  }
  if (action.toolName === "prune_snapshots") {
    await runPruneAction({ ...args, action });
    return;
  }
  if (action.toolName === "commit_preview") {
    await runCommitPreviewAction({ ...args, action });
    return;
  }
  if (action.toolName === "ledger_decision") {
    await runLedgerDecisionAction({ ...args, action });
    return;
  }
  if (action.toolName === "foundation_decision") {
    await runFoundationDecisionAction({ ...args, action });
    return;
  }
  if (action.toolName === "undo") {
    await runUndoAction(args);
    return;
  }
  if (action.toolName === "settle_preview" || action.toolName === "settle_apply") {
    await runSettleAction({ ...args, action });
    return;
  }
  const stamp = Date.now();
  const toolCallId = `user-action-${action.toolName}-${stamp}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };

  args.sendEvent("tool-call", { toolCallId, toolName: action.toolName, args: { chapter: action.chapter } });
  let output: unknown;
  markUserConfirmedTool(args.requestContext, action.toolName);
  try {
    output = await args.executeTool(
      action.toolName,
      {
        chapter: action.chapter,
        ...(action.previewToken ? { previewToken: action.previewToken } : {}),
        ...(action.excluded && action.excluded.length > 0 ? { excluded: action.excluded } : {}),
        ...(action.dayOverride !== undefined ? { dayOverride: action.dayOverride } : {}),
        ...(action.dayEndOverride !== undefined ? { dayEndOverride: action.dayEndOverride } : {}),
      },
      args.requestContext,
    );
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: action.toolName, error: message, retryable: true });
    emitText(`第 ${action.chapter} 章定稿没有完成：${humanizeToolNames(message)}。可以再点一次「确认定稿」重试。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }

  args.sendEvent("tool-result", { toolCallId, toolName: action.toolName, output });
  const result = output as CommitApplyLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.committed === true
      ? `第 ${action.chapter} 章已定稿。`
      : `第 ${action.chapter} 章没有定稿。`;
  emitText(humanizeToolNames(summary));
  const rest = args.scrubber.flush();
  if (rest) args.sendEvent("text-delta", { text: rest });

  const nextSteps = commitApplyNextSteps(action.chapter, result, await resolveNextDraftTarget(args.projectDir, action.chapter));
  // 定稿成功后，设定本里还没标主角、账里有视角人物 → 多给一个「把『X』设为主角」。只是建议：作者点了
  // 才把 intent 发给模型，由模型走 foundation_write 设（可撤销）；建议判不了/判挂了按无建议处理。
  const renameSuggestion = result?.committed === true && args.projectDir
    ? await buildProtagonistRenameSuggestion(args.projectDir).catch(() => undefined)
    : undefined;
  const choices = renameSuggestion
    ? [...nextSteps.choices, { label: renameSuggestion.label, intent: renameSuggestion.intent }]
    : nextSteps.choices;
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: nextSteps.question, choices },
  });
}

interface CommitPreviewLikeOutput {
  readonly canCommit?: unknown;
  readonly summary?: unknown;
}

/**
 * 「定稿」按钮：服务端直接跑 commit_preview（只读；可定稿时登记票据），结果按 agent 回合同款事件推给前端，
 * 前端照常渲染定稿预览卡（账本清单 + 确认定稿按钮）。收尾只回工具自己的用户可见摘要，不调模型。
 */
async function runCommitPreviewAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "commit_preview" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-commit_preview-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const flush = (): void => {
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "commit_preview", args: { chapter: action.chapter } });
  let output: unknown;
  // 「就这么短，照样定稿」：作者确认标记只在这次执行里有效（工具据它放字数下限）。
  if (action.allowShort) markUserConfirmedTool(args.requestContext, "commit_preview");
  try {
    output = await args.executeTool("commit_preview", { chapter: action.chapter }, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "commit_preview", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章的定稿预览没生成出来：${humanizeToolNames(message)}。可以再点一次「定稿」。`);
    flush();
    return;
  } finally {
    if (action.allowShort) markUserConfirmedTool(args.requestContext, undefined);
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "commit_preview", output });
  const result = output as CommitPreviewLikeOutput | undefined;
  // 清单（含定不了的原因）在弹窗和对话小卡里都有，回话只说一句结论（重构 P6）。
  const summary = result?.canCommit === true
    ? `第 ${action.chapter} 章可以定稿，清单打开了。`
    : result?.canCommit === false
      ? `第 ${action.chapter} 章现在还定不了，原因在清单里。`
      : typeof result?.summary === "string" && result.summary.trim() ? result.summary.trim() : `第 ${action.chapter} 章暂时不能定稿。`;
  emitText(humanizeToolNames(summary));
  flush();
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

/** 「确认改账」：作者点了按钮，按作者档命令记下裁定（改前存档、点两次只记一次），回执照实说。 */
async function runLedgerDecisionAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "ledger_decision" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-manage_ledger-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "manage_ledger", args: { op: "confirm" } });
  if (!args.projectDir) {
    const message = "没改账：没拿到书的位置，请重新打开这本书再点。";
    args.sendEvent("tool-result", { toolCallId, toolName: "manage_ledger", output: { ok: false, op: "confirm", summary: message } });
    emitText(message);
    return;
  }
  let outcome: Awaited<ReturnType<typeof applyLedgerDecisions>>;
  try {
    outcome = await applyLedgerDecisions(args.projectDir, {
      key: action.key,
      decisions: action.decisions,
      ...(action.label ? { label: action.label } : {}),
      ...(action.basis ? { basis: action.basis } : {}),
    });
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "manage_ledger", error: message, retryable: true });
    emitText(`没改账：${message}。可以再点一次「确认改账」重试。`);
    return;
  }
  args.sendEvent("tool-result", {
    toolCallId,
    toolName: "manage_ledger",
    // 带上改前的撤销点：界面把这一步登记成一个可撤销的回合，「撤销上一步」只撤这次改账。
    output: { ok: outcome.ok, op: "confirm", summary: outcome.summary, refreshScope: "full", ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}) },
  });
  emitText(outcome.summary);
}

/** 「确认改设定」：作者点了按钮，带作者确认执行那次资料写入（改前存档、点两次只做一次），回执照实说。 */
async function runFoundationDecisionAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "foundation_decision" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-foundation_write-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "foundation_write", args: { op: "confirm" } });
  if (!args.projectDir) {
    const message = "没改设定：没拿到书的位置，请重新打开这本书再点。";
    args.sendEvent("tool-result", { toolCallId, toolName: "foundation_write", output: { ok: false, summary: message } });
    emitText(message);
    return;
  }
  let outcome: Awaited<ReturnType<typeof applyFoundationDecision>>;
  try {
    outcome = await applyFoundationDecision(args.projectDir, { key: action.key, input: action.input, ...(action.basis ? { basis: action.basis } : {}) });
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "foundation_write", error: message, retryable: true });
    emitText(`没改设定：${message}。可以再点一次「确认改设定」重试。`);
    return;
  }
  args.sendEvent("tool-result", {
    toolCallId,
    toolName: "foundation_write",
    // 带上改前的撤销点：界面把这一步登记成一个可撤销的回合，「撤销上一步」只撤这次改设定。
    output: {
      ok: outcome.ok,
      summary: outcome.summary,
      refreshScope: "foundation",
      ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
    },
  });
  emitText(outcome.summary);
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
