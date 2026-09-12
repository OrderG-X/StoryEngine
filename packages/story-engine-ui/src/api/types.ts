import type {
  CharacterMatrixConfirmCandidate,
  CharacterMatrixConfirmPreflightPlan,
  TimelineLayerEvent,
  TimelineMacroBlock,
} from "@actalk/story-engine";
import type { MemoryReadViewModel } from "../agent-command-center/memory-read-viewmodel.js";

export interface StateOverview {
  readonly project: {
    readonly title: string;
    readonly genre: string;
    readonly currentChapter: number | null;
  };
  readonly storyStatus: {
    readonly currentStage?: string;
    readonly currentLocation?: string;
    readonly currentObjective?: string;
    readonly lastTimelineEvent?: string;
  };
  readonly hooks: {
    readonly activeCount: number;
    readonly touchedCount: number;
    readonly resolvedCount: number;
    readonly activeItems: readonly StateOverviewHookItem[];
  };
  readonly threads: {
    readonly total: number;
    readonly open: number;
    readonly touched: number;
    readonly done: number;
    readonly openIntents: number;
    readonly cleanupVisibleCount: number;
    readonly keyOpenItems: readonly StateOverviewThreadItem[];
  };
  readonly arcGoals: {
    readonly activeCount: number;
    readonly touchedCount: number;
    readonly completedCount: number;
    readonly activeItems: readonly StateOverviewArcGoalItem[];
  };
  readonly timeline: {
    readonly recentEvents: readonly StateOverviewTimelineEvent[];
    /** L2：中段每章紧凑摘要。旧书或章数不足时为空数组。 */
    readonly earlierSummary: readonly TimelineLayerEvent[];
    /** L3：远期每 5 章一块宏事件。旧书或章数不足时为空数组。 */
    readonly macroSummary: readonly TimelineMacroBlock[];
  };
  readonly calendar?: {
    readonly currentStoryDay: number;
    readonly currentTimeOfDay: "morning" | "noon" | "afternoon" | "evening" | "night" | "late_night" | "unknown";
  };
  readonly characters: {
    readonly protagonist?: string;
    readonly knownCharacters: readonly StateOverviewCharacterItem[];
  };
  readonly world: {
    readonly summary?: string;
    readonly activeLocations: readonly string[];
    readonly importantFacts: readonly string[];
    readonly protectedSecrets?: readonly string[];
  };
  readonly storyFoundation?: {
    readonly available: boolean;
    readonly missingFiles: readonly string[];
    readonly summary: string;
  };
  readonly storyBible?: StateOverviewStoryBibleSummary;
  readonly writingRules?: StateOverviewWritingRulesSummary;
  readonly characterBible?: StateOverviewCharacterBibleSummary;
  readonly characterMatrix?: StateOverviewCharacterMatrix;
  readonly characterDetails?: readonly StateOverviewCharacterDetail[];
  readonly worldBible?: StateOverviewWorldBibleSummary;
  readonly locationBible?: StateOverviewLocationBibleSummary;
  readonly assetSummary?: StateOverviewAssetSummary;
  readonly locationDetailSummary?: StateOverviewLocationDetailSummary;
  readonly characterDetailSummary?: StateOverviewCharacterDetailSummary;
  readonly foundationCompleteness?: StateOverviewFoundationCompleteness;
  readonly uiChapterFiles?: readonly StateOverviewChapterFileState[];
  readonly maintenance: {
    readonly diagnosticsAvailable: boolean;
    readonly cleanupVisibleCount: number;
    readonly markDoneCandidateCount: number;
    readonly mergeDisabled: true;
    readonly dropDisabled: true;
    readonly confirmPolicy: {
      readonly markDone: "manual_only";
      readonly merge: "disabled";
      readonly drop: "disabled";
    };
  };
  readonly uiHints: {
    readonly recommendedNextPanels: readonly string[];
    readonly warnings: readonly string[];
    readonly disabledActions: readonly string[];
  };
}

export interface StateOverviewChapterFileState {
  readonly chapter: number;
  readonly hasDraftFile: boolean;
  readonly hasCommittedChapter: boolean;
  /** workspace 文件存在（章节被打开过）。导航判断用，不代表本章有真草稿。 */
  readonly hasWorkspaceSnapshot?: boolean;
  /** workspace 的 draftContent 里有真草稿内容（非空、非占位符）。「有草稿」状态看这个。 */
  readonly hasWorkspaceDraft?: boolean;
  readonly draftTitle?: string;
  readonly committedTitle?: string;
  readonly workspaceTitle?: string;
}

export interface StateOverviewHookItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lastTouchedChapter?: number;
  readonly risk?: "low" | "medium" | "high";
  /** B5-2 透传字段（可选）：大/小伏笔派生尺寸。 */
  readonly size?: "major" | "minor";
  /** B5-2 透传字段（可选）：初次埋入章号。 */
  readonly firstSeenChapter?: number;
  /** B5-2 透传字段（可选）：回收章号（status=resolved 时填）。 */
  readonly resolvedAtChapter?: number;
  /** B5-2 透传字段（可选）：同源关联条目数。 */
  readonly relatedCount?: number;
}

export interface StateOverviewThreadItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly type?: string;
  readonly lastTouchedChapter?: number;
  readonly cleanupCandidateClass?: string;
  /** B5-2 透传字段（可选）：大/小线索派生尺寸。 */
  readonly size?: "major" | "minor";
  /** B5-2 透传字段（可选）：初次出现章号。 */
  readonly firstSeenChapter?: number;
  /** B5-2 透传字段（可选）：完成章号（status=done 时填）。 */
  readonly resolvedAtChapter?: number;
  /** B5-2 透传字段（可选）：同源关联条目数。 */
  readonly relatedCount?: number;
}

export interface StateOverviewArcGoalItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly progress?: string;
  readonly lastTouchedChapter?: number;
}

export interface StateOverviewTimelineEvent {
  readonly chapter: number;
  readonly summary: string;
  readonly title?: string;
  readonly mainEvent?: string;
  readonly location?: string;
}

export interface StateOverviewCharacterItem {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly status?: string;
  readonly mood?: string;
  readonly currentGoal?: string;
  readonly recentEvents?: readonly string[];
  readonly lastSeenChapter?: number;
}

export interface StateOverviewCharacterDetail {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly identity?: string;
  readonly age?: string;
  readonly gender?: string;
  readonly height?: string;
  readonly weight?: string;
  readonly distinctiveTraits?: readonly string[];
  readonly bodyTraits?: readonly string[];
  readonly privateBodyTraits?: readonly string[];
  readonly intimacyBoundaries?: readonly string[];
  readonly tags?: readonly string[];
  readonly appearance?: {
    readonly body?: string;
    readonly face?: string;
    readonly hair?: string;
    readonly clothing?: string;
    readonly distinguishingFeatures?: readonly string[];
  };
  readonly appearanceAnchors?: readonly string[];
  readonly emotion?: string;
  readonly goal?: string;
  readonly mood?: string;
  readonly currentGoal?: string;
  readonly recentEvents?: readonly string[];
  readonly relationshipToUser?: string;
  readonly currentArc?: string;
  readonly currentLocationId?: string;
  readonly currentLocationName?: string;
  readonly lastUpdatedChapter?: number | null;
  readonly personality?: readonly string[];
  readonly speechStyle?: string;
  readonly taboos?: readonly string[];
  readonly worldview?: string;
  readonly desire?: string;
  readonly fear?: string;
  readonly weakness?: string;
  readonly contradiction?: string;
  readonly moralBoundary?: string;
  readonly privateMotive?: string;
  readonly relationshipToProtagonist?: string;
  readonly relationshipDynamics?: readonly string[];
  readonly trustLevel?: string;
  readonly hiddenStance?: string;
  readonly speechSamples?: readonly string[];
  readonly speechRules?: readonly string[];
  readonly behaviorBoundaries?: readonly string[];
  readonly knowledgeKnown?: readonly string[];
  readonly knowledgeUnknown?: readonly string[];
  readonly cannotReveal?: readonly string[];
  readonly currentPhysicalState?: string;
  readonly currentMentalState?: string;
  readonly currentResourceState?: string;
  readonly cannotDo?: readonly string[];
  readonly arcPromise?: string;
  readonly currentStateHint?: string;
}

export interface StateOverviewStoryBibleSummary {
  readonly available: boolean;
  readonly projectLogline?: string;
  readonly genre?: string;
  readonly readerPromise?: string;
  readonly longFormGoals: readonly string[];
  readonly centralConflicts: readonly string[];
  readonly coreMysteries: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly canonFacts: readonly string[];
  readonly openQuestions: readonly string[];
  readonly setupAssets?: {
    readonly initialAssets: readonly string[];
    readonly keyItems: readonly string[];
    readonly resourceLimits: readonly string[];
  };
  readonly firstChapterSetup?: {
    readonly goal?: string;
    readonly openingScene?: string;
    readonly hook?: string;
    readonly conflict?: string;
  };
  readonly protectedSecrets?: readonly string[];
}

export interface StateOverviewWritingRulesSummary {
  readonly available: boolean;
  readonly narrativePerspective?: string;
  readonly proseStyle: readonly string[];
  readonly pacing?: string;
  readonly revealPolicy?: string;
  readonly targetChapterWords?: number;
  readonly genreRequirements: readonly string[];
  readonly forbiddenContent: readonly string[];
  readonly doNotDo: readonly string[];
  readonly readerExperienceRules: readonly string[];
  readonly antiAiPatterns?: readonly string[];
  /** 用户自定义全局写作规矩（自由 Markdown，破例⑧）。 */
  readonly customNotes?: string;
}

export interface StateOverviewCharacterBibleSummary {
  readonly available: boolean;
  readonly characterCount: number;
  readonly keyCharacters: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly desire?: string;
    readonly fear?: string;
    readonly weakness?: string;
    readonly appearanceAnchors?: readonly string[];
    readonly contradiction?: string;
    readonly moralBoundary?: string;
    readonly privateMotive?: string;
    readonly relationshipToProtagonist?: string;
    readonly relationshipDynamics?: readonly string[];
    readonly trustLevel?: string;
    readonly hiddenStance?: string;
    readonly behaviorBoundaries?: readonly string[];
    readonly knowledgeKnown?: readonly string[];
    readonly knowledgeUnknown?: readonly string[];
    readonly cannotReveal?: readonly string[];
    readonly speechRules?: readonly string[];
    readonly speechStyle?: string;
    readonly speechSamples?: readonly string[];
    readonly arcPromise?: string;
    readonly currentStateHint?: string;
  }[];
}

export interface StateOverviewCharacterMatrix {
  readonly available: boolean;
  readonly characters: readonly StateOverviewCharacterMatrixItem[];
  readonly relationships: readonly StateOverviewCharacterRelationship[];
  readonly riskReminders: readonly string[];
}

export interface StateOverviewCharacterMatrixItem {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly age?: string;
  readonly gender?: string;
  readonly identity?: string;
  readonly faction?: string;
  readonly desire?: string;
  readonly fear?: string;
  readonly weakness?: string;
  readonly appearanceAnchors?: readonly string[];
  readonly contradiction?: string;
  readonly moralBoundary?: string;
  readonly privateMotive?: string;
  readonly relationshipDynamics?: readonly string[];
  readonly trustLevel?: string;
  readonly hiddenStance?: string;
  readonly behaviorBoundaries: readonly string[];
  readonly cannotDo: readonly string[];
  readonly cannotReveal?: readonly string[];
  readonly speechStyle?: string;
  readonly speechSamples: readonly string[];
  readonly knownFacts: readonly string[];
  readonly unknownTruths: readonly string[];
    readonly protectedSecrets: readonly string[];
    readonly forbiddenReveals: readonly string[];
    readonly currentLocation?: string;
    readonly mood?: string;
    readonly physicalState?: string;
    readonly mentalState?: string;
    readonly resourceState?: string;
    readonly currentGoal?: string;
    readonly recentEvents?: readonly string[];
  readonly lastSeenChapter?: number;
  readonly carriedAssets: readonly string[];
  readonly ownedAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
  readonly relationshipToProtagonist?: string;
  readonly relationships: readonly StateOverviewCharacterRelationship[];
  readonly riskReminders: readonly string[];
  readonly status?: "candidate" | "accepted" | "ignored" | "promoted";
  readonly roleHint?: string;
  readonly firstSeenChapter?: number;
  readonly evidence?: readonly string[];
  readonly appearanceRecords?: readonly {
    readonly chapter: number;
    readonly evidence: string;
    readonly location?: string;
  }[];
  readonly relationshipEvents?: readonly {
    readonly chapter: number;
    readonly relationToProtagonist?: string;
    readonly evidence: string;
  }[];
  /** 自定义额外字段（破例⑦展示落点，与引擎同源）。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewCharacterRelationship {
  readonly targetCharacterId: string;
  readonly targetName: string;
  readonly relationType: string;
  readonly attitude?: string;
  readonly trustLevel?: "low" | "medium" | "high";
  /** 由 trustLevel 确定性派生（low=25/medium=55/high=85），仅供进度条显示；与档级永不矛盾。 */
  readonly trustPercent?: number;
  readonly conflict?: string;
  readonly secret?: string;
  readonly lastChangedChapter?: number;
}

export interface StateOverviewWorldBibleSummary {
  readonly available: boolean;
  readonly ruleCount: number;
  readonly factionCount: number;
  readonly systemCount: number;
  readonly keyRules: readonly string[];
  readonly keyFactions: readonly string[];
  readonly resourceRules?: readonly string[];
  readonly authorityRules?: readonly string[];
  readonly socialOrder?: readonly string[];
  readonly conflictSources?: readonly string[];
  readonly fixedFacts?: readonly string[];
  readonly protectedSecrets?: readonly string[];
  readonly publicFacts?: readonly string[];
  readonly hiddenFacts?: readonly string[];
  readonly forbiddenRuleBreaks?: readonly string[];
  /** 世界观自定义额外字段（破例⑦）。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewLocationBibleSummary {
  readonly available: boolean;
  readonly locationCount: number;
  readonly activeLocationNames: readonly string[];
  readonly riskCount: number;
  readonly resourceCount: number;
  readonly keyRisks?: readonly string[];
  readonly keyResources?: readonly string[];
  readonly keyNarrativeFunctions?: readonly string[];
}

export interface StateOverviewAssetSummary {
  readonly available: boolean;
  readonly carriedAssets: readonly string[];
  readonly ownedAssets: readonly string[];
  readonly unavailableAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
  readonly assetItems?: readonly StateOverviewAssetItem[];
}

export interface StateOverviewAssetItem {
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
  /** 资产自定义额外字段（破例⑦）。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewLocationDetailSummary {
  readonly locations?: readonly StateOverviewLocationDetailItem[];
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly entrances?: readonly string[];
  readonly exits?: readonly string[];
  readonly travelRules: readonly string[];
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly fixedFacts?: readonly string[];
}

export interface StateOverviewLocationDetailItem {
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
  readonly travelRules: readonly string[];
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly fixedFacts: readonly string[];
  readonly hiddenFacts: readonly string[];
  /** 地点自定义额外字段（破例⑦）。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewCharacterDetailSummary {
  readonly characters: readonly {
    readonly id: string;
    readonly name: string;
    readonly age?: string;
    readonly speechStyle?: string;
    readonly speechSamples: readonly string[];
    readonly mood?: string;
    readonly currentGoal?: string;
    readonly recentEvents?: readonly string[];
    readonly currentState?: string;
    readonly cannotDo: readonly string[];
  }[];
}

export interface StateOverviewFoundationCompleteness {
  readonly passed: boolean;
  readonly readinessLevel: "ready" | "warning" | "high_risk";
  readonly missingItems: readonly string[];
  readonly suggestions: readonly string[];
}

export interface StateOverviewRequest {
  readonly projectPath: string;
  readonly chapter?: string;
  readonly maxTimelineEvents?: number;
}

export type StateOverviewApiResponse =
  | { readonly ok: true; readonly overview: StateOverview }
  | { readonly ok: false; readonly error: string };

export interface BookFileActionRequest {
  readonly projectPath: string;
}

export interface RenameBookRequest extends BookFileActionRequest {
  readonly title: string;
}

export interface UpdateStorySettingsRequest extends BookFileActionRequest {
  readonly title: string;
  readonly genre: string;
  readonly logline: string;
  readonly currentPhase: string;
  readonly firstVolumeGoal?: string;
  readonly longFormGoals?: readonly string[];
  readonly worldRules?: readonly string[];
  readonly socialRules?: readonly string[];
  readonly importantFacts?: readonly string[];
  readonly currentMainGoal?: string;
  readonly centralConflicts?: readonly string[];
  readonly forbiddenReveals?: readonly string[];
  readonly openQuestions?: readonly string[];
}

export interface UpdateWritingRulesRequest extends BookFileActionRequest {
  readonly narrativePerspective?: string;
  readonly proseStyle?: readonly string[];
  readonly pacing?: string;
  readonly revealPolicy?: string;
  readonly targetChapterWords?: number;
  readonly genreRequirements?: readonly string[];
  readonly forbiddenContent?: readonly string[];
  readonly doNotDo?: readonly string[];
  readonly readerExperienceRules?: readonly string[];
  readonly rules?: readonly string[];
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

export type ChapterSteeringPacing = "slow" | "medium" | "fast";
export type ChapterSteeringRevealLevel = "none" | "small" | "large";
export type ChapterSteeringSuggestionType = "hook" | "thread" | "arcGoal" | "character" | "location" | "risk";
export type ChapterSteeringAction = "include" | "skip" | "weaken" | "alternative";
export type ChapterSteeringIntensity = "light" | "medium" | "strong";
export type ChapterSteeringRisk = "low" | "medium" | "high";

export interface ChapterSteeringRequest {
  readonly projectPath: string;
  readonly userDirection: string;
  readonly chapter?: number;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly pacing?: ChapterSteeringPacing;
  readonly revealLevel?: ChapterSteeringRevealLevel;
  readonly maxSuggestions?: number;
}

export interface ChapterSteeringDraft {
  readonly userDirection: string;
  readonly chapter: number | null;
  readonly mustInclude: readonly string[];
  readonly mustAvoid: readonly string[];
  readonly pacing: ChapterSteeringPacing;
  readonly revealLevel: ChapterSteeringRevealLevel;
  readonly foundationContext?: ChapterSteeringFoundationContext;
  readonly suggestions: readonly ChapterSteeringSuggestion[];
  readonly selectedInclusions: readonly string[];
  readonly generatedChapterGoalPreview: string;
  readonly safety: {
    readonly writesState: false;
    readonly requiresPreviewBeforeCommit: true;
    readonly disabledActions: readonly string[];
  };
}

export interface ChapterSteeringFoundationContext {
  readonly available: boolean;
  readonly summary: string;
  readonly storyBibleAvailable: boolean;
  readonly writingRulesAvailable: boolean;
  readonly characterBibleAvailable: boolean;
  readonly worldBibleAvailable: boolean;
  readonly locationBibleAvailable: boolean;
  readonly writingRuleReminders: readonly string[];
  readonly genreRuleReminders: readonly string[];
  readonly characterBoundaryReminders: readonly string[];
  readonly protagonistKnowledgeReminders?: readonly string[];
  readonly forbiddenRevealReminders?: readonly string[];
  readonly worldRuleReminders: readonly string[];
  readonly locationContinuityReminders: readonly string[];
  readonly locationRiskReminders?: readonly string[];
  readonly setupAssetReminders?: readonly string[];
}

export interface ChapterSteeringSuggestion {
  readonly id: string;
  readonly type: ChapterSteeringSuggestionType;
  readonly title: string;
  readonly reason: string;
  readonly suggestedMethod: string;
  readonly defaultAction: ChapterSteeringAction;
  readonly availableActions: readonly ["include", "skip", "weaken", "alternative"];
  readonly intensity: ChapterSteeringIntensity;
  readonly risk: ChapterSteeringRisk;
  readonly sourceId?: string;
  readonly sourceStatus?: string;
}

export type ChapterSteeringApiResponse =
  | { readonly ok: true; readonly draft: ChapterSteeringDraft }
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

export interface WriteInstruction {
  readonly target: WriteInstructionTarget;
  readonly mode: "set_fields" | "add_to_array" | "remove_from_array";
  readonly fields?: Record<string, unknown>;
  readonly arrayField?: string;
  readonly values?: readonly string[];
}

export interface ChapterChatDecision {
  readonly agentId: string;
  readonly action: string;
  readonly target: string;
  readonly confidence: number;
  readonly reason: string;
}

// 对话提取出的低风险资料更新候选；是否自动应用由客户端和写入网关共同裁决。
export interface SilentFoundationUpdate {
  readonly actionType: "create_character" | "update_character_detail" | "create_location" | "update_location_detail" | "create_asset" | "update_asset_status" | "update_world_rule" | "update_writing_rule";
  readonly targetFile: string;
  readonly targetPath: string;
  readonly category: "characters" | "locations" | "assets" | "world" | "writingRules";
  readonly after: Record<string, unknown>;
  readonly isSecret?: boolean;
}

export interface ChapterChatResponse {
  readonly reply: string;
  readonly cards: readonly ChapterAdviceCard[];
  readonly toolOutput: readonly string[];
  readonly agentCards?: readonly ChapterAgentCard[];
  readonly intent?: ChapterChatIntent;
  readonly decision?: ChapterChatDecision;
  readonly chapterGoal?: string;
  readonly requiresConfirmation?: boolean;
  readonly model?: string;
  readonly profileId?: string;
  readonly writeInstructions?: readonly WriteInstruction[];
  readonly silentFoundationUpdates?: readonly SilentFoundationUpdate[];
  readonly chapterCompleteSummary?: string;
}

export type ChapterChatIntent =
  | "discuss"
  | "suggest"
  | "direct_edit"
  | "generate_steering"
  | "generate_draft"
  | "quality_check"
  | "ai_review"
  | "revision_preview"
  | "commit_preview"
  | "commit_apply"
  | "continue_next"
  | "edit_foundation"
  | "query_story_data"
  | "write_writing_rules"
  | "write_story_settings"
  | "chapter_complete";

export type ToolStepStatus = "running" | "completed" | "failed" | "needs_confirmation" | "partial" | "stopped";

export interface ToolStep {
  readonly id: string;
  readonly label: string;
  /** 触发该步的工具名（如 generate_draft / quality_check / commit_apply）；供进度卡把步骤映射到「构思/写稿/审校/入库」四相。 */
  readonly toolName?: string;
  readonly status: ToolStepStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** 工具执行详情（真实 summary / 失败原因）；折叠步骤展开后显示「具体怎么执行的」。 */
  readonly detail?: string;
  /** 诚实背书粒度（与服务端 shared/honesty-detection.ts stepBacksWriteClaim 认的字段名对齐）：
   *  prune_snapshots 的 dryRun——true=只读预览没落盘，completed 不背书「已裁剪」；写背书只认 false。 */
  readonly dryRun?: boolean;
  /** manage_style_exemplars 的动作：list 是只读 action，completed 不背书「已添加/已删除」；
   *  写背书只认 add/update/remove。没有这两字段的工具自然缺省、维持旧口径。 */
  readonly action?: string;
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

export type ChapterAdviceCardType =
  | "must_include"
  | "can_weaken"
  | "avoid"
  | "risk"
  | "chapter_goal"
  | "forbidden_info"
  | "alternative";

export type ChapterAdviceAction = "include" | "skip" | "weaken" | "alternative";

export interface ChapterAdviceCard {
  readonly id: string;
  readonly type: ChapterAdviceCardType;
  readonly title: string;
  readonly content: string;
  readonly reason?: string;
  readonly defaultAction: ChapterAdviceAction;
}

export type ChapterChatApiResponse =
  | { readonly ok: true; readonly result: ChapterChatResponse }
  | { readonly ok: false; readonly error: string };

export interface ChapterWorkspaceMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly adviceCards?: readonly ChapterAdviceCard[];
  readonly suggestedActions?: readonly ChapterWorkspaceSuggestedAction[];
  readonly agentCards?: readonly ChapterAgentCard[];
  readonly toolOutput?: readonly string[];
  readonly createdAt?: string;
}

export type ChapterWorkspaceFlowStatus =
  | "idle"
  | "steering_ready"
  | "draft_generating"
  | "draft_ready"
  | "quality_checked"
  | "commit_preview_ready"
  | "waiting_commit_confirmation"
  | "committed"
  | "ready_for_next";

export type ChapterWorkspacePermission =
  | "safe_read"
  | "model_call"
  | "draft_write"
  | "project_config_write"
  | "formal_state_write"
  | "destructive_write"
  | "local_side_effect";

export interface ChapterWorkspaceSuggestedAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly permission: ChapterWorkspacePermission | readonly ChapterWorkspacePermission[];
  readonly requiresConfirmation: boolean;
  readonly endpoint?: string;
}

export interface ChapterWorkspaceSnapshot {
  readonly chapter: number;
  readonly messages: readonly ChapterWorkspaceMessage[];
  readonly selectedAdviceCardKeys: readonly string[];
  readonly flowStatus?: ChapterWorkspaceFlowStatus;
  readonly draftContent?: string;
  readonly draftTitle?: string;
  readonly hasDraftFile?: boolean;
  readonly hasCommittedChapter?: boolean;
  readonly updatedAt?: string;
  readonly generationInterrupted?: boolean;
  readonly recoveredFromDraftFile?: boolean;
  /** 服务端工作区代次；写入时作为 expectedRevision 做乐观并发校验。 */
  readonly revision?: number;
}

export interface ChapterWorkspaceRequest {
  readonly projectPath: string;
  readonly chapter: number;
}

export interface SaveChapterWorkspaceRequest extends ChapterWorkspaceRequest {
  readonly messages?: readonly ChapterWorkspaceMessage[];
  readonly selectedAdviceCardKeys: readonly string[];
  readonly flowStatus?: ChapterWorkspaceFlowStatus;
  readonly draftContent?: string;
  readonly draftTitle?: string;
  readonly writeDraftFile?: boolean;
  /** 生成中被刷新/关页打断：下次打开以盘上更完整稿为准（dogfood F1）。 */
  readonly generationInterrupted?: boolean;
  /** 本次编辑所基于的已加载 revision；旧客户端省略时保持兼容。 */
  readonly expectedRevision?: number;
}

export type ChapterWorkspaceApiResponse =
  | { readonly ok: true; readonly snapshot: ChapterWorkspaceSnapshot }
  | { readonly ok: false; readonly error: string; readonly snapshot?: ChapterWorkspaceSnapshot };

export interface UsageSummary {
  readonly diagnosticsAvailable: boolean;
  readonly diagnosticsCount: number;
  readonly diagnosticsWarnings: readonly string[];
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  readonly cacheHitRatio: number | null;
  readonly recent: readonly UsageRecord[];
}

export interface UsageRecord {
  readonly stage: string;
  readonly chapter: number | null;
  readonly generatedAt: string | null;
  readonly totalTokens: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly cacheHitRatio: number | null;
  readonly elapsedMs: number | null;
}

export type UsageSummaryApiResponse =
  | { readonly ok: true; readonly summary: UsageSummary }
  | { readonly ok: false; readonly error: string };

export interface SnapshotEntryDto {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
}

export type SnapshotListApiResponse =
  | { readonly ok: true; readonly snapshots: readonly SnapshotEntryDto[] }
  | { readonly ok: false; readonly error: string };

export type SnapshotRestoreApiResponse =
  | { readonly ok: true; readonly restored: SnapshotEntryDto }
  | { readonly ok: false; readonly error: string };

export type FoundationGapCategory =
  | "story"
  | "world"
  | "writingRules"
  | "characters"
  | "characterRelationships"
  | "locations"
  | "assets"
  | "hooks"
  | "threads"
  | "arcGoals"
  | "timeline"
  | "knowledgeBoundary";

export type FoundationGapSeverity = "info" | "warning" | "high";
export type FoundationReadinessLevel = "ready" | "warning" | "high_risk";

export interface FoundationGapItem {
  readonly id: string;
  readonly category: FoundationGapCategory;
  readonly severity: FoundationGapSeverity;
  readonly title: string;
  readonly description: string;
  readonly missingFields: readonly string[];
  readonly affectedWritingRisk: string;
  readonly suggestedFix: string;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly targetId?: string;
  readonly requiresUserConfirm: true;
}

export interface FoundationConflictItem {
  readonly id: string;
  readonly category: FoundationGapCategory;
  readonly title: string;
  readonly description: string;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly existingValue: unknown;
  readonly suggestedValue: unknown;
  readonly resolutionOptions: readonly ["keep_existing", "replace", "merge", "defer"];
}

export type FoundationGapActionType =
  | "fill_missing_field"
  | "create_character"
  | "rename_character"
  | "update_character_detail"
  | "create_location"
  | "create_asset"
  | "update_world_rule"
  | "update_writing_rule"
  | "update_character_boundary"
  | "update_location_detail"
  | "update_asset_status"
  | "create_relationship"
  | "update_knowledge_boundary"
  | "delete_foundation_entry"
  | "defer";

export interface FoundationGapSuggestion {
  readonly id: string;
  readonly gapId: string;
  readonly category: FoundationGapCategory;
  readonly actionType: FoundationGapActionType;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly targetId?: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly rationale: string;
  readonly risk: FoundationGapSeverity;
  readonly requiresUserConfirm: true;
  readonly sourceUserMessage?: string;
  readonly extractedEntityName?: string;
  readonly extractedEntityType?: string;
  readonly sourceEvidence?: string;
  readonly preservationWarnings?: readonly string[];
  readonly writeMode?: "merge" | "replace";
  readonly confirmedByUser?: boolean;
}

export interface FoundationGapReport {
  readonly passed: boolean;
  readonly readinessLevel: FoundationReadinessLevel;
  readonly missingItems: readonly FoundationGapItem[];
  readonly riskyItems: readonly FoundationGapItem[];
  readonly conflictItems: readonly FoundationConflictItem[];
  readonly suggestions: readonly FoundationGapSuggestion[];
  readonly byCategory: Readonly<Record<FoundationGapCategory, readonly FoundationGapItem[]>>;
}

export interface FoundationGapDecision {
  readonly suggestionId: string;
  readonly decision: "accept" | "reject" | "defer" | "edit";
  readonly editedAfter?: unknown;
}

export interface FoundationGapApplyPlan {
  readonly acceptedSuggestions: readonly FoundationGapSuggestion[];
  readonly rejectedSuggestionIds: readonly string[];
  readonly deferredSuggestionIds: readonly string[];
  readonly skippedConflicts: readonly FoundationConflictItem[];
  readonly fileChanges: readonly {
    readonly targetFile: string;
    readonly summary: string;
    readonly suggestionIds: readonly string[];
  }[];
}

export interface FoundationGapAppliedWrite {
  readonly domain: "character" | "location" | "world" | "writingRules" | "asset" | "field";
  readonly action: string;
  readonly targetFile: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly summary: string;
  /** 本次写入新建（卡上原本没有）的自定义字段键名，供结果卡如实回报。镜像引擎 FoundationWriteRecord。 */
  readonly newExtraFields?: readonly string[];
}

/** 写入期被跳过的写入（镜像引擎 FoundationGapSkippedWrite）：reason + 含真实实体名的 summary，供 UI 诚实回报。 */
export interface FoundationGapSkippedWrite {
  readonly suggestionId: string;
  readonly reason: "missing_target_id" | "target_not_found" | "apply_failed";
  readonly action: string;
  readonly targetName?: string;
  readonly summary: string;
}

export interface FoundationGapChatAction {
  readonly id: string;
  readonly label: string;
}

export interface FoundationGapChatMessageInput {
  readonly role: "assistant" | "user";
  readonly content: string;
}

export interface FoundationGapChatResult {
  readonly reply: string;
  readonly intent?: FoundationGapActionType;
  readonly askedQuestions?: readonly string[];
  readonly draftSuggestion?: FoundationGapSuggestion;
  readonly missingFields?: readonly string[];
  readonly focusedCategory?: FoundationGapCategory;
  readonly focusedGapIds: readonly string[];
  readonly focusedSuggestionIds: readonly string[];
  readonly generatedSuggestions: readonly FoundationGapSuggestion[];
  readonly suggestedActions: readonly FoundationGapChatAction[];
  readonly safetyWarnings: readonly string[];
  readonly modelProfile?: string;
  readonly fallbackUsed?: boolean;
}

export type FoundationGapReportApiResponse =
  | { readonly ok: true; readonly report: FoundationGapReport }
  | { readonly ok: false; readonly error: string };

export type FoundationGapSuggestionsApiResponse =
  | { readonly ok: true; readonly report: FoundationGapReport; readonly suggestions: readonly FoundationGapSuggestion[] }
  | { readonly ok: false; readonly error: string };

export type FoundationGapPreviewApiResponse =
  | { readonly ok: true; readonly plan: FoundationGapApplyPlan }
  | { readonly ok: false; readonly error: string };

export type FoundationGapApplyApiResponse =
  | { readonly ok: true; readonly result: { readonly applied: boolean; readonly plan: FoundationGapApplyPlan; readonly writes?: readonly FoundationGapAppliedWrite[]; readonly skippedWrites?: readonly FoundationGapSkippedWrite[]; readonly overview: StateOverview; readonly undo?: FoundationGapUndoInfo } }
  | { readonly ok: false; readonly error: string };

export interface FoundationGapUndoInfo {
  readonly undoId: string;
  readonly changedFiles: readonly string[];
}

export interface FoundationGapRollbackRequest {
  readonly projectPath: string;
  readonly undoId: string;
}

export type FoundationGapRollbackApiResponse =
  | { readonly ok: true; readonly result: { readonly undoId: string; readonly restoredFiles: readonly string[]; readonly overview: StateOverview } }
  | { readonly ok: false; readonly error: string };

export interface FoundationGapConfirmCharacterStateWriteRequest {
  readonly projectPath: string;
  readonly characterId: string;
  readonly targetFile: `characters/${string}/state.json`;
  readonly previewHash: string;
  readonly baseHash: string;
  readonly idempotencyKey: string;
  readonly explicitConfirm: true;
  readonly suggestionIds: readonly string[];
  readonly statePatch: Readonly<Record<string, unknown>>;
}

export interface FoundationGapConfirmCharacterStateWriteResult {
  readonly status: "committed" | "blocked" | "failed";
  readonly scope: "character_state_only";
  readonly reason?: string;
  readonly changedFiles: readonly string[];
  readonly didWriteCharacterState: boolean;
  readonly didWriteCharacterProfile: false;
  readonly didWriteCharacterBible: false;
  readonly didWriteCharacterMatrix: false;
  readonly didWriteChapterMarkdown: false;
  readonly didWriteTimeline: false;
  readonly didWriteWorld: false;
  readonly didWriteMemory: false;
  readonly didCallCommitEngine: false;
  readonly didCallApplyCommit: false;
  readonly stateOverviewRefreshRequested: boolean;
  readonly stateOverviewRefreshSucceeded: boolean;
  readonly stateOverviewRefreshError: string | null;
  readonly rollbackAttempted: boolean;
  readonly rollbackSucceeded: boolean | null;
  readonly residue: readonly string[];
  readonly idempotencyReplayed?: boolean;
  readonly overview?: StateOverview;
}

export type FoundationGapConfirmCharacterStateWriteApiResponse =
  | { readonly ok: true; readonly result: FoundationGapConfirmCharacterStateWriteResult }
  | { readonly ok: false; readonly result: FoundationGapConfirmCharacterStateWriteResult; readonly error: string };

export interface CharacterMatrixPreviewPreflightRequest {
  readonly projectPath: string;
  readonly expectedTargetFile: "story/character-matrix.json";
  readonly candidates: readonly CharacterMatrixConfirmCandidate[];
}

export type CharacterMatrixPreviewPreflightPlan = CharacterMatrixConfirmPreflightPlan;

export type CharacterMatrixPreviewPreflightApiResponse =
  | { readonly ok: true; readonly plan: CharacterMatrixConfirmPreflightPlan }
  | { readonly ok: false; readonly error: string };

export type FoundationGapChatApiResponse =
  | { readonly ok: true; readonly result: FoundationGapChatResult }
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

export interface GenerateDraftRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly requestedDraftLength?: number;
  readonly maxOutputTokens?: number;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
}

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

export interface DraftQualityRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly draftContent?: string;
}

export interface DraftDirectEditRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly instruction: string;
  readonly draftContent: string;
}

export interface DraftDirectEditResult {
  readonly draftContent: string;
  readonly reply: string;
  readonly changeSummary: string;
  readonly model?: string;
  readonly profileId?: string;
}

export type DraftDirectEditApiResponse =
  | { readonly ok: true; readonly result: DraftDirectEditResult }
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

export type DraftQualityApiResponse =
  | { readonly ok: true; readonly quality: DraftQualityReport }
  | { readonly ok: false; readonly error: string };

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

export interface DraftAIReviewRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly draftContent?: string;
  readonly chapterGoal?: string;
  readonly userDirection?: string;
  readonly deterministicQuality?: DraftQualityReport;
}

export type DraftAIReviewApiResponse =
  | { readonly ok: true; readonly review: DraftAIReviewReport; readonly model?: string; readonly profileId?: string; readonly usedFallback?: boolean }
  | { readonly ok: false; readonly error: string };

export type DraftRevisionTargetType = "paragraph" | "section" | "dialogue" | "opening" | "ending" | "whole_draft_note";
export type DraftRevisionStatus = "pending" | "preview_generated" | "applied" | "dismissed";

export interface DraftRevisionTask {
  readonly id: string;
  readonly sourceIssueId?: string;
  readonly sourceSuggestionId?: string;
  readonly chapter: number;
  readonly targetType: DraftRevisionTargetType;
  readonly targetText: string;
  readonly targetRangeHint?: string;
  readonly problemSummary: string;
  readonly revisionGoal: string;
  readonly constraints: readonly string[];
  readonly status: DraftRevisionStatus;
}

export interface DraftRevisionPreview {
  readonly taskId: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly changeSummary: string;
  readonly rationale: string;
  readonly riskNotes: readonly string[];
  readonly preservedFacts: readonly string[];
  readonly warnings: readonly string[];
}

export interface DraftRevisionApplyResult {
  readonly applied: boolean;
  readonly chapter: number;
  readonly draftPath: string;
  readonly updatedWordCount: number;
}

export interface DraftRevisionPreviewRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly task: DraftRevisionTask;
  readonly draftContent?: string;
}

export interface DraftRevisionApplyRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly preview: DraftRevisionPreview;
  /** 用户原始点名片段（task.targetText 原样回传）——带上即启用服务端目标级诚实守卫（target_unchanged）；
   *  服务端在 apply 时的当前草稿上自己重新解析目标区间，不信客户端字符串。 */
  readonly targetText?: string;
}

export type DraftRevisionPreviewApiResponse =
  | { readonly ok: true; readonly task: DraftRevisionTask; readonly preview: DraftRevisionPreview; readonly model?: string; readonly profileId?: string; readonly usedFallback?: boolean }
  | { readonly ok: false; readonly error: string };

export type DraftRevisionApplyApiResponse =
  | { readonly ok: true; readonly result: DraftRevisionApplyResult; readonly draftContent: string; readonly overview: StateOverview }
  | { readonly ok: false; readonly error: string };

export type WorkspacePatchApplyDocumentType =
  | "chapter_markdown"
  | "draft_markdown"
  | "outline_markdown"
  | "note_markdown"
  | "review_markdown"
  | "quality_report_markdown"
  | "task_log_markdown";

export interface WorkspacePatchApplyRequest {
  readonly projectPath: string;
  readonly targetPath: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly patchId?: string;
  readonly previewId?: string;
  readonly expectedBeforeHash: string;
  readonly userConfirmed: boolean;
  readonly idempotencyKey: string;
}

export interface WorkspacePatchApplySuccessResult {
  readonly ok: true;
  readonly patchApplyTxId: string;
  readonly targetPath: string;
  readonly documentType: WorkspacePatchApplyDocumentType;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly changeSummary: string;
  readonly changedFiles: readonly string[];
  readonly rollbackAvailable: boolean;
  readonly rollbackNote: string;
  readonly noStateJsonWrite: true;
  readonly noMemoryWrite: true;
  readonly noFormalCommitApply: true;
  readonly warnings: readonly string[];
  readonly transactionPath: string;
}

export interface WorkspacePatchApplyErrorResponse {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
  readonly reasons?: readonly string[];
  readonly warnings?: readonly string[];
}

export type WorkspacePatchApplyApiResponse =
  | WorkspacePatchApplySuccessResult
  | WorkspacePatchApplyErrorResponse;

export type MemoryContextReadRouteStatus = "idle" | "loading" | "ready" | "warning" | "blocked" | "failed";

export interface MemoryContextReadRouteLimits {
  readonly maxFileBytes?: number;
  readonly maxMemoryItems?: number;
  readonly maxTextLengthPerItem?: number;
}

export interface MemoryContextReadRouteRequest {
  readonly projectPath: string;
  readonly memoryTargetPath: string;
  readonly limits?: MemoryContextReadRouteLimits;
  readonly requestId?: string;
}

export interface MemoryContextReadRouteSafety {
  readonly noStateJsonWrite: true;
  readonly noMemoryWrite: true;
  readonly noMarkdownWrite: true;
  readonly noFormalCommit: true;
  readonly noPromptInjection: true;
  readonly noConfirmApplyEffect: true;
}

export interface MemoryContextReadRouteResult {
  readonly ok: boolean;
  readonly status: MemoryContextReadRouteStatus;
  readonly viewModel: MemoryReadViewModel | null;
  readonly warnings: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly normalizedPath: string;
  readonly readOnly: true;
  readonly canWrite: false;
  readonly canInjectAutomatically: false;
  readonly didReadFile: boolean;
  readonly didWriteMemory: false;
  readonly didInjectAutomatically: false;
  readonly requestId?: string;
  readonly safety: MemoryContextReadRouteSafety;
}

export interface CommitRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly selectiveConfirmation?: CommitSelectiveConfirmation;
  readonly transactionId?: string;
  readonly previewHash?: string;
  readonly idempotencyKey?: string;
}

export interface CommitPreviewRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly selectiveConfirmation?: CommitSelectiveConfirmation;
  readonly workspaceDraftId?: string;
  readonly baseHash?: string;
  readonly previewHash?: string;
  readonly readinessStatus?: string;
  readonly requestId?: string;
}

export interface CommitPreviewTransactionMetadata {
  readonly version: "transaction-hardening-v1";
  readonly transactionId: string;
  readonly previewHash: string;
  readonly projectHash: string;
  readonly chapter: number;
  readonly draftHash: string;
  readonly commitPlanHash: string;
  readonly selectiveCandidateSummaryHash: string;
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

export type CommitPreviewApiResponse =
  | {
    readonly ok: true;
    readonly commitPlan: DraftActionReport;
    readonly draftQuality: DraftQualityReport;
    readonly semanticQuality?: DraftQualityReport;
    readonly transaction: CommitPreviewTransactionMetadata;
    readonly transactionId: string;
    readonly previewHash: string;
    readonly formalCommitPreview: FormalCommitPreviewRouteResult;
  }
  | { readonly ok: false; readonly error: string };

export interface FormalCommitPreviewSafety {
  readonly noStateJsonWrite: true;
  readonly noMarkdownWrite: true;
  readonly noMemoryWrite: true;
  readonly noFormalCommit: true;
  readonly noConfirmRoute: true;
  readonly noFormalWriteButton: true;
  readonly noCommitEngine: true;
  readonly noCommitFastDraft: true;
  readonly noApplyCommit: true;
  readonly noWorkspacePatchApply: true;
  readonly noAgentAutoApply: true;
  readonly noRollback: true;
  readonly noMultiFileApply: true;
}

// Confirm-route hashes are intentionally not transaction hashes. For chapter-only
// confirm, `previewHash` and `workspaceDraftId` both identify the current draft
// Markdown content, while `baseHash` identifies the committed chapter Markdown
// content. UI code must not map these from transaction preview/project hashes.
export interface FormalCommitPreviewConfirmRequestContext {
  readonly projectPath: string;
  readonly chapterTarget: number;
  readonly previewHash: string;
  readonly baseHash: string;
  readonly workspaceDraftId: string;
  readonly readinessStatus: "ready_for_formal_review";
}

export interface FormalCommitChapterOnlyConfirmReadiness {
  readonly status: "ready" | "blocked";
  readonly blockingReasons: readonly string[];
  readonly confirmRequestContextAvailable: boolean;
  readonly serverFlagRequiredForWrite: true;
  readonly fullFormalCommitReady: false;
  readonly doesNotUpdateState: true;
  readonly readinessStatus: "ready_for_formal_review" | null;
}

export interface FormalCommitPreviewRouteResult {
  readonly status: "ready" | "blocked" | "failed" | "unavailable";
  readonly formalCommitPlan: unknown | null;
  readonly wouldChangeFiles: readonly string[];
  readonly wouldUpdateState: boolean;
  readonly blockingReasons: readonly string[];
  readonly warnings: readonly string[];
  readonly requestId?: string;
  readonly dryRun: true;
  readonly readOnly: true;
  readonly didWriteState: false;
  readonly didWriteMarkdown: false;
  readonly didWriteMemory: false;
  readonly didFormalCommit: false;
  // Preview remains dry-run only and never grants direct confirmation capability.
  // Actual writes go through `/api/commit/apply`, which auto-snapshots before writing.
  readonly canConfirm: false;
  readonly confirmUnavailable: true;
  readonly previewToken: null;
  readonly confirmRequestContext?: FormalCommitPreviewConfirmRequestContext;
  readonly chapterOnlyConfirmReadiness: FormalCommitChapterOnlyConfirmReadiness;
  readonly safety: FormalCommitPreviewSafety;
}

export interface CommitApplyLegacySuccessApiResponse {
  readonly ok: true;
  readonly report: DraftActionReport;
  readonly overview: StateOverview | null;
  readonly chapterContent?: string;
  readonly chapterTitle?: string;
  readonly warnings?: readonly string[];
}

export type CommitApplySuccessResult = Omit<CommitApplyLegacySuccessApiResponse, "ok">;

export type CommitApplyApiResponse =
  | CommitApplyLegacySuccessApiResponse
  | {
    readonly ok: false;
    readonly error: string;
    readonly draftQuality?: DraftQualityReport;
    readonly semanticQuality?: DraftQualityReport;
    readonly qualityGate?: {
      readonly blockingCount: number;
      readonly draftConfirmed: number;
      readonly draftNeedsConfirmation: number;
      readonly semanticConfirmed: number;
      readonly semanticNeedsConfirmation: number;
      readonly message: string;
    };
  };
