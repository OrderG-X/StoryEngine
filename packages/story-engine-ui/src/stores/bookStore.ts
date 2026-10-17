/**
 * 书（重构 P5：从 workspaceStore 拆出）：章节列表、当前章、流程态、资料派生字段、状态总览、侧栏。
 * 正文在 draftStore，对话在 chatStore，只活在界面里的临时态在 uiStore。
 */
import { create } from "zustand";
import type { ChapterWorkspaceData, SidebarData } from "../types.js";
import type { StateOverview } from "../api/types.js";
import { mockSidebarData, mockWorkspaceData } from "../mockData.js";

export interface BookStore {
  workspace: ChapterWorkspaceData;
  sidebar: SidebarData;
  currentOverview: StateOverview | null;

  setWorkspace: (workspace: ChapterWorkspaceData) => void;
  updateWorkspace: (partial: Partial<ChapterWorkspaceData>) => void;
  setSidebar: (sidebar: SidebarData) => void;
  setCurrentOverview: (overview: StateOverview | null) => void;
}

export const useBookStore = create<BookStore>((set) => ({
  workspace: mockWorkspaceData,
  sidebar: { ...mockSidebarData },
  currentOverview: null,

  setWorkspace: (workspace) => set({ workspace }),
  updateWorkspace: (partial) => set((state) => ({ workspace: { ...state.workspace, ...partial } })),
  setSidebar: (sidebar) => set({ sidebar }),
  setCurrentOverview: (overview) => set({ currentOverview: overview }),
}));
