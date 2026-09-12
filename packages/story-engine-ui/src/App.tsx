import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import ImmersiveAppShell from "./components/v2/ImmersiveAppShell.js";
import ModelSettingsDialog from "./components/ModelSettingsDialog.js";
import SnapshotHistoryDialog from "./components/SnapshotHistoryDialog.js";
import UsageDialog from "./components/UsageDialog.js";
import { useNavigationStore } from "./stores/navigationStore.js";
import { useWorkspaceStore, setProjectKey } from "./stores/workspaceStore.js";
import { useRecentBooksStore } from "./stores/recentBooksStore.js";
import { useThemeStore } from "./stores/themeStore.js";
import { useBookManagement, workspaceFromBook, sidebarFromBook } from "./hooks/useBookManagement.js";
import { useProjectNavigation } from "./hooks/useProjectNavigation.js";
import { useWorkflowActions } from "./hooks/useWorkflowActions.js";
import { useChat } from "./hooks/useChat.js";
import { useFoundationGaps } from "./hooks/useFoundationGaps.js";
import { pickPreferredChapter, sidebarFromStateOverview, workspaceFromStateOverview } from "./api/stateOverviewAdapter.js";
import { ChapterWorkspaceConflictError, fetchListDefaultBooks, saveChapterWorkspaceBeacon } from "./api/client.js";
import { saveChatSessionMessagesBeacon, setChatSessionSaveSkippedNotifier } from "./api/chatSessionsClient.js";
import { createWorkflowMessage } from "./utils/workflowHelpers.js";
import { countTextWords } from "./utils/textUtils.js";
import { readWorkspaceRoute } from "./utils/routing.js";
import { settlePendingDraftAgentCards } from "./utils/draftAgentSettlement.js";
import { createDraftSaveRaceGuard } from "./utils/draftSaveRaceGuard.js";
import {
  createExactPayloadAutosaveRunner,
  isAutosaveSuspended,
  scheduleAutosave,
  setAutosaveFlusher,
  suspendAutosave,
  type AutosaveFlushResult,
} from "./utils/autosaveControl.js";
import { isRealDraftContent } from "./utils/draftContent.js";
import { isDraftFileWriteSuppressed } from "./utils/draftWriteGuard.js";
import { buildWorkspaceAutosaveRequest } from "./utils/workspaceAutosaveRequest.js";
import { prepareVersionedWorkspaceSave, recordWorkspaceRevision } from "./utils/workspaceRevisionTracker.js";
import { reloadAfterWorkspaceRevisionConflict } from "./utils/workspaceRevisionConflict.js";
import {
  persistCapturedAutosavePayload,
  type CapturedAutosavePayload,
} from "./utils/capturedAutosavePersist.js";
import type { SaveChapterWorkspaceRequest } from "./api/types.js";
import type { ChapterMessage, ChapterNavItem, ChapterWorkflowState, LastFormalCommitApply } from "./types.js";

function reconcileWorkspaceConflict(
  projectPath: string,
  chapter: number,
  conflict: ChapterWorkspaceConflictError,
): void {
  const revision = conflict.snapshot.revision ?? 0;
  const nav = useNavigationStore.getState();
  const store = useWorkspaceStore.getState();
  if (nav.projectPath !== projectPath || store.workspace.currentChapter.chapterNumber !== chapter) {
    recordWorkspaceRevision(projectPath, chapter, revision);
    return;
  }
  reloadAfterWorkspaceRevisionConflict({
    projectPath,
    chapter,
    revision,
    recordRevision: recordWorkspaceRevision,
    suspend: suspendAutosave,
    notify: () => nav.showToast("检测到另一窗口已保存更新，正在重新加载磁盘版本；本次旧版本没有覆盖它。", 6500),
    reload: () => window.location.reload(),
  });
}

/* ------------------------------------------------------------------ */
/*  Shared helper: resolveChapterDirection                             */
/* ------------------------------------------------------------------ */

function resolveChapterDirection(value?: unknown): string {
  const store = useWorkspaceStore.getState();
  const nav = useNavigationStore.getState();
  const overview = store.currentOverview;
  const candidates = [
    typeof value === "string" ? value : "",
    store.lastChapterDirection,
    store.steeringDirection,
    firstChapterSetupDirection(overview),
    store.steeringDraft?.generatedChapterGoalPreview ?? "",
  ];
  return candidates.map(normalizeChapterDirection).find((c) => c.length > 0) ?? "";
}

function firstChapterSetupDirection(overview: import("./api/types.js").StateOverview | null): string {
  const setup = overview?.storyBible?.firstChapterSetup;
  if (!setup) return "";
  return [setup.goal, setup.openingScene, setup.hook, setup.conflict]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join("；");
}

function normalizeChapterDirection(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const exactCommands = new Set([
    "写吧", "开始写", "生成草稿", "直接写", "写一章", "开始生成",
    "质检", "提交预览", "确认提交", "正式提交", "继续下一章",
  ]);
  if (exactCommands.has(text)) return "";
  if (/^(?:写吧|开始写|生成草稿|直接写|写一章|开始生成|质检|提交预览|确认提交|正式提交|继续下一章)[。！!？?\s]*$/u.test(text)) return "";
  return text;
}

function isCurrentChapterAlreadyFormallyCommitted(
  lastFormalCommitApply: LastFormalCommitApply | null,
  currentChapter: ChapterNavItem,
  projectPath: string | null,
): boolean {
  const committedByWorkspace =
    currentChapter.status === "committed"
    || currentChapter.hasCommittedChapter === true;
  const committedByLastApply = lastFormalCommitApply?.transactionFinalized === true
    && lastFormalCommitApply.chapter === currentChapter.chapterNumber
    && (!lastFormalCommitApply.projectPath || !projectPath || lastFormalCommitApply.projectPath === projectPath);
  return committedByWorkspace || committedByLastApply;
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export function App() {
  const draftSaveRaceGuard = useRef(createDraftSaveRaceGuard());
  const autosaveRunnerRef = useRef<ReturnType<typeof createExactPayloadAutosaveRunner<CapturedAutosavePayload<readonly ChapterMessage[]>>> | null>(null);
  if (!autosaveRunnerRef.current) {
    autosaveRunnerRef.current = createExactPayloadAutosaveRunner<CapturedAutosavePayload<readonly ChapterMessage[]>>(async (payload) => {
      try {
        const [{ saveChapterWorkspace }, { saveChatSessionMessages }] = await Promise.all([
          import("./api/client.js"),
          import("./api/chatSessionsClient.js"),
        ]);
        await persistCapturedAutosavePayload(payload, {
          saveWorkspace: saveChapterWorkspace,
          saveSession: saveChatSessionMessages,
          onWorkspaceSaved: (snapshot) => {
            const revision = snapshot.revision ?? payload.request.expectedRevision ?? 0;
            recordWorkspaceRevision(payload.request.projectPath, payload.request.chapter, revision);
            const liveStore = useWorkspaceStore.getState();
            if (useNavigationStore.getState().projectPath === payload.request.projectPath
              && liveStore.workspace.currentChapter.chapterNumber === payload.request.chapter) {
              liveStore.setWorkspaceRevision(revision);
            }
          },
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof ChapterWorkspaceConflictError) {
          reconcileWorkspaceConflict(payload.request.projectPath, payload.request.chapter, error);
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, {
      supersedes: (newer, failed) => newer.key === failed.key
        && newer.request.projectPath === failed.request.projectPath
        && newer.request.chapter === failed.request.chapter
        && newer.sessionId === failed.sessionId,
    });
  }
  const [historyOpen, setHistoryOpen] = useState(false);

  /* ---- Zustand store reads ---- */
  const workspaceReady = useNavigationStore((s) => s.workspaceReady);
  const toast = useNavigationStore((s) => s.toast);
  const settingsOpen = useNavigationStore((s) => s.settingsOpen);
  const usageOpen = useNavigationStore((s) => s.usageOpen);
  const usageLoading = useNavigationStore((s) => s.usageLoading);
  const usageError = useNavigationStore((s) => s.usageError);
  const usageSummary = useNavigationStore((s) => s.usageSummary);
  const closeSettings = useNavigationStore((s) => s.closeSettings);
  const closeUsage = useNavigationStore((s) => s.closeUsage);
  const openSettings = useNavigationStore((s) => s.openSettings);

  const workspace = useWorkspaceStore((s) => s.workspace);
  const clearedChatBackup = useWorkspaceStore((s) => s.clearedChatBackup);
  const currentOverview = useWorkspaceStore((s) => s.currentOverview);
  const commitPreviewReport = useWorkspaceStore((s) => s.commitPreviewReport);
  const lastFormalCommitApply = useWorkspaceStore((s) => s.lastFormalCommitApply);
  const draftAIReview = useWorkspaceStore((s) => s.draftAIReview);
  const aiFlavorPending = useWorkspaceStore((s) => s.aiFlavorPending);
  const aiFlavorBatchPending = useWorkspaceStore((s) => s.aiFlavorBatchPending);
  const activeRevisionTask = useWorkspaceStore((s) => s.activeRevisionTask);
  const activeRevisionPreview = useWorkspaceStore((s) => s.activeRevisionPreview);
  const draftActionLoading = useWorkspaceStore((s) => s.draftActionLoading);
  const selectedAdviceCards = useWorkspaceStore((s) => s.selectedAdviceCards);
  const projectPath = useNavigationStore((s) => s.projectPath);
  const activeBookId = useNavigationStore((s) => s.activeBookId);
  const openProjectError = useNavigationStore((s) => s.openProjectError);
  const openProjectLoading = useNavigationStore((s) => s.openProjectLoading);
  const recentBooks = useRecentBooksStore((s) => s.books);
  const themeMode = useThemeStore((s) => s.mode);
  const toggleTheme = useThemeStore((s) => s.toggle);

  /* ---- Sync project key for message persistence ---- */
  useEffect(() => {
    setProjectKey(projectPath ?? activeBookId);
  }, [projectPath, activeBookId]);

  /* ---- 聊天保存被短路的可见信号（UI 审计 T1：绝不静默失败；客户端按会话去重，不会刷屏） ---- */
  useEffect(() => {
    setChatSessionSaveSkippedNotifier(() => {
      useNavigationStore.getState().showToast(
        "本次对话没有被保存：会话尚未成功加载。重新打开本书可恢复自动保存。",
        5600,
      );
    });
    return () => setChatSessionSaveSkippedNotifier(null);
  }, []);

  /* ---- Hook instantiations ---- */
  const bookManagement = useBookManagement();

  const navigation = useProjectNavigation({
    bookManagement,
    countTextWords,
  });

  const applyOverviewToWorkspace = (
    overview: import("./api/types.js").StateOverview,
    draftContent?: string,
    flowStatus = "idle" as ChapterWorkflowState,
    draftTitle?: string,
    // 写类工具（generate_draft/revise_draft/commit_apply）回传的「这次实际操作的章号」：
    // 它是权威，前端必须认领它推进当前章——否则写第2章时 UI 仍停第1章、autosave 把第2章正文写回 chapter-0001.md（跨章污染）。
    // 只读刷新不带此参 → 退回 store 旧章，不把用户从正在看的章弹走。
    targetChapter?: number,
  ) => {
    const store = useWorkspaceStore.getState();
    const preferredChapter = pickPreferredChapter(store.workspace.currentChapter?.chapterNumber, targetChapter);
    const nextWorkspace = workspaceFromStateOverview(overview, preferredChapter);
    const nextTitle = draftTitle ?? extractDraftTitle(draftContent) ?? undefined;
    store.setWorkspace({
      ...nextWorkspace,
      currentChapter: nextTitle ? { ...nextWorkspace.currentChapter, title: nextTitle } : nextWorkspace.currentChapter,
      chapters: nextTitle ? updateChapterListTitle(nextWorkspace.chapters, nextWorkspace.currentChapter.chapterNumber, nextTitle) : nextWorkspace.chapters,
      flowStatus,
      messages: store.workspace.messages,
      draft: {
        ...nextWorkspace.draft,
        ...(draftContent !== undefined
          ? {
            title: nextTitle ?? store.workspace.draft.title,
            content: draftContent,
            savedContent: draftContent,
            wordCount: countTextWords(draftContent),
            status: flowStatus === "committed" ? "committed" : "draft",
          }
          : {}),
      },
    });
    useWorkspaceStore.getState().setCurrentOverview(overview);
    useWorkspaceStore.getState().setSidebar(sidebarFromStateOverview(overview));
  };

  const refreshWorkspaceFromOverview = navigation.refreshWorkspaceFromOverview;

  const appendMessage = (message: import("./types.js").ChapterMessage) => {
    useWorkspaceStore.getState().appendMessage(message);
  };

  const appendWorkflowPrompt = (state: ChapterWorkflowState, content?: string) => {
    appendMessage(createWorkflowMessage(state, content));
  };

  const saveDraftChanges = async (): Promise<void> => {
    await draftSaveRaceGuard.current.run(async () => {
      const store = useWorkspaceStore.getState();
      const nav = useNavigationStore.getState();
      const draft = store.workspace.draft;
      const draftTitle = extractDraftTitle(draft.content) ?? draft.title;
      const hasRealDraft = isRealDraftContent(draft.content);
      const nextFlowStatus = hasRealDraft ? "draft_ready" as const : store.workspace.flowStatus;
      const suppressDraftWrite = isDraftFileWriteSuppressed({
        flowStatus: store.workspace.flowStatus,
        draftActionLoading: store.draftActionLoading,
      });
      const settledMessages = settlePendingDraftAgentCards(store.workspace.messages, "saved");
      useWorkspaceStore.getState().updateWorkspace({ messages: settledMessages });
      const request = nav.projectPath
        ? buildWorkspaceAutosaveRequest({
          projectPath: nav.projectPath,
          chapter: store.workspace.currentChapter.chapterNumber,
          messages: settledMessages,
          selectedAdviceCardKeys: store.selectedAdviceCards.map((item) => item.key),
          flowStatus: nextFlowStatus,
          content: draft.content,
          title: draftTitle,
          suppressed: suppressDraftWrite,
          committed: draft.status === "committed",
        })
        : null;
      if (request) {
        const versionedRequest = prepareVersionedWorkspaceSave(request);
        try {
          const saved = await import("./api/client.js").then(({ saveChapterWorkspace }) => saveChapterWorkspace(versionedRequest));
          const revision = saved.revision ?? versionedRequest.expectedRevision ?? 0;
          recordWorkspaceRevision(versionedRequest.projectPath, versionedRequest.chapter, revision);
          useWorkspaceStore.getState().setWorkspaceRevision(revision);
        } catch (error) {
          if (error instanceof ChapterWorkspaceConflictError) {
            reconcileWorkspaceConflict(versionedRequest.projectPath, versionedRequest.chapter, error);
          }
          throw error;
        }
      }
      useWorkspaceStore.getState().resetCommitState();
      useWorkspaceStore.getState().setDraftAIReview(null);
      useWorkspaceStore.getState().updateWorkspace({ flowStatus: nextFlowStatus });
      if (request?.writeDraftFile === true) {
        useWorkspaceStore.getState().updateDraft({
          title: draftTitle,
          savedContent: draft.content,
          wordCount: countTextWords(draft.content),
        });
        nav.showToast("草稿已保存。", 2200);
      } else if (!hasRealDraft) {
        nav.showToast("当前没有可安全保存的正文，未覆盖磁盘草稿。", 4200);
      }
    });
  };

  const workflow = useWorkflowActions({
    projectPath,
    resolveChapterDirection,
    appendMessage,
    appendWorkflowPrompt,
    applyOverviewToWorkspace,
    saveDraftChanges,
  });

  const foundationGaps = useFoundationGaps(projectPath);

  const { handleSendMessage, handleSelectAdviceCard, handleSuggestedAction, undoToTurn, stopAgent } = useChat({
    projectPath,
    resolveChapterDirection,
    handleGenerateDraft: workflow.handleGenerateDraft,
    handleQualityCheck: workflow.handleQualityCheck,
    handleDraftAIReview: workflow.handleDraftAIReview,
    handleGenerateRevisionPreview: workflow.handleGenerateRevisionPreview,
    handleApplyRevisionPreview: workflow.handleApplyRevisionPreview,
    handleCommitPreview: workflow.handleCommitPreview,
    handleCommitApply: workflow.handleCommitApply,
    handleGenerateSteering: workflow.generateSteering,
    handleContinueNextChapter: navigation.handleContinueNextChapter,
    handleCreateRevisionTask: workflow.handleCreateRevisionTask,
    handleFoundationGapChat: foundationGaps.handleFoundationGapChat,
    handleApplyFoundationGapSuggestionsFromChat: foundationGaps.handleApplyFoundationGapSuggestionsFromChat,
    handleRollbackFoundationGapApplyFromChat: foundationGaps.handleRollbackFoundationGapApplyFromChat,
    applyOverviewToWorkspace,
    refreshWorkspaceFromOverview,
    saveDraftChanges,
  });

  /* ---- Auto-save：串行化 + 失败可见 + 退出/切换 flush（审查 #3/#4/#5） ---- */
  // 同步快照当前 store 状态并按「项目+章节」串行调度一次写盘（bypass 350ms 防抖）。
  // 在此刻捕获内容值（而非在异步任务里懒读），保证「切章/切书」时刷的是**旧章节**的内容。
  const performAutosaveFromStore = useCallback(async (
    options: { readonly keepalive?: boolean } = {},
  ): Promise<AutosaveFlushResult> => {
    if (isAutosaveSuspended()) return { ok: true };
    const store = useWorkspaceStore.getState();
    const nav = useNavigationStore.getState();
    const activeProjectPath = nav.projectPath;
    if (!activeProjectPath) return { ok: true };
    const draft = store.workspace.draft;
    const chapter = store.workspace.currentChapter.chapterNumber;
    // dogfood F1：生成/流式中途 draft.content 是 partial——禁止 writeDraftFile，也不把截断正文写入
    // workspace.draftContent（否则刷新后用截断态盖过盘上完整稿）。消息与流程态仍照存。
    const suppressDraftWrite = isDraftFileWriteSuppressed({
      flowStatus: store.workspace.flowStatus,
      draftActionLoading: store.draftActionLoading,
    });
    const request = buildWorkspaceAutosaveRequest({
      projectPath: activeProjectPath,
      chapter,
      selectedAdviceCardKeys: store.selectedAdviceCards.map((item) => item.key),
      flowStatus: store.workspace.flowStatus,
      content: draft.content,
      title: draft.title,
      suppressed: suppressDraftWrite,
      committed: draft.status === "committed",
      // 刷新/关页打断生成：落 generationInterrupted，下次打开优先以盘上更完整稿恢复。
      ...(suppressDraftWrite && options.keepalive ? { generationInterrupted: true } : {}),
    });
    const sessionId = store.activeSessionId;
    const messages = store.workspace.messages;

    if (options.keepalive) {
      // 退出/隐藏途中：同步派发 keepalive fetch（静态 import，不经动态 import 的微任务——页面卸载时那一跳可能来不及跑）。
      saveChapterWorkspaceBeacon(prepareVersionedWorkspaceSave(request));
      if (sessionId) {
        saveChatSessionMessagesBeacon(activeProjectPath, sessionId, messages);
      }
      return { ok: true };
    }

    const key = `autosave::${activeProjectPath}::${chapter}`;
    const captured = { key, request, sessionId, messages } satisfies Omit<CapturedAutosavePayload<readonly ChapterMessage[]>, "request"> & {
      readonly request: SaveChapterWorkspaceRequest;
    };
    return scheduleAutosave(key, async () => {
      // 真正出队发送时取该书/章最新 revision：同 key 前一笔若刚成功升代次，后一笔随即用新代次，避免自撞 409。
      const sent: CapturedAutosavePayload<readonly ChapterMessage[]> = {
        ...captured,
        request: prepareVersionedWorkspaceSave(captured.request),
      };
      const result = await autosaveRunnerRef.current!.run(sent);
      if (!result.ok) {
        throw new Error(result.error);
      }
    });
  }, []);

  const retryFailedAutosave = useCallback(async (): Promise<AutosaveFlushResult> => {
    const failed = autosaveRunnerRef.current?.getFailedPayload();
    if (!failed) return performAutosaveFromStore();
    // failed.request 就是上一次真正发出的 payload（含当时 expectedRevision），绝不从当前 store 重拼目标。
    return scheduleAutosave(failed.key, async () => {
      const result = await autosaveRunnerRef.current!.run(failed);
      if (!result.ok) throw new Error(result.error);
    });
  }, [performAutosaveFromStore]);

  // 导航离开（切章/切书/回首页）前把当前编辑刷盘：注册给 autosaveControl，navigation 侧调用。
  useEffect(() => {
    setAutosaveFlusher(() => performAutosaveFromStore());
    return () => setAutosaveFlusher(null);
  }, [performAutosaveFromStore]);

  // 关窗/刷新/切后台前 keepalive flush，抢救最后一次未落盘的编辑（审查 #4）。
  useEffect(() => {
    const onHide = () => performAutosaveFromStore({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [performAutosaveFromStore]);

  useEffect(() => {
    if (!workspaceReady || !projectPath) return undefined;
    const timeoutId = window.setTimeout(() => {
      // M5：「撤销到此」冻结期内不写盘，避免在途/待触发的 autosave PUT 落在 git restore 之后抹掉回退草稿。
      performAutosaveFromStore();
    }, 350);
    return () => window.clearTimeout(timeoutId);
  }, [
    workspaceReady,
    projectPath,
    workspace.currentChapter.chapterNumber,
    workspace.messages,
    workspace.flowStatus,
    workspace.draft.content,
    workspace.draft.title,
    selectedAdviceCards,
    performAutosaveFromStore,
  ]);

  /* ---- Initial routing useEffect ---- */
  useEffect(() => {
    const applyRoute = () => {
      const route = readWorkspaceRoute();
      if (route.type === "book") {
        navigation.openRecentBook(route.bookId, { updateUrl: false });
        return;
      }
      if (route.type === "project") {
        void navigation.openProject(route.projectPath, { updateUrl: false });
        return;
      }
      navigation.openHome({ updateUrl: false });
    };
    applyRoute();
    window.addEventListener("popstate", applyRoute);

    // 首页启动时扫描默认目录，归并进书架（服务端真值刷新已有条目 + 按活跃时间排序；
    // 别再逐本 upsertBook 头插——那会把服务端的「最近活跃降序」反转，最旧的书霸占 books[0]）
    void (async () => {
      try {
        const defaultBooks = await fetchListDefaultBooks();
        useRecentBooksStore.getState().syncScannedBooks(defaultBooks);
      } catch {
        // 扫描失败不影响首页加载
      }
    })();

    return () => window.removeEventListener("popstate", applyRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Derived values for workspace props ---- */
  const steeringDirection = useWorkspaceStore((s) => s.steeringDirection);
  const steeringDraft = useWorkspaceStore((s) => s.steeringDraft);
  const steeringError = useWorkspaceStore((s) => s.steeringError);
  const steeringLoading = useWorkspaceStore((s) => s.steeringLoading);
  const chatLoading = useWorkspaceStore((s) => s.chatLoading);
  const chatError = useWorkspaceStore((s) => s.chatError);
  const sidebar = useWorkspaceStore((s) => s.sidebar);

  /* ---- Dialogs ---- */
  const settingsDialog = (
    <ModelSettingsDialog open={settingsOpen} onCancel={closeSettings} />
  );

  const usageDialog = usageOpen ? (
    <UsageDialog error={usageError} loading={usageLoading} summary={usageSummary} onClose={closeUsage} />
  ) : null;

  const historyDialog = historyOpen && projectPath ? (
    <SnapshotHistoryDialog
      projectPath={projectPath}
      onClose={() => setHistoryOpen(false)}
      onRestored={() => { window.location.reload(); }}
    />
  ) : null;

  /* ---- Render ---- */
  if (!workspaceReady) {
    return (
      <>
        <ErrorBoundary fallbackTitle="首页加载出错">
          <ImmersiveAppShell
            mode="home"
            home={{
              recentBooks,
              onChooseFolder: () => {
                const nextProjectPath = window.prompt("请输入 StoryEngine 项目完整路径");
                if (nextProjectPath?.trim()) void navigation.openProject(nextProjectPath.trim());
              },
              onCreateBook: (draft) => navigation.handleCreateBook(draft),
              onOpenSettings: openSettings,
              openProjectError,
              openProjectLoading,
              onOpenProject: (nextProjectPath) => navigation.openProject(nextProjectPath),
              onOpenRecentBook: navigation.openRecentBook,
              onRenameRecentBook: bookManagement.renameRecentBook,
              onRemoveRecentBook: bookManagement.removeRecentBook,
              onDeleteRecentBook: bookManagement.deleteRecentBook,
              onOpenRecentBookFolder: bookManagement.openRecentBookFolder,
            }}
          />
        </ErrorBoundary>
        {toast && <div className="app-toast">{toast}</div>}
        <ErrorBoundary fallbackTitle="设置对话框出错">
          {settingsDialog}
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="用量对话框出错">
          {usageDialog}
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="操作历史对话框出错">
          {historyDialog}
        </ErrorBoundary>
      </>
    );
  }

  return (
    <>
      <ErrorBoundary
        fallbackTitle="工作区加载出错"
        onGoHome={() => navigation.openHome()}
      >
        <ImmersiveAppShell
          key={activeBookId ?? projectPath ?? "workspace"}
          mode="workspace"
          workspace={{
            projectPath,
            sidebar,
            steeringDirection,
            steeringDraft,
            steeringError,
            steeringLoading,
            chatLoading,
            chatError,
            draftActionLoading,
            commitPreview: commitPreviewReport,
            lastFormalCommitApply,
            isCurrentChapterAlreadyFormallyCommitted: isCurrentChapterAlreadyFormallyCommitted(
              lastFormalCommitApply,
              workspace.currentChapter,
              projectPath,
            ),
            draftAIReview,
            aiFlavorPending,
            aiFlavorBatchPending,
            activeRevisionTask,
            activeRevisionPreview,
            themeMode,
            workspace,
            selectedAdviceCardKeys: selectedAdviceCards.map((item) => item.key),
            onGenerateSteering: () => void workflow.generateSteering(),
            onRepairDraft: () => void workflow.handleQualityCheck(),
            onDraftAIReview: () => void workflow.handleDraftAIReview(),
            onCreateRevisionTask: workflow.handleCreateRevisionTask,
            onFixAiFlavorViolation: workflow.handleFixAiFlavorViolation,
            onFixAllAiFlavorViolations: workflow.handleFixAiFlavorAll,
            onGenerateRevisionPreview: () => void workflow.handleGenerateRevisionPreview(),
            onApplyRevisionPreview: () => void workflow.handleApplyRevisionPreview(),
            onDismissRevisionTask: workflow.handleDismissRevisionTask,
            onRegenerateDraft: () => void workflow.handleGenerateDraft(),
            onGoHome: () => navigation.openHome(),
            onOpenHistory: () => setHistoryOpen(true),
            onOpenSettings: openSettings,
            onOpenUsage: () => void (async () => {
              if (!projectPath) {
                useNavigationStore.getState().setUsageError("请先打开真实本地项目。");
                useNavigationStore.getState().openUsage();
                return;
              }
              useNavigationStore.getState().openUsage();
              useNavigationStore.getState().setUsageLoading(true);
              useNavigationStore.getState().setUsageError(null);
              try {
                const { fetchUsageSummary } = await import("./api/client.js");
                useNavigationStore.getState().setUsageSummary(await fetchUsageSummary(projectPath));
              } catch (error) {
                useNavigationStore.getState().setUsageError(error instanceof Error ? error.message : String(error));
              } finally {
                useNavigationStore.getState().setUsageLoading(false);
              }
            })(),
            onSelectChapter: navigation.handleSelectChapter,
            onSelectAdviceCard: handleSelectAdviceCard,
            onSuggestedAction: handleSuggestedAction,
            onSendMessage: handleSendMessage,
            onStopAgent: stopAgent,
            onClearChat: () => {
              useWorkspaceStore.getState().clearChat();
              useNavigationStore.getState().showToast("已清空对话（正文和资料不受影响，可撤销）", 4000);
            },
            onUndoClearChat: () => useWorkspaceStore.getState().undoClearChat(),
            canUndoClearChat: clearedChatBackup !== null,
            onUndoToTurn: (message) => void undoToTurn(message),
            onSteeringDirectionChange: (value) => {
              useWorkspaceStore.getState().setSteeringDirection(value);
              if (useWorkspaceStore.getState().steeringError) useWorkspaceStore.getState().setSteeringError(null);
              if (useWorkspaceStore.getState().chatError) useWorkspaceStore.getState().setChatError(null);
            },
            onDraftContentChange: (content: string) => {
              const ws = useWorkspaceStore.getState();
              const draftTitle = extractDraftTitle(content) ?? ws.workspace.draft.title;
              ws.setWorkspace({
                ...ws.workspace,
                draft: {
                  ...ws.workspace.draft,
                  title: draftTitle,
                  content,
                  wordCount: countTextWords(content),
                  status: ws.workspace.draft.status === "committed" ? "committed" : "draft",
                  savedContent: ws.workspace.draft.savedContent ?? ws.workspace.draft.content,
                },
              });
            },
            onSelectionRewrite: workflow.handleSelectionRewrite,
            onSelectionRewriteCustom: workflow.handleSelectionRewriteCustom,
            onReroll: () => void workflow.handleRerollCandidates(),
            onApplyCandidate: (content: string) => void workflow.handleApplyCandidate(content),
            onCloseCandidates: workflow.handleCloseCandidates,
            onToggleTheme: toggleTheme,
            onRetryAutosave: () => { void retryFailedAutosave(); },
            overview: currentOverview,
          }}
        />
      </ErrorBoundary>
      {toast && <div className="app-toast">{toast}</div>}
      <ErrorBoundary fallbackTitle="设置对话框出错">
        {settingsDialog}
      </ErrorBoundary>
      <ErrorBoundary fallbackTitle="用量对话框出错">
        {usageDialog}
      </ErrorBoundary>
      <ErrorBoundary fallbackTitle="操作历史对话框出错">
        {historyDialog}
      </ErrorBoundary>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Helper functions (pure, non-component)                             */
/* ------------------------------------------------------------------ */

function extractDraftTitle(content: string | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine?.startsWith("#")) return null;
  const title = firstLine.replace(/^#+\s*/u, "").replace(/^第[一二三四五六七八九十百\d]+章\s*[·：:、-]?\s*/u, "").trim();
  return title || null;
}

function updateChapterListTitle(chapters: readonly import("./types.js").ChapterNavItem[], chapterNumber: number, title: string): readonly import("./types.js").ChapterNavItem[] {
  return chapters.map((chapter) => (
    chapter.chapterNumber === chapterNumber ? { ...chapter, title } : chapter
  ));
}
