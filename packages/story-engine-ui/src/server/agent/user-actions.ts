/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿预览卡 / 建议条「确认定稿」）发来的明确指令，
 * 服务端直接执行对应工具，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 事件协议与 agent 回合完全一致（tool-call / tool-result / text-delta），前端投影零分叉：
 * 入库 delta 卡、撤销快照、草稿以 committed 态载入都照旧走。收尾文本与下一步选项确定性生成，不调模型。
 */
import type { RequestContext } from "@mastra/core/di";

import { extractDraftTitle, stripLeadingMarkdownChapterHeading } from "../lib/project-io.js";
import { isOperationId } from "../lib/operations/store.js";
import { buildStateOverview, type StateOverview } from "../book/state-overview.js";
import { stripMarkdownEmphasis } from "../../lib/markdown-emphasis.js";
import { createRevisionModelChannel, type RevisionModelCaller } from "../services/revision-service.js";
import { fixDraftByUnits, type DraftUnitFixResult } from "../services/unit-fix.js";
import { applyFoundationDecision } from "./foundation-decisions.js";
import { applyLedgerDecisions, MAX_DECISIONS_PER_CHANGE } from "./ledger-decisions.js";
import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";
import { markUserConfirmedTool } from "./request-context.js";
import { parseSettleAction, runSettleAction, type SettleUserAction } from "./settle-actions.js";
import { COLD_PAUSED_TEXT } from "../editorial/reader-window.js";
import { cachedContinuityCheck, type InspectMode } from "../services/inspect-service.js";
import {
  checkChapterAction,
  continueChoice,
  humanizeToolNames,
  resolveNextDraftTarget,
  sendNextSteps,
  writeNextChoice,
  type NextDraftTarget,
  type NextStepChoice,
} from "./next-steps.js";
import { runOperationAction } from "./operation-turn.js";

export {
  checkChapterAction,
  continueChoice,
  humanizeToolNames,
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
  "generate_draft",
  "manage_snapshots",
  "revise_draft",
  "brainstorm_chapter",
] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];
/** 不走工具、服务端直接执行的作者命令（重构 P3：「确认改账」= 记作者裁定；P4：「确认改设定」；P12：定论预览 / 改齐）。 */
const DIRECT_ACTION_NAMES = ["ledger_decision", "foundation_decision", "undo", "settle_preview", "settle_apply"] as const;

/**
 * 按钮交给执行器的（写作版本 P2a 契约第四节）：新操作（核账、审稿……）出按钮的时候就带好请求号和 issuedAt，点几次都是这一次；
 * 「接着做」「不要了」接着一次停着的操作。片 1 只有检查（inspect.run）是操作，别的按钮随各自那一片迁过来。
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
  | { readonly kind: "resume"; readonly opId: string }
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
  /**
   * 「写这一章」按钮（2026-10-10 引擎升级第 5 期「出稿一条路」）：直接执行 generate_draft——先拿章纲、写、
   * 字数不够接着写、写完核账，和对话里让 AI 写同一套。原来按钮走 /api/draft/stream，没章纲也不核账。
   */
  | { readonly toolName: "generate_draft"; readonly chapter: number; readonly chapterGoal?: string; readonly continueDraft?: boolean }
  /** 「撤销上一步」按钮（重构 P4）：撤上一回合的写盘改动（同对话里说「撤销上一步」的 manage_snapshots op=undo）。 */
  | { readonly toolName: "undo" }
  /**
   * 核账条目上的「改这处」「改掉这 N 处」（重构 P6；P12 起按编号句子一次改齐）：服务端直接改、不经对话 AI——
   * 模型曾读完稿就说「改好了」而没调改稿工具。改不成（原句没找到 / 出现多次）照实说，给「让 AI 改」。
   */
  | { readonly toolName: "revise_draft"; readonly chapter: number; readonly fixes: readonly ReviseFix[] }
  /**
   * 「给我几种走法」「再来几种」（重构 P6 头脑风暴）：只读，章纲员出几种走法、核账员核前文，结果进对话、作者在稿纸上挑。
   * idea = 作者在稿纸上方填的想法原话；avoid = 已经给过的走法名字（再来几种时别出一样的）。
   */
  | { readonly toolName: "brainstorm_chapter"; readonly chapter: number; readonly idea?: string; readonly avoid?: readonly string[] }
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

/** 核账「改这处」的一处：本章原句（逐字锚点）+ 要改成什么样。 */
export interface ReviseFix {
  readonly targetText: string;
  readonly revisionGoal: string;
}

/** 账本清单一次最多去掉多少条（防异常请求体）。 */
const MAX_EXCLUDED = 500;
/** 「改掉这 N 处」一次最多改几处、每处原句 / 目标多长（防异常请求体）。 */
const MAX_REVISE_FIXES = 12;
const MAX_REVISE_TEXT = 800;
/** 头脑风暴：作者想法多长、「再来几种」最多带几个已给过的走法名。 */
const MAX_BRAINSTORM_IDEA = 500;
const MAX_BRAINSTORM_AVOID = 12;

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

/** 按钮带的请求号：出按钮时给的 UUID（字母数字和 `-_`，1～64 位）。 */
function readRequestKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : undefined;
}

/** 按钮交给执行器的动作（新操作 / 接着做 / 不要了）：形状不对一律 invalid，不当普通对话。 */
function parseOperationAction(record: Record<string, unknown>): ParsedUserAction {
  if (record.kind === "resume" || record.kind === "cancel") {
    const opId = typeof record.opId === "string" ? record.opId.trim() : "";
    if (!isOperationId(opId)) return { kind: "invalid", reason: "这次操作的号不对。" };
    return { kind: "action", action: { kind: record.kind, opId } };
  }
  if (record.kind !== "new") return { kind: "invalid", reason: "不支持的操作。" };
  if (record.type !== "inspect.run") return { kind: "invalid", reason: "不支持的操作。" };
  const mode = record.mode as InspectMode;
  if (!INSPECT_MODES.includes(mode)) return { kind: "invalid", reason: "不认识要做哪种检查。" };
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {};
  const chapter = params.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return { kind: "invalid", reason: "缺少有效章号。" };
  const requestKey = readRequestKey(record.requestKey);
  const issuedAt = typeof record.issuedAt === "string" && record.issuedAt.length <= 40 && Number.isFinite(Date.parse(record.issuedAt)) ? record.issuedAt : undefined;
  if (!requestKey || !issuedAt) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
  return {
    kind: "action",
    action: {
      kind: "new",
      type: "inspect.run",
      mode,
      params: { chapter, ...(mode === "continuity" && params.fresh === true ? { fresh: true as const } : {}) },
      requestKey,
      issuedAt: new Date(Date.parse(issuedAt)).toISOString(),
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
  if (toolName === "generate_draft") {
    const chapterGoal = typeof record.chapterGoal === "string" ? record.chapterGoal.trim().slice(0, 2000) : "";
    return {
      kind: "action",
      action: { toolName: "generate_draft", chapter, ...(chapterGoal ? { chapterGoal } : {}), ...(record.continueDraft === true ? { continueDraft: true } : {}) },
    };
  }
  if (toolName === "brainstorm_chapter") {
    const idea = typeof record.idea === "string" ? record.idea.trim().slice(0, MAX_BRAINSTORM_IDEA) : "";
    const avoid = Array.isArray(record.avoid)
      ? [...new Set(record.avoid.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_BRAINSTORM_AVOID)
      : [];
    return { kind: "action", action: { toolName: "brainstorm_chapter", chapter, ...(idea ? { idea } : {}), ...(avoid.length > 0 ? { avoid } : {}) } };
  }
  if (toolName === "revise_draft") {
    if (!Array.isArray(record.fixes) || record.fixes.length === 0 || record.fixes.length > MAX_REVISE_FIXES) {
      return { kind: "invalid", reason: "要改的地方不对。" };
    }
    const fixes: ReviseFix[] = [];
    for (const raw of record.fixes) {
      const fix = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
      const targetText = typeof fix.targetText === "string" ? fix.targetText.trim() : "";
      const revisionGoal = typeof fix.revisionGoal === "string" ? fix.revisionGoal.trim() : "";
      if (!targetText || !revisionGoal || targetText.length > MAX_REVISE_TEXT || revisionGoal.length > MAX_REVISE_TEXT) {
        return { kind: "invalid", reason: "要改的地方不对。" };
      }
      fixes.push({ targetText, revisionGoal });
    }
    return { kind: "action", action: { toolName: "revise_draft", chapter, fixes } };
  }
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
  /** 「改这处」用的修订模型（测试注入）；缺省按 repair 任务的配置。 */
  readonly fixModel?: RevisionModelCaller;
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
    await runOperationAction({ action, projectDir: args.projectDir, sendEvent: args.sendEvent, scrubber: args.scrubber, signal: args.signal ?? new AbortController().signal });
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
  if (action.toolName === "generate_draft") {
    await runGenerateDraftAction({ ...args, action });
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
  if (action.toolName === "revise_draft") {
    await runReviseFixesAction({ ...args, action });
    return;
  }
  if (action.toolName === "brainstorm_chapter") {
    await runBrainstormAction({ ...args, action });
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

interface CheckContinuityLikeOutput {
  readonly ok?: unknown;
  readonly reused?: unknown;
  readonly summary?: unknown;
  /** summary 去掉逐条问题的结论那句（重构 P6）。 */
  readonly headline?: unknown;
  readonly sure?: readonly unknown[];
  readonly maybe?: readonly unknown[];
  /** 只在「还在读、这次没核」时有：核账员读到第 done / total 章（区分「还在读」和「出错」用这个字段，别解析 failures 文字）。 */
  readonly pending?: { readonly done: number; readonly total: number };
  /** 冷窗口：核账员还没读完全书，这次只对照了一部分（pausedBackfill＝后台补读停着等作者）。 */
  readonly coverage?: { readonly pausedBackfill?: string };
}

/**
 * 写完那遍核账的一句话（重构 P6 第 6 步）：问题清单在核账卡和稿纸划线上，这里只说几处。
 * fixed＞0（2026-10-23）：写完核出的已按前文改了几处、改完又核过——作者看着正文变了，得知道是改过的，卡上是改后还剩的。
 */
export function afterDraftCheckLine(result: CheckContinuityLikeOutput, fixed = 0): string | undefined {
  if (result.ok !== true) return undefined;
  const sure = Array.isArray(result.sure) ? result.sure.length : 0;
  const maybe = Array.isArray(result.maybe) ? result.maybe.length : 0;
  const cold = result.coverage ? `（核账员还没读完全书，更早的细节可能漏${result.coverage.pausedBackfill ? `；${COLD_PAUSED_TEXT}` : ""}）` : "";
  // 稿纸上默认只画确定的；「可能」在核账卡上点开才画（2026-10-23 稿纸减噪），别说成画上了。
  const counts = sure > 0
    ? `确定对不上 ${sure} 处，画在稿纸上了${maybe > 0 ? `；另有可能 ${maybe} 处，在卡上点开看` : ""}`
    : `没有确定对不上的；可能 ${maybe} 处，在卡上点开看`;
  if (fixed > 0) {
    return sure + maybe === 0
      ? `写完核账，改了 ${fixed} 处对不上的；再核没发现别的${cold}。`
      : `写完核账，改了 ${fixed} 处对不上的；再核还有${counts}${cold}。`;
  }
  return sure + maybe === 0
    ? `写完核了一遍，没发现对不上的地方${cold}。`
    : `写完核了一遍：${counts}${cold}。`;
}

/**
 * 写完这一章接着出核账卡（结果来自写完那遍核账的记忆，不再调模型）：卡按 `card` 事件推给前端（不是一次工具调用，也不是一次操作），
 * 回话「写完核了一遍…」，再给下一步。核账本身是操作（inspect.run），这里只是把出稿流程里核过的那份结果摆出来。
 */
async function sendAfterDraftCheck(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly chapter: number;
  /** 写完那遍的核账记忆。 */
  readonly output: unknown;
  /** 写完核出的按前文改了几处（改完再核的结果才进了核账记忆）。 */
  readonly fixedAfterDraft?: number;
  /** 写完的稿子比字数下限短：下一步先给「接着往下写」。 */
  readonly shortAfterDraft?: boolean;
  /** 后面还有别的接着出（写完就出定稿预览）：不给下一步。 */
  readonly skipNextSteps?: boolean;
  /** 下一步前面再加的（作者要点可能没写到：「补上这几条」）。 */
  readonly moreChoices?: readonly NextStepChoice[];
}): Promise<void> {
  const { chapter } = args;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  const result = args.output as CheckContinuityLikeOutput | undefined;
  args.sendEvent("card", { type: "continuity", check: args.output });
  // 问题清单在核账卡和稿纸划线上（重构 P6），回话只说结论那句。
  const said = [result ? afterDraftCheckLine(result, args.fixedAfterDraft) : undefined, result?.headline, result?.summary]
    .find((text): text is string => typeof text === "string" && text.trim().length > 0);
  emitText(said ? said.trim() : `第 ${chapter} 章写完核了一遍。`);
  if (args.skipNextSteps || result?.ok === false) return;
  const sureCount = Array.isArray(result?.sure) ? result.sure.length : 0;
  const more: NextStepChoice[] = [...(args.shortAfterDraft ? [continueChoice(chapter)] : []), ...(args.moreChoices ?? [])];
  // 确定 N 处时，改法都在核账卡上（「改掉这 N 处」、逐条「改这处 / 不是问题」，R4.5），稿纸工具条照样有「定稿」：不再挂下一步。
  const choices: NextStepChoice[] = sureCount > 0
    ? more
    : [
      ...more,
      {
        label: "预览定稿",
        intent: `预览第 ${chapter} 章的定稿改动`,
        recommended: more.length === 0,
        action: { toolName: "commit_preview", chapter },
      },
      // 写作前沿章（R7.7）：在旧章上核账时不再推荐回去重写 N+1 旧章。
      writeNextChoice(await resolveNextDraftTarget(args.projectDir, chapter), "AI 写下一章"),
    ];
  sendNextSteps(args.sendEvent, "接下来？", choices);
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

/** 「给我几种走法」按钮：服务端直接跑只读的 brainstorm_chapter，走法卡进对话、稿纸上方给作者挑；回执一句话。 */
async function runBrainstormAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "brainstorm_chapter" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-brainstorm_chapter-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  const input = {
    chapter: action.chapter,
    ...(action.idea ? { idea: action.idea } : {}),
    ...(action.avoid ? { avoid: action.avoid } : {}),
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "brainstorm_chapter", args: input });
  let output: unknown;
  try {
    output = await args.executeTool("brainstorm_chapter", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "brainstorm_chapter", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章的走法没想出来：${humanizeToolNames(message)}。可以再点一次。`);
    return;
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "brainstorm_chapter", output });
  const result = output as { readonly ok?: unknown; readonly summary?: unknown } | undefined;
  emitText(typeof result?.summary === "string" && result.summary.trim()
    ? humanizeToolNames(result.summary.trim())
    : `第 ${action.chapter} 章的走法没想出来。`);
}

/**
 * 「改这处」「改掉这 N 处」按钮（P12 编号句子）：这一章要改的几处一次交修订模型、按编号整句换，
 * 回执照实说改了几处、哪几处没改成。结果按 revise_draft 的输出交给前端（稿纸换上新正文、可撤销）。
 */
async function runReviseFixesAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "revise_draft" }>;
}): Promise<void> {
  const { action } = args;
  const stamp = Date.now();
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  const toolCallId = `user-action-revise_draft-${stamp}`;
  const total = action.fixes.length;
  args.sendEvent("tool-call", { toolCallId, toolName: "revise_draft", args: { chapter: action.chapter } });
  let result: DraftUnitFixResult;
  let overview: StateOverview;
  try {
    if (!args.projectDir) throw new Error("没找到这本书");
    const callModel = args.fixModel ?? (await createRevisionModelChannel()).call;
    result = await fixDraftByUnits({
      projectDir: args.projectDir,
      chapter: action.chapter,
      fixes: action.fixes.map((fix) => ({ quote: fix.targetText, goal: fix.revisionGoal })),
      callModel,
    });
    overview = await buildStateOverview({ projectDir: args.projectDir, chapter: action.chapter, maxTimelineEvents: 8 });
  } catch (error) {
    const message = humanizeToolNames(args.scrubError(error));
    args.sendEvent("tool-error", { toolCallId, toolName: "revise_draft", error: message, retryable: true });
    emitText(`${total === 1 ? "这一处" : `这 ${total} 处`}没改成：${message}。可以再点一次。`);
    return;
  }
  // 改好了但没换上（改的途中稿子或前文变了）：如实说，AI 这版留在稿纸上等作者选。
  const applied = result.kept ? 0 : result.applied.length;
  const failed = result.kept ? [] : result.failed.map(({ fix, why }) => ({ fix: action.fixes[fix]!, why }));
  const also = applied > 0 && result.alsoChanged > 0 ? `本章别处说同一件事的 ${result.alsoChanged} 句跟着改了。` : "";
  const done = applied === 0 ? "" : `${total === 1 ? "改好了这一处（可撤销）。" : `改好了 ${applied} 处（可撤销）。`}${also}`;
  const notDone = failed.length === 0
    ? ""
    : total === 1 ? `这一处没改成：${failed[0]!.why}。` : `${failed.length} 处没改成：${failed[0]!.why}。`;
  const summary = result.kept ? result.kept.message : `${done}${notDone}`;
  args.sendEvent("tool-result", {
    toolCallId,
    toolName: "revise_draft",
    output: {
      ok: applied > 0,
      applied: applied > 0,
      summary,
      refreshScope: "full",
      chapter: action.chapter,
      overview,
      ...(applied > 0 ? { draftBody: stripMarkdownEmphasis(stripLeadingMarkdownChapterHeading(result.text)).trim() } : {}),
      ...(result.draftVersion !== undefined ? { draftVersion: result.draftVersion } : {}),
      ...(result.snapshotId ? { snapshotId: result.snapshotId } : {}),
    },
  });
  emitText(summary);
  const choices: NextStepChoice[] = [
    ...(failed.length > 0 ? [{
      label: "让 AI 改",
      intent: `${failed.map(({ fix }) => `把第 ${action.chapter} 章里「${fix.targetText}」这处改掉：${fix.revisionGoal}。`).join("")}只改这几处，别的不动。`,
      recommended: true,
    }] : []),
    ...(applied > 0 ? [{
      label: "再核一遍",
      intent: `重新核第 ${action.chapter} 章的账`,
      ...(failed.length === 0 ? { recommended: true } : {}),
      action: checkChapterAction(action.chapter),
    }] : []),
  ];
  if (choices.length === 0) return;
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: applied > 0 ? "改好了，接下来？" : "没改成，接下来？", choices },
  });
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

interface GenerateDraftLikeOutput {
  readonly ok?: unknown;
  readonly summary?: unknown;
  readonly draftTitle?: unknown;
  readonly draftBody?: unknown;
  readonly draftLength?: { readonly actualLength?: unknown; readonly lowerBound?: unknown; readonly lengthStatus?: unknown };
  readonly qualityPipeline?: { readonly continuity?: { readonly checked?: unknown; readonly autoFixed?: { readonly applied?: unknown } } };
  readonly continued?: { readonly kept?: unknown; readonly added?: unknown };
  readonly blockedReason?: unknown;
  /** 写好了但没换上（AI 这版留在稿纸上等作者选）。 */
  readonly kept?: unknown;
  readonly beatFidelity?: { readonly missingBeats?: readonly unknown[]; readonly postDeAiNewMisses?: readonly unknown[] };
}

/**
 * 「写这一章」写成后给作者的一句（重构 P6 第 6 步）：章纲、角色、定稿提示、核对细节都在「生成正文」步骤里点开看，
 * 回话只说写好了、多少字、差多少（十章会话里这句约 400 字）。没载入稿纸这种要作者知道的照说。
 */
export function draftBrief(chapter: number, result: GenerateDraftLikeOutput): string {
  // 写手有时把「第 N 章 · 」也写进章名：前面已经说了第几章，书名号里只放章名。
  const bare = typeof result.draftTitle === "string" ? extractDraftTitle(`# ${result.draftTitle.trim()}`) : null;
  const title = bare ? `《${bare}》` : "";
  const actual = typeof result.draftLength?.actualLength === "number" ? result.draftLength.actualLength : undefined;
  const lower = typeof result.draftLength?.lowerBound === "number" ? result.draftLength.lowerBound : undefined;
  const short = result.draftLength?.lengthStatus === "below_lower_bound" && actual !== undefined && lower !== undefined
    ? `，比下限少 ${lower - actual} 字` : "";
  const kept = result.continued?.kept;
  const added = result.continued?.added;
  const lines = [typeof kept === "number" && typeof added === "number"
    ? `第 ${chapter} 章接着写了 ${added} 字，前面的 ${kept} 字没动${actual !== undefined ? `，全章 ${actual} 字` : ""}${short}。`
    : `第 ${chapter} 章写好了${title}${actual !== undefined ? `，${actual} 字` : ""}${short}。`];
  if (typeof result.draftBody === "string" && !result.draftBody.trim()) {
    lines.push("正文已写盘，但这次没载入稿纸：切到别的章再切回来就能看到，不用重写。");
  }
  return lines.join("\n");
}

/** 出稿没成的下一步：接着写没得接 → 改成从头写；这章已定稿 → 不给（回话里说了怎么办）；其余照原样再来一次。 */
export function retryDraftChoices(action: Extract<UserAction, { readonly toolName: "generate_draft" }>, blockedReason: unknown, kept?: unknown): NextStepChoice[] {
  // 导入的书还在通读记账：再点也是同一句「等它记完」，不给「再写一次」。
  if (blockedReason === "rereading") return [];
  // 写好了没换上：AI 这版在稿纸上等作者选，不再写一遍。
  if (kept) return [];
  if (action.continueDraft && blockedReason === "chapter_committed") return [];
  if (action.continueDraft && blockedReason === "nothing_to_continue") {
    return [{ label: `AI 写第 ${action.chapter} 章`, intent: "写这一章的正文", recommended: true, action: { toolName: "generate_draft", chapter: action.chapter } }];
  }
  return [{ label: "再写一次", intent: "写这一章的正文", recommended: true, action }];
}

/** 「写这一章」按钮：服务端直接出稿（正文照常经 draft-delta 流进稿纸），结果按 agent 回合同款事件推给前端，再按 finishDraftTurn 收尾。 */
async function runGenerateDraftAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "generate_draft" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-generate_draft-${Date.now()}`;
  const input = {
    chapter: action.chapter,
    ...(action.chapterGoal ? { chapterGoal: action.chapterGoal } : {}),
    ...(action.continueDraft ? { continueDraft: true } : {}),
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "generate_draft", args: input });
  let output: unknown;
  // 作者确认标记：按钮/选项点击本身就是作者授权，generate_draft 见此标记才允许整章重写有稿的章、
  // 方向不用再找原句（按钮带的方向就是作者点的）。标记只在本次执行期间存在，结束即清（与 prune 同款）；
  // 本通道不跑模型，不存在模型调用蹭标记的窗口。
  markUserConfirmedTool(args.requestContext, "generate_draft");
  try {
    output = await args.executeTool("generate_draft", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "generate_draft", error: message, retryable: true });
    const scrubbed = args.scrubber.push(`第 ${action.chapter} 章没写成：${message}。原来的稿子没动，可以再点一次。`);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "generate_draft", output });
  await finishDraftTurn({ ...args, output });
}

/** 出稿结果里还可能没写到的作者要点（复核后仍漏的 + 去味后新漏的）。 */
function missingBeatsOf(result: GenerateDraftLikeOutput): readonly string[] {
  const fidelity = result.beatFidelity;
  return [...new Set([...(fidelity?.missingBeats ?? []), ...(fidelity?.postDeAiNewMisses ?? [])].filter((beat): beat is string => typeof beat === "string" && beat.trim().length > 0))];
}

/**
 * 出稿之后这一轮怎么收（外部审查 2026-10-28：「写这一章」按钮和对话里让 AI 写同一套，写成了不再交给对话 AI 多说一轮）：
 * 一句结论（作者要的要点可能没写到的照说）→ 写完那遍核过的账出核账卡（只用核账记忆，不再调模型）→
 * 作者要写完就出定稿预览的接着出预览，否则给下一步。没写成的照原因说、给「再写一次」。
 */
export async function finishDraftTurn(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "generate_draft" }>;
  readonly output: unknown;
  /** 作者说了写完就出定稿预览（出稿带 thenPreview）：核账卡后接着出预览，下一步就在预览卡上。 */
  readonly thenPreview?: boolean;
  /** 读核账记忆（测试注入）；缺省按盘上工作稿读，记忆对不上就是 null。 */
  readonly readCachedCheck?: (projectDir: string, chapter: number) => Promise<unknown>;
}): Promise<void> {
  const { action } = args;
  const stamp = Date.now();
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const flush = (): void => {
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  const result = args.output as GenerateDraftLikeOutput | undefined;
  const written = result?.ok === true;
  const checked = result?.qualityPipeline?.continuity?.checked;
  const short = written && result?.draftLength?.lengthStatus === "below_lower_bound";
  const missing = written && result ? missingBeatsOf(result) : [];
  // 写完那遍核过的账：只认核账记忆（稿子又被改过、有一步没跑成没记下的都是 null），不再调模型。
  const cached = written && checked === true && args.projectDir
    ? await (args.readCachedCheck ?? cachedContinuityCheck)(args.projectDir, action.chapter).catch(() => null)
    : null;
  // 写成了：一句结论（细节在步骤里）；没写成：照原因说（summary 里是拒稿原因）。
  emitText(written && result
    ? [
      draftBrief(action.chapter, result),
      missing.length > 0 ? `这几条要点可能没写到：${missing.join("、")}。` : "",
      checked === false ? "写完那遍核账没跑成，可以点「核账」再核。" : checked === true && !cached ? "写完那遍核账没核全，可以点「核账」再核。" : "",
    ].filter(Boolean).join("\n")
    : typeof result?.summary === "string" && result.summary.trim()
      ? humanizeToolNames(result.summary.trim())
      : `第 ${action.chapter} 章没写成，原来的稿子没动。`);
  flush();
  const preview = async (): Promise<void> => {
    args.sendEvent("text-delta", { text: "\n" });
    await runCommitPreviewAction({ ...args, action: { toolName: "commit_preview", chapter: action.chapter } });
  };
  const fillBeats: NextStepChoice[] = missing.length > 0
    ? [{ label: "补上这几条", intent: `第 ${action.chapter} 章把这几条要点补进去：${missing.join("、")}。只补这些，别的不动。` }]
    : [];
  // 写完已经核过一遍账（结果在核账记忆里）：直接出核账卡、问题画到稿纸上，不用作者再点「核账」。
  if (cached) {
    args.sendEvent("text-delta", { text: "\n" });
    const fixed = result?.qualityPipeline?.continuity?.autoFixed?.applied;
    await sendAfterDraftCheck({
      ...args,
      chapter: action.chapter,
      output: cached,
      ...(typeof fixed === "number" && fixed > 0 ? { fixedAfterDraft: fixed } : {}),
      ...(short ? { shortAfterDraft: true } : {}),
      ...(args.thenPreview ? { skipNextSteps: true } : { moreChoices: fillBeats }),
    });
    if (args.thenPreview) await preview();
    return;
  }
  if (written && args.thenPreview) {
    await preview();
    return;
  }
  const choices: NextStepChoice[] = written
    ? [
      ...(short ? [continueChoice(action.chapter)] : []),
      ...fillBeats,
      {
        label: "预览定稿",
        intent: `预览第 ${action.chapter} 章的定稿改动`,
        recommended: !short && fillBeats.length === 0,
        action: { toolName: "commit_preview", chapter: action.chapter },
      },
      { label: "核账", intent: "核账", action: checkChapterAction(action.chapter) },
    ]
    : retryDraftChoices(action, result?.blockedReason, result?.kept);
  if (choices.length === 0) return;
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: written ? `第 ${action.chapter} 章写好了，接下来？` : `第 ${action.chapter} 章没写成，接下来？`, choices },
  });
}
