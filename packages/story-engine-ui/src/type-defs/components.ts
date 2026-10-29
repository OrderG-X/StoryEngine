import type { CreateBookResult, DraftAIReviewReport, ImportBookRequest, StateOverview } from "../api/types.js";
import type { SuggestedAction, ThemeMode } from "./workflow.js";
import type { ChapterNavItem, ChapterMessage, ChapterWorkspaceData, LastFormalCommitApply, AiFlavorViolation, WorkspaceDraftCandidate } from "./workspace.js";
import type { CommitPreviewUiReport } from "./commit.js";
import type { SelectionRevisionKey } from "../components/v2/selectionRevisionTemplates.js";

export interface WritingWorkspaceLayoutProps {
  readonly projectPath?: string | null;
  readonly workspace: ChapterWorkspaceData;
  /** B5-2: 当前故事 overview（含伏笔/线索/章号），透传给 codex 资料面板。可能为 null（书未打开时）。 */
  readonly overview?: StateOverview | null;
  readonly themeMode: ThemeMode;
  readonly onSelectChapter?: (chapterId: string) => void;
  readonly onSelectSection?: (section: string) => void;
  readonly onSuggestedAction?: (action: SuggestedAction) => void;
  readonly onGoHome?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onToggleTheme?: () => void;
  readonly onSendMessage?: (message: string) => void;
  /** 「下一步」选项带结构化动作时（R4.7，服务端生成的确定性选项）：点击直接发 body.action，不经模型。 */
  readonly onSendUserAction?: (action: import("../api/agentChatClient.js").AgentUserAction) => void;
  /** 写作区固定按钮（重构 P4）：直接发对应的结构化动作，不经模型、不靠文案匹配。 */
  readonly onChapterButton?: (button: import("../utils/chapterButtons.js").ChapterButton) => void;
  /** M3：停止当前在跑的 agent 流（中止 SSE）；已写出的内容保留、不报错。chatLoading 时展示「停止」按钮调用。 */
  readonly onStopAgent?: () => void;
  /** 清空当前对话（不影响正文与资料）。聊天头部「清空」按钮调用。 */
  readonly onClearChat?: () => void;
  /** 撤销刚才的清空，恢复对话。清空后的空状态里「撤销」按钮调用。 */
  readonly onUndoClearChat?: () => void;
  /** 是否可撤销清空（刚清空且未继续对话时为 true）。 */
  readonly canUndoClearChat?: boolean;
  /** 块级「撤销到此」：把某个 AI 回合的 git 改动整块回退 + 截断对话 + 刷工作台（chatLoading 时禁用）。 */
  readonly onUndoToTurn?: (message: ChapterMessage) => void;
  readonly steeringDirection: string;
  readonly chatLoading?: boolean;
  readonly chatError?: string | null;
  readonly commitPreview?: CommitPreviewUiReport | null;
  readonly lastFormalCommitApply?: LastFormalCommitApply | null;
  readonly isCurrentChapterAlreadyFormallyCommitted?: boolean;
  readonly draftAIReview?: DraftAIReviewReport | null;
  /** AI 味卡「改掉这句」：交去 AI 味（只改这一句，直接改、可撤销）。messageId=这张卡所属的消息，改好了据它标「已改」。 */
  readonly onFixAiFlavorViolation?: (violation: AiFlavorViolation, messageId: string) => void;
  /** AI 味卡「一键全修」：卡上还没改的几句一次交去 AI 味（换前存档、可撤销）。 */
  readonly onFixAllAiFlavorViolations?: (violations: readonly AiFlavorViolation[], messageId: string) => void;
  /** 体检卡当前在改的违规（来自 store.aiFlavorPending）：命中某条消息时该卡那条显示「改写中…」。 */
  readonly aiFlavorPending?: { readonly messageId: string; readonly violationId: string } | null;
  /** 一键全修进行中的卡片 messageId（来自 store.aiFlavorBatchPending）：命中时该卡顶部按钮转「全修中…」。 */
  readonly aiFlavorBatchPending?: string | null;
  readonly onSteeringDirectionChange: (value: string) => void;
  readonly onDraftContentChange?: (content: string) => void;
  /** 选区浮动操作条（阶段三块②）：选中正文 + 模板键 → 交改写（对话里出改前改后，点「换上」才换、可撤销）。 */
  readonly onSelectionRewrite?: (selectionText: string, key: SelectionRevisionKey) => Promise<void>;
  /** 「✎ 自己说」：选中正文 + 作者自己的要求 → 同上。 */
  readonly onSelectionRewriteCustom?: (selectionText: string, instruction: string) => Promise<void>;
  /** 「AI 另写几版」（片 2D）：另写两版摆给作者挑，作者的稿子不动（进对话一轮）。 */
  readonly onReroll?: () => void;
  /** 并排面板上点「用这版」：交 draft.adopt 换进工作稿（进对话一轮，先存档、可撤销）。 */
  readonly onApplyCandidate?: (candidate: WorkspaceDraftCandidate) => void;
  readonly onCloseCandidates?: () => void;
  /** 稿纸提示条上 AI 写好、没换上的那份：换上 / 不要了（进对话一轮）。 */
  readonly onPendingCandidate?: (decision: "adopt" | "discard") => Promise<import("../drafts/draftSync.js").PaperDecisionResult>;
}

export interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly currentChapterTitle: string;
  readonly currentChapterNumber: number;
  readonly protagonistName: string;
  readonly status: "草稿中" | "待确认" | "可继续下一章";
  readonly updatedAt: string;
  /** 最近活跃时间（ms）。书架排序真值：扫描来自服务端 lastActiveMs，本地打开/新建/改名时=Date.now()。缺失（老数据）当 0。 */
  readonly lastActiveMs?: number;
  readonly logline: string;
  readonly writtenChapters: number;
  readonly totalWords: number;
  readonly projectPath: string;
}

export type CreateBookDraft = CreateBookResult;

export interface HomePageProps {
  readonly recentBooks: readonly BookSummary[];
  readonly onChooseFolder: () => void;
  readonly onCreateBook: (draft: CreateBookDraft) => void;
  /** 导入已写的书（P8）：建书、开书；失败抛错（弹窗留着显示原因）。 */
  readonly onImportBook: (input: ImportBookRequest) => Promise<void>;
  readonly onOpenSettings: () => void;
  readonly openProjectError?: string | null;
  readonly openProjectLoading?: boolean;
  readonly onOpenProject: (projectPath: string) => void | Promise<boolean | void>;
  readonly onOpenRecentBook: (bookId: string) => void;
  readonly onRenameRecentBook: (bookId: string, nextTitle: string) => Promise<string>;
  readonly onRemoveRecentBook: (bookId: string) => Promise<string>;
  readonly onDeleteRecentBook: (bookId: string) => Promise<string>;
  readonly onOpenRecentBookFolder: (bookId: string) => Promise<string>;
}

export interface OpenBookDialogProps {
  readonly open: boolean;
  readonly recentBooks: readonly BookSummary[];
  readonly error?: string | null;
  readonly loading?: boolean;
  readonly onChooseFolder: () => void;
  readonly onCancel: () => void;
  readonly onOpenProject: (projectPath: string) => void | Promise<boolean | void>;
}

export interface ModelSettingsDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  /** 整页内嵌模式（写作台左侧入口）：无遮罩弹层，直接铺满主区域。 */
  readonly embedded?: boolean;
}
