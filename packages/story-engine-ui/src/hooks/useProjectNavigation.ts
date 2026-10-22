import {
  createStoryProjectFromDraft,
  fetchStateOverview,
  importBookProject,
} from "../api/client.js";
import { fetchChapterPaper, type ChapterPaper } from "../api/workingDraftClient.js";
import { listChatSessions, readChatSession } from "../api/chatSessionsClient.js";
import type { ImportBookRequest, StateOverview } from "../api/types.js";
import { workspaceFromStateOverview } from "../api/stateOverviewAdapter.js";
import { bookSummaryFromOverview, isRealProjectBook } from "../utils/bookUtils.js";
import { pushHomeUrl, pushWorkspaceUrlForBook, pushWorkspaceUrlForProject } from "../utils/routing.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { emptyCommitSelections, useUiStore } from "../stores/uiStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useRecentBooksStore } from "../stores/recentBooksStore.js";
import { bookCreationPromptText, bookImportPromptText } from "../utils/bookCreationPrompt.js";
import { isFreshBook } from "../utils/isFreshBook.js";
import { flushAllSaves } from "../sync/saveAll.js";
import { markChatLoaded } from "../sync/chatSync.js";
import { flowStatusForPaper } from "../workspace/applyOverview.js";
import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceOperationTargetCurrent,
  type WorkspaceOperationToken,
} from "../utils/workspaceOperation.js";
import type {
  BookSummary,
  ChapterMessage,
  ChapterNavItem,
  ChapterWorkspaceData,
  ChapterWorkflowState,
} from "../types.js";

/* ------------------------------------------------------------------ */
/*  Parameters & return type                                           */
/* ------------------------------------------------------------------ */

export interface UseProjectNavigationParams {
  readonly bookManagement: {
    readonly upsertRecentBook: (book: BookSummary) => void;
  };
  readonly countTextWords: (text: string) => number;
}

export interface UseProjectNavigationReturn {
  /**
   * onBusy:"silent"（长跑 #1）：忙碌守卫撞上时不弹「已有操作正在进行」toast、静默放弃本次导航。
   * 只给 App 启动/路由回放用——StrictMode 会在挂载时同步双跑初始路由 effect，第一次 openHome 还
   * await 在 flushAllSaves 里没走完 finally，第二次就撞上单槽忙碌守卫误弹 toast（首页加载即弹的根源）。
   * 用户点击导航（onGoHome 等）保持默认 "toast"，忙碌仍要如实告知。
   */
  readonly openProject: (
    nextProjectPath: string,
    options?: { readonly updateUrl?: boolean; readonly onBusy?: "toast" | "silent" },
  ) => Promise<boolean>;
  readonly openRecentBook: (
    bookId: string,
    options?: { readonly updateUrl?: boolean; readonly onBusy?: "toast" | "silent" },
  ) => Promise<boolean>;
  readonly openHome: (
    options?: { readonly updateUrl?: boolean; readonly onBusy?: "toast" | "silent" },
  ) => Promise<boolean>;
  readonly openChapterWorkspace: (chapter: ChapterNavItem) => Promise<void>;
  readonly handleSelectChapter: (chapterId: string) => void;
  readonly handleContinueNextChapter: () => Promise<void>;
  readonly handleCreateBook: (draft: Parameters<typeof createStoryProjectFromDraft>[0]["draft"]) => Promise<void>;
  readonly handleImportBook: (request: ImportBookRequest) => Promise<void>;
  readonly refreshWorkspaceFromOverview: (overview: StateOverview) => void;
}

/* ------------------------------------------------------------------ */
/*  Helper functions (extracted from App.tsx)                          */
/* ------------------------------------------------------------------ */

function updateChapterListTitle(chapters: readonly ChapterNavItem[], chapterNumber: number, title: string): readonly ChapterNavItem[] {
  return chapters.map((chapter) => (
    chapter.chapterNumber === chapterNumber ? { ...chapter, title } : chapter
  ));
}

type ChapterFileState = Pick<ChapterNavItem, "hasDraftFile" | "hasCommittedChapter" | "editedSinceCommit">;

function updateChapterListForActive(
  chapters: readonly ChapterNavItem[],
  activeChapterNumber: number,
  activeTitle: string,
  fileStates: ReadonlyMap<number, ChapterFileState> = new Map(),
): readonly ChapterNavItem[] {
  const byNumber = new Map<number, ChapterNavItem>();
  for (const chapter of chapters) {
    byNumber.set(chapter.chapterNumber, chapter);
  }
  if (!byNumber.has(activeChapterNumber)) {
    byNumber.set(activeChapterNumber, {
      id: `ch-${activeChapterNumber}`,
      chapterNumber: activeChapterNumber,
      title: activeTitle,
      status: "current",
    });
  }

  return [...byNumber.values()]
    .map((chapter) => ({
      ...chapter,
      ...fileStates.get(chapter.chapterNumber),
      title: chapter.chapterNumber === activeChapterNumber ? activeTitle : chapter.title,
      status: resolveChapterNavStatus(chapter, activeChapterNumber, fileStates.get(chapter.chapterNumber)),
    }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function resolveChapterNavStatus(
  chapter: ChapterNavItem,
  activeChapterNumber: number,
  fileState: ChapterFileState | undefined,
): ChapterNavItem["status"] {
  if (chapter.chapterNumber === activeChapterNumber) return "current";
  if (fileState?.hasCommittedChapter === true || chapter.hasCommittedChapter === true) return "committed";
  if (fileState?.hasDraftFile === true || chapter.hasDraftFile === true) return "draft";
  if (chapter.status === "current") return "draft";
  return chapter.status;
}

function fileStateFromPaper(paper: ChapterPaper): ChapterFileState {
  return {
    hasDraftFile: paper.draft !== null,
    hasCommittedChapter: paper.committed !== null,
    editedSinceCommit: paper.editedSinceCommit === true,
  };
}

function resolveInitialChapterNumber(chapters: readonly ChapterNavItem[], fallbackChapterNumber: number): number {
  return maxChapterNumber(chapters.filter((chapter) => chapter.hasDraftFile === true))
    ?? maxChapterNumber(chapters.filter((chapter) => chapter.hasCommittedChapter === true))
    ?? fallbackChapterNumber;
}

function maxChapterNumber(chapters: readonly ChapterNavItem[]): number | undefined {
  if (chapters.length === 0) return undefined;
  return Math.max(...chapters.map((chapter) => chapter.chapterNumber));
}

function workingDraftChainState(chapters: readonly ChapterNavItem[], activeChapterNumber: number): Pick<ChapterWorkspaceData, "hasUncommittedDrafts" | "workingDraftChain" | "previousUncommittedDraftContext" | "latestUncommittedDraftChapter"> {
  const uncommittedDraftChapters = chapters
    .filter((chapter) => chapter.hasDraftFile === true && chapter.hasCommittedChapter !== true)
    .map((chapter) => chapter.chapterNumber);
  const latestUncommittedDraftChapter = uncommittedDraftChapters.length > 0 ? Math.max(...uncommittedDraftChapters) : undefined;
  return {
    hasUncommittedDrafts: uncommittedDraftChapters.length > 0,
    workingDraftChain: uncommittedDraftChapters.length > 0,
    previousUncommittedDraftContext: uncommittedDraftChapters.includes(activeChapterNumber - 1),
    ...(latestUncommittedDraftChapter !== undefined ? { latestUncommittedDraftChapter } : {}),
  };
}

function workspaceFromBook(book: BookSummary) {
  const chapterWindow = Array.from({ length: 5 }, (_, index) => {
    const chapterNumber = Math.max(1, book.currentChapterNumber - 2) + index;
    return {
      id: `${book.id}-ch-${chapterNumber}`,
      chapterNumber,
      title: chapterNumber === book.currentChapterNumber ? book.currentChapterTitle : `第${chapterNumber}章`,
      status: chapterNumber < book.currentChapterNumber
        ? "committed" as const
        : chapterNumber === book.currentChapterNumber
          ? "current" as const
          : "planned" as const,
    };
  });
  const currentChapter = chapterWindow.find((chapter) => chapter.chapterNumber === book.currentChapterNumber) ?? chapterWindow[0] ?? {
    id: "ch-1",
    chapterNumber: 1,
    title: "第1章",
    status: "current" as const,
  };
  const flowStatus: ChapterWorkflowState = book.status === "待确认"
    ? "waiting_commit_confirmation"
    : book.status === "可继续下一章"
      ? "ready_for_next"
      : "idle";

  return {
    projectName: book.title,
    currentChapter,
    chapters: chapterWindow,
    flowStatus,
    messages: [
      {
        id: `${book.id}-system`,
        kind: "scaffolding" as const,
        role: "assistant" as const,
        content: `已进入《${book.title}》的章节工作台。当前章节：第${book.currentChapterNumber}章 · ${book.currentChapterTitle}。`,
      },
    ],
  };
}

/** 开书开场白消息的 id 前缀——reopen 时据此识别它，跳过章节 idle 追加（守住开书语气）。 */
const BOOK_CREATION_GREETING_ID_PREFIX = "assistant-book-creation-";

/** 构造一条开书语气开场白 assistant 消息（新建空书 / 再入空书共用，id 带可识别前缀）。 */
function bookCreationGreetingMessage(): ChapterMessage {
  return {
    id: `${BOOK_CREATION_GREETING_ID_PREFIX}${Date.now()}`,
    role: "assistant",
    content: bookCreationPromptText(),
  };
}

/** 导入已写的书后的开场白（P8）：说清记账员在后台从头记账、记完才能核账定稿。重开书时当脚手架滤掉（进度行还在）。 */
function bookImportGreetingMessage(chapters: number): ChapterMessage {
  return {
    id: `assistant-book-import-${Date.now()}`,
    role: "assistant",
    kind: "scaffolding",
    content: bookImportPromptText(chapters),
  };
}

/** 这组消息是否就是单条开书开场白（空书开书时注入）。 */
export function isBookCreationGreeting(messages: readonly ChapterMessage[]): boolean {
  return messages.length === 1 && (messages[0]?.id?.startsWith(BOOK_CREATION_GREETING_ID_PREFIX) ?? false);
}

/**
 * 一条消息是否为「注入的脚手架」——开场白 / 流程招呼 / 系统提示这类非真实对话的填充。
 * 进入工作台时这些一律不展示（用户 2026-06-16 反馈：多余、又吓人）。判据从严，绝不误删真实交互：
 * 带卡片 / 工具步骤 / 建议卡的消息一定是真实产物，先放行。
 */
function isInjectedEntryScaffolding(message: ChapterMessage): boolean {
  if ((message.agentCards?.length ?? 0) > 0
    || (message.toolSteps?.length ?? 0) > 0
    || (message.cards?.length ?? 0) > 0) {
    return false;
  }
  // 系统提示（「已将误入聊天区的正文移回左侧草稿区」等）全是注入通知，非用户/AI 对话。
  if (message.role === "system") return true;
  const id = message.id ?? "";
  // 注入的流程 idle 招呼（assistant-workflow-*）/ 开书开场白（assistant-book-creation-*）。
  if (id.startsWith("assistant-workflow-") || id.startsWith("assistant-book-creation-")) return true;
  // 工作区 / 章节进入开场白：按消息自带的 kind 认（重构 P4），不按文案。
  return message.kind === "scaffolding";
}

/**
 * 进入工作台（开书 / 换章 / 再入）时要展示的对话：滤掉所有注入脚手架，只留真实对话（用户发言 + AI 真实回复）；
 * 没有真实对话就返回空，由空状态提示「可直接描述下一章方向」接管。
 *
 * 为什么这么改（用户 2026-06-16 反馈）：开书「先跟 AI 聊天」的流程已下线，现在输入书名直接进工作台，
 * 那些「已进入第 N 章工作区 / 我已读取当前故事状态 / 已将误入正文移回」之类填充纯属多余、又吓人。
 * 工作流程进行中的实时提示（草稿已生成、入库预览…）由 agent 产出、带卡片/步骤，不在脚手架之列、照常显示。
 */
function entryChatMessages(messages: readonly ChapterMessage[]): readonly ChapterMessage[] {
  return messages.filter((message) => !isInjectedEntryScaffolding(message));
}

/**
 * 开书时后端没读到会话历史（backendSessionLoaded=false）该用哪组消息。
 * 修「同名删后重建 / 新书串台」bug：书目录名按书名确定性生成（toSafeId），同名删后重建会拿到一模一样的
 * projectPath，内存里上一本书残留的消息会被误当成本书历史端出来。判据：
 * - 刚建的新书（isFreshBook）：它后端必然没有任何会话历史，内存消息必是上一本残留 → 一律用开书开场白，绝不沿用内存消息。
 * - 非新书但本次没读到会话：只有重开同一项目才可回退内存；切到另一项目时内存属于旧书，必须清空。
 */
function messagesWhenBackendSessionMissing(params: {
  readonly overview: StateOverview | undefined;
  readonly storeMessages: readonly ChapterMessage[];
  readonly allowStoreFallback: boolean;
}): readonly ChapterMessage[] {
  if (params.overview && isFreshBook(params.overview)) return [bookCreationGreetingMessage()];
  return params.allowStoreFallback ? params.storeMessages : [];
}

/**
 * 资料刷新（refreshScope:"foundation"，foundation_write 触发）的 workspace 合并：
 * 用 overview 派生的 base 刷资料/侧栏相关字段，但**保留**用户当前停留章 currentChapter/chapters
 * 与流程态 flowStatus（正文在 draftStore、对话在 chatStore，都不经这里）。
 *
 * H4：历史上这里直接铺开 base（含 overview 最新章的 currentChapter/chapters），用户在第2章顺手记资料
 * 会被顶部跳到最新章、草稿仍停第2章，界面对不上。
 */
export function mergeFoundationRefreshWorkspace(
  nextBase: ChapterWorkspaceData,
  current: ChapterWorkspaceData,
): ChapterWorkspaceData {
  return {
    ...nextBase,
    currentChapter: current.currentChapter,
    chapters: current.chapters,
    flowStatus: current.flowStatus,
  };
}

export const __useProjectNavigationTest = {
  messagesWhenBackendSessionMissing,
  entryChatMessages,
  isBookCreationGreeting,
  resolveInitialChapterNumber,
  workingDraftChainState,
  updateChapterListForActive,
  resolveChapterNavStatus,
  mergeFoundationRefreshWorkspace,
};

/* ------------------------------------------------------------------ */
/*  Main hook                                                          */
/* ------------------------------------------------------------------ */

export function useProjectNavigation(params: UseProjectNavigationParams): UseProjectNavigationReturn {
  const { bookManagement, countTextWords } = params;

  /* ---- navigation store ---- */
  const {
    setWorkspaceReady,
    setProjectPath,
    setActiveBookId,
    setOpenProjectError,
    setOpenProjectLoading,
    showToast,
  } = useNavigationStore();

  /* ---- 书 / 对话 / 界面临时态（重构 P5：拆成三块；setter 是稳定函数，直接取） ---- */
  const workspace = useBookStore((s) => s.workspace);
  const { setWorkspace, setCurrentOverview } = useBookStore.getState();
  const { setMessages, setChatError, setSessions, setActiveArchivedCount, setChatHistoryBudget } = useChatStore.getState();
  const {
    setSteeringDirection,
    setLastChapterDirection,
    setCommitPreviewReport,
    setDraftAIReview,
    setActiveRevisionTask,
    setActiveRevisionPreview,
    setCommitSelections,
    resetTransientUiState,
  } = useUiStore.getState();

  const currentNavigationIdentity = () => {
    const liveBook = useBookStore.getState();
    const liveChat = useChatStore.getState();
    return {
      projectPath: useNavigationStore.getState().projectPath ?? "",
      chapter: liveBook.workspace.currentChapter.chapterNumber,
      sessionId: liveChat.activeSessionId,
    };
  };

  const beginNavigationTransition = (
    action: string,
    onBusy: "toast" | "silent" = "toast",
  ): WorkspaceOperationToken | null => {
    const token = beginWorkspaceOperation("navigation-transition", currentNavigationIdentity());
    if (!token && onBusy === "toast") showToast(`已有操作正在进行，暂不能${action}。`, 4600);
    return token;
  };

  const ownsNavigationOrigin = (token: WorkspaceOperationToken): boolean =>
    isWorkspaceOperationTargetCurrent(token, currentNavigationIdentity());

  /* ---- recent books store (for openRecentBook lookup) ---- */
  const recentBooks = useRecentBooksStore((s) => s.books);

  /* ================================================================ */
  /*  openProject                                                     */
  /* ================================================================ */
  const openProject = async (
    nextProjectPath: string,
    options: { readonly updateUrl?: boolean; readonly onBusy?: "toast" | "silent" } = {},
  ): Promise<boolean> => {
    const transition = beginNavigationTransition("切换书籍", options.onBusy);
    if (!transition) return false;
    try {
      // 旧书必须真正存完才能换。失败就留在原地，不能假装已经保存。
      const flushed = await flushAllSaves();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前书籍：${flushed.error}`, 5200);
        return false;
      }
      setOpenProjectLoading(true);
      setOpenProjectError(null);
      const overview = await fetchStateOverview({ projectPath: nextProjectPath, maxTimelineEvents: 8 });
      if (!ownsNavigationOrigin(transition)) return false;
      const nextWorkspace = workspaceFromStateOverview(overview);
      const baseChapterNumber = nextWorkspace.currentChapter.chapterNumber;
      // 打开哪一章从盘上算：最新有工作稿的那章 → 最新定稿章 → 引擎当前章（重构 P5，不再读按章存的 JSON 去猜）。
      const activeChapterNumber = resolveInitialChapterNumber(nextWorkspace.chapters, baseChapterNumber);
      const paper = await fetchChapterPaper(nextProjectPath, activeChapterNumber);
      if (!ownsNavigationOrigin(transition)) return false;
      const fileStates = new Map<number, ChapterFileState>([[activeChapterNumber, fileStateFromPaper(paper)]]);
      const activeChapter = nextWorkspace.chapters.find((chapter) => chapter.chapterNumber === activeChapterNumber) ?? {
        id: `ch-${activeChapterNumber}`,
        chapterNumber: activeChapterNumber,
        title: `第${activeChapterNumber}章`,
        status: "current" as const,
      };
      const book = bookSummaryFromOverview(overview, nextProjectPath);
      const storeMessages = useChatStore.getState().messages;
      // 对话只有一份：项目里的会话文件（重构 P5）。
      const sessionIndex = await listChatSessions(nextProjectPath).catch(() => null);
      if (!ownsNavigationOrigin(transition)) return false;
      let backendSessionMessages: readonly ChapterMessage[] = [];
      let activeArchivedCount = 0;
      let backendSessionLoaded = false;
      let sessionReadFailed = false;
      if (sessionIndex?.index) {
        const activeSessionId = sessionIndex.index.activeSessionId;
        const active = await readChatSession(nextProjectPath, activeSessionId).catch((error) => {
          console.warn("[openProject] 读取会话历史失败", { activeSessionId, error });
          sessionReadFailed = true;
          return null;
        });
        if (!ownsNavigationOrigin(transition)) return false;
        if (active?.session && active.session.messages.length > 0) {
          backendSessionMessages = active.session.messages;
          activeArchivedCount = active.session.archivedCount ?? 0;
          backendSessionLoaded = true;
        }
      } else {
        sessionReadFailed = true;
      }
      // 没读到后端会话历史时，绝不把内存里上一本书的残留消息当成本书历史（见 messagesWhenBackendSessionMissing）。
      if (!backendSessionLoaded) {
        backendSessionMessages = messagesWhenBackendSessionMissing({
          overview,
          storeMessages,
          allowStoreFallback: nextProjectPath === transition.projectPath,
        });
        if (sessionReadFailed) {
          // 绝不静默：读失败要让用户看得见。
          showToast("聊天记录从服务器读取失败；重新打开本书可重试。", 5200);
        }
      }
      const draftTitle = paper.draft?.title ?? paper.committed?.title ?? activeChapter.title;
      const paperState = { body: paper.draft?.body ?? paper.committed?.body ?? "", committed: paper.committed };
      const paperFlow = flowStatusForPaper(paperState);
      // 盘上这一章什么都没有：用引擎推的流程态（如「可以写下一章」）；有稿有定稿就按稿纸算。
      const flowStatus: ChapterWorkflowState = paperFlow === "idle" && activeChapterNumber === baseChapterNumber ? nextWorkspace.flowStatus : paperFlow;
      const chapters = updateChapterListForActive(
        activeChapterNumber === baseChapterNumber ? updateChapterListTitle(nextWorkspace.chapters, activeChapterNumber, draftTitle) : nextWorkspace.chapters,
        activeChapterNumber,
        draftTitle,
        fileStates,
      );
      const entryMessages = entryChatMessages(backendSessionMessages);
      // 所有异步读取完成、来源身份没变：同一个同步回合里换上新书的项目 / 会话 / 工作区 / 稿纸。
      resetTransientUiState();
      setActiveBookId(null);
      setProjectPath(nextProjectPath);
      setCurrentOverview(overview);
      if (sessionIndex?.index) {
        setSessions(sessionIndex.index.sessions, sessionIndex.index.activeSessionId);
        if (sessionIndex.chatHistoryBudgetTokens) setChatHistoryBudget(sessionIndex.chatHistoryBudgetTokens);
        if (backendSessionLoaded) markChatLoaded(nextProjectPath, sessionIndex.index.activeSessionId, entryMessages);
      } else {
        // 后端会话不可用时也必须清掉上一本书的 index/active id，避免后续保存写回旧会话。
        setSessions([], "");
      }
      setActiveArchivedCount(activeArchivedCount);
      setWorkspace({
        ...nextWorkspace,
        ...workingDraftChainState(chapters, activeChapterNumber),
        flowStatus,
        currentChapter: {
          ...activeChapter,
          title: draftTitle,
          status: "current",
          ...fileStates.get(activeChapterNumber),
        },
        chapters,
      });
      setMessages(entryMessages);
      useDraftStore.getState().loadPaper(nextProjectPath, paper);
      bookManagement.upsertRecentBook(book);
      setSteeringDirection("");
      useUiStore.getState().clearComposerDrafts();
      setLastChapterDirection("");
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      setWorkspaceReady(true);
      if (options.updateUrl !== false) {
        pushWorkspaceUrlForProject(nextProjectPath);
      }
      return true;
    } catch (error) {
      if (ownsNavigationOrigin(transition)) {
        const raw = error instanceof Error ? error.message : String(error);
        setOpenProjectError(`打开项目失败：${raw}`);
        // 从书架点开失败时，弹窗里的错误看不见——必须当场说清楚，不能点了没反应（铁律④ 不静默失败）。
        showToast(describeOpenProjectFailure(raw, nextProjectPath, recentBooks), 6500);
      }
      return false;
    } finally {
      setOpenProjectLoading(false);
      finishWorkspaceOperation(transition);
    }
  };

  /* ================================================================ */
  /*  openRecentBook                                                  */
  /* ================================================================ */
  const openRecentBook = async (
    bookId: string,
    options: { readonly updateUrl?: boolean; readonly onBusy?: "toast" | "silent" } = {},
  ): Promise<boolean> => {
    const book = recentBooks.find((item) => item.id === bookId);
    if (!book) return false;

    if (isRealProjectBook(book)) {
      return openProject(book.projectPath, options);
    }

    const transition = beginNavigationTransition("切换书籍", options.onBusy);
    if (!transition) return false;

    try {
      const flushed = await flushAllSaves();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前书籍：${flushed.error}`, 5200);
        return false;
      }
      setActiveBookId(book.id);
      setProjectPath(null);
      useDraftStore.getState().reset();
      setCurrentOverview(null);
      setOpenProjectError(null);
      setSteeringDirection("");
      useUiStore.getState().clearComposerDrafts();
      setLastChapterDirection("");
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      resetTransientUiState();
      setSessions([], "");
      setActiveArchivedCount(0);
      {
        const bookWorkspace = workspaceFromBook(book);
        setWorkspace({ ...workspace, ...bookWorkspace });
        setMessages([]);
      }
      setWorkspaceReady(true);
      if (options.updateUrl !== false) pushWorkspaceUrlForBook(book.id);
      return true;
    } finally {
      finishWorkspaceOperation(transition);
    }
  };

  /* ================================================================ */
  /*  openHome                                                        */
  /* ================================================================ */
  const openHome = async (
    options: { readonly updateUrl?: boolean; readonly onBusy?: "toast" | "silent" } = {},
  ): Promise<boolean> => {
    const transition = beginNavigationTransition("返回首页", options.onBusy);
    if (!transition) return false;
    try {
      const flushed = await flushAllSaves();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前工作区：${flushed.error}`, 5200);
        return false;
      }
      setWorkspaceReady(false);
      setActiveBookId(null);
      setProjectPath(null);
      useDraftStore.getState().reset();
      setCurrentOverview(null);
      setOpenProjectError(null);
      setSteeringDirection("");
      useUiStore.getState().clearComposerDrafts();
      setLastChapterDirection("");
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      setSessions([], "");
      setActiveArchivedCount(0);
      if (options.updateUrl !== false) pushHomeUrl();
      return true;
    } finally {
      finishWorkspaceOperation(transition);
    }
  };

  /* ================================================================ */
  /*  openChapterWorkspace                                            */
  /* ================================================================ */
  const openChapterWorkspace = async (chapter: ChapterNavItem): Promise<void> => {
    const transition = beginNavigationTransition("切换章节");
    if (!transition) return;
    // 换章前先把手上那章没存的字存掉（存不上就留在原地）。
    try {
      const flushed = await flushAllSaves();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前章节：${flushed.error}`, 5200);
        return;
      }
      const currentProjectPath = transition.projectPath || null;
      const paper: ChapterPaper | null = currentProjectPath ? await fetchChapterPaper(currentProjectPath, chapter.chapterNumber) : null;
      if (!ownsNavigationOrigin(transition)) return;
      const outgoingChapter = useBookStore.getState().workspace.currentChapter?.chapterNumber ?? null;
      const draftTitle = paper?.draft?.title ?? paper?.committed?.title ?? chapter.title;
      const flowStatus: ChapterWorkflowState = paper
        ? flowStatusForPaper({ body: paper.draft?.body ?? paper.committed?.body ?? "", committed: paper.committed })
        : "idle";
      {
        const current = useBookStore.getState().workspace;
        const fileStates = new Map<number, ChapterFileState>();
        if (paper) fileStates.set(chapter.chapterNumber, fileStateFromPaper(paper));
        const chapters = updateChapterListForActive(current.chapters, chapter.chapterNumber, draftTitle, fileStates);
        setWorkspace({
          ...current,
          ...workingDraftChainState(chapters, chapter.chapterNumber),
          currentChapter: {
            ...chapter,
            title: draftTitle,
            status: "current",
            ...fileStates.get(chapter.chapterNumber),
          },
          chapters,
          flowStatus,
        });
      }
      if (currentProjectPath && paper) useDraftStore.getState().loadPaper(currentProjectPath, paper);
      // 输入框里没发的字按章存着：切走不丢，切回来还在；不会把这章的话带到别的章（P11）。
      useUiStore.getState().switchComposerChapter(outgoingChapter, chapter.chapterNumber);
      setLastChapterDirection("");
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      setCommitSelections(emptyCommitSelections());
    } catch (error) {
      if (ownsNavigationOrigin(transition)) {
        setOpenProjectError(`打开章节失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      finishWorkspaceOperation(transition);
    }
  };

  /* ================================================================ */
  /*  handleSelectChapter                                             */
  /* ================================================================ */
  const handleSelectChapter = (chapterId: string) => {
    const chapter = workspace.chapters.find((item) => item.id === chapterId);
    if (!chapter) return;
    void openChapterWorkspace(chapter);
  };

  /* ================================================================ */
  /*  handleContinueNextChapter                                       */
  /* ================================================================ */
  const handleContinueNextChapter = async (): Promise<void> => {
    const nextChapterNumber = workspace.currentChapter.chapterNumber + 1;
    const existing = workspace.chapters.find((chapter) => chapter.chapterNumber === nextChapterNumber);
    await openChapterWorkspace(existing ? {
      ...existing,
      title: existing.title === "下一章" ? `第${nextChapterNumber}章` : existing.title,
    } : {
      id: `ch-${nextChapterNumber}`,
      chapterNumber: nextChapterNumber,
      title: `第${nextChapterNumber}章`,
      status: "planned",
    });
  };

  /* ================================================================ */
  /*  handleCreateBook / handleImportBook                             */
  /* ================================================================ */
  /**
   * 建一本新书并开进写作台（「新建一本书」「导入已写的书」共用）：手上的书先存好 → create() 建书 → 会话接线 → 同步换上新书。
   * 失败：新建的弹 toast；导入的抛出去（导入弹窗留着、显示原因）。
   */
  const openNewBook = async (input: {
    readonly operation: string;
    readonly title: string;
    readonly create: () => Promise<{ readonly projectDir: string; readonly overview: StateOverview }>;
    readonly greeting: () => ChapterMessage;
    readonly verb: string;
    readonly rethrow: boolean;
  }): Promise<void> => {
    const transition = beginNavigationTransition(input.operation);
    if (!transition) {
      if (input.rethrow) throw new Error("正在打开别的书，稍等一下再试。");
      return;
    }
    const switched = `你切换了书，那次${input.operation}的结果没有生效。`;
    try {
      // 手上这本书（如果开着）先存好再换。失败就不建，不能假装已经保存。
      const flushed = await flushAllSaves();
      if (!flushed.ok) {
        if (input.rethrow) throw new Error(`手上这本书没存上，没有${input.verb}：${flushed.error}`);
        showToast(`保存失败，没有新建书籍：${flushed.error}`, 5200);
        return;
      }
      if (!ownsNavigationOrigin(transition)) return;
      const created = await input.create();
      if (!ownsNavigationOrigin(transition)) {
        showToast(switched, 5000);
        return;
      }
      // 新建书与 openProject 同款接线：引导会话索引 + 接上全局对话记忆上限。
      // 不接的话 activeSessionId 一直是空串——对话只存会话文件（见 sync/chatSync），
      // sessionId 为空整段聊天不落盘，重启后首聊历史丢失；chatHistoryBudget 也会停在 96k 默认值，
      // 配置的上限被静默顶掉。读失败不阻塞开书：回退旧行为（空会话），重开本书时 openProject 会补正。
      const sessionBootstrap = await listChatSessions(created.projectDir).catch(() => null);
      if (!ownsNavigationOrigin(transition)) {
        showToast(switched, 5000);
        return;
      }
      // 还必须把活跃会话真正读一遍：sessionEpochs 只在 readChatSession/create/setActive/delete 登记，
      // 只 list 不读 → 首开期间 saveChatSessionMessages/beacon 因「本次运行未成功加载过该会话」全部短路，
      // 聊了一整场的历史一个字都不落盘（UI 审计 T1 / A-1，实测会话文件 messages=0）。
      // 读失败不阻塞开书，但绝不静默——开书成功的 toast 换成如实告警。
      let activeSessionLoaded = true;
      if (sessionBootstrap?.index?.activeSessionId) {
        activeSessionLoaded = await readChatSession(created.projectDir, sessionBootstrap.index.activeSessionId)
          .then((result) => Boolean(result?.session))
          .catch(() => false);
        if (!ownsNavigationOrigin(transition)) {
          showToast(switched, 5000);
          return;
        }
      }
      const nextWorkspace = workspaceFromStateOverview(created.overview);
      const firstPaper = await fetchChapterPaper(created.projectDir, nextWorkspace.currentChapter.chapterNumber).catch(() => null);
      if (!ownsNavigationOrigin(transition)) {
        showToast(switched, 5000);
        return;
      }
      const book = bookSummaryFromOverview(created.overview, created.projectDir);
      // 从这里起同步换上新书（中间不再 await，免得半新半旧的状态被存进新书）。
      setActiveBookId(null);
      setProjectPath(created.projectDir);
      setCurrentOverview(created.overview);
      if (sessionBootstrap?.index) {
        setSessions(sessionBootstrap.index.sessions, sessionBootstrap.index.activeSessionId);
        if (sessionBootstrap.chatHistoryBudgetTokens) setChatHistoryBudget(sessionBootstrap.chatHistoryBudgetTokens);
      } else {
        setSessions([], "");
      }
      setActiveArchivedCount(0);
      useDraftStore.getState().loadPaper(created.projectDir, firstPaper ?? {
        chapter: nextWorkspace.currentChapter.chapterNumber,
        draft: null,
        committed: null,
        editedSinceCommit: null,
      });
      setWorkspace(nextWorkspace);
      // 新建空书直接给开书开场白（与 openProject 打开空书一致，见 messagesWhenBackendSessionMissing）：
      // 否则落到章节 idle 语气「当前章节已就绪，可以生成本章方案」，对一本还没开写的新书是误导（修 R2#4）。
      // 导入的书给导入版开场白（说清记账员在后台记账、记完才能核账定稿）。
      setMessages([input.greeting()]);
      bookManagement.upsertRecentBook(book);
      setWorkspaceReady(true);
      pushWorkspaceUrlForProject(created.projectDir);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      if (!activeSessionLoaded) {
        // 会话没读成功 → epoch 未登记 → 本次运行聊天自动保存会被短路（另有客户端一次性 toast 兜底）。
        // 开书照旧放行（重开本书 openProject 会补正），但成功 toast 必须让位给如实告警。
        showToast(`《${input.title}》已${input.verb}，但聊天会话初始化失败：本次对话可能不会被保存，重新打开本书即可恢复。`, 6400);
      } else {
        showToast(`《${input.title}》已${input.verb}并打开。`);
      }
    } catch (error) {
      if (input.rethrow) throw error;
      if (ownsNavigationOrigin(transition)) {
        showToast(`创建失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      finishWorkspaceOperation(transition);
    }
  };

  const handleCreateBook = (draft: Parameters<typeof createStoryProjectFromDraft>[0]["draft"]): Promise<void> => openNewBook({
    operation: "新建书籍",
    title: draft.title || "未命名",
    create: () => createStoryProjectFromDraft({ draft }),
    greeting: bookCreationGreetingMessage,
    verb: "创建",
    rethrow: false,
  });

  const handleImportBook = (request: ImportBookRequest): Promise<void> => {
    let chapters = 0;
    return openNewBook({
      operation: "导入书",
      title: request.title || "未命名",
      create: async () => {
        const imported = await importBookProject(request);
        chapters = imported.chapters;
        return imported;
      },
      greeting: () => bookImportGreetingMessage(chapters),
      verb: "导入",
      rethrow: true,
    });
  };

  /* ================================================================ */
  /*  refreshWorkspaceFromOverview                                    */
  /* ================================================================ */
  const refreshWorkspaceFromOverview = (overview: StateOverview) => {
    setCurrentOverview(overview);
    {
      const current = useBookStore.getState().workspace;
      // H4：保留用户当前停留章/章节列表/对话/草稿，只让 overview 刷资料/侧栏派生字段。
      setWorkspace(mergeFoundationRefreshWorkspace(workspaceFromStateOverview(overview), current));
    }
    const currentProjectPath = useNavigationStore.getState().projectPath;
    if (currentProjectPath) bookManagement.upsertRecentBook(bookSummaryFromOverview(overview, currentProjectPath));
  };

  return {
    openProject,
    openRecentBook,
    openHome,
    openChapterWorkspace,
    handleSelectChapter,
    handleContinueNextChapter,
    handleCreateBook,
    handleImportBook,
    refreshWorkspaceFromOverview,
  };
}

/** 打开书失败时给作者看的一句话：找不到文件夹单独说清楚怎么办，其它错误去掉「Request failed with status 500」这类前缀。 */
export function describeOpenProjectFailure(
  raw: string,
  projectPath: string,
  books: readonly { readonly title: string; readonly projectPath: string }[],
): string {
  const title = books.find((book) => book.projectPath === projectPath)?.title;
  const name = title ? `《${title}》` : "这本书";
  // 不猜白名单：报错分类
  if (/项目目录不存在|ENOENT|no such file/iu.test(raw)) {
    return `找不到${name}的文件夹，可能被移走或删掉了。可以在书的「···」里把它从书架移除，或用「打开书文件夹」重新选位置。`;
  }
  const cleaned = raw.replace(/^Request failed with status \d+\s*/u, "").trim();
  return `${name}没打开：${cleaned || "原因不明"}`;
}
