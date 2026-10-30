/**
 * agentChatClient — 读 POST /api/agent/chat 的 SSE 流，把后端事件分发给回调。
 *
 * 后端事件协议（见 server/routes/agent-chat.ts）：
 *   - text-delta   { text }                                 → onTextDelta(text)
 *   - tool-call    { toolCallId, toolName, args }           → onToolCall({ toolName })
 *   - tool-result  { toolCallId, toolName, output }         → onToolResult({ toolName, overview, refreshScope, snapshotId })
 *   - tool-error   { toolCallId, toolName, error, retryable } → onToolError({ toolCallId, toolName, message, retryable })
 *   - operation    { type: snapshot|record, operation } / { type: live, opId, event } → onOperation / onOperationProgress（写作版本 P2a）
 *   - error        { error, retryable, reason }             → onError(message, retryable, reason)
 *   - done         { finishReason? }                        → onDone()
 *
 * SSE 行读法参考现有 fetchChapterChatStream：跨 chunk 缓冲，空行 flush 一个事件。
 * 铁律：绝不静默失败——HTTP 非 2xx / 无 body / SSE error 事件，统统走 onError（默认可重试）。
 */
import { mergeSignals } from "./fetchJson.js";
import type { StateOverview, DraftReviewView, QualityCardReport } from "./types.js";
import type { AiFlavorReport } from "../types.js";
import type { BrainstormCardData, CommitPreviewCardData, DraftVersionsCardData, SettingRefData, SettleCardData } from "../type-defs/workspace.js";
import { readBrainstormData } from "../utils/brainstormCard.js";
import { readCommitPreviewCard } from "../utils/commitPreviewCard.js";
import { readDraftVersions } from "../utils/draftVersions.js";
import { readSettleData, readSettleExcluded } from "../utils/settleCard.js";
import type { AiErrorReason } from "../server/lib/ai-errors.js";
import type { ChatHistoryMessage } from "../server/lib/project-io.js";

const AI_ERROR_REASONS: readonly AiErrorReason[] = ["setup", "auth", "quota", "rate-limit", "server", "network", "timeout", "unknown"];

/** 服务端给的出错原因（P11）：只认约定的几个值，别的当没给。 */
export function readAiErrorReason(value: unknown): AiErrorReason | undefined {
  return AI_ERROR_REASONS.find((reason) => reason === value);
}

export interface StreamAgentChatRequest {
  readonly projectPath: string;
  readonly messages: readonly ChatHistoryMessage[];
  /** 用户当前打开/停留的章号。后端据此引导 agent 默认作用于该章、工具缺省回退该值（H3：回看旧章不写错章）。 */
  readonly currentChapter?: number;
  /**
   * R7.2：上一个有写盘回合的首个快照（该回合第一次写盘前）。后端 undo 工具优先按它整回合回退，
   * 与作者说「撤销上一步」= 撤上一回合全部改动 的理解一致。
   */
  readonly lastTurnUndoHint?: { readonly snapshotId: string; readonly changes: number };
  /** 作者给当前章挑中的走法（稿纸上方点的「用这个」）：作者在对话里说「照这个写」时 AI 才知道是哪条。 */
  readonly pickedDirection?: { readonly chapter: number; readonly text: string };
  /** 结构化动作（作者点了按钮）：服务端直接交给执行器或直接做，不经模型。 */
  readonly action?: AgentUserAction;
  /** 这一轮是作者哪条消息发起的（写作版本 P2a）：消息号随消息存、重发沿用；对话里交的操作按它去重（一条消息只做一件）。 */
  readonly messageId?: string;
  readonly issuedAt?: string;
}

/** 检查的四种（服务端 inspect.run 的 mode）。 */
export type InspectModeData = "continuity" | "quality" | "review" | "flavor";
export const INSPECT_MODES: readonly InspectModeData[] = ["continuity", "quality", "review", "flavor"];

/** 写稿的两种（服务端 draft.change 的 mode）：写这一章 / 接着往下写。 */
export type DraftModeData = "write" | "continue";

/** 写稿参数（与服务端 services/draft-change/params.ts 的 DraftChangeParams 同形）。 */
export interface DraftParamsData {
  readonly chapter: number;
  readonly direction?: string;
  readonly mustHitBeats?: readonly string[];
  readonly length?: number;
  readonly selectedCharacters?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  readonly candidates?: 2 | 3;
  /** 几版作者自己挑（「AI 另写几版」）：每版都留成候选、一版不换上。 */
  readonly pick?: "author";
  readonly autoDeAi?: false;
  readonly thenPreview?: true;
  /** 作者点了「重写这一章」（这章有稿、已定稿也整章重写）。 */
  readonly rewrite?: true;
  readonly allowWriteAhead?: true;
}

/** 改稿（片 2C，和服务端 services/draft-change/params.ts 的 DraftEditParams 同形）：改写几段 / 按核账改 / 去 AI 味。 */
export type DraftEditModeData = "revise" | "fix" | "deai";

export type DraftEditParamsData =
  | {
    readonly mode: "revise";
    readonly chapter: number;
    readonly edits: readonly { readonly targetText: string; readonly revisionGoal?: string; readonly replacementText?: string }[];
    readonly style?: "deai";
    /** 改好先给作者看、点了「换上」才换（选中文字改写）。 */
    readonly preview?: true;
  }
  | { readonly mode: "fix"; readonly chapter: number; readonly fixes: readonly { readonly targetText: string; readonly revisionGoal: string }[] }
  | {
    readonly mode: "deai";
    readonly chapter: number;
    readonly violations: readonly { readonly id: string; readonly text: string; readonly reason?: string; readonly severity?: string; readonly suggestedFix?: string }[];
  };

/** 一次最多改几处、一处原句最多多长（和服务端 params.ts 的 EDIT_MAX_* 一致；超了服务端整个不收）。 */
export const EDIT_MAX_TEXT = 800;
export const EDIT_MAX_FIXES = 12;
export const EDIT_MAX_VIOLATIONS = 30;

/** 改了的一处（改前 → 改后）。 */
export interface EditChangeData {
  readonly from: string;
  readonly to: string;
}

/**
 * 操作按钮（写作版本 P2a，与服务端 agent/user-actions.ts 的 OperationAction 同形）：交一次新的检查、写稿、改稿（请求号在按钮出的时候给，
 * 连点两下只做一次）、停着的「接着做」（等作者点的带上点的哪个）、「不要了」。
 */
export type OperationActionData =
  | {
    readonly kind: "new";
    readonly type: "inspect.run";
    readonly mode: InspectModeData;
    readonly params: { readonly chapter: number; readonly fresh?: true };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  | {
    readonly kind: "new";
    readonly type: "draft.change";
    readonly mode: DraftModeData;
    readonly params: DraftParamsData;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  | {
    readonly kind: "new";
    readonly type: "draft.change";
    readonly mode: DraftEditModeData;
    readonly params: DraftEditParamsData;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 换上 / 不要一份 AI 稿（片 2D：稿纸提示条、「另外几版」卡）。 */
  | CandidateActionData<"draft.adopt">
  | CandidateActionData<"draft.discard">
  /** 想走法（片 2D：稿纸上方「给我几种走法」「再来几种」）。 */
  | { readonly kind: "new"; readonly type: "plan.propose"; readonly params: PlanParamsData; readonly requestKey: string; readonly issuedAt: string }
  /** 「认下」（片 3）：那次改设定里 AI 刚写进去的那几处算作者写的。accept = 那次改设定的操作号。 */
  | { readonly kind: "new"; readonly type: "settings.change"; readonly params: { readonly accept: string }; readonly requestKey: string; readonly issuedAt: string }
  /** 作者在线索板 / 梗概上直接改账（片 3）：这几笔不再问，直接记（作者档、可撤销）。 */
  | { readonly kind: "new"; readonly type: "ledger.change"; readonly mode: "author"; readonly params: { readonly changes: readonly LedgerChangeData[] }; readonly requestKey: string; readonly issuedAt: string }
  /** 定论（片 3C）：核账卡「以第 N 章为准 / 以本章为准 / 以设定为准」（pick）；「以定论为准」、设定本「查前文」、定论卡「重新查」（statement）。 */
  | { readonly kind: "new"; readonly type: "canon.propose"; readonly mode: "pick"; readonly params: CanonPickData; readonly requestKey: string; readonly issuedAt: string }
  | { readonly kind: "new"; readonly type: "canon.propose"; readonly mode: "statement"; readonly params: CanonStatementData; readonly requestKey: string; readonly issuedAt: string }
  /** 定稿（片 4A）：「定稿」出清单；「就这么短，照样定稿」带 allowShort（只认按钮）。 */
  | { readonly kind: "new"; readonly type: "commit.prepare"; readonly params: CommitPrepareParamsData; readonly requestKey: string; readonly issuedAt: string }
  | { readonly kind: "resume"; readonly opId: string; readonly answer?: AuthorAnswerData }
  | { readonly kind: "cancel"; readonly opId: string };

/** 作者点了等着的那个按钮：哪一个、点的哪个决定、划掉了哪几项、填了哪几栏（定稿清单上改的天数 day / dayEnd）。 */
export interface AuthorAnswerData {
  readonly actionId: string;
  readonly decision: string;
  readonly excluded?: readonly string[];
  readonly values?: Readonly<Record<string, number>>;
}

/** 定稿参数（和服务端 recipes/commit-prepare.ts 的 CommitPrepareParams 同形）。 */
export interface CommitPrepareParamsData {
  readonly chapter: number;
  readonly allowShort?: true;
}

/** 一个定稿按钮（请求号这时候给）。allowShort＝这一章就这么短，不拿字数下限挡。 */
export function newCommitAction(chapter: number, options: { readonly allowShort?: boolean } = {}): OperationActionData {
  return {
    kind: "new",
    type: "commit.prepare",
    params: { chapter, ...(options.allowShort ? { allowShort: true as const } : {}) },
    requestKey: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
  };
}

/** 作者直接改的一笔账（和服务端 services/ledger-change/plan.ts 的 LedgerChangeRequest 同形，界面只用到这几种）。title 只给对话里回显用，服务端不读。 */
export type LedgerChangeData =
  | { readonly op: "resolve"; readonly id: string; readonly chapter: number; readonly title?: string }
  | { readonly op: "importance"; readonly id: string; readonly importance: "major" | "normal" | "minor"; readonly title?: string }
  | { readonly op: "summary"; readonly chapter: number; readonly text: string };

/** 一个直接改账的按钮（请求号这时候给：点了一次就是这一次）。 */
export function newLedgerAction(changes: readonly LedgerChangeData[]): OperationActionData {
  return { kind: "new", type: "ledger.change", mode: "author", params: { changes }, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
}

/** 定论的一边：某章的一句，或设定本的一栏。 */
export type SettleSideData =
  | { readonly where: "chapter"; readonly chapter: number; readonly quote: string }
  | { readonly where: "setting"; readonly quote: string; readonly label: string; readonly card?: string };
export type ChapterSideData = Extract<SettleSideData, { readonly where: "chapter" }>;

/** 以某一边为准（和服务端 recipes/canon-propose.ts 的 CanonProposeInput 同形）：item＝核账卡上点的那条（条目键），改齐后那条算改掉了。 */
export interface CanonPickData {
  readonly chapter: number;
  readonly truth: SettleSideData;
  readonly other?: SettleSideData;
  readonly also?: readonly ChapterSideData[];
  readonly reason?: string;
  readonly item?: string;
}

/** 按作者定下的说法查全书：also＝核账报过和它打架的那几句（一定查）。 */
export interface CanonStatementData {
  readonly statement: string;
  readonly chapter?: number;
  readonly also?: readonly ChapterSideData[];
}

/** 一个定论按钮（请求号这时候给：点了一次就是这一次）。 */
export function newCanonPick(params: CanonPickData): OperationActionData {
  return { kind: "new", type: "canon.propose", mode: "pick", params, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
}

export function newCanonStatement(params: CanonStatementData): OperationActionData {
  return { kind: "new", type: "canon.propose", mode: "statement", params, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
}

/** 换上 / 不要 AI 稿（和服务端 services/draft-change/params.ts 的 CandidateDecisionParams 同形）。 */
export type CandidateDecisionTypeData = "draft.adopt" | "draft.discard";

interface CandidateActionData<T extends CandidateDecisionTypeData> {
  readonly kind: "new";
  readonly type: T;
  readonly params: CandidateDecisionParamsData;
  readonly requestKey: string;
  readonly issuedAt: string;
}

export interface CandidateDecisionParamsData {
  readonly chapter: number;
  readonly candidateId: string;
  /** 作者看到的那一份的指纹。 */
  readonly sha: string;
  /** 换上：作者眼前那份工作稿的版本（这一章原来没有工作稿是 null）。 */
  readonly baseVersion?: string | null;
}

/** 一个换上 / 不要 AI 稿的按钮（请求号这时候给）。 */
export function newCandidateAction(type: CandidateDecisionTypeData, params: CandidateDecisionParamsData): OperationActionData {
  const stamp = { requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
  return type === "draft.adopt" ? { kind: "new", type, params, ...stamp } : { kind: "new", type, params, ...stamp };
}

/** 想走法的参数（和服务端 recipes/plan-propose.ts 的 PlanProposeParams 同形）：idea = 作者填的想法原话；avoid = 已经给过的走法名字。 */
export interface PlanParamsData {
  readonly chapter: number;
  readonly idea?: string;
  readonly avoid?: readonly string[];
}

/** 一个想走法按钮（请求号这时候给）。 */
export function newPlanAction(params: PlanParamsData): OperationActionData {
  return { kind: "new", type: "plan.propose", params, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
}

export const isCandidateDecisionType = (type: unknown): type is CandidateDecisionTypeData => type === "draft.adopt" || type === "draft.discard";

/** 一个新检查按钮（请求号这时候给）。 */
export function newInspectAction(mode: InspectModeData, chapter: number, options: { readonly fresh?: boolean } = {}): OperationActionData {
  return {
    kind: "new",
    type: "inspect.run",
    mode,
    params: { chapter, ...(mode === "continuity" && options.fresh ? { fresh: true as const } : {}) },
    requestKey: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
  };
}

/** 一个新写稿按钮（写这一章 / 重写 / 接着往下写；请求号这时候给）。 */
export function newDraftAction(mode: DraftModeData, params: DraftParamsData): OperationActionData {
  return { kind: "new", type: "draft.change", mode, params, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
}

/** 一个新改稿按钮（请求号这时候给）。 */
export function newEditAction(params: DraftEditParamsData): OperationActionData {
  return { kind: "new", type: "draft.change", mode: params.mode, params, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString() };
}

export const isDraftEditMode = (mode: unknown): mode is DraftEditModeData => mode === "revise" || mode === "fix" || mode === "deai";

export type DraftEditActionData = Extract<OperationActionData, { readonly mode: DraftEditModeData }>;

/** 是改稿按钮（不是写稿、检查）。 */
export const isDraftEditAction = (action: AgentUserAction): action is DraftEditActionData =>
  "kind" in action && action.kind === "new" && action.type === "draft.change" && isDraftEditMode(action.mode);

/** 是操作按钮（不是按工具名的老按钮）。 */
export function isOperationAction(action: AgentUserAction): action is OperationActionData {
  return "kind" in action;
}

/** 结构化动作（与服务端 agent/user-actions.ts 的 UserAction 同形）。 */
export type AgentUserAction =
  | OperationActionData
  | { readonly toolName: "prune_snapshots"; readonly keep?: number }
  | { readonly toolName: "undo" };

/** 核账结果里的一条：本章原句 ↔ 前文原句；对设定本的条目 earlierQuote＝设定原文（R7.3）。 */
export interface ContinuityCheckItem {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  /** R7.3 对的是设定本（人物卡 / 地点 / 资产 / 世界规则）而不是某一章。 */
  readonly againstSetting?: SettingRefData;
  /** R7.3 错在哪一章、按钮就改哪一章（前文章和设定不一致时指向前文那章）；缺省＝本章。 */
  readonly fixChapter?: number;
  /** 这句是上一遍按核账改出来的（from＝改前那句），这遍又说不对：两遍说法相反，已降成「可能」。 */
  readonly revisited?: { readonly from: string };
}

const SETTING_KINDS = new Set<NonNullable<SettingRefData["kind"]>>(["canon", "story", "character", "place", "item", "lore"]);

/** 核账条目的 againstSetting（防御解析）：没有 label 的不算；kind 只认那几类（定论 / 故事设定 / 四种卡），卡名是非空字符串才带。 */
export function readSettingRef(value: unknown): SettingRefData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label) return undefined;
  const kind = typeof record.kind === "string" && SETTING_KINDS.has(record.kind as NonNullable<SettingRefData["kind"]>)
    ? record.kind as NonNullable<SettingRefData["kind"]>
    : undefined;
  const card = typeof record.card === "string" && record.card.trim() ? record.card.trim() : undefined;
  return { label, ...(kind ? { kind } : {}), ...(card ? { card } : {}) };
}

/** 核账结果（投影到消息上渲染「核账」卡）。 */
export interface ContinuityCheckView {
  readonly chapter: number;
  readonly sure: readonly ContinuityCheckItem[];
  readonly maybe: readonly ContinuityCheckItem[];
  /** 错在前面某章、之前报过还没改的。 */
  readonly earlierOpen?: readonly ContinuityCheckItem[];
}

function toContinuityItems(value: unknown): readonly ContinuityCheckItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.quote !== "string" || typeof record.earlierQuote !== "string") return [];
    const againstSetting = readSettingRef(record.againstSetting);
    return [{
      quote: record.quote,
      earlierQuote: record.earlierQuote,
      earlierChapter: typeof record.earlierChapter === "number" ? record.earlierChapter : 0,
      reason: typeof record.reason === "string" ? record.reason : "",
      ...(againstSetting ? { againstSetting } : {}),
      ...(Number.isInteger(record.fixChapter) && (record.fixChapter as number) > 0 ? { fixChapter: record.fixChapter as number } : {}),
      ...(readRevisited(record.revisited) ?? {}),
    }];
  });
}

function readRevisited(value: unknown): { readonly revisited: { readonly from: string } } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const from = (value as Record<string, unknown>).from;
  return typeof from === "string" && from.trim() ? { revisited: { from: from.trim() } } : undefined;
}

export interface AgentToolResult {
  readonly toolCallId?: string;
  readonly toolName: string;
  /** 工具诚实成功标志（写类/出稿工具）：false=引擎拒绝/失败/未写入。前端据此把时间线置 failed，防 agent 文本谎报盖过真实结果。 */
  readonly ok?: boolean;
  /** 写类工具因「需用户确认」被挡下（如删除角色未确认）：前端据此把该步骤置 needs_confirmation（待确认·暖色），区别于失败/红。 */
  readonly needsConfirmation?: boolean;
  /** 部分纠错失败（写成功但有要删的目标没命中）：前端据此把该步骤置 partial（部分完成·琥珀色），不当全成功绿色（修#1）。 */
  readonly partialMiss?: boolean;
  /** R7.9：工具参数/输出没过 Mastra 校验（服务端归一标记）——投影层一律置「失败」，即便裁决类工具（没跑≠裁决未过）。 */
  readonly toolValidationFailure?: boolean;
  /** 工具边界没让它执行（这一轮已经出了稿，先等作者看稿）：投影层置「已停止」，不当失败。 */
  readonly skipped?: boolean;
  readonly summary?: string;
  /** 改草稿类工具（revise_draft）返回的「当前章完整草稿正文（去 Markdown 标题）」。
   *  前端据此把真正文载入工作区——否则只能用不含正文的 overview 刷新，草稿被占位覆盖、autosave 抹掉真正文。 */
  readonly draftBody?: string;
  readonly draftTitle?: string;
  /** 这份正文写回时的版本号（revise_draft 带，同一进程严格递增）：并行改稿的结果到达顺序不等于写入顺序，前端只套用更新的。 */
  readonly draftVersion?: number;
  /** undo_last_change 专属：true=磁盘真的被 git 回退了。前端据此冻结 autosave、改读磁盘真值、回合收尾后整页重载——
   *  否则内存里撤销前的旧稿会被 autosave 写回去（此前只靠 409 冲突兜底）。 */
  readonly undone?: boolean;
  readonly overview?: StateOverview;
  readonly refreshScope?: "full" | "foundation";
  readonly snapshotId?: string;
  /** 写类/出稿工具实际操作的章号：透传给投影层回写进 turnSnapshots，供「撤销到此回合」写回该回合实际操作的章。 */
  readonly chapter?: number;
  /** suggest_next_steps 专属：agent 提议的下一步选项，透传给投影层挂到消息→驱动「下一步」卡。
   *  choice.action（R4.7）：服务端自己生成的确定性选项带结构化动作，点击直接发 body.action 不经模型；
   *  模型生成的选项没有 action。 */
  readonly nextStepPrompt?: {
    readonly question: string;
    readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean; readonly action?: AgentUserAction }[];
  };
  /** prune_snapshots 专属：模型只做了预览、有可裁内容，等用户点「确认裁剪」按钮。 */
  readonly pruneConfirmAction?: { readonly keep?: number };
  /** change_draft 专属（重构 P4）：这一章已有稿子，AI 不覆盖，等作者点「接着往下写」「重写这一章」（服务端出的按钮动作）。 */
  readonly rewriteChoices?: readonly RewriteChoiceData[];
}

/** 「接着往下写」「重写这一章」按钮：服务端出的写稿动作（点几次都是这一次）。 */
export interface RewriteChoiceData {
  readonly label: string;
  readonly mode: DraftModeData;
  readonly action: OperationActionData;
}

/** 操作的状态（与服务端 lib/operations/store.ts 的 OperationState 同形）。 */
export type OperationStateData = "queued" | "running" | "waiting_author" | "paused" | "succeeded" | "failed" | "cancelled" | "obsolete";
const OPERATION_STATES: readonly OperationStateData[] = ["queued", "running", "waiting_author", "paused", "succeeded", "failed", "cancelled", "obsolete"];

/** 检查做完的结果卡（按检查种类映射回原来的卡片字段）。checkedVersion＝查的是工作稿哪一版（查定稿时没有）。 */
export interface InspectCardsData {
  readonly continuityCheck?: ContinuityCheckView;
  readonly qualityReport?: QualityCardReport;
  readonly draftReview?: DraftReviewView;
  readonly aiFlavorReport?: AiFlavorReport;
  readonly checkedVersion?: string;
}

/** 一次操作给界面看的样子（服务端 operationView 的子集，防御解析）。中文说法（what / stateText）都是服务端给的。 */
export interface OperationViewData {
  readonly opId: string;
  readonly kind: string;
  readonly mode?: string;
  readonly chapter?: number;
  /** 做的什么（「核账·第 3 章」）。 */
  readonly what: string;
  readonly state: OperationStateData;
  readonly stateText: string;
  /** 作者能点的（接着做 / 不要了）。 */
  readonly allowed: readonly ("resume" | "cancel")[];
  readonly pauseReason?: string;
  readonly currentStep?: string;
  /** 给作者看的一句（结论或没成的原因）。 */
  readonly summary: string;
  /** 结束了的那一句（对话收尾和卡上同一句，服务端拼好的）；没结束是空串。 */
  readonly conclusion: string;
  readonly failure?: { readonly message: string; readonly retryable: boolean };
  readonly eventSeq: number;
  /** 谁交的（对话 / 按钮 / 后台）和那句话、那个按钮的号：重开书时找回这次操作挂在哪条消息上。 */
  readonly origin: { readonly kind: string; readonly messageId?: string };
  /** 检查做完了的结果卡。 */
  readonly inspect?: InspectCardsData;
  /** 写稿做完了的那几样（写的哪章、换上了没有、另外几版）。 */
  readonly draft?: DraftOperationData;
  /** 想走法做完了的几种走法（走法卡、稿纸上方给作者挑）。 */
  readonly plan?: BrainstormCardData;
  /** 改设定、改账、定论改齐了（设定本 / 概况跟着重读、这一轮记下存档点）。 */
  readonly changed?: ChangedData;
  /** 定论做完了：卡、作者划掉的、改没改（核账卡认哪几条被改掉了）。 */
  readonly canon?: CanonResultData;
  /** 定稿做完了：定不了的原因（定稿清单卡照摆），或定成了（定稿回执、打的存档点）。 */
  readonly commit?: CommitResultData;
  /** 等作者点的（改写的改前改后 +「换上 / 再改一版」、改设定的「确认改设定」、改账的「确认改账」）；点过的不算。 */
  readonly pending?: PendingActionData;
}

/** 改设定、改账、定论改齐了（都在设定本里：设定卡、线索板和故事地图、定论；定论还可能改了正文）：打的存档点。 */
export interface ChangedData {
  readonly what: "settings" | "ledger" | "canon";
  readonly snapshotId?: string;
}

/** 定稿做完了（服务端 CommitPrepareBody 的子集）：定不了的带清单卡（原因、「就这么短」），定成了的带回执原样（渲染侧防御解析）。 */
export interface CommitResultData {
  readonly chapter: number;
  readonly committed: boolean;
  readonly blocked?: CommitPreviewCardData;
  readonly report?: unknown;
  readonly snapshotId?: string;
}

/** 定论做完了（服务端 CanonProposeBody 的子集）。 */
export interface CanonResultData {
  readonly card: SettleCardData;
  readonly excluded: readonly string[];
  readonly applied: boolean;
}

/** 改写的改法（等作者点「换上」，服务端 RevisePreview 的子集）。 */
export interface RevisePreviewData {
  readonly round: number;
  readonly changes: readonly EditChangeData[];
  readonly failed: readonly { readonly target: string; readonly why: string }[];
  readonly brief?: string;
}

/**
 * 等作者点的那个按钮：改写的「换上 / 再改一版」；改设定的「确认改设定」、改账的「确认改账」（同一张确认卡：
 * 服务端 SettingsConfirmPreview / LedgerConfirmPreview，要改的每一处只有名字、原话，notes 是附带要说的）。
 */
export type PendingActionData =
  | { readonly kind: "revise"; readonly actionId: string; readonly decisions: readonly string[]; readonly revise: RevisePreviewData }
  /** 定论查完了等作者点「确认」（服务端 CanonConfirmPreview）：卡上每处能划掉。 */
  | { readonly kind: "canon"; readonly actionId: string; readonly decisions: readonly string[]; readonly card: SettleCardData; readonly summary: string }
  | { readonly kind: "confirm"; readonly what: "settings" | "ledger"; readonly actionId: string; readonly decisions: readonly string[]; readonly lines: readonly string[]; readonly notes: readonly string[] }
  /** 定稿清单等作者点「确认定稿」（服务端 CommitConfirmPreview）：清单上每行能划掉、天数两栏能改。 */
  | { readonly kind: "commit"; readonly actionId: string; readonly decisions: readonly string[]; readonly preview: CommitPreviewCardData };

/** 写稿做完了的结果（服务端 draft.change 结果 body 的子集）。 */
export interface DraftOperationData {
  readonly chapter: number;
  /** 换上了工作稿（没换上：写的途中稿子或前文改过，AI 这版留成候选在稿纸上等作者选）。 */
  readonly applied: boolean;
  readonly title?: string;
  /** 这次写稿打的存档点，先后照写的先后（新拟的章纲存盘前、换上工作稿前）：这一轮的「撤销到此」、对话里说「撤销上一步」从第一个退。 */
  readonly snapshots?: readonly string[];
  /** 一次写几版时落选的几版、作者要自己挑的几版（「另外几版」卡；都留成了候选）。 */
  readonly versions?: DraftVersionsCardData;
  /** 改稿改了的几处（稿纸上高亮改后那句）。 */
  readonly changes?: readonly EditChangeData[];
}

/** 操作的实时事件（与服务端 lib/operations/live.ts 的 LiveEvent 同形）。 */
export type OperationLiveData =
  /** 一步开始（含整步重做）：exec 换了，之前流出来的正文作废。 */
  | { readonly type: "step"; readonly step: string; readonly exec: string }
  | { readonly type: "progress"; readonly text: string }
  /** 正文流：同一个 exec 里 streamSeq 递增；replace＝新写的这段整段换成 text；base＝接着写时本来写好的那段。 */
  | { readonly type: "draft-delta"; readonly exec: string; readonly streamSeq: number; readonly text: string; readonly replace?: true; readonly base?: true };

export function readOperationLive(value: unknown): OperationLiveData | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "progress") return typeof value.text === "string" ? { type: "progress", text: value.text } : undefined;
  if (value.type === "step") return typeof value.step === "string" && typeof value.exec === "string" ? { type: "step", step: value.step, exec: value.exec } : undefined;
  if (value.type !== "draft-delta" || typeof value.exec !== "string" || typeof value.text !== "string" || typeof value.streamSeq !== "number") return undefined;
  return {
    type: "draft-delta",
    exec: value.exec,
    streamSeq: value.streamSeq,
    text: value.text,
    ...(value.replace === true ? { replace: true as const } : {}),
    ...(value.base === true ? { base: true as const } : {}),
  };
}

/** 改了的几处（防御解析：不是一对字的丢掉）；一处没有是 undefined。 */
function editChanges(value: unknown): readonly EditChangeData[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes = value.flatMap((item): EditChangeData[] => (isRecord(item) && typeof item.from === "string" && typeof item.to === "string" ? [{ from: item.from, to: item.to }] : []));
  return changes.length > 0 ? changes : undefined;
}

/** 改写等作者点「换上」的那个按钮（服务端 REVISE_CONFIRM_KIND）、「确认改设定」（SETTINGS_CONFIRM_KIND）、「确认改账」（LEDGER_CONFIRM_KIND）；点过的、认不出的不算。 */
const REVISE_CONFIRM_KIND = "draft.revise.confirm";
const CONFIRM_KINDS: Readonly<Record<string, "settings" | "ledger">> = { settings_confirm: "settings", ledger_confirm: "ledger" };
const CANON_CONFIRM_KIND = "canon_confirm";
const COMMIT_CONFIRM_KIND = "commit_confirm";

function readPendingAction(value: unknown): PendingActionData | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item) || item.decided === true || typeof item.actionId !== "string") continue;
    const decisions = Array.isArray(item.decisions) ? item.decisions.filter((decision): decision is string => typeof decision === "string") : [];
    const preview = isRecord(item.preview) ? item.preview : undefined;
    const what = typeof item.kind === "string" ? CONFIRM_KINDS[item.kind] : undefined;
    if (what) {
      // 改设定一次最多 60 步（核心 MAX_OPS_PER_CHANGE），改账最多 20 笔：卡上一条不漏。
      const lines = preview ? textList(preview.lines, 60) : undefined;
      if (!lines || decisions.length === 0) continue;
      return { kind: "confirm", what, actionId: item.actionId, decisions, lines, notes: textList(preview!.notes, 20) ?? [] };
    }
    if (item.kind === COMMIT_CONFIRM_KIND) {
      const view = preview ? readCommitPreviewCard(preview.view) : undefined;
      if (!view || decisions.length === 0) continue;
      return { kind: "commit", actionId: item.actionId, decisions, preview: view };
    }
    if (item.kind === CANON_CONFIRM_KIND) {
      const card = preview ? readSettleData(preview.card) : undefined;
      if (!card || decisions.length === 0) continue;
      return { kind: "canon", actionId: item.actionId, decisions, card, summary: typeof preview!.summary === "string" ? preview!.summary : "" };
    }
    if (item.kind !== REVISE_CONFIRM_KIND) continue;
    const changes = preview ? editChanges(preview.changes) : undefined;
    if (!preview || !changes || decisions.length === 0) continue;
    const failed = Array.isArray(preview.failed)
      ? preview.failed.flatMap((entry) => (isRecord(entry) && typeof entry.target === "string" && typeof entry.why === "string" ? [{ target: entry.target, why: entry.why }] : []))
      : [];
    return {
      kind: "revise",
      actionId: item.actionId,
      decisions,
      revise: {
        round: positiveInt(preview.round) ?? 1,
        changes,
        failed,
        ...(typeof preview.brief === "string" && preview.brief.trim() ? { brief: preview.brief.trim() } : {}),
      },
    };
  }
  return undefined;
}

/** 写稿结果 → 界面要的那几样（不是写稿、没做完、形状不对是 undefined）。 */
function readDraftOperation(body: unknown): DraftOperationData | undefined {
  if (!isRecord(body)) return undefined;
  const chapter = positiveInt(body.chapter);
  if (chapter === undefined) return undefined;
  // 换上作者挑的 AI 稿（片 2D）：换没换上、打的存档点（这一轮的「撤销到此」从它退）。
  if (body.kind === "draft.adopt") {
    return { chapter, applied: body.applied === true, ...(typeof body.snapshotId === "string" && body.snapshotId ? { snapshots: [body.snapshotId] } : {}) };
  }
  if (body.kind !== "draft.change") return undefined;
  const versions = readDraftVersions({ chapter, otherVersions: body.otherVersions, ...(body.pick === "author" ? { pick: true } : {}) });
  const snapshots = [body.planSnapshotId, body.ok === true ? body.snapshotId : undefined]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const changes = editChanges(body.changes);
  return {
    chapter,
    applied: body.ok === true,
    ...(typeof body.draftTitle === "string" && body.draftTitle.trim() ? { title: body.draftTitle.trim() } : {}),
    ...(snapshots.length > 0 ? { snapshots } : {}),
    ...(changes ? { changes } : {}),
    ...(versions ? { versions } : {}),
  };
}

export interface AgentToolError {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentChatHandlers {
  readonly onTextDelta: (text: string) => void;
  /** 服务端状态说明（如「历史过长，仅保留最近 N 条作为上下文」）：必须展示给用户，不能静默吞掉（R4）。 */
  readonly onStatus?: (message: string) => void;
  /** 思考链增量（仅思考模式下有）。累加成消息的「思考过程」。 */
  readonly onReasoningDelta?: (text: string) => void;
  readonly onToolCall: (info: { readonly toolCallId?: string; readonly toolName: string }) => void;
  readonly onToolResult: (info: AgentToolResult) => void;
  /** 这一轮交上的操作（写作版本 P2a）：每次记录变了发一份（先一份当前的）。 */
  readonly onOperation?: (operation: OperationViewData) => void;
  /** 操作的一句进度（「核账员在读第 3 章」）。 */
  readonly onOperationProgress?: (info: { readonly opId: string; readonly text: string }) => void;
  /** 操作的步骤开始、正文流（写稿时正文逐字进稿纸）。 */
  readonly onOperationLive?: (info: { readonly opId: string; readonly event: Exclude<OperationLiveData, { readonly type: "progress" }> }) => void;
  /** 工具内部抛错：携带 toolCallId/toolName，让上层把对应步骤/卡片收尾为 failed，再 append 错误。 */
  readonly onToolError: (info: AgentToolError) => void;
  readonly onError: (message: string, retryable: boolean, reason?: AiErrorReason) => void;
  readonly onDone: () => void;
  /** 本轮真实 token 用量（服务端轮末发；服务商没回用量时为 0）。 */
  readonly onUsage?: (usage: AgentTurnUsage) => void;
}

/** 一轮对话的 token 用量（合计：对话 AI + 工具内部调用）。 */
export interface AgentTurnUsage {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

/** 空闲看门狗超时：上游/网络半挂时多久没有任何 SSE 数据就判超时、中止流（M3：治「永久转圈」）。 */
const AGENT_IDLE_TIMEOUT_MS = 90_000;

export async function streamAgentChat(
  input: StreamAgentChatRequest,
  handlers: AgentChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const { signal: mergedSignal, cleanup } = mergeSignals(signal);
  // M3：在 mergedSignal（含用户「停止」）之上再叠一个内部 controller，用于「空闲超时」中止——
  // 任一来源 abort 都会中止 fetch/读流。idleFired 区分「超时」与「用户主动停止」，给不同收尾。
  const idleController = new AbortController();
  let idleFired = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const onMergedAbort = () => idleController.abort(mergedSignal.reason);
  if (mergedSignal.aborted) idleController.abort(mergedSignal.reason);
  else mergedSignal.addEventListener("abort", onMergedAbort, { once: true });
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      idleController.abort(new DOMException("agent-idle-timeout", "AbortError"));
    }, AGENT_IDLE_TIMEOUT_MS);
  };
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  let doneEmitted = false;
  const emitDone = () => {
    if (doneEmitted) return;
    doneEmitted = true;
    handlers.onDone();
  };

  try {
    armIdle();
    const response = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectPath: input.projectPath,
        messages: input.messages,
        ...(typeof input.currentChapter === "number" ? { currentChapter: input.currentChapter } : {}),
        ...(input.lastTurnUndoHint ? { lastTurnUndoHint: input.lastTurnUndoHint } : {}),
        ...(input.pickedDirection ? { pickedDirection: input.pickedDirection } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.messageId && input.issuedAt ? { messageId: input.messageId, issuedAt: input.issuedAt } : {}),
      }),
      signal: idleController.signal,
    });
    if (!response.ok || !response.body) {
      // 非 2xx：尽量读出服务端给的真实原因（如「项目目录不存在」「API Key 未设置」），别只甩一个
      // 「请求失败：500」让用户摸不着头脑。读不到 body 才退回状态码。
      const server = await readServerError(response);
      handlers.onError(server.message ?? `写作助手请求失败：${response.status}`, true, server.reason);
      emitDone();
      return;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];
    let badFrameReported = false;

    const flush = () => {
      if (dataLines.length === 0) {
        eventName = "message";
        return;
      }
      const raw = dataLines.join("\n");
      dataLines = [];
      const current = eventName;
      eventName = "message";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        // 审计 Low：坏帧不再无声吞——断流尾部截断的 error/done 帧解析失败时若不报，
        // 回合会以「正常结束+内容缺尾」假收场（违反本文件头的绝不静默铁律）。每条流只报一次。
        if (!badFrameReported) {
          badFrameReported = true;
          handlers.onError("收到无法解析的事件帧（连接可能被截断），本次回复可能不完整；可重试该消息。", true);
        }
        return;
      }
      dispatchEvent(current, parsed);
    };

    const dispatchEvent = (event: string, parsed: unknown) => {
      if (!isRecord(parsed)) return;
      switch (event) {
        case "text-delta":
          if (typeof parsed.text === "string") handlers.onTextDelta(parsed.text);
          return;
        case "status":
          // 服务端状态说明（R4：历史窗口裁剪等）必须照实带给用户，不能静默吞掉。
          if (typeof parsed.message === "string") handlers.onStatus?.(parsed.message);
          return;
        case "reasoning-delta":
          if (typeof parsed.text === "string") handlers.onReasoningDelta?.(parsed.text);
          return;
        case "tool-call":
          if (typeof parsed.toolName === "string") {
            handlers.onToolCall({
              toolName: parsed.toolName,
              toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
            });
          }
          return;
        case "tool-result": {
          if (typeof parsed.toolName !== "string") return;
          const output = isRecord(parsed.output) ? parsed.output : {};
          handlers.onToolResult({
            toolName: parsed.toolName,
            toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
            // 诚实成功标志 + 摘要必须透传给投影层，否则 ok:false 的失败会被显示成完成（结构性谎报）。
            // 条件透传：读类工具无 ok/summary 则不带这俩 key（保持轻量、不影响读类行为）。
            ...(typeof output.ok === "boolean" ? { ok: output.ok } : {}),
            // 需确认（删除角色未确认等）：透传给投影层置「待确认」步骤态，区别于失败。
            ...(output.needsConfirmation === true ? { needsConfirmation: true } : {}),
            ...(output.partialMiss === true ? { partialMiss: true } : {}),
            // R7.9：Mastra 校验失败标记（服务端 agent-chat 归一时带上）——投影层据此一律置「失败」，
            // 即便是裁决类工具（校验失败=工具没跑，不是「裁决未过」）。
            ...(output.toolValidationFailure === true ? { toolValidationFailure: true } : {}),
            ...(output.skipped === true ? { skipped: true } : {}),
            ...(typeof output.summary === "string" ? { summary: output.summary } : {}),
            // 改草稿工具的真正文必须透传，前端据此把真正文载入工作区（防占位覆盖+autosave 抹稿）。
            ...(typeof output.draftBody === "string" ? { draftBody: output.draftBody } : {}),
            ...(typeof output.draftTitle === "string" ? { draftTitle: output.draftTitle } : {}),
            ...(typeof output.draftVersion === "number" && Number.isFinite(output.draftVersion) ? { draftVersion: output.draftVersion } : {}),
            // 撤销标志（undo_last_change / 今并入 manage_snapshots op=undo）：只在布尔时透传，前端据此冻结 autosave、改读磁盘真值。
            ...(typeof output.undone === "boolean" && (parsed.toolName === "undo_last_change" || parsed.toolName === "manage_snapshots")
              ? { undone: output.undone }
              : {}),
            // suggest_next_steps 专属：agent 提议的下一步选项（question/choices 不在轻量白名单里），透传给投影层挂到消息。
            // choice.action（R4.7）按白名单防御解析（toNextStepPrompt）：只放行下一步级的操作按钮，
            // 「确认定稿」「确认裁剪」这类授权写盘动作必须走各自的确认卡，不许藏在选项里被点击直达。
            ...(parsed.toolName === "suggest_next_steps" && isNextStepPrompt(output)
              ? { nextStepPrompt: toNextStepPrompt(output) }
              : {}),
            ...((parsed.toolName === "prune_snapshots" || parsed.toolName === "manage_snapshots")
              && output.needsConfirmation === true
              && typeof output.confirmAction === "object" && output.confirmAction !== null
              ? {
                  pruneConfirmAction: {
                    ...(typeof (output.confirmAction as { keep?: unknown }).keep === "number"
                      ? { keep: (output.confirmAction as { keep: number }).keep }
                      : {}),
                  },
                }
              : {}),
            ...(parsed.toolName === "change_draft" && readRewriteChoices(output.rewriteChoices)
              ? { rewriteChoices: readRewriteChoices(output.rewriteChoices)! }
              : {}),
            overview: output.overview as StateOverview | undefined,
            refreshScope: output.refreshScope as "full" | "foundation" | undefined,
            snapshotId: typeof output.snapshotId === "string" ? output.snapshotId : undefined,
            chapter: typeof output.chapter === "number" ? output.chapter : undefined,
          });
          return;
        }
        case "operation": {
          if (parsed.type === "live") {
            const live = readOperationLive(parsed.event);
            if (typeof parsed.opId !== "string" || !live) return;
            if (live.type === "progress") handlers.onOperationProgress?.({ opId: parsed.opId, text: live.text });
            else handlers.onOperationLive?.({ opId: parsed.opId, event: live });
            return;
          }
          const operation = readOperationView(parsed.operation);
          if (operation) handlers.onOperation?.(operation);
          return;
        }
        case "tool-error":
          if (typeof parsed.toolName === "string") {
            handlers.onToolError({
              toolName: parsed.toolName,
              toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
              message: typeof parsed.error === "string" ? parsed.error : "写作助手执行出错。",
              retryable: parsed.retryable !== false,
            });
          }
          return;
        case "error":
          handlers.onError(
            typeof parsed.error === "string" ? parsed.error : "写作助手执行出错。",
            parsed.retryable !== false,
            readAiErrorReason(parsed.reason),
          );
          return;
        case "usage": {
          const total = parsed.total && typeof parsed.total === "object" ? parsed.total as Record<string, unknown> : undefined;
          const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
          if (total) handlers.onUsage?.({ input: num(total.input), cachedInput: num(total.cachedInput), output: num(total.output) });
          return;
        }
        case "done":
          emitDone();
          return;
        default:
          return;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // 收到数据就重置看门狗：只在「真的卡住没数据」时才超时。
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flush();
        } else if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
    }
    flush();
    // 流自然结束但后端没发 done（异常断流），也收尾，避免上层永久 loading。
    emitDone();
  } catch (error) {
    if (idleFired) {
      // 空闲超时：上游/网络半挂，给一条可重试的超时提示（而非裸 AbortError 文案）。
      handlers.onError("写作助手响应超时（约 90 秒无响应），可以点重试。", true, "timeout");
    } else if (mergedSignal.aborted) {
      // 用户主动「停止」：不报错、不留错误气泡，保留已流式出的内容，干净收尾。
      // （什么都不 onError，下面统一 emitDone。）
    } else {
      const message = error instanceof Error ? error.message : String(error);
      handlers.onError(message, true);
    }
    emitDone();
  } finally {
    clearIdle();
    mergedSignal.removeEventListener("abort", onMergedAbort);
    cleanup();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** change_draft 回执里的「接着往下写」「重写这一章」（防御解析：动作对不上写稿的丢掉）。 */
function readRewriteChoices(value: unknown): readonly RewriteChoiceData[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices = value.flatMap((item): RewriteChoiceData[] => {
    if (!isRecord(item) || typeof item.label !== "string" || !item.label.trim()) return [];
    const action = isRecord(item.action) ? parseOperationActionData(item.action) : undefined;
    return action?.kind === "new" && action.type === "draft.change" && (action.mode === "write" || action.mode === "continue") ? [{ label: item.label.trim(), mode: action.mode, action }] : [];
  });
  return choices.length > 0 ? choices : undefined;
}

/**
 * 一次操作的样子（防御解析）：号、种类、状态缺了就不认。检查做完了（succeeded）按种类把结果映射回原来的卡片字段。
 * 章号从 origin.chapter 取（对话、按钮交的都带）。
 */
export function readOperationView(value: unknown): OperationViewData | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.opId !== "string" || !value.opId || typeof value.kind !== "string") return undefined;
  const state = OPERATION_STATES.find((item) => item === value.state);
  if (!state) return undefined;
  const origin = isRecord(value.origin) ? value.origin : {};
  // 针对的章是服务端视图给的（参数里的章，不是交的时候所在的章）。
  const chapter = typeof value.chapter === "number" && Number.isInteger(value.chapter) && value.chapter > 0 ? value.chapter : undefined;
  const failure = isRecord(value.failure) && typeof value.failure.message === "string"
    ? { message: value.failure.message, retryable: value.failure.retryable !== false }
    : undefined;
  const mode = typeof value.mode === "string" ? value.mode : undefined;
  const result = isRecord(value.result) ? value.result : undefined;
  const inspect = state === "succeeded" && value.kind === "inspect.run" && mode && result ? readInspectCards(mode, result.body) : undefined;
  const draft = state === "succeeded" && (value.kind === "draft.change" || value.kind === "draft.adopt") && result ? readDraftOperation(result.body) : undefined;
  const plan = state === "succeeded" && value.kind === "plan.propose" && result ? readBrainstormData(result.body) : undefined;
  const changed = state === "succeeded" && result ? readChanged(value.kind, result.body) : undefined;
  const canon = state === "succeeded" && value.kind === "canon.propose" && result ? readCanonResult(result.body) : undefined;
  const commit = state === "succeeded" && value.kind === "commit.prepare" && result ? readCommitResult(result.body) : undefined;
  const pending = state === "waiting_author" ? readPendingAction(value.pendingActions) : undefined;
  const allowed = Array.isArray(value.allowed)
    ? value.allowed.filter((item): item is "resume" | "cancel" => item === "resume" || item === "cancel")
    : [];
  return {
    opId: value.opId,
    kind: value.kind,
    ...(mode ? { mode } : {}),
    ...(chapter !== undefined ? { chapter } : {}),
    what: typeof value.what === "string" && value.what ? value.what : "这次操作",
    state,
    stateText: typeof value.stateText === "string" ? value.stateText : "",
    allowed,
    ...(typeof value.pauseReason === "string" ? { pauseReason: value.pauseReason } : {}),
    ...(typeof value.currentStep === "string" ? { currentStep: value.currentStep } : {}),
    summary: typeof value.summary === "string" ? value.summary : "",
    conclusion: typeof value.conclusion === "string" ? value.conclusion : "",
    ...(failure ? { failure } : {}),
    eventSeq: typeof value.eventSeq === "number" ? value.eventSeq : 0,
    origin: {
      kind: typeof origin.kind === "string" ? origin.kind : "",
      ...(typeof origin.messageId === "string" && origin.messageId ? { messageId: origin.messageId } : {}),
    },
    ...(inspect ? { inspect } : {}),
    ...(draft ? { draft } : {}),
    ...(plan ? { plan } : {}),
    ...(changed ? { changed } : {}),
    ...(canon ? { canon } : {}),
    ...(commit ? { commit } : {}),
    ...(pending ? { pending } : {}),
  };
}

/** 定稿的结果：定不了的清单卡认不出、定成了没带回执都不认。 */
function readCommitResult(body: unknown): CommitResultData | undefined {
  if (!isRecord(body) || body.kind !== "commit.prepare") return undefined;
  const chapter = positiveInt(body.chapter);
  if (chapter === undefined) return undefined;
  if (body.committed !== true) {
    const blocked = readCommitPreviewCard(body.blocked);
    return blocked ? { chapter, committed: false, blocked } : undefined;
  }
  const report = isRecord(body.done) && isRecord(body.done.report) ? body.done.report : undefined;
  if (!report) return undefined;
  return { chapter, committed: true, report, ...(typeof body.snapshotId === "string" && body.snapshotId ? { snapshotId: body.snapshotId } : {}) };
}

/** 改设定、改账、定论改齐了：改了哪一片、打的存档点（这一轮的「撤销到此」从它退）。不是这几类、定论没改是 undefined。 */
function readChanged(kind: unknown, body: unknown): ChangedData | undefined {
  const what = kind === "settings.change" ? "settings" : kind === "ledger.change" ? "ledger" : kind === "canon.propose" ? "canon" : undefined;
  if (!what || !isRecord(body) || body.kind !== kind || (what === "canon" && body.applied !== true)) return undefined;
  return { what, ...(typeof body.snapshotId === "string" && body.snapshotId ? { snapshotId: body.snapshotId } : {}) };
}

/** 定论的结果：划掉的只认卡上真有的。 */
function readCanonResult(body: unknown): CanonResultData | undefined {
  if (!isRecord(body) || body.kind !== "canon.propose") return undefined;
  const card = readSettleData(body.card);
  if (!card) return undefined;
  return { card, excluded: readSettleExcluded(body.excluded, card), applied: body.applied === true };
}

/**
 * 检查结果 → 卡片字段（结构化结果的形状沿用原来四个检查工具的输出）。没查成（ok:false、审稿走了回退）不出卡：
 * 空清单不等于「没问题」，只留结论那句如实说（R4.1）。
 */
export function readInspectCards(mode: string, value: unknown): InspectCardsData | undefined {
  if (!isRecord(value)) return undefined;
  const checkedVersion = value.source === "draft" && typeof value.checkedVersion === "string" && value.checkedVersion ? { checkedVersion: value.checkedVersion } : {};
  switch (mode) {
    case "continuity": {
      if (value.ok === false || typeof value.chapter !== "number" || (!Array.isArray(value.sure) && !Array.isArray(value.maybe))) return undefined;
      const earlierOpen = toContinuityItems(value.earlierOpen);
      return {
        continuityCheck: { chapter: value.chapter, sure: toContinuityItems(value.sure), maybe: toContinuityItems(value.maybe), ...(earlierOpen.length > 0 ? { earlierOpen } : {}) },
        ...checkedVersion,
      };
    }
    case "quality":
      return value.ok !== false && isRecord(value.refined) ? { qualityReport: value.refined as unknown as QualityCardReport, ...checkedVersion } : undefined;
    case "review":
      return isDraftReview(value) ? { draftReview: value.review as DraftReviewView, ...checkedVersion } : undefined;
    case "flavor":
      return isAiFlavorReport(value) && value.ok !== false ? { aiFlavorReport: value as unknown as AiFlavorReport, ...checkedVersion } : undefined;
    default:
      return undefined;
  }
}

/** 查 AI 味结果形状校验：必须有 boolean ok + 数组 violations + boolean usedFallback。
 *  形状不符就不出卡（防把别的结果误当体检报告）。 */
function isAiFlavorReport(value: Record<string, unknown>): boolean {
  return typeof value.ok === "boolean"
    && Array.isArray(value.violations)
    && typeof value.usedFallback === "boolean";
}

/**
 * 内容审阅结果形状守卫：review 是对象且有 issues 数组（防把别的结果误当审稿报告）。
 * **审稿没跑成（ok:false / usedFallback=true）→ 返回 false**：引擎此时回 fallback 报告（含一条假 issue「AI 审稿结果不可用」），
 * 不能当「审校问题」卡渲染（否则显成『1 处问题』+ 可点改这处，点了让 agent 去改不存在的问题）；
 * 让结论那句「这次没审完、要不要重试」如实告知。与查 AI 味的 ok!==false 守卫对称。
 * ok:false 是 R4.1 同类排查补的防御位（今天 ok:false ⟺ usedFallback，字段双保险）。
 */
function isDraftReview(value: Record<string, unknown>): boolean {
  if (value.ok === false) return false;
  if (value.usedFallback === true) return false;
  const review = value.review;
  return typeof review === "object" && review !== null && Array.isArray((review as { issues?: unknown }).issues);
}

/** suggest_next_steps 输出形状守卫：有 question 字符串 + 非空 choices 数组。 */
function isNextStepPrompt(value: Record<string, unknown>): boolean {
  return typeof value.question === "string"
    && Array.isArray(value.choices)
    && value.choices.length > 0;
}

/**
 * 「下一步」选项里允许直达的结构化动作（R4.7）：只有操作按钮——定稿（出清单）、检查、写稿、接着做 / 不要了。「确认裁剪」这类
 * 授权写盘动作**不在**里面：要走各自的确认卡。按工具名的老按钮（commit_preview、check_continuity、generate_draft……P2a 前存下的）
 * 不认：那几个工具已经没了，选项照留、点了交给 AI。
 */
export function parseNextStepUserAction(value: unknown): AgentUserAction | undefined {
  return isRecord(value) && value.kind !== undefined ? parseOperationActionData(value) : undefined;
}

/** 操作按钮（防御解析，和服务端 user-actions 的 parseOperationAction 同一口径）。 */
function parseOperationActionData(value: Record<string, unknown>): OperationActionData | undefined {
  if (value.kind === "resume" || value.kind === "cancel") {
    if (typeof value.opId !== "string" || !/^op-[0-9a-f]{20}$/u.test(value.opId)) return undefined;
    if (value.kind === "cancel" || value.answer === undefined) return { kind: value.kind, opId: value.opId };
    const answer = isRecord(value.answer) ? value.answer : {};
    const { actionId, decision } = answer;
    const excluded = Array.isArray(answer.excluded) ? answer.excluded.filter((key): key is string => typeof key === "string" && /^[A-Za-z0-9:_-]{1,40}$/u.test(key)) : [];
    const values: Record<string, number> = Object.fromEntries((isRecord(answer.values) ? Object.entries(answer.values) : [])
      .filter((entry): entry is [string, number] => /^[A-Za-z0-9_]{1,32}$/u.test(entry[0]) && typeof entry[1] === "number" && Number.isInteger(entry[1]))
      .slice(0, 8));
    return typeof actionId === "string" && /^[A-Za-z0-9:_-]{1,64}$/u.test(actionId) && typeof decision === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(decision)
      ? { kind: "resume", opId: value.opId, answer: { actionId, decision, ...(excluded.length > 0 ? { excluded } : {}), ...(Object.keys(values).length > 0 ? { values } : {}) } }
      : undefined;
  }
  if (value.kind !== "new") return undefined;
  if (typeof value.requestKey !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.requestKey)) return undefined;
  if (typeof value.issuedAt !== "string" || value.issuedAt.length > 40 || !Number.isFinite(Date.parse(value.issuedAt))) return undefined;
  const stamp = { requestKey: value.requestKey, issuedAt: value.issuedAt };
  if (value.type === "commit.prepare") {
    const params = isRecord(value.params) ? value.params : {};
    const chapter = positiveInt(params.chapter);
    return chapter ? { kind: "new", type: "commit.prepare", params: { chapter, ...(params.allowShort === true ? { allowShort: true as const } : {}) }, ...stamp } : undefined;
  }
  if (value.type === "plan.propose") {
    const params = readPlanParams(value.params);
    return params ? { kind: "new", type: "plan.propose", params, ...stamp } : undefined;
  }
  if (value.type === "settings.change") {
    const accept = isRecord(value.params) ? value.params.accept : undefined;
    return typeof accept === "string" && /^op-[0-9a-f]{20}$/u.test(accept) ? { kind: "new", type: "settings.change", params: { accept }, ...stamp } : undefined;
  }
  if (value.type === "ledger.change") {
    const changes = isRecord(value.params) && Array.isArray(value.params.changes) ? value.params.changes.map(readLedgerChange) : [];
    return value.mode === "author" && changes.length > 0 && changes.length <= 20 && changes.every((item) => item !== undefined)
      ? { kind: "new", type: "ledger.change", mode: "author", params: { changes: changes as LedgerChangeData[] }, ...stamp }
      : undefined;
  }
  if (value.type === "canon.propose") {
    const params = isRecord(value.params) ? value.params : {};
    if (value.mode === "statement") {
      const statement = nonEmptyText(params.statement, 400);
      const chapter = positiveInt(params.chapter);
      const also = readChapterSides(params.also);
      return statement ? { kind: "new", type: "canon.propose", mode: "statement", params: { statement, ...(chapter ? { chapter } : {}), ...(also.length > 0 ? { also } : {}) }, ...stamp } : undefined;
    }
    const chapter = positiveInt(params.chapter);
    const truth = readSettleSide(params.truth);
    if (value.mode !== "pick" || !chapter || !truth) return undefined;
    const other = readSettleSide(params.other);
    const also = readChapterSides(params.also);
    const reason = nonEmptyText(params.reason, 400);
    const item = typeof params.item === "string" && params.item.length > 0 && params.item.length <= 1601 ? params.item : undefined;
    return {
      kind: "new",
      type: "canon.propose",
      mode: "pick",
      params: { chapter, truth, ...(other ? { other } : {}), ...(also.length > 0 ? { also } : {}), ...(reason ? { reason } : {}), ...(item ? { item } : {}) },
      ...stamp,
    };
  }
  if (value.type === "draft.change" && isDraftEditMode(value.mode)) {
    const params = readEditParams(value.mode, value.params);
    return params ? { kind: "new", type: "draft.change", mode: params.mode, params, ...stamp } : undefined;
  }
  if (value.type === "draft.change") {
    const mode = value.mode === "write" || value.mode === "continue" ? value.mode : undefined;
    const params = mode ? readDraftParams(mode, value.params) : undefined;
    return mode && params ? { kind: "new", type: "draft.change", mode, params, ...stamp } : undefined;
  }
  if (value.type !== "inspect.run") return undefined;
  const mode = INSPECT_MODES.find((item) => item === value.mode);
  const params = isRecord(value.params) ? value.params : {};
  const chapter = params.chapter;
  if (!mode || typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return undefined;
  return {
    kind: "new",
    type: "inspect.run",
    mode,
    params: { chapter, ...(mode === "continuity" && params.fresh === true ? { fresh: true as const } : {}) },
    ...stamp,
  };
}

/** 定论的一边（防御解析）。 */
function readSettleSide(value: unknown): SettleSideData | undefined {
  if (!isRecord(value)) return undefined;
  const quote = nonEmptyText(value.quote, 800);
  if (!quote) return undefined;
  if (value.where === "setting") {
    const label = nonEmptyText(value.label, 40);
    const card = nonEmptyText(value.card, 40);
    return label ? { where: "setting", quote, label, ...(card ? { card } : {}) } : undefined;
  }
  const chapter = positiveInt(value.chapter);
  return value.where === "chapter" && chapter ? { where: "chapter", chapter, quote } : undefined;
}

const readChapterSides = (value: unknown): ChapterSideData[] =>
  (Array.isArray(value) ? value.slice(0, 10) : []).map(readSettleSide).filter((side): side is ChapterSideData => side?.where === "chapter");

/** 直接改账的一笔（防御解析）：形状不对是 undefined。 */
function readLedgerChange(value: unknown): LedgerChangeData | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyText(value.id, 200);
  const chapter = positiveInt(value.chapter);
  const title = nonEmptyText(value.title, 200);
  const named = title ? { title } : {};
  if (value.op === "resolve") return id && chapter ? { op: "resolve", id, chapter, ...named } : undefined;
  if (value.op === "importance") {
    const importance = value.importance === "major" || value.importance === "normal" || value.importance === "minor" ? value.importance : undefined;
    return id && importance ? { op: "importance", id, importance, ...named } : undefined;
  }
  const text = nonEmptyText(value.text, 2000);
  return value.op === "summary" && chapter && text ? { op: "summary", chapter, text } : undefined;
}

const positiveInt = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const nonEmptyText = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const textList = (value: unknown, max = 20): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((item) => { const text = nonEmptyText(item, 500); return text ? [text] : []; }).slice(0, max);
  return items.length > 0 ? items : undefined;
};

/** 想走法参数（和服务端 readPlanProposeParams 同一口径）：章号不对是 undefined。 */
function readPlanParams(value: unknown): PlanParamsData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positiveInt(value.chapter);
  if (chapter === undefined) return undefined;
  const idea = nonEmptyText(value.idea, 500);
  const avoid = Array.isArray(value.avoid)
    ? [...new Set(value.avoid.flatMap((item) => { const text = nonEmptyText(item, 40); return text ? [text] : []; }))].slice(0, 9)
    : [];
  return { chapter, ...(idea ? { idea } : {}), ...(avoid.length > 0 ? { avoid } : {}) };
}

/** 写稿参数（和服务端 readDraftChangeParams 同一口径）：章号不对是 undefined，多的字段丢掉；接着写不带多版、重写。 */
function readDraftParams(mode: DraftModeData, value: unknown): DraftParamsData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positiveInt(value.chapter);
  if (chapter === undefined) return undefined;
  const writing = mode === "write";
  const direction = nonEmptyText(value.direction, 2000);
  const mustHitBeats = textList(value.mustHitBeats);
  const length = positiveInt(value.length);
  const selectedCharacters = textList(value.selectedCharacters);
  const selectedHookIds = textList(value.selectedHookIds);
  const maxTimelineEvents = positiveInt(value.maxTimelineEvents);
  const contextTokenBudget = positiveInt(value.contextTokenBudget);
  const pick = writing && value.pick === "author" ? "author" as const : undefined;
  const candidates = writing && (value.candidates === 2 || value.candidates === 3) ? value.candidates : undefined;
  return {
    chapter,
    ...(direction ? { direction } : {}),
    ...(mustHitBeats ? { mustHitBeats } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(selectedCharacters ? { selectedCharacters } : {}),
    ...(selectedHookIds ? { selectedHookIds } : {}),
    ...(maxTimelineEvents !== undefined ? { maxTimelineEvents } : {}),
    ...(contextTokenBudget !== undefined ? { contextTokenBudget } : {}),
    ...(candidates !== undefined ? { candidates } : {}),
    ...(pick ? { pick } : {}),
    ...(value.autoDeAi === false ? { autoDeAi: false as const } : {}),
    ...(value.thenPreview === true ? { thenPreview: true as const } : {}),
    ...(writing && value.rewrite === true ? { rewrite: true as const } : {}),
    ...(value.allowWriteAhead === true ? { allowWriteAhead: true as const } : {}),
  };
}

/** 改稿参数（和服务端 readDraftEditParams 同一口径的子集：章号、要改的原文缺了不认；细的服务端执行前再校验）。 */
function readEditParams(mode: DraftEditModeData, value: unknown): DraftEditParamsData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positiveInt(value.chapter);
  if (chapter === undefined) return undefined;
  const records = (list: unknown): readonly Record<string, unknown>[] | undefined =>
    Array.isArray(list) && list.length > 0 && list.every(isRecord) ? list : undefined;
  const textOf = (item: Record<string, unknown>, key: string): string | undefined => (typeof item[key] === "string" && (item[key] as string).trim() ? item[key] as string : undefined);
  if (mode === "revise") {
    const items = records(value.edits);
    const edits = items?.map((item) => {
      const targetText = textOf(item, "targetText");
      const revisionGoal = textOf(item, "revisionGoal");
      const replacementText = textOf(item, "replacementText");
      return targetText ? { targetText, ...(revisionGoal ? { revisionGoal } : {}), ...(replacementText ? { replacementText } : {}) } : undefined;
    });
    if (!edits || edits.some((edit) => !edit)) return undefined;
    return {
      mode,
      chapter,
      edits: edits as NonNullable<(typeof edits)[number]>[],
      ...(value.style === "deai" ? { style: "deai" as const } : {}),
      ...(value.preview === true ? { preview: true as const } : {}),
    };
  }
  if (mode === "fix") {
    const fixes = records(value.fixes)?.map((item) => {
      const targetText = textOf(item, "targetText");
      const revisionGoal = textOf(item, "revisionGoal");
      return targetText && revisionGoal ? { targetText, revisionGoal } : undefined;
    });
    return fixes && fixes.every(Boolean) ? { mode, chapter, fixes: fixes as NonNullable<(typeof fixes)[number]>[] } : undefined;
  }
  const violations = records(value.violations)?.map((item) => {
    const id = textOf(item, "id");
    const sentence = textOf(item, "text");
    const reason = textOf(item, "reason");
    const severity = textOf(item, "severity");
    const suggestedFix = textOf(item, "suggestedFix");
    return id && sentence ? { id, text: sentence, ...(reason ? { reason } : {}), ...(severity ? { severity } : {}), ...(suggestedFix ? { suggestedFix } : {}) } : undefined;
  });
  return violations && violations.every(Boolean) ? { mode, chapter, violations: violations as NonNullable<(typeof violations)[number]>[] } : undefined;
}

/** 存盘消息里的写稿按钮动作（读回时校验；服务端执行前还会再校验）。 */
export function readStoredOperationAction(value: unknown): OperationActionData | undefined {
  return isRecord(value) ? parseOperationActionData(value) : undefined;
}

/** suggest_next_steps 输出 → 「下一步」卡数据（choices 的 action 字段经白名单防御解析，坏的丢掉、选项保留）。 */
function toNextStepPrompt(output: Record<string, unknown>): NonNullable<AgentToolResult["nextStepPrompt"]> {
  const question = typeof output.question === "string" ? output.question : "";
  const choices = (Array.isArray(output.choices) ? output.choices : []).flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.intent !== "string") return [];
    const action = parseNextStepUserAction(item.action);
    return [{
      label: item.label,
      intent: item.intent,
      ...(typeof item.recommended === "boolean" ? { recommended: item.recommended } : {}),
      ...(action ? { action } : {}),
    }];
  });
  return { question, choices };
}

/** 从非 2xx 响应体里取服务端 `{ error }`；取不到返回 undefined（让调用方退回状态码文案）。 */
async function readServerError(response: Response): Promise<{ readonly message?: string; readonly reason?: AiErrorReason }> {
  try {
    const raw = await response.text();
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.trim()) {
      const reason = readAiErrorReason(parsed.reason);
      return { message: parsed.error.trim(), ...(reason ? { reason } : {}) };
    }
  } catch {
    // body 非 JSON / 读失败：退回状态码文案。
  }
  return {};
}
