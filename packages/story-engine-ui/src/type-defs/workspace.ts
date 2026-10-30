import type { ChapterAgentCard, DraftReviewView, QualityCardReport, ToolStep } from "../api/types.js";
import type { SuggestedAction, ChapterWorkflowState } from "./workflow.js";
import type { AiErrorReason } from "../server/lib/ai-errors.js";
import type { CanonResultData, PendingActionData } from "../api/agentChatClient.js";

/** Async work is owned by the exact book, chapter, chat session and operation. */
export interface WorkspaceOperationTarget {
  readonly projectPath: string;
  readonly chapter: number;
  readonly sessionId: string;
  readonly operationId: string;
}

/** 一份候选稿（拆开的：正文 + 章名；没章名 = 选用时沿用作者眼前的）。 */
/** 并排面板上的一版（「另外几版」卡点开的）：哪一章、哪本书的，点「用这版」带着候选号和指纹交 draft.adopt。 */
export interface WorkspaceDraftCandidate extends DraftVersionData {
  readonly chapter: number;
  readonly projectPath: string;
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
  /**
   * 作者这句发出的时间（写作版本 P2a，只记在作者的话上）：和消息号一起随请求发，服务端按「消息号」认这一句交的操作；
   * 重发沿用存下的这个，不重新取时间。
   */
  readonly issuedAt?: string;
}

/**
 * 消息上挂的卡（重构 P5：原来是消息上 15 个各管各的可选字段）。按 type 区分；存盘按 type 校验（server/lib/message-cards-io.ts），
 * 老会话读的时候把老字段转成这里的卡。一条消息上同一种卡最多一张。
 */
export type MessageCard =
  /**
   * 定稿清单（写作版本 P2a 片 4A：commit.prepare 出的清单或定不了的原因）：裁决照实显示，不靠模型转述。opId＝出它的那次定稿
   * （在等作者点「确认定稿」时，确认就是接着做它）；checkedVersion＝清单到时稿纸的版本号：稿子没再变就直接打开这份，不再重跑记账员。
   */
  | { readonly type: "commit-preview"; readonly preview: CommitPreviewCardData; readonly opId?: string; readonly checkedVersion?: string | null }
  /** 定稿回执（定成了的那次定稿记了多少账）：原样存，渲染侧防御解析。 */
  | { readonly type: "commit-report"; readonly report: unknown }
  /**
   * 核账（check_continuity）。dismissed＝作者点过「不是问题」的条目（continuityItemKey），对话卡和稿纸划线共用；
   * checkedVersion＝结果到时稿纸的版本号（核的是这一版），稿纸版本变了就是「核过后改过稿」。
   */
  | { readonly type: "continuity"; readonly check: ContinuityCheckData; readonly dismissed?: readonly string[]; readonly checkedVersion?: string | null }
  /** 内容审阅问题清单。checkedVersion＝审的是工作稿哪一版（审定稿时没有），和核账卡同一口径。 */
  | { readonly type: "draft-review"; readonly review: DraftReviewView; readonly checkedVersion?: string | null }
  /** 硬伤检查。 */
  | { readonly type: "quality"; readonly report: QualityCardReport; readonly checkedVersion?: string | null }
  /** 机器腔体检；fixedIds＝已点「改掉这句」改成功的几条。 */
  | { readonly type: "ai-flavor"; readonly report: AiFlavorReport; readonly fixedIds?: readonly string[]; readonly checkedVersion?: string | null }
  /** 一次操作（写作版本 P2a：对话里、按钮交上的检查）：在做到哪、停着为什么停、能点什么。做完的结果另挂一张卡。 */
  | { readonly type: "operation"; readonly op: OperationCardData }
  /** AI 提的「下一步」选项（suggest_next_steps）。 */
  | { readonly type: "next-steps"; readonly prompt: NextStepPrompt }
  /** 这一轮出错了（整条消息按错误卡渲染）；detail＝技术详情里的原始报错，reason＝服务端分的类（P11，老消息没有）。 */
  | { readonly type: "error"; readonly detail?: string; readonly reason?: AiErrorReason }
  /** 服务端状态说明（如历史窗口被裁剪）：照实显示，不进助手正文。 */
  | { readonly type: "status-notes"; readonly notes: readonly string[] }
  /** 想走法（plan.propose，写作版本 P2a；P6 起的头脑风暴）：几种走法；picked＝作者挑中的那种（序号），没挑缺省。 */
  | { readonly type: "directions"; readonly brainstorm: BrainstormCardData; readonly picked?: number }
  /** AI 一次写几版（写稿 candidates>1）时落选的几版全文：作者点开看、挑一版换进工作稿。 */
  | { readonly type: "draft-versions"; readonly versions: DraftVersionsCardData };

export type MessageCardType = MessageCard["type"];

/** 操作卡（服务端操作视图里给界面的那几样；中文说法都是服务端给的，界面不自己拼）。 */
export interface OperationCardData {
  readonly opId: string;
  readonly kind: string;
  readonly mode?: string;
  readonly chapter?: number;
  /** 做的什么（「核账·第 3 章」）。 */
  readonly what: string;
  readonly state: "queued" | "running" | "waiting_author" | "paused" | "succeeded" | "failed" | "cancelled" | "obsolete";
  /** 状态的中文说法（停着的带为什么停）。 */
  readonly stateText: string;
  /** 作者能点的。 */
  readonly allowed: readonly ("resume" | "cancel")[];
  /** 结论或没成的原因。 */
  readonly summary: string;
  /** 结束了的那一句（服务端拼好的，卡上照显示）；没结束是空串。 */
  readonly conclusion?: string;
  /** 在做的时候最新的一句进度（「核账员在读第 3 章」）；结束了清掉。 */
  readonly progress?: string;
  /** 记录到第几条事件（迟到的旧记录不盖新的）。 */
  readonly eventSeq: number;
  /** 结束时这一轮的话里已经说了结论（卡上不再重复）；后台做完、重开才收到的没有。 */
  readonly announced?: true;
  /** 停着等作者点的（改写的改前改后 +「换上 / 再改一版」）：只挂在最近交它、点它的那条消息上。 */
  readonly pending?: PendingActionData;
  /** 定论做完了：卡、作者划掉的、改没改（核账卡认哪几条被它改掉了；存进消息）。 */
  readonly canon?: CanonResultData;
}

/** 定论卡（canon.propose 的预览、结果）：只有原句和名字，没有编号。draft＝改的是还没定稿的工作稿。 */
export interface SettleCardData {
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

/** 「另外几版」卡：哪一章、落选的几版（index＝第几版，1 起）。 */
/** 「另外几版」卡（写作版本 P2a 片 2D）：几版都留成了候选，带候选号和指纹，点「用这版」交 draft.adopt 换上。 */
export interface DraftVersionsCardData {
  readonly chapter: number;
  /** 作者要自己挑的几版（一版都没换上）；没有 = 选优换上了一版，这是落选的几版。 */
  readonly pick?: true;
  readonly versions: readonly DraftVersionData[];
}

export interface DraftVersionData {
  /** 第几版（1 起）。 */
  readonly index: number;
  readonly candidateId: string;
  readonly sha: string;
  readonly title?: string;
  readonly body: string;
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

/** 定稿清单卡的数据（服务端 services/commit-view.ts 的 CommitPreviewView；防御解析见 utils/commitPreviewCard.ts）。 */
export interface CommitPreviewCardData {
  readonly chapter: number;
  readonly canCommit: boolean;
  /** 定不了的原因（引擎确定性判定：缺稿 / 硬伤 / 记账员没记成等）。非空时 canCommit 必为 false。 */
  readonly blockingReasons?: readonly string[];
  readonly summary?: string;
  /** 正文硬闸没过的地方（卡内默认折叠）。 */
  readonly draftIssues?: readonly string[];
  /** 记账员交了、但原句在正文里找不到或指向前文没有的东西，这次没记上的（带原因，人话）。 */
  readonly notRecorded?: readonly string[];
  /** 要如实告诉作者的提醒（记账员没读完前文、这章定稿过会换掉原来的账……）。 */
  readonly notes?: readonly string[];
  /** 只差字数下限：定稿窗口给「就这么短，照样定稿」。 */
  readonly shortOnly?: boolean;
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
  /** 查的哪章（老消息没有）：稿纸开着这章时，原句已不在稿里的算改掉了。 */
  readonly chapter?: number;
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
