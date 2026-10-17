import { create } from "zustand";
import type {
  ChapterMessage,
  ChapterWorkspaceData,
  CommitPreviewUiReport,
  CommitSelectiveConfirmationState,
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

/** AI 出稿的阶段：拟章纲 / 写正文。 */
export type DraftPhase = "plan" | "write";

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
  draftActionLoading: string | null;
  /** AI 出稿进行到哪一步（服务端 draft-delta 带 phase 推过来）：plan=拟章纲，write=写正文；不在出稿为 null。稿纸空着时显示给作者看。 */
  draftPhase: DraftPhase | null;
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
  setDraftActionLoading: (loading: string | null) => void;
  setDraftPhase: (phase: DraftPhase | null) => void;
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
  setSessions: (sessions: readonly ChatSessionIndexEntry[], activeSessionId?: string) => void;
  setActiveSessionId: (activeSessionId: string) => void;
  setActiveArchivedCount: (activeArchivedCount: number) => void;
  setChatHistoryBudget: (budget: number) => void;

  /* ---- compound setters ---- */
  setError: (field: "steering" | "chat", error: string | null) => void;

  /* ---- domain actions ---- */
  updateWorkspace: (partial: Partial<ChapterWorkspaceData>) => void;
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

// 对话不再在浏览器里另存一份（重构 P5）：开书时从项目里的会话文件读，见 useProjectNavigation。
export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  /* ---- initial state ---- */
  workspace: { ...mockWorkspaceData, messages: [] },
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
  draftActionLoading: null,
  draftPhase: null,
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

  /* ---- simple setters ---- */
  setWorkspace: (workspace) => set({ workspace }),
  setSidebar: (sidebar) => set({ sidebar }),
  setCurrentOverview: (overview) => set({ currentOverview: overview }),
  setSteeringDirection: (value) => set({ steeringDirection: value }),
  setLastChapterDirection: (value) => set({ lastChapterDirection: value }),
  setSteeringDraft: (draft) => set({ steeringDraft: draft }),
  setSteeringError: (error) => set({ steeringError: error }),
  setSteeringLoading: (loading) => set({ steeringLoading: loading }),
  setChatLoading: (loading) => set({ chatLoading: loading }),
  setChatError: (error) => set({ chatError: error }),
  setDraftActionLoading: (loading) => set({ draftActionLoading: loading }),
  setDraftPhase: (phase) => set({ draftPhase: phase }),
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
      return { workspace: { ...state.workspace, messages: newMessages } };
    }),
  setActiveRevisionTask: (task) => set({ activeRevisionTask: task }),
  setActiveRevisionPreview: (preview) => set({ activeRevisionPreview: preview }),
  setRevisionHighlight: (text) => set({ revisionHighlightTexts: text ? [text] : [] }),
  setRevisionHighlights: (texts) => set({ revisionHighlightTexts: texts }),
  setSessions: (sessions, activeSessionId) =>
    set({ sessions, ...(activeSessionId !== undefined ? { activeSessionId } : {}) }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setActiveArchivedCount: (activeArchivedCount) => set({ activeArchivedCount }),
  setChatHistoryBudget: (budget) => set({ chatHistoryBudget: budget }),

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
    set((state) => ({
      workspace: { ...state.workspace, ...partial },
    })),

  appendMessage: (message) =>
    set((state) => {
      const newMessages = [...state.workspace.messages, message];
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
      return {
        workspace: { ...state.workspace, messages: [] },
        clearedChatBackup: current,
      };
    }),

  undoClearChat: () =>
    set((state) => {
      const backup = state.clearedChatBackup;
      if (!backup) return {};
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
    }),
}));
