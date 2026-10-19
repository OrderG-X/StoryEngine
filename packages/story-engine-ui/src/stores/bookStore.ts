/**
 * 书（重构 P5：从 workspaceStore 拆出）：章节列表、当前章、流程态、状态总览。设定本自己读 GET /api/bible（P9）。
 * 正文在 draftStore，对话在 chatStore，只活在界面里的临时态在 uiStore。
 */
import { create } from "zustand";
import type { ChapterWorkspaceData } from "../types.js";
import type { StateOverview } from "../api/types.js";
import { mockWorkspaceData } from "../mockData.js";

export interface BookStore {
  workspace: ChapterWorkspaceData;
  currentOverview: StateOverview | null;

  setWorkspace: (workspace: ChapterWorkspaceData) => void;
  updateWorkspace: (partial: Partial<ChapterWorkspaceData>) => void;
  setCurrentOverview: (overview: StateOverview | null) => void;
}

export const useBookStore = create<BookStore>((set) => ({
  workspace: mockWorkspaceData,
  currentOverview: null,

  setWorkspace: (workspace) => set({ workspace }),
  updateWorkspace: (partial) => set((state) => ({ workspace: { ...state.workspace, ...partial } })),
  setCurrentOverview: (overview) => set({ currentOverview: overview }),
}));
