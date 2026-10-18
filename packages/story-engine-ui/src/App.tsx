import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import ImmersiveAppShell from "./components/v2/ImmersiveAppShell.js";
import { SettingsModal, type SettingsTab } from "./components/v2/codex/SettingsModal.js";
import UsageDialog from "./components/UsageDialog.js";
import { useNavigationStore } from "./stores/navigationStore.js";
import { useBookStore } from "./stores/bookStore.js";
import { useChatStore } from "./stores/chatStore.js";
import { useUiStore } from "./stores/uiStore.js";
import { useRecentBooksStore } from "./stores/recentBooksStore.js";
import { useThemeStore } from "./stores/themeStore.js";
import { useBookManagement } from "./hooks/useBookManagement.js";
import { useProjectNavigation } from "./hooks/useProjectNavigation.js";
import { useWorkflowActions } from "./hooks/useWorkflowActions.js";
import { useChat } from "./hooks/useChat.js";
import { fetchDefaultBookLibrary } from "./api/client.js";
import { setChatSessionSaveSkippedNotifier } from "./api/chatSessionsClient.js";
import { countTextWords, extractDraftTitle } from "./utils/textUtils.js";
import { readWorkspaceRoute } from "./utils/routing.js";
import { isRealDraftContent } from "./utils/draftContent.js";
import { editDraft } from "./drafts/draftSync.js";
import { saveChatNow, scheduleChatSave } from "./sync/chatSync.js";
import { flushAllSaves, saveAllKeepalive } from "./sync/saveAll.js";
import type { ChapterNavItem, LastFormalCommitApply } from "./types.js";

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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");

  const workspace = useBookStore((s) => s.workspace);
  const messages = useChatStore((s) => s.messages);
  const clearedChatBackup = useChatStore((s) => s.clearedChatBackup);
  const currentOverview = useBookStore((s) => s.currentOverview);
  const commitPreviewReport = useUiStore((s) => s.commitPreviewReport);
  const lastFormalCommitApply = useUiStore((s) => s.lastFormalCommitApply);
  const draftAIReview = useUiStore((s) => s.draftAIReview);
  const aiFlavorPending = useUiStore((s) => s.aiFlavorPending);
  const aiFlavorBatchPending = useUiStore((s) => s.aiFlavorBatchPending);
  const activeRevisionTask = useUiStore((s) => s.activeRevisionTask);
  const activeRevisionPreview = useUiStore((s) => s.activeRevisionPreview);
  const draftActionLoading = useUiStore((s) => s.draftActionLoading);
  const projectPath = useNavigationStore((s) => s.projectPath);
  const activeBookId = useNavigationStore((s) => s.activeBookId);
  const openProjectError = useNavigationStore((s) => s.openProjectError);
  const openProjectLoading = useNavigationStore((s) => s.openProjectLoading);
  const recentBooks = useRecentBooksStore((s) => s.books);
  const themeMode = useThemeStore((s) => s.mode);
  const toggleTheme = useThemeStore((s) => s.toggle);

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

  const refreshWorkspaceFromOverview = navigation.refreshWorkspaceFromOverview;

  const appendMessage = (message: import("./types.js").ChapterMessage) => {
    useChatStore.getState().appendMessage(message);
  };

  const workflow = useWorkflowActions({
    projectPath,
    appendMessage,
  });

  const { handleSendMessage, handleSuggestedAction, handleSendUserAction, handleChapterButton, undoToTurn, stopAgent } = useChat({
    projectPath,
    handleApplyRevisionPreview: workflow.handleApplyRevisionPreview,
    refreshWorkspaceFromOverview,
  });

  /* ---- 存盘（重构 P5）：稿子归 draftSync（作者改字时自己排），对话归 chatSync，这里只管「消息变了」和「页面要关」 ---- */
  useEffect(() => {
    if (!workspaceReady || !projectPath) return;
    scheduleChatSave();
  }, [workspaceReady, projectPath, messages]);

  useEffect(() => {
    // 关窗 / 刷新：keepalive 发出最后一笔，不等回执。
    const onHide = () => saveAllKeepalive();
    // 只是切后台：页面还活着，走常规保存。
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flushAllSaves({ background: true });
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /* ---- Initial routing useEffect ---- */
  useEffect(() => {
    // 首次挂载走 onBusy:"silent"（长跑 #1）：StrictMode 挂载期同步双跑本 effect，第一次 openHome 还
    // await 在 flushAutosaveNow 里没走完 finally，第二次就撞上单槽忙碌守卫——误弹「已有操作正在进行，
    // 暂不能返回首页」。启动路由回放撞忙只静默放弃（第一次正在去的正是同一个路由）；popstate 是
    // 用户驱动的导航，保持默认弹 toast 如实告知。
    const applyRoute = (initial = false) => {
      const route = readWorkspaceRoute();
      const onBusy = initial ? ("silent" as const) : ("toast" as const);
      if (route.type === "book") {
        navigation.openRecentBook(route.bookId, { updateUrl: false, onBusy });
        return;
      }
      if (route.type === "project") {
        void navigation.openProject(route.projectPath, { updateUrl: false, onBusy });
        return;
      }
      navigation.openHome({ updateUrl: false, onBusy });
    };
    applyRoute(true);
    const onPopState = (): void => applyRoute(false);
    window.addEventListener("popstate", onPopState);

    // 首页启动时扫描默认目录，归并进书架（服务端真值刷新已有条目 + 按活跃时间排序；
    // 别再逐本 upsertBook 头插——那会把服务端的「最近活跃降序」反转，最旧的书霸占 books[0]）
    void (async () => {
      try {
        const library = await fetchDefaultBookLibrary();
        useRecentBooksStore.getState().syncScannedBooks(library.books, library);
      } catch {
        // 扫描失败不影响首页加载
      }
    })();

    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Derived values for workspace props ---- */
  const steeringDirection = useUiStore((s) => s.steeringDirection);
  const steeringDraft = useUiStore((s) => s.steeringDraft);
  const steeringError = useUiStore((s) => s.steeringError);
  const steeringLoading = useUiStore((s) => s.steeringLoading);
  const chatLoading = useChatStore((s) => s.chatLoading);
  const chatError = useChatStore((s) => s.chatError);
  const sidebar = useBookStore((s) => s.sidebar);

  /* ---- Dialogs ---- */
  // 设置只留一套（P6 第 6 步）：书架也开写作台那个设置弹窗。弹窗样式在 .codex-app 作用域里，外面套一层零高度的壳。
  const settingsDialog = settingsOpen ? (
    <div className="codex-app se-settings-host">
      <SettingsModal tab={settingsTab} onTab={setSettingsTab} onClose={() => { closeSettings(); setSettingsTab("model"); }} />
    </div>
  ) : null;

  const usageDialog = usageOpen ? (
    <UsageDialog error={usageError} loading={usageLoading} summary={usageSummary} onClose={closeUsage} />
  ) : null;

  /* ---- Render ---- */
  // 地址栏就是某本书（刷新写作台、桌面版重开）而书还在加载：先给一个安静的「正在打开」，
  // 别先闪一下书架再跳进书里。打开失败（openProjectError）照常落回书架并提示。
  if (!workspaceReady && readWorkspaceRoute().type !== "home" && !openProjectError) {
    return (
      <div className="se-boot" role="status" aria-live="polite">
        <span className="se-boot-dot" aria-hidden="true" />
        正在打开…
      </div>
    );
  }
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
              onImportBook: (input) => navigation.handleImportBook(input),
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
            onFixAiFlavorViolation: workflow.handleFixAiFlavorViolation,
            onFixAllAiFlavorViolations: workflow.handleFixAiFlavorAll,
            onGenerateRevisionPreview: () => void workflow.handleGenerateRevisionPreview(),
            onApplyRevisionPreview: () => void workflow.handleApplyRevisionPreview(),
            onDismissRevisionTask: workflow.handleDismissRevisionTask,
            onGoHome: () => navigation.openHome(),
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
            onSuggestedAction: handleSuggestedAction,
            onSendMessage: handleSendMessage,
            onSendUserAction: handleSendUserAction,
            onChapterButton: handleChapterButton,
            onStopAgent: stopAgent,
            onClearChat: () => {
              if (useChatStore.getState().messages.length === 0) return;
              useChatStore.getState().clearChat();
              useNavigationStore.getState().showToast("已清空对话（正文和资料不受影响，可撤销）", 4000);
              // 清空是作者明确的动作：空对话也要写进会话文件，否则刷新后又回来。
              void saveChatNow({ allowEmpty: true }).then((result) => {
                if (!result.ok) {
                  useNavigationStore.getState().showToast(`清空没写进会话文件（${result.error}），刷新后对话可能恢复。`, 5000);
                }
              });
            },
            onUndoClearChat: () => {
              useChatStore.getState().undoClearChat();
              void saveChatNow().then((result) => {
                if (!result.ok) {
                  useNavigationStore.getState().showToast(`恢复没写进会话文件（${result.error}），刷新后可能仍是清空的。`, 5000);
                }
              });
            },
            canUndoClearChat: clearedChatBackup !== null,
            onUndoToTurn: (message) => void undoToTurn(message),
            onSteeringDirectionChange: (value) => {
              useUiStore.getState().setSteeringDirection(value);
              if (useUiStore.getState().steeringError) useUiStore.getState().setSteeringError(null);
              if (useChatStore.getState().chatError) useChatStore.getState().setChatError(null);
            },
            onDraftContentChange: (content: string) => {
              editDraft(content, extractDraftTitle(content) ?? undefined);
              // 作者自己写出了正文：章节状态跟着进「有草稿」，下面的按钮换成核账 / 审稿 / 定稿
              // （2026-10-10 验收：作者贴完一整章，状态还是「待开始」，只给「写这一章 / 先给方案」两个让 AI 写的按钮）。
              const wsBook = useBookStore.getState();
              if ((wsBook.workspace.flowStatus === "idle" || wsBook.workspace.flowStatus === "steering_ready") && isRealDraftContent(content)) {
                wsBook.updateWorkspace({ flowStatus: "draft_ready" });
              }
            },
            onSelectionRewrite: workflow.handleSelectionRewrite,
            onSelectionRewriteCustom: workflow.handleSelectionRewriteCustom,
            onReroll: () => void workflow.handleRerollCandidates(),
            onApplyCandidate: (content: string) => void workflow.handleApplyCandidate(content),
            onCloseCandidates: workflow.handleCloseCandidates,
            onToggleTheme: toggleTheme,
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
    </>
  );
}
