import type { TimelineLayerEvent, TimelineMacroBlock } from "../server/book/timeline-layers.js";

/** 开书概况：形状以服务端为准（重构 P9 起设定卡走设定本 GET /api/bible，这里只剩账和几个数）。 */
import type { UiStateOverview } from "../server/services/ui-overview.js";
import type { ReaderCatchUpRoleState, RereadStatus } from "../server/editorial/catch-up.js";
export type StateOverview = UiStateOverview;
export type {
  StateOverviewArcGoalItem,
  StateOverviewCharacterItem,
  StateOverviewSetting,
  StateOverviewThreadItem,
  StateOverviewTimelineEvent,
} from "../server/book/state-overview.js";
export type { ReaderCatchUpRoleState, ReadersCatchUpStatus as ReaderCatchUpStatus, RereadStatus } from "../server/editorial/catch-up.js";
export type { UiChapterFileState as StateOverviewChapterFileState } from "../server/lib/project-io.js";
export type { ProtagonistSuggestion } from "../server/writing/presence/protagonist-suggestion.js";

export interface StateOverviewRequest {
  readonly projectPath: string;
  readonly chapter?: string;
  readonly maxTimelineEvents?: number;
}

export type StateOverviewApiResponse =
  | { readonly ok: true; readonly overview: StateOverview }
  | { readonly ok: false; readonly error: string };

/** GET /api/reader-progress 的响应（R4.3 在读期间 5 秒一次的轻量轮询）。 */
export type ReaderProgressApiResponse =
  | { readonly ok: true; readonly reading: boolean; readonly roles: readonly ReaderCatchUpRoleState[]; readonly reread?: RereadStatus }
  | { readonly ok: false; readonly error: string };

export interface BookFileActionRequest {
  readonly projectPath: string;
}

export interface RenameBookRequest extends BookFileActionRequest {
  readonly title: string;
}

export interface DeleteBookRequest extends BookFileActionRequest {
  readonly confirm?: boolean;
  readonly confirmDelete?: boolean;
  readonly confirmTitle?: string;
  readonly confirmProjectPath?: string;
}

export type BookFileActionApiResponse =
  | { readonly ok: true; readonly overview?: StateOverview; readonly title?: string }
  | { readonly ok: false; readonly error: string };

export interface ChapterChatRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly message: string;
  readonly messages: readonly ChatMessage[];
  readonly mode?: "suggest" | "discuss";
}

export type WriteInstructionTarget =
  | "writing_rules"
  | "story_settings";

// 对话提取出的低风险资料更新候选；是否自动应用由客户端和写入网关共同裁决。
/**
 * running=进行中；completed=正常完成；failed=工具失败/被拒绝（红）；needs_confirmation=待确认；
 * partial=部分完成；stopped=人喊停；verdict=老会话里裁决类只读工具（P2a 前的 commit_preview）正常执行后的「否定裁决」
 * （如「暂不可定稿」）——落定形态，不红不绿，不是失败；现在不再产生，只为老会话照原样显示。
 */
export type ToolStepStatus = "running" | "completed" | "failed" | "needs_confirmation" | "partial" | "stopped" | "verdict";

export interface ToolStep {
  readonly id: string;
  readonly label: string;
  /** 触发该步的工具名（如 change_draft / run_check / prepare_commit）；供进度卡把步骤映射到「构思/写稿/审校/入库」四相。 */
  readonly toolName?: string;
  readonly status: ToolStepStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** 工具执行详情（真实 summary / 失败原因）；折叠步骤展开后显示「具体怎么执行的」。 */
  readonly detail?: string;
  /** AI 传的参数没通过校验、这步没执行（原因已回给 AI，它多半会改了参数重来）。 */
  readonly invalidArgs?: true;
}

/**
 * AI 审稿（ai_review）问题视图——client 侧镜像引擎 DraftAIReviewIssue 的渲染子集。
 * 故意在 client 另定义一份（不从 server/engine 拉类型进浏览器包，照 AiFlavorReport 同例）；
 * ai_review 工具把整份 review 透传过来，前端据此渲染「审校问题清单」可点卡。
 */
export interface DraftReviewIssueView {
  readonly id: string;
  readonly severity: "info" | "warning" | "high";
  readonly category?: string;
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly suggestedFix: string;
  readonly affectedParagraphHint?: string;
}

export interface DraftReviewView {
  readonly verdict?: string;
  readonly score?: number;
  readonly summary: string;
  readonly issues: readonly DraftReviewIssueView[];
}

/**
 * 质检明细卡视图——client 侧镜像引擎/server 的 RefinedQualityReport 渲染子集（照 DraftReviewView 同例，
 * 不把 server 类型拉进浏览器包）。quality_check 工具把整份 refined 透传过来，前端据此渲染「质检」明细卡。
 */
export interface QualityCardIssue {
  readonly type: string;
  readonly label: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly downgradeNote?: string;
}

export interface QualityCardReport {
  readonly passed: boolean;
  readonly blocking: readonly QualityCardIssue[];
  /** AI 判定 confirmed+high 的严重问题：不硬拦入库但醒目展示、强烈建议先改（治「可入库」与严重问题并列读着矛盾）。 */
  readonly severe?: readonly QualityCardIssue[];
  readonly soft: readonly QualityCardIssue[];
  readonly reference: readonly QualityCardIssue[];
  readonly summary: string;
}

export type ChapterAgentCardStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "needs_confirmation" | "saved" | "rejected" | "partial" | "stopped";

export type ChapterAgentCardKind =
  | "orchestrator"
  | "steering"
  | "draft"
  | "revision"
  | "review"
  | "quality"
  | "commit"
  | "foundation"
  | "project";

export interface ChapterAgentCard {
  readonly id: string;
  readonly kind: ChapterAgentCardKind;
  readonly agentName: string;
  readonly status: ChapterAgentCardStatus;
  readonly title: string;
  readonly summary: string;
  readonly detail?: readonly string[];
  readonly permission?: ChapterWorkspacePermission | readonly ChapterWorkspacePermission[];
  readonly primaryActionId?: string;
}

export type ChapterWorkspacePermission =
  | "safe_read"
  | "model_call"
  | "draft_write"
  | "project_config_write"
  | "formal_state_write"
  | "destructive_write"
  | "local_side_effect";

export interface SnapshotEntryDto {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  /** 这个存档点之后改了什么（已翻成人话，如「正文：第 58 章写入定稿」）；认不出时缺省。 */
  readonly changes?: readonly string[];
  /** 操作历史筛选分类（服务端按写入方工具名定）；老服务端没给时按「正文改动」。 */
  readonly kind?: "commit" | "draft" | "bible" | "restore";
}

export type SnapshotListApiResponse =
  | { readonly ok: true; readonly snapshots: readonly SnapshotEntryDto[] }
  | { readonly ok: false; readonly error: string };

/** 恢复的结果：做完了的那次操作（结论、改了哪些在里面，前端按操作视图读）。 */
export type SnapshotRestoreApiResponse =
  | { readonly ok: true; readonly operation: unknown }
  | { readonly ok: false; readonly error: string };

export type ModelSettingsStatus = "missing" | "loaded" | "invalid_json" | "invalid_schema";
export type ModelSettingsIssueSeverity = "info" | "warning" | "error" | "high";

export interface ModelSettingsRequest {
  // no longer required — settings are global
}

export interface TaskAssignmentEntry {
  /** 该任务指定的模型档案 id；省略=没显式选模型、走引擎回退（思考开关仍独立生效）。 */
  readonly profileId?: string;
  readonly thinking: boolean;
}

/** 任务 → {用哪个档案, 开不开思考} 视图（UI 旁路 task-assignments.json 的展示/保存形态）。 */
export type TaskAssignmentView = Readonly<Record<string, TaskAssignmentEntry>>;

export interface SaveModelSettingsRequest {
  readonly rawText: string;
  readonly providerApiKeys?: Readonly<Record<string, string>>;
  readonly taskAssignments?: TaskAssignmentView;
  /** 备用模型档案（P10）：字符串 = 设成它，null = 不用备用；不带 = 不动。 */
  readonly fallbackProfileId?: string | null;
}

export interface ModelSettingsLoadResult {
  readonly passed: boolean;
  readonly available: boolean;
  readonly status: ModelSettingsStatus;
  readonly configPath: string;
  readonly summary: ModelSettingsSummary;
  readonly issues: readonly ModelSettingsValidationIssue[];
}

export interface ModelSettingsSummary {
  readonly available: boolean;
  readonly status: ModelSettingsStatus;
  readonly configPath: string;
  readonly defaultProvider?: string;
  readonly defaultProfile?: string;
  readonly providers: readonly ProviderConfigSummary[];
  readonly profiles: readonly ModelProfileSummary[];
  readonly taskProfiles: TaskProfileMap;
  readonly issueCount: number;
  readonly highRiskIssueCount: number;
}

export interface ProviderConfigSummary {
  readonly id: string;
  readonly label?: string;
  readonly type: "openai-compatible" | "openai" | "local" | "custom";
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKeyStatus: "not_required" | "present" | "missing";
  readonly quotaGroup?: string;
}

export interface ModelProfileSummary {
  readonly id: string;
  readonly label?: string;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly stream?: boolean;
}

export interface TaskProfileMap {
  readonly fastDraft?: string;
  readonly chapterSteering?: string;
  readonly qualityCheck?: string;
  readonly repair?: string;
  readonly enrichment?: string;
  readonly draftReview?: string;
  readonly triage?: string;
}

export interface ModelSettingsValidationIssue {
  readonly severity: ModelSettingsIssueSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ModelSettingsApiResponse =
  | {
      readonly ok: true;
      readonly result: ModelSettingsLoadResult;
      readonly rawText: string;
      readonly taskAssignments?: TaskAssignmentView;
      /** 备用模型档案（P10）；null = 没设。 */
      readonly fallbackProfileId?: string | null;
      /** 保存成功但有条目被丢弃（如打码哨兵无法还原的自定义请求头）时如实告知；无丢弃则不带该字段。 */
      readonly warnings?: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

export interface ModelTestConnectionRequest {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
}

export interface ModelTestConnectionResult {
  readonly providerId: string;
  readonly models: readonly ModelInfoItem[];
  readonly elapsedMs?: number;
}

export interface ModelInfoItem {
  readonly id: string;
  readonly name?: string;
}

export type ModelTestConnectionApiResponse =
  | { readonly ok: true; readonly result: ModelTestConnectionResult }
  | { readonly ok: false; readonly error: string };

/* ---- Create Book ---- */

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CreateBookResult {
  readonly title: string;
  readonly genre: string;
  readonly logline: string;
  readonly readerPromise: string;
  readonly coreAppeal: string;
  readonly worldPremise: string;
  readonly coreRules: readonly string[];
  readonly resourceRules: readonly string[];
  readonly socialOrder: readonly string[];
  readonly conflictSources: readonly string[];
  readonly forbiddenWorldRules: readonly string[];
  readonly protagonistName: string;
  readonly protagonistIdentity: string;
  readonly desire: string;
  readonly fear: string;
  readonly weakness: string;
  readonly behaviorBoundaries: readonly string[];
  readonly knowledgeKnown: readonly string[];
  readonly knowledgeUnknown: readonly string[];
  readonly speechStyle: string;
  readonly initialLocation: string;
  readonly importantLocations: readonly string[];
  readonly locationRisks: readonly string[];
  readonly initialAssets: readonly string[];
  readonly keyItems: readonly string[];
  readonly resourceLimits: readonly string[];
  readonly narrativePerspective: string;
  readonly proseStyle: readonly string[];
  readonly pacing: string;
  readonly revealPolicy: string;
  readonly targetChapterWords: string;
  readonly forbiddenContent: readonly string[];
  readonly doNotDo: readonly string[];
  readonly firstVolumeGoal: string;
  readonly longFormGoals: readonly string[];
  readonly centralConflicts: readonly string[];
  readonly growthPromise: string;
  readonly firstChapterGoal: string;
  readonly openingScene: string;
  readonly firstHook: string;
  readonly firstConflict: string;
  readonly forbiddenReveals: readonly string[];
  readonly hiddenTruths: readonly string[];
  readonly mustAvoid: readonly string[];
  readonly revealSchedule: readonly string[];
}

export interface CreateProjectRequest {
  readonly draft: CreateBookResult;
  readonly rootDir?: string;
}

export type CreateProjectApiResponse =
  | { readonly ok: true; readonly projectDir: string; readonly overview: StateOverview }
  | { readonly ok: false; readonly error: string };

/** 导入已写的书（P8）：要导的文件（全文已在浏览器里解好码）。 */
export interface ImportBookFile {
  readonly name: string;
  readonly text: string;
}

/** 切章预览里的一段：preamble＝第一章前面的字（简介、作者的话），默认不导；chapter＝一章。 */
export interface ImportPreviewPart {
  readonly kind: "preamble" | "chapter";
  readonly title: string;
  readonly chars: number;
  readonly file: string;
}

export interface ImportPreview {
  readonly parts: readonly ImportPreviewPart[];
  /** 章节正文总字数（不算前言）。 */
  readonly totalChars: number;
  /** 丢掉的空章（只有标题没有正文）。 */
  readonly emptyDropped: number;
  readonly volumeLines: number;
  /** 一个文件时取文件名当书名；几个文件时为空。 */
  readonly suggestedTitle: string;
}

export type ImportPreviewApiResponse =
  | ({ readonly ok: true } & ImportPreview)
  | { readonly ok: false; readonly error: string };

export interface ImportBookRequest {
  readonly title: string;
  readonly files: readonly ImportBookFile[];
  /** 和预览的 parts 一一对应：这一段导不导。 */
  readonly include: readonly boolean[];
}

export type ImportBookApiResponse =
  | { readonly ok: true; readonly projectDir: string; readonly overview: StateOverview; readonly imported: { readonly chapters: number } }
  | { readonly ok: false; readonly error: string };

export interface WriterContextBudgetApiPayload {
  readonly droppedSections: readonly string[];
}

export interface DraftActionReport {
  readonly passed?: boolean;
  readonly issues?: readonly string[];
  readonly draftPath?: string;
  readonly title?: string;
  readonly [key: string]: unknown;
}

export type GenerateDraftApiResponse =
  // warnings：enforce 降级留痕（回读失败/正文未载入等）随 200 投影（routes/draft.ts 按 canonical
  // http.warnings 带出）——类型层必须透出，否则调用方再次静默丢警告。
  | { readonly ok: true; readonly report: DraftActionReport; readonly draftContent: string; readonly draftTitle?: string; readonly overview: StateOverview; readonly contextBudget?: WriterContextBudgetApiPayload; readonly warnings?: readonly string[] }
  | { readonly ok: false; readonly error: string };

export type QualityCandidateSeverityHint = "low" | "medium" | "high";
export type QualityAiJudgementVerdict = "confirmed" | "uncertain" | "dismissed" | "author_intent";
export type QualityAiJudgementSeverity = "none" | "low" | "medium" | "high";
export type QualityAiJudgementAction = "ignore" | "watch" | "ask_user" | "revise" | "require_confirmation";
export type QualityUserDisplayCategory = "confirmed" | "needs_confirmation" | "watch" | "dismissed";

export interface RuleQualityCandidate {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly message: string;
  readonly evidence: string;
  readonly severityHint: QualityCandidateSeverityHint;
  readonly confidenceHint: number;
  readonly status: "candidate" | "judged";
  readonly contextHint?: string;
}

export interface QualityAiJudgement {
  readonly candidateId: string;
  readonly verdict: QualityAiJudgementVerdict;
  readonly severity: QualityAiJudgementSeverity;
  readonly explanation: string;
  readonly recommendedAction: QualityAiJudgementAction;
}

export interface JudgedQualityCandidate extends RuleQualityCandidate {
  readonly status: "judged";
  readonly judgement: QualityAiJudgement;
  readonly userDisplayCategory: QualityUserDisplayCategory;
}

export interface DraftQualityReport {
  readonly passed: boolean;
  readonly issues: readonly {
    readonly severity: "info" | "warning" | "error";
    readonly type: string;
    readonly message: string;
    readonly candidateId?: string;
    readonly judgement?: QualityAiJudgement;
    readonly userDisplayCategory?: QualityUserDisplayCategory;
  }[];
  readonly candidates?: readonly RuleQualityCandidate[];
  readonly judgedIssues?: readonly JudgedQualityCandidate[];
  readonly modelJudge?: {
    readonly used: boolean;
    readonly fallbackUsed: boolean;
    readonly profileId?: string;
    readonly model?: string;
    readonly error?: string;
    readonly summary?: string;
  };
}

export type DraftAIReviewVerdict = "ready_to_commit" | "needs_minor_revision" | "needs_major_revision" | "blocked";

export interface DraftAIReviewIssue {
  readonly id: string;
  readonly severity: "info" | "warning" | "high";
  readonly category: "plot" | "pacing" | "character" | "dialogue" | "style" | "continuity" | "worldbuilding" | "reader_hook";
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly suggestedFix: string;
  readonly affectedParagraphHint?: string;
}

export interface DraftAIRevisionSuggestion {
  readonly id: string;
  readonly target: string;
  readonly suggestion: string;
  readonly reason: string;
  readonly priority: "low" | "medium" | "high";
}

export interface DraftAIReviewReport {
  readonly passed: boolean;
  readonly score: number;
  readonly verdict: DraftAIReviewVerdict;
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly issues: readonly DraftAIReviewIssue[];
  readonly suggestedRevisions: readonly DraftAIRevisionSuggestion[];
  readonly continuityNotes: readonly string[];
  readonly styleNotes: readonly string[];
  readonly characterNotes: readonly string[];
  readonly pacingNotes: readonly string[];
  readonly readerHookNotes: readonly string[];
  readonly shouldCommit: boolean;
  readonly blockingReasons: readonly string[];
}

export interface CommitSelectiveConfirmation {
  readonly assetDecisions?: readonly CommitSelectiveDecision[];
  readonly locationDecisions?: readonly CommitSelectiveDecision[];
  readonly characterKnowledgeDecisions?: readonly CommitSelectiveDecision[];
}

export interface CommitSelectiveDecision {
  readonly candidateId: string;
  readonly state: "accept" | "reject" | "defer";
  readonly edited?: {
    readonly name?: string;
    readonly after?: string;
    readonly evidence?: string;
  };
}

