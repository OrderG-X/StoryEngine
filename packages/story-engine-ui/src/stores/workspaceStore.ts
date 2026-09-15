import { create } from "zustand";
import type {
  ChapterMessage,
  ChapterWorkspaceData,
  CommitPreviewUiReport,
  CommitSelectiveConfirmationState,
  DraftPreview,
  LastFormalCommitApply,
  SidebarData,
} from "../types.js";
import type { ChatSessionIndexEntry, WorkspaceDraftCandidate, WorkspaceRevisionPreview } from "../type-defs/workspace.js";
import type {
  ChapterSteeringDraft,
  DraftAIReviewReport,
  DraftRevisionTask,
  FoundationGapApplyPlan,
  FoundationGapDecision,
  FoundationGapReport,
  FoundationGapSuggestion,
  StateOverview,
} from "../api/types.js";
import { mockWorkspaceData, mockSidebarData } from "../mockData.js";

/* ------------------------------------------------------------------ */
/*  Message persistence                                                */
/* ------------------------------------------------------------------ */

const MESSAGES_STORAGE_KEY = "se-ng-chat-messages";

let currentProjectKey: string | null = null;

function getProjectStorageKey(projectKey: string | null): string {
  return `${MESSAGES_STORAGE_KEY}:${projectKey ?? "default"}`;
}

function loadMessages(projectKey: string | null): readonly ChapterMessage[] {
  try {
    const raw = sessionStorage.getItem(getProjectStorageKey(projectKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMessagesSync(messages: readonly ChapterMessage[], projectKey: string | null): void {
  try {
    sessionStorage.setItem(getProjectStorageKey(projectKey), JSON.stringify(messages));
  } catch {
    // Ignore quota errors
  }
}

// 流式更新期间 updateMessage 每个增量都调 saveMessages：整条历史 JSON.stringify + 同步 setItem
// 在主线程上是 O(回合字数 × 历史条数)，长稿流到几千 token 会把 UI 卡顿成幻灯片。节流到至多每
// 250ms 写一次，且总是写「最新一条」——首次调用排期、期间只刷新待写值、到点落盘最终状态。
const MESSAGE_SAVE_THROTTLE_MS = 250;
let pendingSave: { readonly messages: readonly ChapterMessage[]; readonly projectKey: string | null } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveMessages(messages: readonly ChapterMessage[], projectKey: string | null): void {
  pendingSave = { messages, projectKey };
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pendingSave === null) return;
    const pending = pendingSave;
    pendingSave = null;
    writeMessagesSync(pending.messages, pending.projectKey);
  }, MESSAGE_SAVE_THROTTLE_MS);
}

/**
 * 立即把节流里攒着的待写尾巴同步落盘。撤销重载（undoToTurn 写完截断立刻 window.location.reload）
 * 与切项目（setProjectKey）前必须调：节流窗口内的 reload 会读到旧 sessionStorage，孤儿气泡复活。
 */
export function flushPendingMessageSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSave === null) return;
  const pending = pendingSave;
  pendingSave = null;
  writeMessagesSync(pending.messages, pending.projectKey);
}

function clearMessages(projectKey: string | null): void {
  try {
    sessionStorage.removeItem(getProjectStorageKey(projectKey));
  } catch {
    // Ignore
  }
}

export function setProjectKey(projectKey: string | null): void {
  // 切走前把上一项目的待写尾巴落盘（写的是它自己当时的 key），否则新项目的 sessionStorage 会覆盖掉尾巴。
  flushPendingMessageSave();
  currentProjectKey = projectKey;
  const persistedMessages = loadMessages(projectKey);
  if (persistedMessages.length === 0) return;
  const state = useWorkspaceStore.getState();
  if (!shouldHydrateProjectMessages(state.workspace.messages)) return;
  state.updateWorkspace({ messages: persistedMessages });
}

function shouldHydrateProjectMessages(messages: readonly ChapterMessage[]): boolean {
  if (messages.length === 0) return true;
  return messages.every((message) => message.id.startsWith("assistant-workflow-"));
}

/* ------------------------------------------------------------------ */
/*  Local helper types not exported from the types modules             */
/* ------------------------------------------------------------------ */

export interface SelectedAdviceCard {
  readonly key: string;
  readonly card: import("../api/types.js").ChapterAdviceCard;
}

/* ------------------------------------------------------------------ */
/*  Commit selections factory                                          */
/* ------------------------------------------------------------------ */

export function emptyCommitSelections(): CommitSelectiveConfirmationState {
  return { assets: {}, locations: {}, characterKnowledge: {} };
}

/** 抽卡候选（块③）：「再来一版」临时生成的一版正文（含标题），挑中才落盘。 */
export type DraftCandidate = WorkspaceDraftCandidate;

/* ------------------------------------------------------------------ */
/*  Store interface                                                    */
/* ------------------------------------------------------------------ */

export interface WorkspaceStore {
  /* ---- state ---- */
  workspace: ChapterWorkspaceData;
  sidebar: SidebarData;
  currentOverview: StateOverview | null;
  steeringDirection: string;
  lastChapterDirection: string;
  steeringDraft: ChapterSteeringDraft | null;
  steeringError: string | null;
  steeringLoading: boolean;
  chatLoading: boolean;
  chatError: string | null;
  /** 改稿低把握度「先问」时暂存的待确认改稿指令；下一轮用户确认即执行。 */
  pendingDirectEditInstruction: string | null;
  draftActionLoading: string | null;
  /** 抽卡（块③）：「再来一版」生成的 2–3 个临时候选；非 null 即展开并排候选面板，挑中才落盘。 */
  draftCandidates: readonly DraftCandidate[] | null;
  selectedAdviceCards: readonly SelectedAdviceCard[];
  commitPreviewReport: CommitPreviewUiReport | null;
  commitSelections: CommitSelectiveConfirmationState;
  lastFormalCommitApply: LastFormalCommitApply | null;
  draftAIReview: DraftAIReviewReport | null;
  /** 体检卡「改掉这句」当前在改的违规（跨 preview→apply 异步间隙保活）：哪条消息的哪条违规。
   *  应用成功后据它把该违规标「已改」；卡片据它显示「改写中…」。非改写期为 null。 */
  aiFlavorPending: { readonly messageId: string; readonly violationId: string } | null;
  /** 一键全修进行中的卡片 messageId（非 null 时该卡显示「一键全修中…」、禁重复点）。 */
  aiFlavorBatchPending: string | null;
  activeRevisionTask: DraftRevisionTask | null;
  activeRevisionPreview: WorkspaceRevisionPreview | null;
  /** 正文「刚改片段」黄高亮的定位锚（=改写后的新文本，可多处）；非空时 WritingPaper 在正文里高亮并滚到首处。用户编辑/切章/新改写时清。 */
  revisionHighlightTexts: readonly string[];
  foundationGapReport: FoundationGapReport | null;
  foundationGapSuggestions: readonly FoundationGapSuggestion[];
  foundationGapDecisions: Readonly<Record<string, FoundationGapDecision["decision"]>>;
  foundationGapApplyPlan: FoundationGapApplyPlan | null;
  foundationGapLoading: string | null;
  foundationGapError: string | null;
  sessions: readonly ChatSessionIndexEntry[];
  activeSessionId: string;
  activeArchivedCount: number;
  chatHistoryBudget: number;
  /** 当前已加载章节 workspace 的服务端 revision（CAS 基线）。 */
  workspaceRevision: number;

  /* ---- setters ---- */
  setWorkspace: (workspace: ChapterWorkspaceData) => void;
  setSidebar: (sidebar: SidebarData) => void;
  setCurrentOverview: (overview: StateOverview | null) => void;
  setSteeringDirection: (value: string) => void;
  setLastChapterDirection: (value: string) => void;
  setSteeringDraft: (draft: ChapterSteeringDraft | null) => void;
  setSteeringError: (error: string | null) => void;
  setSteeringLoading: (loading: boolean) => void;
  setChatLoading: (loading: boolean) => void;
  setChatError: (error: string | null) => void;
  setPendingDirectEditInstruction: (instruction: string | null) => void;
  setDraftActionLoading: (loading: string | null) => void;
  setDraftCandidates: (candidates: readonly DraftCandidate[] | null) => void;
  setSelectedAdviceCards: (cards: readonly SelectedAdviceCard[]) => void;
  setCommitPreviewReport: (report: CommitPreviewUiReport | null) => void;
  setCommitSelections: (selections: CommitSelectiveConfirmationState) => void;
  setLastFormalCommitApply: (result: LastFormalCommitApply | null) => void;
  setDraftAIReview: (review: DraftAIReviewReport | null) => void;
  setAiFlavorPending: (pending: { readonly messageId: string; readonly violationId: string } | null) => void;
  setAiFlavorBatchPending: (messageId: string | null) => void;
  /** 把某条消息里的某条违规标为「已改」（追加进该消息的 aiFlavorFixedIds，去重）。 */
  markAiFlavorViolationFixed: (messageId: string, violationId: string) => void;
  setActiveRevisionTask: (task: DraftRevisionTask | null) => void;
  setActiveRevisionPreview: (preview: WorkspaceRevisionPreview | null) => void;
  setRevisionHighlight: (text: string | null) => void;
  /** 一键全修：一次高亮多处改动（按改后文本定位）；传空清空。 */
  setRevisionHighlights: (texts: readonly string[]) => void;
  setFoundationGapReport: (report: FoundationGapReport | null) => void;
  setFoundationGapSuggestions: (suggestions: readonly FoundationGapSuggestion[]) => void;
  setFoundationGapDecisions: (decisions: Readonly<Record<string, FoundationGapDecision["decision"]>>) => void;
  setFoundationGapApplyPlan: (plan: FoundationGapApplyPlan | null) => void;
  setFoundationGapLoading: (loading: string | null) => void;
  setFoundationGapError: (error: string | null) => void;
  setSessions: (sessions: readonly ChatSessionIndexEntry[], activeSessionId?: string) => void;
  setActiveSessionId: (activeSessionId: string) => void;
  setActiveArchivedCount: (activeArchivedCount: number) => void;
  setChatHistoryBudget: (budget: number) => void;
  setWorkspaceRevision: (revision: number) => void;

  /* ---- compound setters ---- */
  setError: (field: "steering" | "chat", error: string | null) => void;

  /* ---- domain actions ---- */
  updateWorkspace: (partial: Partial<ChapterWorkspaceData>) => void;
  updateDraft: (partial: Partial<DraftPreview>) => void;
  appendMessage: (message: ChapterMessage) => void;
  updateMessage: (id: string, updater: (message: ChapterMessage) => ChapterMessage) => void;
  /** 清空对话的回退备份：非 null 时可撤销刚才的清空（继续对话即清掉入口）。 */
  readonly clearedChatBackup: readonly ChapterMessage[] | null;
  /** 清空当前对话（备份原消息以供撤销）。不影响正文与资料。 */
  clearChat: () => void;
  /** 撤销上一次清空，恢复对话。 */
  undoClearChat: () => void;
  resetSteeringState: () => void;
  resetCommitState: () => void;
  resetRevisionState: () => void;
  resetFoundationGaps: () => void;
  /** 切项目/开书前清掉所有「当前操作在飞」的项目级临时态，防跨书串写（M7：A书候选稿挂到B书）。 */
  resetTransientWorkspaceState: () => void;
}

/* ------------------------------------------------------------------ */
/*  Store implementation                                               */
/* ------------------------------------------------------------------ */

const persistedMessages = loadMessages(currentProjectKey);
// Initial chat history must never fall back to mockData's demo messages
// (msg-001/msg-002 end-of-world seed): those leak into real projects and pollute
// the chat conversation history. Real sessions start empty; openProject /
// ensureWorkflowPrompt produce the clean greeting from the backend state overview.
const initialMessages = persistedMessages.length > 0
  ? persistedMessages
  : [];

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  /* ---- initial state ---- */
  workspace: { ...mockWorkspaceData, messages: initialMessages },
  sidebar: { ...mockSidebarData },
  currentOverview: null,
  steeringDirection: "",
  lastChapterDirection: "",
  steeringDraft: null,
  steeringError: null,
  steeringLoading: false,
  chatLoading: false,
  chatError: null,
  clearedChatBackup: null,
  pendingDirectEditInstruction: null,
  draftActionLoading: null,
  draftCandidates: null,
  selectedAdviceCards: [],
  commitPreviewReport: null,
  commitSelections: emptyCommitSelections(),
  lastFormalCommitApply: null,
  draftAIReview: null,
  aiFlavorPending: null, aiFlavorBatchPending: null,
  activeRevisionTask: null,
  activeRevisionPreview: null,
  revisionHighlightTexts: [],
  foundationGapReport: null,
  foundationGapSuggestions: [],
  foundationGapDecisions: {},
  foundationGapApplyPlan: null,
  foundationGapLoading: null,
  foundationGapError: null,
  sessions: [],
  activeSessionId: "",
  activeArchivedCount: 0,
  chatHistoryBudget: 96000,
  workspaceRevision: 0,

  /* ---- simple setters ---- */
  setWorkspace: (workspace) => {
    // Clear persisted messages when switching to a fresh workspace
    if (workspace.messages.length === 0) {
      clearMessages(currentProjectKey);
    }
    set({ workspace });
  },
  setSidebar: (sidebar) => set({ sidebar }),
  setCurrentOverview: (overview) => set({ currentOverview: overview }),
  setSteeringDirection: (value) => set({ steeringDirection: value }),
  setLastChapterDirection: (value) => set({ lastChapterDirection: value }),
  setSteeringDraft: (draft) => set({ steeringDraft: draft }),
  setSteeringError: (error) => set({ steeringError: error }),
  setSteeringLoading: (loading) => set({ steeringLoading: loading }),
  setChatLoading: (loading) => set({ chatLoading: loading }),
  setChatError: (error) => set({ chatError: error }),
  setPendingDirectEditInstruction: (instruction) => set({ pendingDirectEditInstruction: instruction }),
  setDraftActionLoading: (loading) => set({ draftActionLoading: loading }),
  setDraftCandidates: (candidates) => set({ draftCandidates: candidates }),
  setSelectedAdviceCards: (cards) => set({ selectedAdviceCards: cards }),
  setCommitPreviewReport: (report) => set({ commitPreviewReport: report }),
  setCommitSelections: (selections) => set({ commitSelections: selections }),
  setLastFormalCommitApply: (result) => set({ lastFormalCommitApply: result }),
  setDraftAIReview: (review) => set({ draftAIReview: review }),
  setAiFlavorPending: (pending) => set({ aiFlavorPending: pending }),
  setAiFlavorBatchPending: (messageId) => set({ aiFlavorBatchPending: messageId }),
  markAiFlavorViolationFixed: (messageId, violationId) =>
    set((state) => {
      const newMessages = state.workspace.messages.map((message) => (
        message.id === messageId && !(message.aiFlavorFixedIds ?? []).includes(violationId)
          ? { ...message, aiFlavorFixedIds: [...(message.aiFlavorFixedIds ?? []), violationId] }
          : message
      ));
      saveMessages(newMessages, currentProjectKey);
      return { workspace: { ...state.workspace, messages: newMessages } };
    }),
  setActiveRevisionTask: (task) => set({ activeRevisionTask: task }),
  setActiveRevisionPreview: (preview) => set({ activeRevisionPreview: preview }),
  setRevisionHighlight: (text) => set({ revisionHighlightTexts: text ? [text] : [] }),
  setRevisionHighlights: (texts) => set({ revisionHighlightTexts: texts }),
  setFoundationGapReport: (report) => set({ foundationGapReport: report }),
  setFoundationGapSuggestions: (suggestions) => set({ foundationGapSuggestions: suggestions }),
  setFoundationGapDecisions: (decisions) => set({ foundationGapDecisions: decisions }),
  setFoundationGapApplyPlan: (plan) => set({ foundationGapApplyPlan: plan }),
  setFoundationGapLoading: (loading) => set({ foundationGapLoading: loading }),
  setFoundationGapError: (error) => set({ foundationGapError: error }),
  setSessions: (sessions, activeSessionId) =>
    set({ sessions, ...(activeSessionId !== undefined ? { activeSessionId } : {}) }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setActiveArchivedCount: (activeArchivedCount) => set({ activeArchivedCount }),
  setChatHistoryBudget: (budget) => set({ chatHistoryBudget: budget }),
  setWorkspaceRevision: (workspaceRevision) => set({ workspaceRevision }),

  /* ---- compound setters ---- */
  setError: (field, error) => {
    if (field === "steering") {
      set({ steeringError: error });
    } else {
      set({ chatError: error });
    }
  },

  /* ---- domain actions ---- */
  updateWorkspace: (partial) =>
    set((state) => {
      if (partial.messages !== undefined) {
        saveMessages(partial.messages, currentProjectKey);
      }
      return {
        workspace: { ...state.workspace, ...partial },
      };
    }),

  updateDraft: (partial) =>
    set((state) => ({
      workspace: {
        ...state.workspace,
        draft: { ...state.workspace.draft, ...partial },
      },
    })),

  appendMessage: (message) =>
    set((state) => {
      const newMessages = [...state.workspace.messages, message];
      saveMessages(newMessages, currentProjectKey);
      return {
        workspace: {
          ...state.workspace,
          messages: newMessages,
        },
        // 一旦继续对话，撤销「清空」的入口就消失。
        clearedChatBackup: null,
      };
    }),

  clearChat: () =>
    set((state) => {
      const current = state.workspace.messages;
      if (current.length === 0) return {};
      saveMessages([], currentProjectKey);
      return {
        workspace: { ...state.workspace, messages: [] },
        clearedChatBackup: current,
      };
    }),

  undoClearChat: () =>
    set((state) => {
      const backup = state.clearedChatBackup;
      if (!backup) return {};
      saveMessages(backup, currentProjectKey);
      return {
        workspace: { ...state.workspace, messages: backup },
        clearedChatBackup: null,
      };
    }),

  updateMessage: (id, updater) =>
    set((state) => {
      const newMessages = state.workspace.messages.map((message) => (
        message.id === id ? updater(message) : message
      ));
      saveMessages(newMessages, currentProjectKey);
      return {
        workspace: {
          ...state.workspace,
          messages: newMessages,
        },
      };
    }),

  resetSteeringState: () =>
    set({
      steeringDirection: "",
      steeringDraft: null,
      steeringError: null,
      steeringLoading: false,
    }),

  resetCommitState: () =>
    set({
      commitPreviewReport: null,
      commitSelections: emptyCommitSelections(),
    }),

  resetRevisionState: () =>
    set({
      activeRevisionTask: null,
      activeRevisionPreview: null,
      revisionHighlightTexts: [],
      aiFlavorPending: null, aiFlavorBatchPending: null,
    }),

  resetFoundationGaps: () =>
    set({
      foundationGapReport: null,
      foundationGapSuggestions: [],
      foundationGapDecisions: {},
      foundationGapApplyPlan: null,
      foundationGapLoading: null,
      foundationGapError: null,
    }),

  // M7：切项目/开书前清掉所有「当前操作在飞」的项目级临时态——尤其 draftCandidates（A书候选稿若残留，
  // 切到B书点「用这版」会把A的内容写进B草稿）。这些都不该跨项目存活，openProject 开头统一清。
  resetTransientWorkspaceState: () =>
    set({
      draftCandidates: null,
      commitPreviewReport: null,
      draftAIReview: null,
      aiFlavorPending: null, aiFlavorBatchPending: null,
      activeRevisionTask: null,
      activeRevisionPreview: null,
      revisionHighlightTexts: [],
      steeringDraft: null,
      steeringError: null,
      pendingDirectEditInstruction: null,
    }),
}));
