/**
 * 只活在界面里的临时态（重构 P5：从 workspaceStore 拆出）：章纲方向、改稿高亮、定稿勾选、候选稿、
 * 资料补全、各种 loading。不存盘；换书、撤销后清掉（resetTransientUiState）。
 */
import { create } from "zustand";
import type {
  CommitPreviewUiReport,
  CommitSelectiveConfirmationState,
  LastFormalCommitApply,
} from "../types.js";
import type { WorkspaceDraftCandidate } from "../type-defs/workspace.js";
import type { DraftAIReviewReport } from "../api/types.js";

export function emptyCommitSelections(): CommitSelectiveConfirmationState {
  return { assets: {}, locations: {}, characterKnowledge: {} };
}

/** 抽卡候选（块③）：「再来一版」临时生成的一版正文（含标题），挑中才落盘。 */
export type DraftCandidate = WorkspaceDraftCandidate;

/** AI 出稿的阶段：拟章纲 / 写正文。 */
/** 出稿阶段：拟章纲 / 写正文 / 写完核对前文并按核账改（稿纸上照阶段提示作者）。 */
export type DraftPhase = "plan" | "write" | "check";

export interface UiStore {
  steeringDirection: string;
  /** 每章没发出去的输入框草稿（P11）：切章时存下离开那章的、换上要去那章的；换书清空。 */
  composerDrafts: Readonly<Record<number, string>>;
  /** AI 出稿进行到哪一步（服务端 draft-delta 带 phase 推过来）：plan=拟章纲，write=写正文；不在出稿为 null。稿纸空着时显示给作者看。 */
  draftPhase: DraftPhase | null;
  /** AI 另写的几版（片 2D：「另外几版」卡上点开）：非 null 即展开并排面板，挑中一版交 draft.adopt 换上。 */
  draftCandidates: readonly DraftCandidate[] | null;
  commitPreviewReport: CommitPreviewUiReport | null;
  commitSelections: CommitSelectiveConfirmationState;
  lastFormalCommitApply: LastFormalCommitApply | null;
  draftAIReview: DraftAIReviewReport | null;
  /** AI 味卡「改掉这句」当前在改的那句：哪条消息的哪条。改好了据它标「已改」；卡片据它显示「改写中…」。没在改为 null。 */
  aiFlavorPending: { readonly messageId: string; readonly violationId: string } | null;
  /** 一键全修进行中的卡片 messageId（非 null 时该卡显示「一键全修中…」、禁重复点）。 */
  aiFlavorBatchPending: string | null;
  /** 正文「刚改片段」黄高亮的定位锚（=改写后的新文本，可多处）；非空时 WritingPaper 在正文里高亮并滚到首处。用户编辑/切章/新改写时清。 */
  revisionHighlightTexts: readonly string[];

  setSteeringDirection: (value: string) => void;
  /** 切章：把输入框里没发的字记到离开的那章，换上要去那章上次没发的字（没有就空）。 */
  switchComposerChapter: (from: number | null, to: number) => void;
  clearComposerDrafts: () => void;
  setDraftPhase: (phase: DraftPhase | null) => void;
  setDraftCandidates: (candidates: readonly DraftCandidate[] | null) => void;
  setCommitPreviewReport: (report: CommitPreviewUiReport | null) => void;
  setCommitSelections: (selections: CommitSelectiveConfirmationState) => void;
  setLastFormalCommitApply: (result: LastFormalCommitApply | null) => void;
  setDraftAIReview: (review: DraftAIReviewReport | null) => void;
  setAiFlavorPending: (pending: { readonly messageId: string; readonly violationId: string } | null) => void;
  setAiFlavorBatchPending: (messageId: string | null) => void;
  setRevisionHighlight: (text: string | null) => void;
  /** 一键全修：一次高亮多处改动（按改后文本定位）；传空清空。 */
  setRevisionHighlights: (texts: readonly string[]) => void;

  resetSteeringState: () => void;
  resetCommitState: () => void;
  resetRevisionState: () => void;
  /** 切项目、开书、撤销恢复后清掉所有「当前操作在飞」的临时态，防跨书串写（M7：A书候选稿挂到B书）。 */
  resetTransientUiState: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  steeringDirection: "",
  composerDrafts: {},
  draftPhase: null,
  draftCandidates: null,
  commitPreviewReport: null,
  commitSelections: emptyCommitSelections(),
  lastFormalCommitApply: null,
  draftAIReview: null,
  aiFlavorPending: null,
  aiFlavorBatchPending: null,
  revisionHighlightTexts: [],

  setSteeringDirection: (value) => set({ steeringDirection: value }),
  switchComposerChapter: (from, to) => set((state) => {
    const drafts: Record<number, string> = { ...state.composerDrafts };
    if (from !== null && from !== to) {
      if (state.steeringDirection.trim()) drafts[from] = state.steeringDirection;
      else delete drafts[from];
    }
    const next = from === to ? state.steeringDirection : drafts[to] ?? "";
    delete drafts[to];
    return { composerDrafts: drafts, steeringDirection: next };
  }),
  clearComposerDrafts: () => set({ composerDrafts: {} }),
  setDraftPhase: (phase) => set({ draftPhase: phase }),
  setDraftCandidates: (candidates) => set({ draftCandidates: candidates }),
  setCommitPreviewReport: (report) => set({ commitPreviewReport: report }),
  setCommitSelections: (selections) => set({ commitSelections: selections }),
  setLastFormalCommitApply: (result) => set({ lastFormalCommitApply: result }),
  setDraftAIReview: (review) => set({ draftAIReview: review }),
  setAiFlavorPending: (pending) => set({ aiFlavorPending: pending }),
  setAiFlavorBatchPending: (messageId) => set({ aiFlavorBatchPending: messageId }),
  setRevisionHighlight: (text) => set({ revisionHighlightTexts: text ? [text] : [] }),
  setRevisionHighlights: (texts) => set({ revisionHighlightTexts: texts }),

  resetSteeringState: () => set({ steeringDirection: "" }),
  resetCommitState: () => set({ commitPreviewReport: null, commitSelections: emptyCommitSelections() }),
  resetRevisionState: () => set({
    revisionHighlightTexts: [],
    aiFlavorPending: null,
    aiFlavorBatchPending: null,
  }),
  // M7：尤其 draftCandidates（A书候选稿若残留，切到B书点「用这版」会把A的内容写进B草稿）。
  resetTransientUiState: () => set({
    draftCandidates: null,
    commitPreviewReport: null,
    draftAIReview: null,
    aiFlavorPending: null,
    aiFlavorBatchPending: null,
    revisionHighlightTexts: [],
  }),
}));
