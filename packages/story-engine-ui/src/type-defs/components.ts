import type { ChapterAdviceCard, ChapterSteeringDraft, CreateBookResult, DraftAIReviewIssue, DraftAIReviewReport, DraftAIRevisionSuggestion, DraftRevisionPreview, DraftRevisionTask, ModelSettingsLoadResult, StateOverview, StateOverviewCharacterMatrix } from "../api/types.js";
import type { DevApiPermission, SuggestedAction, ThemeMode } from "./workflow.js";
import type { ChapterNavItem, ChapterMessage, ProtagonistStatus, LocationStatus, TimeStatus, KnowledgeBoundary, AssetSummary, StoryMemory, RiskWarning, ChapterWorkspaceData, LastFormalCommitApply, SidebarData, AiFlavorViolation } from "./workspace.js";
import type { CommitPreviewUiReport } from "./commit.js";
import type { SelectionRevisionKey } from "../components/v2/selectionRevisionTemplates.js";

export interface WritingWorkspaceLayoutProps {
  readonly projectPath?: string | null;
  readonly workspace: ChapterWorkspaceData;
  /** B5-2: 当前故事 overview（含伏笔/线索/章号），透传给 codex 资料面板。可能为 null（书未打开时）。 */
  readonly overview?: StateOverview | null;
  readonly sidebar: SidebarData;
  readonly themeMode: ThemeMode;
  readonly selectedAdviceCardKeys?: readonly string[];
  readonly onSelectChapter?: (chapterId: string) => void;
  readonly onSelectSection?: (section: string) => void;
  readonly onSelectAdviceCard?: (key: string, card: ChapterAdviceCard) => void;
  readonly onSuggestedAction?: (action: SuggestedAction) => void;
  readonly onGoHome?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenUsage?: () => void;
  readonly onToggleTheme?: () => void;
  readonly onSendMessage?: (message: string) => void;
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
  readonly steeringDraft?: ChapterSteeringDraft | null;
  readonly steeringError?: string | null;
  readonly steeringLoading?: boolean;
  readonly chatLoading?: boolean;
  readonly chatError?: string | null;
  readonly draftActionLoading?: string | null;
  readonly commitPreview?: CommitPreviewUiReport | null;
  readonly lastFormalCommitApply?: LastFormalCommitApply | null;
  readonly isCurrentChapterAlreadyFormallyCommitted?: boolean;
  readonly draftAIReview?: DraftAIReviewReport | null;
  /** 体检卡「改掉这句」：复用选区改写链路（key=deai + suggestedFix）→ 弹改写预览、可撤销。
   *  messageId=这张卡所属的消息，用于改写应用成功后把该违规标「已改」。 */
  readonly onFixAiFlavorViolation?: (violation: AiFlavorViolation, messageId: string) => void;
  /** 体检卡「一键全修」：把还没改的违规一次批量去 AI 味（走 de-ai-flavor 端点·倒序落盘·整批可撤销）。 */
  readonly onFixAllAiFlavorViolations?: (violations: readonly AiFlavorViolation[], messageId: string) => void;
  /** 体检卡当前在改的违规（来自 store.aiFlavorPending）：命中某条消息时该卡那条显示「改写中…」。 */
  readonly aiFlavorPending?: { readonly messageId: string; readonly violationId: string } | null;
  /** 一键全修进行中的卡片 messageId（来自 store.aiFlavorBatchPending）：命中时该卡顶部按钮转「全修中…」。 */
  readonly aiFlavorBatchPending?: string | null;
  readonly activeRevisionTask?: DraftRevisionTask | null;
  readonly activeRevisionPreview?: DraftRevisionPreview | null;
  readonly onSteeringDirectionChange: (value: string) => void;
  readonly onGenerateSteering: () => void;
  readonly onRepairDraft?: () => void;
  readonly onDraftAIReview?: () => void;
  readonly onCreateRevisionTask?: (source: { readonly issue?: DraftAIReviewIssue; readonly suggestion?: DraftAIRevisionSuggestion }) => void;
  readonly onGenerateRevisionPreview?: () => void;
  readonly onApplyRevisionPreview?: () => void;
  readonly onDismissRevisionTask?: () => void;
  readonly onRegenerateDraft?: () => void;
  readonly onDraftContentChange?: (content: string) => void;
  /** 选区浮动操作条（阶段三块②）：选中正文 + 模板键 → 复用 draft-revision 改写选中段、可撤销。 */
  readonly onSelectionRewrite?: (selectionText: string, key: SelectionRevisionKey) => Promise<void>;
  /** 「✎ 自己说」：选中正文 + 用户自定义改写要求 → 走 custom 模板改写选中段、可撤销。 */
  readonly onSelectionRewriteCustom?: (selectionText: string, instruction: string) => Promise<void>;
  /** 抽卡（阶段三块③）：再来一版生成 2–3 个临时候选并排选。 */
  readonly onReroll?: () => void;
  readonly onApplyCandidate?: (content: string) => void;
  readonly onCloseCandidates?: () => void;
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

export interface ChapterSidebarProps {
  readonly chapters: readonly ChapterNavItem[];
  readonly sidebar: SidebarData;
  readonly activeChapterId: string;
  readonly onSelectChapter?: (chapterId: string) => void;
  readonly onSelectSection?: (section: string) => void;
  readonly onGoHome?: () => void;
}

export interface ModelSettingsDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  /** 整页内嵌模式（写作台左侧入口）：无遮罩弹层，直接铺满主区域。 */
  readonly embedded?: boolean;
}
