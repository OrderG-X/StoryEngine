import type { ChapterAgentCard, DraftReviewView, DraftRevisionPreview, QualityCardReport, ToolStep } from "../api/types.js";
import type { SuggestedAction, ChapterWorkflowState } from "./workflow.js";
import type { AiErrorReason } from "../server/lib/ai-errors.js";

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
  /** 已定稿、但工作稿定稿后又改过（P11）：底栏「N 章工作稿还没定稿」要算上它。 */
  readonly editedSinceCommit?: boolean;
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
  /**
   * 「scaffolding」= 界面自己塞的招呼/进度提示（进工作台、流程提示），不是对话；进书时滤掉、空状态据此判断（重构 P4：不再按文案认）。
   * 「restore」= 作者在操作历史里点了恢复（不走对话）记下的一行：它之前那轮的「下一步」「撤销这次定稿」都不再算数。
   */
  readonly kind?: "scaffolding" | "restore";
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
  /** 这一轮出错了（整条消息按错误卡渲染）；detail＝技术详情里的原始报错，reason＝服务端分的类（P11，老消息没有）。 */
  | { readonly type: "error"; readonly detail?: string; readonly reason?: AiErrorReason }
  /** 服务端状态说明（如历史窗口被裁剪）：照实显示，不进助手正文。 */
  | { readonly type: "status-notes"; readonly notes: readonly string[] }
  /** 头脑风暴（brainstorm_chapter，重构 P6）：几种走法；picked＝作者挑中的那种（序号），没挑缺省。 */
  | { readonly type: "directions"; readonly brainstorm: BrainstormCardData; readonly picked?: number }
  /**
   * 定论（P12：核账卡「以第 N 章为准」、对话里「以这个为准」）：定论 + 前文要改的几句、账和设定本跟着改的。
   * excluded＝作者划掉不改的那几处（key）；applied＝点了「确认」后服务端回的那句结果（有它就是改齐了）。
   */
  | { readonly type: "settle"; readonly settle: SettleCardData; readonly excluded?: readonly string[]; readonly applied?: string };

export type MessageCardType = MessageCard["type"];

/** 定论卡：只有原句和名字，没有编号。draft＝改的是还没定稿的工作稿。 */
export interface SettleCardData {
  readonly token: string;
  readonly canon: string;
  /** 设定本里已经有这条定论了（不再记一次）。 */
  readonly canonExists: boolean;
  /** 只是某一场里的事：只改句子，不记进设定本。 */
  readonly sceneOnly?: boolean;
  /** 换掉设定本里原来那条定论（原文）。 */
  readonly replaces?: string;
  /** 从哪一章点进来的（「再核第 N 章」）。 */
  readonly chapter?: number;
  readonly edits: readonly { readonly key: string; readonly chapter: number; readonly draft: boolean; readonly from: string; readonly to: string; readonly why?: string }[];
  /** 账里跟着改的事实：after 缺省＝这条作废。 */
  readonly facts: readonly { readonly chapter: number; readonly before: string; readonly after?: string }[];
  /** 设定本跟着改的栏：card 缺省＝故事设定。 */
  readonly fields: readonly { readonly key: string; readonly card?: string; readonly label: string; readonly from: string; readonly to: string }[];
  /** 查了哪几章。 */
  readonly searched: readonly number[];
  /** 核账报过和它打架、这次却没查出改法的句子。 */
  readonly missed: readonly { readonly chapter: number; readonly quote: string }[];
  /** 核账卡上点「以本章为准」的那条（条目键）：改齐后那条算改掉了。 */
  readonly resolves?: string;
  /** 没查全的（哪一批、为什么）。 */
  readonly failures: readonly string[];
}

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
  /** 错在前面某章、之前报过还没改的（不算这一章的问题，卡上收起）。 */
  readonly earlierOpen?: readonly ContinuityCheckItemData[];
}

export interface NextStepPrompt {
  readonly question: string;
  readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean; readonly action?: import("../api/agentChatClient.js").AgentUserAction }[];
}

/** 核账条目对的那句设定出自哪：哪一类（label：人物卡 / 地点…），落在一张卡里就带卡名。老卡片只有 label。 */
export interface SettingRefData {
  readonly label: string;
  readonly kind?: "canon" | "story" | "character" | "place" | "item" | "lore";
  readonly card?: string;
}

/** 核账卡上的一条（check_continuity 投影）：本章原句 ↔ 前文原句；对设定本的条目 earlierQuote＝设定原文。 */
export interface ContinuityCheckItemData {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  /** R7.3 对的是设定本（人物卡 / 地点 / 资产 / 世界规则）而不是某一章。 */
  readonly againstSetting?: SettingRefData;
  /** R7.3 错在哪一章、按钮就改哪一章（前文章和设定不一致时指向前文那章）；缺省＝本章。 */
  readonly fixChapter?: number;
  /** 这句是上一遍按核账改出来的（from＝改前那句），这遍又说不对：两遍说法相反，在「可能」里交作者定。 */
  readonly revisited?: { readonly from: string };
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
    readonly editableDayEnd?: number;
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

export interface ChapterWorkspaceData {
  readonly projectName: string;
  readonly currentChapter: ChapterNavItem;
  readonly chapters: readonly ChapterNavItem[];
  readonly flowStatus: ChapterWorkflowState;
  readonly hasUncommittedDrafts?: boolean;
  readonly workingDraftChain?: boolean;
  readonly previousUncommittedDraftContext?: boolean;
  readonly latestUncommittedDraftChapter?: number;
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
