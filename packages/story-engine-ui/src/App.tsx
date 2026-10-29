import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import ImmersiveAppShell from "./components/v2/ImmersiveAppShell.js";
import { SettingsModal, type SettingsTab } from "./components/v2/codex/SettingsModal.js";
import { useNavigationStore } from "./stores/navigationStore.js";
import { useBookStore } from "./stores/bookStore.js";
import { useChatStore } from "./stores/chatStore.js";
import { useUiStore } from "./stores/uiStore.js";
import { useRecentBooksStore } from "./stores/recentBooksStore.js";
import { useThemeStore } from "./stores/themeStore.js";
import { useBookManagement } from "./hooks/useBookManagement.js";
import { usePresence } from "./hooks/usePresence.js";
import { useProjectNavigation } from "./hooks/useProjectNavigation.js";
import { useDraftPicks } from "./hooks/useDraftPicks.js";
import { useChat } from "./hooks/useChat.js";
import { useDraftEdits } from "./hooks/useDraftEdits.js";
import { setChatSessionSaveSkippedNotifier } from "./api/chatSessionsClient.js";
import { countTextWords } from "./utils/textUtils.js";
import { readWorkspaceRoute } from "./utils/routing.js";
import { isRealDraftContent } from "./utils/draftContent.js";
import { editDraft, flushDraftSave, hasFailedUnsavedDraft } from "./drafts/draftSync.js";
import { saveChatNow, scheduleChatSave } from "./sync/chatSync.js";
import { flushAllSaves, saveAllKeepalive } from "./sync/saveAll.js";
import type { ChapterNavItem, LastFormalCommitApply } from "./types.js";
import { AppToast } from "./components/v2/AppToast.js";

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
  const closeSettings = useNavigationStore((s) => s.closeSettings);
  const openSettings = useNavigationStore((s) => s.openSettings);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");
  // 关设置先播完退场；播完再把页签拨回「模型」（不然关的那一下会闪到模型页）。
  const settingsPresence = usePresence(settingsOpen);
  useEffect(() => { if (!settingsPresence.mounted) setSettingsTab("model"); }, [settingsPresence.mounted]);

  const workspace = useBookStore((s) => s.workspace);
  const messages = useChatStore((s) => s.messages);
  const clearedChatBackup = useChatStore((s) => s.clearedChatBackup);
  const currentOverview = useBookStore((s) => s.currentOverview);
  const commitPreviewReport = useUiStore((s) => s.commitPreviewReport);
  const lastFormalCommitApply = useUiStore((s) => s.lastFormalCommitApply);
  const draftAIReview = useUiStore((s) => s.draftAIReview);
  const aiFlavorPending = useUiStore((s) => s.aiFlavorPending);
  const aiFlavorBatchPending = useUiStore((s) => s.aiFlavorBatchPending);
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


  const { handleSendMessage, handleSuggestedAction, handleSendUserAction, handleChapterButton, undoToTurn, stopAgent } = useChat({
    projectPath,
    refreshWorkspaceFromOverview,
  });

  const edits = useDraftEdits({ sendUserAction: handleSendUserAction });
  const picks = useDraftPicks({ sendUserAction: handleSendUserAction });

  /* ---- 存盘（重构 P5）：稿子归 draftSync（作者改字时自己排），对话归 chatSync，这里只管「消息变了」和「页面要关」 ---- */
  useEffect(() => {
    if (!workspaceReady || !projectPath) return;
    scheduleChatSave();
  }, [workspaceReady, projectPath, messages]);

  useEffect(() => {
    // 关窗 / 刷新：keepalive 发出最后一笔，不等回执。
    const onHide = () => saveAllKeepalive();
    // 上一笔明确没存上：拦下离页（浏览器 / 桌面壳会问作者），马上再正常存一次；作者仍要关，pagehide 照样补发 keepalive。
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasFailedUnsavedDraft()) {
        saveAllKeepalive();
        return;
      }
      event.preventDefault();
      event.returnValue = "";
      void flushDraftSave();
    };
    // 只是切后台：页面还活着，走常规保存。
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flushAllSaves();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
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

    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Derived values for workspace props ---- */
  const steeringDirection = useUiStore((s) => s.steeringDirection);
  const chatLoading = useChatStore((s) => s.chatLoading);
  const chatError = useChatStore((s) => s.chatError);

  /* ---- Dialogs ---- */
  // 设置只留一套（P6 第 6 步）：书架也开写作台那个设置弹窗。弹窗样式在 .codex-app 作用域里，外面套一层零高度的壳。
  const settingsDialog = settingsPresence.mounted ? (
    <div className="codex-app se-settings-host">
      <SettingsModal tab={settingsTab} onTab={setSettingsTab} onClose={closeSettings} presence={settingsPresence} />
    </div>
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
        <AppToast message={toast} />
        <ErrorBoundary fallbackTitle="设置对话框出错">
          {settingsDialog}
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
            steeringDirection,
            chatLoading,
            chatError,
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
            themeMode,
            workspace,
            onFixAiFlavorViolation: edits.handleFixAiFlavorViolation,
            onFixAllAiFlavorViolations: edits.handleFixAiFlavorAll,
            onGoHome: () => navigation.openHome(),
            onOpenSettings: openSettings,
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
              if (useChatStore.getState().chatError) useChatStore.getState().setChatError(null);
            },
            onDraftContentChange: (content: string) => {
              editDraft(content);
              // 作者自己写出了正文：章节状态跟着进「有草稿」，下面的按钮换成核账 / 审稿 / 定稿
              // （2026-10-10 验收：作者贴完一整章，状态还是「待开始」，只给「写这一章 / 先给方案」两个让 AI 写的按钮）。
              const wsBook = useBookStore.getState();
              if ((wsBook.workspace.flowStatus === "idle" || wsBook.workspace.flowStatus === "steering_ready") && isRealDraftContent(content)) {
                wsBook.updateWorkspace({ flowStatus: "draft_ready" });
              }
            },
            onSelectionRewrite: edits.handleSelectionRewrite,
            onSelectionRewriteCustom: edits.handleSelectionRewriteCustom,
            onReroll: () => void picks.rerollVersions(),
            onApplyCandidate: (candidate) => void picks.adoptVersion(candidate),
            onCloseCandidates: () => useUiStore.getState().setDraftCandidates(null),
            onPendingCandidate: picks.decidePending,
            onToggleTheme: toggleTheme,
            overview: currentOverview,
          }}
        />
      </ErrorBoundary>
      <AppToast message={toast} />
      <ErrorBoundary fallbackTitle="设置对话框出错">
        {settingsDialog}
      </ErrorBoundary>
    </>
  );
}
