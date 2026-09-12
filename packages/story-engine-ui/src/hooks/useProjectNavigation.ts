import {
  createStoryProjectFromDraft,
  fetchChapterWorkspace,
  fetchStateOverview,
} from "../api/client.js";
import { listChatSessions, readChatSession } from "../api/chatSessionsClient.js";
import type { StateOverview } from "../api/types.js";
import { sidebarFromStateOverview, workspaceFromStateOverview } from "../api/stateOverviewAdapter.js";
import { pushHomeUrl, pushWorkspaceUrlForBook, pushWorkspaceUrlForProject } from "../utils/routing.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useWorkspaceStore, emptyCommitSelections, setProjectKey, type SelectedAdviceCard } from "../stores/workspaceStore.js";
import { useRecentBooksStore } from "../stores/recentBooksStore.js";
import {
  actionsForWorkflowState,
  workflowPromptText,
} from "../utils/workflowHelpers.js";
import { looksLikeDraftBody, extractDraftTitle } from "../utils/textUtils.js";
import { bookCreationPromptText } from "../utils/bookCreationPrompt.js";
import { isFreshBook } from "../utils/isFreshBook.js";
import { consumeUndoReloadPreferSession } from "../utils/undoReloadFlag.js";
import { flushAutosaveNow, isAutosaveSuspended, resumeAutosave, suspendAutosave } from "../utils/autosaveControl.js";
import { recordWorkspaceRevision } from "../utils/workspaceRevisionTracker.js";
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
  SidebarData,
  SuggestedAction,
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
  readonly openProject: (nextProjectPath: string, options?: { readonly updateUrl?: boolean }) => Promise<boolean>;
  readonly openRecentBook: (bookId: string, options?: { readonly updateUrl?: boolean }) => Promise<boolean>;
  readonly openHome: (options?: { readonly updateUrl?: boolean }) => Promise<boolean>;
  readonly openChapterWorkspace: (chapter: ChapterNavItem) => Promise<void>;
  readonly handleSelectChapter: (chapterId: string) => void;
  readonly handleContinueNextChapter: () => Promise<void>;
  readonly handleCreateBook: (draft: Parameters<typeof createStoryProjectFromDraft>[0]["draft"]) => Promise<void>;
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

type ChapterFileState = Pick<ChapterNavItem, "hasDraftFile" | "hasCommittedChapter">;

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

function fileStateFromSnapshot(snapshot: Awaited<ReturnType<typeof fetchChapterWorkspace>> | null | undefined): ChapterFileState | undefined {
  if (!snapshot) return undefined;
  return {
    hasDraftFile: snapshot.hasDraftFile === true,
    hasCommittedChapter: snapshot.hasCommittedChapter === true,
  };
}

function resolveInitialChapterNumber(chapters: readonly ChapterNavItem[], fallbackChapterNumber: number): number {
  return maxChapterNumber(chapters.filter((chapter) => chapter.hasDraftFile === true))
    ?? maxChapterNumber(chapters.filter((chapter) => chapter.hasCommittedChapter === true))
    ?? maxChapterNumber(chapters.filter((chapter) => chapter.hasWorkspaceSnapshot === true))
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

function recoverMisroutedDraft(messages: readonly ChapterMessage[]): { readonly draftContent: string; readonly messages: readonly ChapterMessage[] } | null {
  const draftMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.adviceCards?.length && looksLikeDraftBody(message.content));
  if (!draftMessage) return null;
  return {
    draftContent: draftMessage.content,
    messages: [
      ...messages.filter((message) => message.id !== draftMessage.id),
      {
        id: `system-draft-recovered-${Date.now()}`,
        role: "system",
        content: "已将误入聊天区的正文移回左侧草稿区。",
        toolOutput: draftMessage.toolOutput,
      },
    ],
  };
}

function resolveSelectedAdviceCards(keys: readonly string[], messages: readonly ChapterMessage[]): readonly SelectedAdviceCard[] {
  const selected: SelectedAdviceCard[] = [];
  const keySet = new Set(keys);
  for (const message of messages) {
    for (const card of message.adviceCards ?? []) {
      const key = `${message.id}:${card.id}`;
      if (keySet.has(key)) {
        selected.push({ key, card });
      }
    }
  }
  return selected;
}

function isInProgressWorkspaceSnapshot(snapshot: Awaited<ReturnType<typeof fetchChapterWorkspace>> | null | undefined): boolean {
  if (!isRestorableWorkspaceSnapshot(snapshot)) return false;
  if (snapshot.flowStatus === "committed" || snapshot.flowStatus === "ready_for_next") return false;
  if (!snapshot.flowStatus || snapshot.flowStatus === "idle") return false;
  return Boolean(snapshot.draftContent?.trim() || snapshot.messages.length > 0);
}

function isRestorableWorkspaceSnapshot(snapshot: Awaited<ReturnType<typeof fetchChapterWorkspace>> | null | undefined): snapshot is Awaited<ReturnType<typeof fetchChapterWorkspace>> {
  if (!snapshot) return false;
  if (snapshot.flowStatus === "idle" && Boolean(snapshot.draftContent?.trim())) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/*  Book summary helpers                                               */
/* ------------------------------------------------------------------ */

function stableBookId(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `project-${hash.toString(16)}`;
}

function titleFromEvent(event: StateOverview["timeline"]["recentEvents"][number] | undefined, chapter: number): string {
  const source = event?.mainEvent ?? event?.summary;
  if (!source?.trim()) return `第${chapter}章`;
  const cleaned = source.replace(/\s+/gu, " ").trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}...` : cleaned;
}

function estimateWordsFromOverview(overview: StateOverview): number {
  const timelineWords = overview.timeline.recentEvents.reduce((total, event) => total + event.summary.length + (event.mainEvent?.length ?? 0), 0);
  return Math.max(timelineWords * 20, (overview.project.currentChapter ?? 0) * 3000);
}

function bookSummaryFromOverview(overview: StateOverview, projectPath: string): BookSummary {
  const currentChapterNumber = overview.project.currentChapter ?? overview.timeline.recentEvents.at(-1)?.chapter ?? 1;
  const currentEvent = overview.timeline.recentEvents.find((event) => event.chapter === currentChapterNumber) ?? overview.timeline.recentEvents.at(-1);
  const writtenChapters = Math.max(overview.project.currentChapter ?? overview.timeline.recentEvents.length, overview.timeline.recentEvents.length, 0);
  const projectTitle = overview.project.title || "未命名故事";
  return {
    id: stableBookId(projectPath),
    title: projectTitle,
    genre: overview.project.genre || "长篇故事",
    currentChapterTitle: titleFromEvent(currentEvent, currentChapterNumber),
    currentChapterNumber,
    protagonistName: overview.characters.protagonist ?? overview.characters.knownCharacters[0]?.name ?? "主角",
    status: overview.project.currentChapter ? "可继续下一章" : "草稿中",
    updatedAt: "刚刚",
    lastActiveMs: Date.now(),
    logline: overview.world.summary ?? overview.storyStatus.currentObjective ?? "继续当前故事。",
    writtenChapters,
    totalWords: estimateWordsFromOverview(overview),
    projectPath,
  };
}

function isRealProjectBook(book: BookSummary): boolean {
  return Boolean(book.projectPath.trim()) && !book.projectPath.startsWith("/mock/");
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

  const draftContent = [
    `这里是《${book.title}》第${book.currentChapterNumber}章「${book.currentChapterTitle}」的章节工作区。`,
    isRealProjectBook(book)
      ? "本区域会读取项目状态、生成本章方案、草稿和提交预览。"
      : "这条书架记录还没有绑定本地项目目录。打开或创建真实项目后，本区域会读取项目状态。",
    book.logline,
  ].join("\n\n");

  return {
    projectName: book.title,
    currentChapter,
    chapters: chapterWindow,
    flowStatus,
    draft: {
      chapterNumber: book.currentChapterNumber,
      title: book.currentChapterTitle,
      status: (flowStatus === "ready_for_next" ? "committed" : "draft") as "committed" | "draft",
      content: draftContent,
      wordCount: Math.max(1200, Math.round(book.totalWords / Math.max(book.writtenChapters, 1))),
    },
    messages: [
      {
        id: `${book.id}-system`,
        role: "assistant" as const,
        content: `已进入《${book.title}》的章节工作台。当前章节：第${book.currentChapterNumber}章 · ${book.currentChapterTitle}。`,
      },
    ],
    protagonist: {
      name: book.protagonistName,
      age: undefined,
      identity: "暂无身份状态",
      currentGoal: book.logline,
      physicalState: ["尚未配置身体状态"],
      mentalState: ["尚未配置精神状态"],
      resourceState: ["尚未配置当前资源状态"],
      currentSituation: "尚未配置当前阶段",
      boundaries: ["尚未配置角色边界"],
      cannotDo: ["尚未配置不能做什么"],
      speechSamples: ["尚未配置说话样本"],
    },
  };
}

function sidebarFromBook(book: BookSummary): SidebarData {
  return {
    storySettings: [book.title, book.genre, book.logline],
    writingRules: ["写作规则：尚未配置"],
    characters: [book.protagonistName],
    locations: ["尚未配置重要地点"],
    assets: ["尚未配置资产预留"],
    hooks: ["暂无伏笔线索"],
    arcGoals: ["暂无主线目标"],
  };
}

/**
 * A residual store session is only worth preserving when it represents a genuine
 * prior user conversation — i.e. it contains at least one real user turn whose id
 * is not a known seed/scaffolding marker. This guards against mockData demo seeds
 * (msg-001/msg-002) and workflow-only scaffolding leaking into a freshly opened
 * real project that has no backend snapshot.
 */
function isGenuineUserSession(messages: readonly ChapterMessage[]): boolean {
  if (messages.length === 0) return false;
  // Workflow scaffolding (assistant-workflow-*) is regenerated, never a real session.
  if (messages.every((m) => m.id.startsWith("assistant-workflow-"))) return false;
  // A real session has a genuine user turn that is not a mockData demo seed.
  return messages.some((m) => m.role === "user" && !m.id.startsWith("msg-0"));
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

/** 这组消息是否就是单条开书开场白（由 selectOpenProjectMessages 为空书注入）。 */
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
    || (message.adviceCards?.length ?? 0) > 0) {
    return false;
  }
  // 系统提示（「已将误入聊天区的正文移回左侧草稿区」等）全是注入通知，非用户/AI 对话。
  if (message.role === "system") return true;
  const id = message.id ?? "";
  // 注入的流程 idle 招呼（assistant-workflow-*）/ 开书开场白（assistant-book-creation-*）。
  if (id.startsWith("assistant-workflow-") || id.startsWith("assistant-book-creation-")) return true;
  // 工作区 / 章节进入开场白。
  const content = (message.content ?? "").trim();
  if (content.startsWith("已进入《") || content.startsWith("已进入第")) return true;
  return false;
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
 * Decides which chat history to show when opening a project.
 * Priority: restorable backend snapshot → genuine prior session →
 * persisted book-creation greeting (untouched new book) → fresh-empty-book greeting → adapter clean greeting.
 *
 * 为什么有「persistedMessages 是开书开场白」这条（V4 真机教训）：新建空书时开书开场白会被 autosave 写进
 * chapter-workspace 缓存，但该缓存对「草稿恢复」不算可恢复快照（无真实草稿）→ snapshotMessages 为空，
 * 于是只能从原始当前章节快照的 messages 里把它捞回来。这是「这本是没动过的新书」的 ground truth，
 * 不受 overview 启发式被建书/autosave 产物（种下的 arc-goal、占位草稿致 hasDraftFile）干扰。
 * isFreshBook(overview) 仅作兜底（缓存尚未写入时，如刚建首开）。两条都只在没有真实历史会话时才会触达，
 * 绝不覆盖用户真实对话。
 */
function selectOpenProjectMessages(params: {
  readonly snapshotMessages: readonly ChapterMessage[] | null | undefined;
  readonly persistedMessages?: readonly ChapterMessage[] | null | undefined;
  readonly sessionMessages: readonly ChapterMessage[];
  readonly workspaceMessages: readonly ChapterMessage[];
  readonly overview?: StateOverview;
  /** 「撤销到此」后的那一次 reload：忽略磁盘对话（被 git restore 还原成回合起点脏态、含孤儿消息），
   *  改用 sessionStorage 里刚写好的干净截断（H5）。仅这一次为真，绝不影响后续正常开书。 */
  readonly preferSession?: boolean;
}): readonly ChapterMessage[] {
  const { snapshotMessages, persistedMessages, sessionMessages, workspaceMessages, overview, preferSession } = params;
  // H5：撤销 reload 时跳过磁盘 snapshotMessages（脏态孤儿），让下面的「真实历史会话 / 干净开场白」分支接管。
  if (!preferSession && snapshotMessages && snapshotMessages.length > 0) return snapshotMessages;
  if (isGenuineUserSession(sessionMessages)) return sessionMessages;
  // 持久化消息就是「单条开书开场白」= 没动过的新书（建书时写入、用户没聊过）→ 保留开书语气。
  if (persistedMessages && isBookCreationGreeting(persistedMessages)) return persistedMessages;
  if (overview && isFreshBook(overview)) {
    return [bookCreationGreetingMessage()];
  }
  return workspaceMessages;
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
 * 用 overview 派生的 base 刷资料/侧栏相关字段，但**保留**用户当前停留章 currentChapter/chapters、
 * 对话 messages、草稿 draft 与流程态 flowStatus。
 *
 * H4：历史上这里直接铺开 base（含 overview 最新章的 currentChapter/chapters），用户在第2章顺手记资料
 * 会被顶部跳到最新章、草稿仍停第2章，界面对不上。必须与 useFoundationGaps.ts 的 refreshWorkspaceFromOverview
 * 保持同款字段保留——改一处记得同步另一处。
 */
export function mergeFoundationRefreshWorkspace(
  nextBase: ChapterWorkspaceData,
  current: ChapterWorkspaceData,
): ChapterWorkspaceData {
  return {
    ...nextBase,
    currentChapter: current.currentChapter,
    chapters: current.chapters,
    messages: current.messages,
    flowStatus: current.flowStatus,
    draft: current.draft,
  };
}

export const __useProjectNavigationTest = {
  selectOpenProjectMessages,
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

  /* ---- workspace store ---- */
  const {
    workspace,
    setWorkspace,
    setSidebar,
    setCurrentOverview,
    setSteeringDirection,
    setLastChapterDirection,
    setSteeringDraft,
    setSteeringError,
    setChatError,
    setCommitPreviewReport,
    setDraftAIReview,
    setActiveRevisionTask,
    setActiveRevisionPreview,
    setCommitSelections,
    setSelectedAdviceCards,
    resetFoundationGaps,
    resetTransientWorkspaceState,
    setSessions,
    setActiveArchivedCount,
    setChatHistoryBudget,
    setWorkspaceRevision,
  } = useWorkspaceStore();

  const currentNavigationIdentity = () => {
    const live = useWorkspaceStore.getState();
    return {
      projectPath: useNavigationStore.getState().projectPath ?? "",
      chapter: live.workspace.currentChapter.chapterNumber,
      sessionId: live.activeSessionId,
    };
  };

  const beginNavigationTransition = (action: string): WorkspaceOperationToken | null => {
    const token = beginWorkspaceOperation("navigation-transition", currentNavigationIdentity());
    if (!token) showToast(`已有操作正在进行，暂不能${action}。`, 4600);
    return token;
  };

  const ownsNavigationOrigin = (token: WorkspaceOperationToken): boolean =>
    isWorkspaceOperationTargetCurrent(token, currentNavigationIdentity());

  /* ---- recent books store (for openRecentBook lookup) ---- */
  const recentBooks = useRecentBooksStore((s) => s.books);

  /* ================================================================ */
  /*  openProject                                                     */
  /* ================================================================ */
  const openProject = async (nextProjectPath: string, options: { readonly updateUrl?: boolean } = {}): Promise<boolean> => {
    const transition = beginNavigationTransition("切换书籍");
    if (!transition) return false;
    const wasSuspended = isAutosaveSuspended();
    let suspendedForTransition = false;
    try {
      // 旧书保存必须真正完成后才能替换 project/session/workspace。失败就留在原地，不能假装已经保存。
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前书籍：${flushed.error}`, 5200);
        return false;
      }
      // 过渡期冻结 autosave：setProjectPath(新书) 与 setWorkspace(新内容) 之间有多个 await，
      // 这个窗口里若有 350ms 防抖计时器/pagehide keepalive 触发，会拿「新 projectPath + 旧书草稿」
      // 的混合态写盘 → 旧书内容串进新书。
      if (!wasSuspended) {
        suspendAutosave();
        suspendedForTransition = true;
      }
      setOpenProjectLoading(true);
      setOpenProjectError(null);
      const overview = await fetchStateOverview({ projectPath: nextProjectPath, maxTimelineEvents: 8 });
      if (!ownsNavigationOrigin(transition)) return false;
      const nextWorkspace = workspaceFromStateOverview(overview);
      const baseChapterNumber = nextWorkspace.currentChapter.chapterNumber;
      const initialChapterNumber = resolveInitialChapterNumber(nextWorkspace.chapters, baseChapterNumber);
      const snapshotChapterNumbers = [...new Set([baseChapterNumber, baseChapterNumber + 1, initialChapterNumber])];
      const snapshots = await Promise.all(snapshotChapterNumbers.map(async (chapterNumber) => [
        chapterNumber,
        await fetchChapterWorkspace({
          projectPath: nextProjectPath,
          chapter: chapterNumber,
        }),
      ] as const));
      if (!ownsNavigationOrigin(transition)) return false;
      const snapshotByChapter = new Map(snapshots);
      const currentSnapshot = snapshotByChapter.get(baseChapterNumber) ?? null;
      const nextChapterSnapshot = snapshotByChapter.get(baseChapterNumber + 1) ?? null;
      const initialSnapshot = snapshotByChapter.get(initialChapterNumber) ?? null;
      const snapshot = isRestorableWorkspaceSnapshot(initialSnapshot)
        ? initialSnapshot
        : isInProgressWorkspaceSnapshot(nextChapterSnapshot)
        ? nextChapterSnapshot
        : isRestorableWorkspaceSnapshot(currentSnapshot)
          ? currentSnapshot
          : null;
      const fileStates = new Map<number, ChapterFileState>();
      for (const [chapterNumber, chapterSnapshot] of snapshotByChapter) {
        const fileState = fileStateFromSnapshot(chapterSnapshot);
        if (fileState) fileStates.set(chapterNumber, fileState);
      }
      const activeChapterNumber = snapshot?.chapter ?? baseChapterNumber;
      // 内容是否可恢复与 CAS 基线是两件事：即使占位/idle 内容被拒绝，也必须保留磁盘 raw revision。
      const rawActiveSnapshot = snapshotByChapter.get(activeChapterNumber) ?? null;
      const activeChapter = nextWorkspace.chapters.find((chapter) => chapter.chapterNumber === activeChapterNumber) ?? {
        id: `ch-${activeChapterNumber}`,
        chapterNumber: activeChapterNumber,
        title: `第${activeChapterNumber}章`,
        status: "current" as const,
      };
      const book = bookSummaryFromOverview(overview, nextProjectPath);
      // Choose chat history: backend snapshot → genuine prior user session →
      // adapter clean greeting. A real project with no backend snapshot must NOT
      // keep mockData demo seeds or workflow scaffolding left in the store.
      // storeMessages = store 内存里当前的消息（zustand workspace.messages）。既是 selectOpenProjectMessages
      // 的候选输入，也是「一个聊天走天涯」改造后读取后端会话历史失败/为空时的兜底（见下方 backendSessionMessages 回退）。
      const storeMessages = useWorkspaceStore.getState().workspace.messages;
      // selectedOpenProjectMessages = selectOpenProjectMessages 选出的最优历史候选。
      // 注意（隐患C·保守保留）：自「一个聊天走天涯」改造后，最终写进 store 的 messages 改由下方
      // backendSessionMessages（readChatSession 的活跃会话）决定；此返回值的 snapshotMessages 最高优先级
      // 分支已不直接决定最终 messages，目前仅供 recoverMisroutedDraft 捞回误投草稿。
      // TODO：若确认 selectOpenProjectMessages 的 snapshot 优先级分支对开书主流程已无其他作用，可评估精简；
      //       未 100% 确认前保留全套逻辑，不为清理死代码冒险改坏开书主流程。
      const selectedOpenProjectMessages = selectOpenProjectMessages({
        snapshotMessages: snapshot?.messages,
        // 原始当前章节快照的 messages：空书的开书开场白即便快照「不可恢复草稿」也能从这里捞回（V4）。
        persistedMessages: currentSnapshot?.messages,
        sessionMessages: storeMessages,
        workspaceMessages: nextWorkspace.messages,
        // 仅当既无 backend snapshot 也无真实历史、且这是刚建的空书时，
        // 注入开书语气开场白；其余情况(有内容/有历史)一律不变。
        overview,
        // H5：「撤销到此」reload 的一次性标记——忽略被 restore 还原成脏态的磁盘对话，用 sessionStorage 干净截断。
        preferSession: consumeUndoReloadPreferSession(),
      });
      const hasSnapshotDraft = snapshot?.draftContent !== undefined;
      const recovered = hasSnapshotDraft ? null : recoverMisroutedDraft(selectedOpenProjectMessages);
      const draftContent = snapshot?.draftContent ?? recovered?.draftContent;
      // 开书时按当前活跃会话装载聊天（替代旧的按章快照取 messages）
      const sessionIndex = await listChatSessions(nextProjectPath).catch(() => null);
      if (!ownsNavigationOrigin(transition)) return false;
      // backendSessionMessages = readChatSession 读到的后端活跃会话历史，最终写进 store 的消息以它为准。
      let backendSessionMessages: readonly ChapterMessage[] = [];
      let activeArchivedCount = 0;
      let backendSessionLoaded = false;
      if (sessionIndex?.index) {
        const activeSessionId = sessionIndex.index.activeSessionId;
        const active = await readChatSession(nextProjectPath, activeSessionId).catch((error) => {
          console.warn("[openProject] 读取会话历史失败，回退到内存消息", { activeSessionId, error });
          return null;
        });
        if (!ownsNavigationOrigin(transition)) return false;
        if (active?.session && active.session.messages.length > 0) {
          backendSessionMessages = active.session.messages;
          activeArchivedCount = active.session.archivedCount ?? 0;
          backendSessionLoaded = true;
        }
      }
      // 没读到后端会话历史时，绝不把内存里上一本书的残留消息当成本书历史（见 messagesWhenBackendSessionMissing）。
      if (!backendSessionLoaded) {
        if (!(overview && isFreshBook(overview))) {
          console.warn("[openProject] 会话历史失败/为空，回退到内存消息", {
            hasSessionIndex: Boolean(sessionIndex?.index),
            storeMessageCount: storeMessages.length,
          });
        }
        backendSessionMessages = messagesWhenBackendSessionMissing({
          overview,
          storeMessages,
          allowStoreFallback: nextProjectPath === transition.projectPath,
        });
      }
      const draftTitle = snapshot?.draftTitle ?? extractDraftTitle(draftContent) ?? activeChapter.title;
      const flowStatus: ChapterWorkflowState = snapshot?.flowStatus
        ?? (draftContent?.trim() ? "draft_ready" : activeChapterNumber === baseChapterNumber ? nextWorkspace.flowStatus : "idle");
      const chapters = activeChapterNumber === baseChapterNumber
        ? updateChapterListForActive(updateChapterListTitle(nextWorkspace.chapters, activeChapterNumber, draftTitle), activeChapterNumber, draftTitle, fileStates)
        : updateChapterListForActive(nextWorkspace.chapters, activeChapterNumber, draftTitle, fileStates);
      // All asynchronous reads completed while the origin identity remained
      // current. Commit the new project/session/workspace in one synchronous turn.
      resetTransientWorkspaceState();
      setActiveBookId(null);
      setProjectPath(nextProjectPath);
      setCurrentOverview(overview);
      setProjectKey(nextProjectPath);
      if (sessionIndex?.index) {
        setSessions(sessionIndex.index.sessions, sessionIndex.index.activeSessionId);
        if (sessionIndex.chatHistoryBudgetTokens) setChatHistoryBudget(sessionIndex.chatHistoryBudgetTokens);
      } else {
        // 后端会话不可用时也必须清掉上一本书的 index/active id，避免后续 autosave 写回旧会话。
        setSessions([], "");
      }
      setActiveArchivedCount(activeArchivedCount);
      recordWorkspaceRevision(nextProjectPath, activeChapterNumber, rawActiveSnapshot?.revision ?? 0);
      setWorkspaceRevision(rawActiveSnapshot?.revision ?? 0);
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
        messages: entryChatMessages(backendSessionMessages),
        draft: draftContent !== undefined
          ? {
            ...nextWorkspace.draft,
            chapterNumber: activeChapterNumber,
            title: draftTitle,
            content: draftContent,
            savedContent: draftContent,
            wordCount: countTextWords(draftContent),
            status: flowStatus === "committed" || flowStatus === "ready_for_next" ? "committed" : "draft",
          }
          : nextWorkspace.draft,
      });
      setSidebar(sidebarFromStateOverview(overview));
      bookManagement.upsertRecentBook(book);
      setSteeringDirection("");
      setLastChapterDirection("");
      setSteeringDraft(null);
      setSteeringError(null);
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      resetFoundationGaps();
      setSelectedAdviceCards(resolveSelectedAdviceCards(snapshot?.selectedAdviceCardKeys ?? [], backendSessionMessages));
      setWorkspaceReady(true);
      if (snapshot?.generationInterrupted || snapshot?.recoveredFromDraftFile) {
        showToast(
          snapshot.recoveredFromDraftFile
            ? "上次生成被打断，已恢复磁盘上更完整的工作稿。"
            : "上次生成被打断，工作稿未用中途内容覆写。",
          4200,
        );
      }
      if (options.updateUrl !== false) {
        pushWorkspaceUrlForProject(nextProjectPath);
      }
      return true;
    } catch (error) {
      if (ownsNavigationOrigin(transition)) {
        setOpenProjectError(`打开项目失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    } finally {
      if (suspendedForTransition) resumeAutosave();
      setOpenProjectLoading(false);
      finishWorkspaceOperation(transition);
    }
  };

  /* ================================================================ */
  /*  openRecentBook                                                  */
  /* ================================================================ */
  const openRecentBook = async (bookId: string, options: { readonly updateUrl?: boolean } = {}): Promise<boolean> => {
    const book = recentBooks.find((item) => item.id === bookId);
    if (!book) return false;

    if (isRealProjectBook(book)) {
      return openProject(book.projectPath, options);
    }

    const transition = beginNavigationTransition("切换书籍");
    if (!transition) return false;

    try {
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前书籍：${flushed.error}`, 5200);
        return false;
      }
      setActiveBookId(book.id);
      setProjectPath(null);
      setProjectKey(book.id);
      setCurrentOverview(null);
      setOpenProjectError(null);
      setSidebar(sidebarFromBook(book));
      setSteeringDirection("");
      setLastChapterDirection("");
      setSteeringDraft(null);
      setSteeringError(null);
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      resetFoundationGaps();
      resetTransientWorkspaceState();
      setSessions([], "");
      setActiveArchivedCount(0);
      setWorkspaceRevision(0);
      setSelectedAdviceCards([]);
      {
        const bookWorkspace = workspaceFromBook(book);
        setWorkspace({
          ...workspace,
          ...bookWorkspace,
          location: workspace.location,
          time: workspace.time,
          knowledge: workspace.knowledge,
          assets: workspace.assets,
          memory: workspace.memory,
          risks: workspace.risks,
          hardConstraints: workspace.hardConstraints,
          characterMatrix: workspace.characterMatrix,
          messages: entryChatMessages(bookWorkspace.messages),
        });
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
  const openHome = async (options: { readonly updateUrl?: boolean } = {}): Promise<boolean> => {
    const transition = beginNavigationTransition("返回首页");
    if (!transition) return false;
    try {
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前工作区：${flushed.error}`, 5200);
        return false;
      }
      setWorkspaceReady(false);
      setActiveBookId(null);
      setProjectPath(null);
      setProjectKey(null);
      setCurrentOverview(null);
      setOpenProjectError(null);
      setSteeringDirection("");
      setLastChapterDirection("");
      setSteeringDraft(null);
      setSteeringError(null);
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      resetFoundationGaps();
      setSessions([], "");
      setActiveArchivedCount(0);
      setWorkspaceRevision(0);
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
    // 审查 #4：切章前把当前章未落盘的编辑刷盘（在替换 workspace store 前 capture 旧章内容）。
    try {
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        showToast(`保存失败，仍停留在当前章节：${flushed.error}`, 5200);
        return;
      }
      let snapshot: Awaited<ReturnType<typeof fetchChapterWorkspace>> | null = null;
      let rawSnapshot: Awaited<ReturnType<typeof fetchChapterWorkspace>> | null = null;
      const currentProjectPath = transition.projectPath || null;
      if (currentProjectPath) {
        rawSnapshot = await fetchChapterWorkspace({
          projectPath: currentProjectPath,
          chapter: chapter.chapterNumber,
        });
        if (!ownsNavigationOrigin(transition)) return;
        snapshot = rawSnapshot;
        if (!isRestorableWorkspaceSnapshot(snapshot)) snapshot = null;
      }

      const draftContent = snapshot?.draftContent ?? "";
      const draftTitle = snapshot?.draftTitle ?? chapter.title;
      const hasCommittedChapter = snapshot?.hasCommittedChapter === true
        || (snapshot?.hasCommittedChapter === undefined && chapter.hasCommittedChapter !== false && chapter.status === "committed");
      const flowStatus: ChapterWorkflowState = snapshot?.flowStatus ?? (draftContent.trim() ? "draft_ready" : hasCommittedChapter ? "committed" : "idle");

      {
        const current = useWorkspaceStore.getState().workspace;
        const fileStates = new Map<number, ChapterFileState>();
        const fileState = fileStateFromSnapshot(snapshot);
        if (fileState) fileStates.set(chapter.chapterNumber, fileState);
        const chapters = updateChapterListForActive(current.chapters, chapter.chapterNumber, draftTitle, fileStates);
        setWorkspace({
          ...current,
          ...workingDraftChainState(chapters, chapter.chapterNumber),
          currentChapter: {
            ...chapter,
            title: draftTitle,
            status: "current",
            ...fileState,
          },
          chapters,
          flowStatus,
          draft: {
            ...current.draft,
            chapterNumber: chapter.chapterNumber,
            title: draftTitle,
            content: draftContent,
            savedContent: draftContent,
            wordCount: draftContent.trim() ? countTextWords(draftContent) : undefined,
            status: flowStatus === "committed" || flowStatus === "ready_for_next" ? "committed" : "draft",
          },
        });
      }
      if (currentProjectPath) {
        recordWorkspaceRevision(currentProjectPath, chapter.chapterNumber, rawSnapshot?.revision ?? 0);
      }
      setWorkspaceRevision(rawSnapshot?.revision ?? 0);
      setSteeringDirection("");
      setLastChapterDirection("");
      setSteeringDraft(null);
      setSteeringError(null);
      setChatError(null);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      setCommitSelections(emptyCommitSelections());
      setSelectedAdviceCards([]);
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
  /*  handleCreateBook                                                */
  /* ================================================================ */
  const handleCreateBook = async (draft: Parameters<typeof createStoryProjectFromDraft>[0]["draft"]): Promise<void> => {
    const transition = beginNavigationTransition("创建新书");
    if (!transition) return;
    try {
      const created = await createStoryProjectFromDraft({ draft });
      if (!ownsNavigationOrigin(transition)) {
        showToast("原工作区已经变化，已丢弃迟到的新建书籍回执。", 5000);
        return;
      }
      // 新建书与 openProject 同款接线：引导会话索引 + 接上全局对话记忆上限。
      // 不接的话 activeSessionId 一直是空串——聊天自动保存只写会话文件（见 performAutosaveFromStore），
      // sessionId 为空整段聊天不落盘，重启后首聊历史丢失；chatHistoryBudget 也会停在 96k 默认值，
      // 配置的上限被静默顶掉。读失败不阻塞开书：回退旧行为（空会话），重开本书时 openProject 会补正。
      const sessionBootstrap = await listChatSessions(created.projectDir).catch(() => null);
      if (!ownsNavigationOrigin(transition)) {
        showToast("原工作区已经变化，已丢弃迟到的新建书籍回执。", 5000);
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
          showToast("原工作区已经变化，已丢弃迟到的新建书籍回执。", 5000);
          return;
        }
      }
      const book = bookSummaryFromOverview(created.overview, created.projectDir);
      setActiveBookId(null);
      setProjectPath(created.projectDir);
      setCurrentOverview(created.overview);
      // App 的 useEffect 要到下一次 render 才切 key；这里必须先切，避免 B 的首条消息落进 A 的 sessionStorage。
      setProjectKey(created.projectDir);
      if (sessionBootstrap?.index) {
        setSessions(sessionBootstrap.index.sessions, sessionBootstrap.index.activeSessionId);
        if (sessionBootstrap.chatHistoryBudgetTokens) setChatHistoryBudget(sessionBootstrap.chatHistoryBudgetTokens);
      } else {
        setSessions([], "");
      }
      setActiveArchivedCount(0);
      setWorkspaceRevision(0);
      const nextWorkspace = workspaceFromStateOverview(created.overview);
      recordWorkspaceRevision(created.projectDir, nextWorkspace.currentChapter.chapterNumber, 0);
      setWorkspace({
        ...nextWorkspace,
        // 新建空书直接给开书开场白（与 openProject 打开空书一致，见 selectOpenProjectMessages）：
        // 否则落到章节 idle 语气「当前章节已就绪，可以生成本章方案」，对一本还没开写的新书是误导（修 R2#4）。
        messages: [bookCreationGreetingMessage()],
      });
      setSidebar(sidebarFromStateOverview(created.overview));
      bookManagement.upsertRecentBook(book);
      setWorkspaceReady(true);
      pushWorkspaceUrlForProject(created.projectDir);
      setCommitPreviewReport(null);
      setDraftAIReview(null);
      setActiveRevisionTask(null);
      setActiveRevisionPreview(null);
      resetFoundationGaps();
      if (!activeSessionLoaded) {
        // 会话没读成功 → epoch 未登记 → 本次运行聊天自动保存会被短路（另有客户端一次性 toast 兜底）。
        // 开书照旧放行（重开本书 openProject 会补正），但成功 toast 必须让位给如实告警。
        showToast(`《${draft.title || "未命名"}》已创建，但聊天会话初始化失败：本次对话可能不会被保存，重新打开本书即可恢复。`, 6400);
      } else {
        showToast(`《${draft.title || "未命名"}》已创建并打开。`);
      }
    } catch (error) {
      if (ownsNavigationOrigin(transition)) {
        showToast(`创建失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      finishWorkspaceOperation(transition);
    }
  };

  /* ================================================================ */
  /*  refreshWorkspaceFromOverview                                    */
  /* ================================================================ */
  const refreshWorkspaceFromOverview = (overview: StateOverview) => {
    setCurrentOverview(overview);
    {
      const current = useWorkspaceStore.getState().workspace;
      // H4：保留用户当前停留章/章节列表/对话/草稿，只让 overview 刷资料/侧栏派生字段。
      setWorkspace(mergeFoundationRefreshWorkspace(workspaceFromStateOverview(overview), current));
    }
    setSidebar(sidebarFromStateOverview(overview));
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
    refreshWorkspaceFromOverview,
  };
}
