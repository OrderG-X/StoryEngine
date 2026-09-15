import type { ChapterAdviceCard, ChapterAgentCard, DraftAIReviewReport, DraftReviewView, DraftRevisionPreview, StateOverviewCharacterMatrix, ToolStep } from "../api/types.js";
import type { WorldbuildingData } from "../api/worldbuildingClient.js";
import type { SuggestedAction, ChapterWorkflowState } from "./workflow.js";

/** Async work is owned by the exact book, chapter, chat session and operation. */
export interface WorkspaceOperationTarget {
  readonly projectPath: string;
  readonly chapter: number;
  readonly sessionId: string;
  readonly operationId: string;
}

export type WorkspaceRevisionPreview = DraftRevisionPreview & {
  readonly originTarget: WorkspaceOperationTarget;
};

export interface WorkspaceDraftCandidate {
  readonly content: string;
  readonly title?: string;
  readonly originTarget: WorkspaceOperationTarget;
}

export interface ChapterNavItem {
  readonly id: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly status: "committed" | "draft" | "current" | "planned";
  readonly hasDraftFile?: boolean;
  readonly hasCommittedChapter?: boolean;
  readonly hasWorkspaceSnapshot?: boolean;
}

/**
 * 助手消息的「有序分段」：忠实记录 agent 流式事件的真实时间顺序（想→调工具→再想→答），
 * 让 codex 聊天按发生顺序逐段渲染，而非把整回合拍平成 thinking/toolSteps/content 三个桶。
 * - reasoning / text 段直接带累加文本；
 * - tool 段只引用 toolCallId，详情仍读 ChapterMessage.toolSteps[id]（单一真相、settle 不受影响）。
 * 与 content/thinking/toolSteps 并存（后者保留给撤销/入库/classic 壳/时间线）；旧消息无此字段→渲染回退。
 */
export type MessageSegment =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly toolCallId: string };

export interface ChapterMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly adviceCards?: readonly ChapterAdviceCard[];
  readonly suggestedActions?: readonly SuggestedAction[];
  readonly agentCards?: readonly ChapterAgentCard[];
  readonly toolOutput?: readonly string[];
  readonly toolSteps?: readonly ToolStep[];
  /** 有序分段时间线（流真实顺序）；codex 渲染优先用它，旧消息无此字段则回退三桶渲染。 */
  readonly segments?: readonly MessageSegment[];
  readonly thinking?: string;
  readonly createdAt?: string;
  readonly intentTitle?: string;
  readonly turnStartedAt?: number;
  readonly turnEndedAt?: number;
  readonly turnSnapshots?: readonly { readonly toolName: string; readonly snapshotId: string; readonly chapterNumber?: number }[];
  readonly affectedScopes?: readonly ("full" | "foundation")[];
  /** 去 AI 味体检报告：随这条 assistant 消息走（替代旧的全局常驻挂件），在时间线里渲染体检卡、随对话滚动。 */
  readonly aiFlavorReport?: AiFlavorReport;
  /** 本条体检报告里已点「改掉这句」并应用成功的违规 id 集合——卡片据此把那几条标「已改 ✓」；随消息持久化。 */
  readonly aiFlavorFixedIds?: readonly string[];
  /** REST 深度审稿报告（handleDraftAIReview）：随这条 assistant 消息走，渲染可折叠审稿卡（含「生成修订任务」）；勿与下方 draftReview 混淆。 */
  readonly aiReviewReport?: DraftAIReviewReport;
  /** AI 审稿（ai_review 工具）报告：随这条 assistant 消息走，渲染「审校问题清单」可点卡（点一条=给 agent 发改写意图）。 */
  readonly draftReview?: DraftReviewView;
  /** agent 主动提议的「下一步」选项（suggest_next_steps 工具输出）。最新一条消息有它时，「下一步」卡渲染它，
   *  否则退回按 flowStatus 写死的兜底选项。点选项=把对应 intent 当用户消息发回给 agent。 */
  readonly nextStepPrompt?: {
    readonly question: string;
    readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean }[];
  };
  readonly isErrorNotice?: boolean;
  /** 错误卡「技术详情」里展示的原始报错（不进主文案）。 */
  readonly errorDetail?: string;
  /** commit_apply 入库报告（CommitReport）：随这条消息走，渲染「入库」delta 卡（这章改了哪些角色/伏笔/线索/时间线/主线目标）。原样存，渲染侧 summarizeCommitReport 防御解析。 */
  readonly commitReport?: unknown;
  /** quality_check 分层质检报告（RefinedQualityReport 子集）：随这条消息走，渲染「质检」明细卡（blocking 硬伤 / soft 软提示）。 */
  readonly qualityReport?: import("../api/types.js").QualityCardReport;
  /** commit_preview 人物名一致性提醒：本章出现的名字疑似把已确立角色名写歪（引擎确定性判定）。随消息走，渲染固定提醒卡，不靠模型转述、不被说软。 */
  readonly nameConsistencyWarnings?: readonly { readonly establishedName: string; readonly driftedVariant: string; readonly message: string }[];
  /** commit_preview 伏笔/线索待收口提醒：某伏笔/线索连续多章没推进（引擎确定性判定：active/open 超 3 章未触及）。随消息走，渲染固定提醒卡，不靠模型转述、不被隐去。 */
  readonly staleThreadWarnings?: readonly { readonly kind: string; readonly title: string; readonly lastTouchedChapter: number; readonly chaptersSinceTouched: number; readonly message: string }[];
  /** commit_preview 结构化定稿预览（R3）：裁决结果（可否定稿/不可定稿）+ 阻断项 + 质量问题计数随消息走，
   *  渲染固定「定稿预览」卡——裁决不靠模型转述（模型可能把硬阻断说成「小问题」或干脆不提）。 */
  readonly commitPreview?: CommitPreviewCardData;
  /** 服务端状态说明（R4：如「历史窗口被裁剪」）：照实展示给用户、不进助手正文（不替模型说话）。 */
  readonly statusNotes?: readonly string[];
}

/** 「定稿预览」卡的确定性数据（commit_preview 工具输出的投影子集，渲染侧防御解析）。 */
export interface CommitPreviewCardData {
  readonly chapter: number;
  readonly canCommit: boolean;
  /** 阻断理由（引擎确定性判定：缺稿/质检硬伤/名字漂移等）。非空时 canCommit 必为 false。 */
  readonly blockingReasons?: readonly string[];
  readonly summary?: string;
  /** 质量问题分层计数（不展开明细，明细走质检卡）；缺省时不渲染该行。 */
  readonly draftIssueCount?: number;
  readonly semanticIssueCount?: number;
}

export interface DraftPreview {
  readonly chapterNumber: number;
  readonly title: string;
  readonly status: "draft" | "committed" | "needs_repair";
  readonly content: string;
  readonly wordCount?: number;
  readonly savedContent?: string;
}

export interface ProtagonistStatus {
  readonly name: string;
  readonly age?: string;
  readonly identity: string;
  readonly currentGoal: string;
  readonly physicalState: readonly string[];
  readonly mentalState: readonly string[];
  readonly resourceState: readonly string[];
  readonly currentSituation: string;
  readonly boundaries: readonly string[];
  readonly cannotDo: readonly string[];
  readonly speechStyle?: string;
  readonly speechSamples: readonly string[];
}

export interface LocationStatus {
  readonly currentLocation: string;
  readonly currentPosition?: string;
  readonly previousLocation?: string;
  readonly transitionStatus: "same_location" | "moving" | "changed" | "unknown";
  readonly locations?: readonly LocationDetailStatus[];
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly entrances: readonly string[];
  readonly exits: readonly string[];
  readonly resources: readonly string[];
  readonly fixedFacts: readonly string[];
  readonly risks: readonly string[];
  readonly nearbyLocations: readonly string[];
  readonly travelRules: readonly string[];
}

export interface LocationDetailStatus {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly parentLocation?: string;
  readonly currentKnownPosition?: string;
  readonly sensory: readonly string[];
  readonly narrativeFunction?: string;
  readonly possibleConflicts: readonly string[];
  readonly currentStatus?: string;
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly entrances: readonly string[];
  readonly exits: readonly string[];
  readonly nearbyLocations: readonly string[];
  readonly travelRules: readonly string[];
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly fixedFacts: readonly string[];
  readonly hiddenFacts: readonly string[];
  /** 自定义额外字段（破例⑦展示落点）；面板「自定义字段」section 渲染。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface TimeStatus {
  readonly currentStoryDay: string;
  readonly currentTimeOfDay: string;
  readonly latestChapter: string;
  readonly latestEvent: string;
}

export interface KnowledgeBoundary {
  readonly knownFacts: readonly string[];
  readonly unknownTruths: readonly string[];
  readonly forbiddenReveals: readonly string[];
}

export interface AssetSummary {
  readonly items?: readonly AssetDetailStatus[];
  readonly carriedItems: readonly string[];
  readonly availableAssets: readonly string[];
  readonly unavailableAssets: readonly string[];
  readonly resources: readonly string[];
  readonly properties: readonly string[];
  readonly containers: readonly { readonly name: string; readonly contents: readonly string[] }[];
  readonly plotCriticalItems: readonly string[];
  readonly assetRules: readonly string[];
}

export interface AssetDetailStatus {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly owner?: string;
  readonly currentLocation?: string;
  readonly carriedBy?: string;
  readonly status: string;
  readonly isConsumable?: boolean;
  readonly isPlotCritical?: boolean;
  readonly rules: readonly string[];
  readonly usageRules: readonly string[];
  readonly lossRules: readonly string[];
  readonly notes: readonly string[];
  /** 自定义额外字段（破例⑦展示落点）；面板「自定义字段」section 渲染。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StoryMemory {
  readonly activeForeshadowing: readonly string[];
  readonly openThreads: readonly string[];
  readonly arcGoals: readonly string[];
  readonly recentTimeline: readonly string[];
}

export interface RiskWarning {
  readonly id: string;
  readonly level: "low" | "medium" | "high";
  readonly text: string;
}

export interface SidebarData {
  readonly storySettings: readonly string[];
  readonly writingRules: readonly string[];
  /** 写作规则的「自定义补充」自由 Markdown（破例⑧）；与 writingRules 字符串数组分开传，避免污染 splitRuleList 解析。 */
  readonly writingRulesCustomNotes?: string;
  readonly characters: readonly string[];
  readonly locations: readonly string[];
  readonly assets: readonly string[];
  readonly hooks: readonly string[];
  readonly arcGoals: readonly string[];
}

export interface ChapterWorkspaceData {
  readonly projectName: string;
  readonly currentChapter: ChapterNavItem;
  readonly chapters: readonly ChapterNavItem[];
  readonly flowStatus: ChapterWorkflowState;
  readonly hasUncommittedDrafts?: boolean;
  readonly workingDraftChain?: boolean;
  readonly previousUncommittedDraftContext?: boolean;
  readonly latestUncommittedDraftChapter?: number;
  readonly draft: DraftPreview;
  readonly messages: readonly ChapterMessage[];
  readonly protagonist: ProtagonistStatus;
  readonly characterMatrix?: StateOverviewCharacterMatrix;
  readonly location: LocationStatus;
  readonly time: TimeStatus;
  readonly knowledge: KnowledgeBoundary;
  readonly assets: AssetSummary;
  readonly memory: StoryMemory;
  readonly risks: readonly RiskWarning[];
  readonly hardConstraints: readonly string[];
  readonly foundationCompleteness?: {
    readonly readinessLevel: "ready" | "warning" | "high_risk";
    readonly passed: boolean;
    readonly missingItems: readonly string[];
    readonly suggestions: readonly string[];
  };
  /** 加厚层（generate_worldbuilding）缺失时，用引擎正典 world-bible 映射出的兜底世界观，供面板回退显示。 */
  readonly worldbuildingFallback?: WorldbuildingData | null;
}

/**
 * 去 AI 味体检报告（前端镜像）——与后端 server/agent/ai-flavor/ai-flavor-check.ts 的
 * AiFlavorReport/AiFlavorViolation 同形。**故意在 type-defs 里另定义一份**，不从 server/ 目录
 * import：前端不得 import server 代码（check-import-boundary 会红）。工具输出经 SSE 透传到前端时
 * 是普通 JSON，形状一致即可对接。
 */
export interface AiFlavorViolation {
  readonly id: string;
  /** AI 腔原句，逐字取自草稿、草稿内唯一（保证「改掉这句」能在草稿里定位）。 */
  readonly text: string;
  /** 为什么是 AI 腔 / 踩了哪条规则。 */
  readonly reason: string;
  readonly severity: "high" | "medium" | "low";
  /** 一句话改写方向（拼进选区改写的 revisionGoal）。 */
  readonly suggestedFix?: string;
}

export interface AiFlavorReport {
  readonly ok: boolean;
  readonly summary: string;
  readonly violations: readonly AiFlavorViolation[];
  readonly usedFallback: boolean;
}

export interface LastFormalCommitApply {
  readonly projectPath?: string;
  readonly chapter: number;
  readonly transactionFinalized: boolean;
  readonly changedFiles: readonly string[];
  readonly finalizedAt?: string;
  readonly transactionDir?: string;
}

export interface ChatSession {
  readonly id: string;
  readonly name: string;
  readonly messages: readonly ChapterMessage[];
  readonly archivedCount?: number;
  readonly prevArchivedCount?: number;
  /** 窗口纪元：服务端每次冷热分层溢写 +1；save 回传过期纪元会被拒（防旧页全量回写）。 */
  readonly windowEpoch?: number;
  /** 累计已冷归档的消息条数（聊天头部归档标记的数据来源）。 */
  readonly coldArchivedCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ChatSessionIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}
export interface ChatSessionIndex {
  readonly sessions: readonly ChatSessionIndexEntry[];
  readonly activeSessionId: string;
}
