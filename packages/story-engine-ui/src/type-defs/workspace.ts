import type { ChapterAgentCard, DraftReviewView, DraftRevisionPreview, QualityCardReport, StateOverviewCharacterMatrix, ToolStep } from "../api/types.js";
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
  /** 「scaffolding」= 界面自己塞的招呼/进度提示（进工作台、流程提示），不是对话；进书时滤掉、空状态据此判断（重构 P4：不再按文案认）。 */
  readonly kind?: "scaffolding";
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
  /** 这条消息挂的卡（定稿预览、核账、审稿……）：一个联合类型，按 type 区分、按 type 渲染（重构 P5）。 */
  readonly cards?: readonly MessageCard[];
  /** 这一轮的真实 token 用量（对话 AI + 工具内部调用），作者看得见每轮花了多少。 */
  readonly tokenUsage?: { readonly input: number; readonly cachedInput: number; readonly output: number };
  /** 作者发这句时在看哪一章（只记在作者的话上；右栏「这一章的对话」按它分，重构 P6 第 6 步）。 */
  readonly chapter?: number;
}

/**
 * 消息上挂的卡（重构 P5：原来是消息上 15 个各管各的可选字段）。按 type 区分；存盘按 type 校验（server/lib/message-cards-io.ts），
 * 老会话读的时候把老字段转成这里的卡。一条消息上同一种卡最多一张。
 */
export type MessageCard =
  /** 定稿预览（commit_preview）：裁决照实显示，不靠模型转述。 */
  /** 定稿预览。checkedVersion＝预览时稿纸的版本号：稿子没再变就直接打开这份清单，不再重跑记账员（重构 P6）。 */
  | { readonly type: "commit-preview"; readonly preview: CommitPreviewCardData; readonly checkedVersion?: string | null }
  /** 定稿回执（commit_apply 的入库报告）：这章改了哪些账。原样存，渲染侧防御解析。 */
  | { readonly type: "commit-report"; readonly report: unknown }
  /**
   * 核账（check_continuity）。dismissed＝作者点过「不是问题」的条目（continuityItemKey），对话卡和稿纸划线共用；
   * checkedVersion＝结果到时稿纸的版本号（核的是这一版），稿纸版本变了就是「核过后改过稿」。
   */
  | { readonly type: "continuity"; readonly check: ContinuityCheckData; readonly dismissed?: readonly string[]; readonly checkedVersion?: string | null }
  /** 审稿（ai_review）问题清单。 */
  | { readonly type: "draft-review"; readonly review: DraftReviewView }
  /** 硬伤检查（quality_check）。 */
  | { readonly type: "quality"; readonly report: QualityCardReport }
  /** 机器腔体检（check_ai_flavor）；fixedIds＝已点「改掉这句」改成功的几条。 */
  | { readonly type: "ai-flavor"; readonly report: AiFlavorReport; readonly fixedIds?: readonly string[] }
  /** AI 提的「下一步」选项（suggest_next_steps）。 */
  | { readonly type: "next-steps"; readonly prompt: NextStepPrompt }
  /** 名字写歪提醒（commit_preview）。 */
  | { readonly type: "name-drift"; readonly warnings: readonly NameDriftWarning[] }
  /** 线索久未推进提醒（commit_preview）。 */
  | { readonly type: "stale-threads"; readonly warnings: readonly StaleThreadWarningData[] }
  /** 这一轮出错了（整条消息按错误卡渲染）；detail＝技术详情里的原始报错。 */
  | { readonly type: "error"; readonly detail?: string }
  /** 服务端状态说明（如历史窗口被裁剪）：照实显示，不进助手正文。 */
  | { readonly type: "status-notes"; readonly notes: readonly string[] }
  /** 头脑风暴（brainstorm_chapter，重构 P6）：几种走法；picked＝作者挑中的那种（序号），没挑缺省。 */
  | { readonly type: "directions"; readonly brainstorm: BrainstormCardData; readonly picked?: number };

export type MessageCardType = MessageCard["type"];

/** 头脑风暴卡：章纲员出的几种走法 + 核账员核前文的结果（线索只带名字，不带编号）。 */
export interface BrainstormCardData {
  readonly chapter: number;
  readonly idea?: string;
  readonly options: readonly BrainstormOptionData[];
  /** 核账员核过前文没有；没核成时 checkNote 说原因。 */
  readonly checked: boolean;
  readonly checkNote?: string;
  readonly coldNote?: string;
}

export interface BrainstormOptionData {
  readonly title: string;
  readonly steps: readonly string[];
  readonly recommended?: boolean;
  readonly threads: readonly { readonly title: string; readonly idle: number; readonly stale: boolean }[];
  /** 和前文对不上的地方：第几步、前文哪章哪句、为什么。 */
  readonly problems: readonly { readonly step: number; readonly earlierChapter: number; readonly earlierQuote: string; readonly reason: string }[];
}

export interface ContinuityCheckData {
  readonly chapter: number;
  readonly sure: readonly ContinuityCheckItemData[];
  readonly maybe: readonly ContinuityCheckItemData[];
}

export interface NextStepPrompt {
  readonly question: string;
  readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean; readonly action?: import("../api/agentChatClient.js").AgentUserAction }[];
}

export interface NameDriftWarning {
  readonly establishedName: string;
  readonly driftedVariant: string;
  readonly message: string;
}

export interface StaleThreadWarningData {
  readonly kind: string;
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
}

/** 核账卡上的一条（check_continuity 投影）：本章原句 ↔ 前文原句；对设定本的条目 earlierQuote＝设定原文。 */
export interface ContinuityCheckItemData {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  /** R7.3 对的是设定本（人物卡 / 地点 / 资产 / 世界规则）而不是某一章。 */
  readonly againstSetting?: { readonly label: string };
  /** R7.3 错在哪一章、按钮就改哪一章（前文章和设定不一致时指向前文那章）；缺省＝本章。 */
  readonly fixChapter?: number;
}

/** 「定稿预览」卡的确定性数据（commit_preview 工具输出的投影子集，渲染侧防御解析）。 */
export interface CommitPreviewCardData {
  readonly chapter: number;
  readonly canCommit: boolean;
  /** 阻断理由（引擎确定性判定：缺稿/质检硬伤/名字漂移等）。非空时 canCommit 必为 false。 */
  readonly blockingReasons?: readonly string[];
  readonly summary?: string;
  /** 质量问题分层计数；缺省时不渲染该行。 */
  readonly draftIssueCount?: number;
  readonly semanticIssueCount?: number;
  /** R7.7·报告 4.3：质量问题明细文案，卡内默认折叠展开；不再指向界面上不存在的「质检卡」。 */
  readonly draftIssues?: readonly string[];
  readonly semanticIssues?: readonly string[];
  /** 记账员交了、但原句在正文里找不到或指向前文没有的东西，这次没记上的（带原因，人话）。 */
  readonly notRecorded?: readonly string[];
  /** 要如实告诉作者的提醒（记账员没读完前文、这章定稿过会换掉原来的账……）。 */
  readonly notes?: readonly string[];
  /** 预览令牌（不展示）：「确认定稿」按钮原样带回，服务重启后仍可凭它放行同一版草稿。 */
  readonly previewToken?: string;
  /** 定稿会往账本里写的东西：作者可去掉不对的（removable），去掉的定稿时不写；要确认的改记默认不勾（defaultUnchecked），勾上才作数。 */
  readonly ledgerChecklist?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly reason?: string;
    readonly detail?: string;
    readonly removable: boolean;
    readonly editableDay?: number;
    readonly needsConfirm?: boolean;
    readonly defaultUnchecked?: boolean;
  }[];
}

export interface DraftPreview {
  readonly chapterNumber: number;
  readonly title: string;
  readonly status: "draft" | "committed" | "needs_repair";
  readonly content: string;
  readonly wordCount?: number;
  /** AI 正在往这一章流式出稿：稿纸只读显示流出来的字（不进作者的稿子）。 */
  readonly streaming?: boolean;
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
 * 去 AI 味体检报告（前端镜像）——与后端 server/writing/ai-flavor/ai-flavor-check.ts 的
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
