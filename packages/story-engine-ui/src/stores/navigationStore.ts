import { create } from "zustand";

/** 中间区视图：资料中心 / 写作台 / 操作历史。 */
export type CenterView = "library" | "desk" | "history";

export interface NavigationStore {
  readonly workspaceReady: boolean;
  readonly projectPath: string | null;
  readonly activeBookId: string | null;
  readonly openProjectError: string | null;
  readonly openProjectLoading: boolean;
  readonly settingsOpen: boolean;
  readonly toast: string | null;
  /** 一次性「请切到中间区某视图」信号：出稿/续写时置 "desk"，WritingWorkspaceCodex 消费后清空。 */
  readonly pendingCenterView: CenterView | null;
  /** 刚定稿、作者还没在设定本里看过「这章改了什么」的章号（顶栏「设定本」亮小点）；看过就清。 */
  readonly unseenChangesChapter: number | null;

  readonly setWorkspaceReady: (value: boolean) => void;
  readonly setProjectPath: (path: string | null) => void;
  readonly setActiveBookId: (id: string | null) => void;
  readonly setOpenProjectError: (error: string | null) => void;
  readonly setOpenProjectLoading: (loading: boolean) => void;
  readonly openSettings: () => void;
  readonly closeSettings: () => void;
  readonly showToast: (message: string, duration?: number) => void;
  readonly clearToast: () => void;
  /** 请求中间区切到某视图（出稿/续写时调，置 "desk"）。 */
  readonly requestCenterView: (view: CenterView) => void;
  /** 消费完跳转信号后清空（WritingWorkspaceCodex 调）。 */
  readonly clearPendingCenterView: () => void;
  readonly setUnseenChangesChapter: (chapter: number | null) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useNavigationStore = create<NavigationStore>((set) => ({
  workspaceReady: false,
  projectPath: null,
  activeBookId: null,
  openProjectError: null,
  openProjectLoading: false,
  settingsOpen: false,
  toast: null,
  pendingCenterView: null,
  unseenChangesChapter: null,

  setUnseenChangesChapter: (chapter) => set({ unseenChangesChapter: chapter }),
  setWorkspaceReady: (value) => set({ workspaceReady: value }),
  requestCenterView: (view) => set({ pendingCenterView: view }),
  clearPendingCenterView: () => set({ pendingCenterView: null }),
  // 换了书：上一本「刚定稿没看过」的小点不能跟过来。
  setProjectPath: (path) => set((state) => (state.projectPath === path ? { projectPath: path } : { projectPath: path, unseenChangesChapter: null })),
  setActiveBookId: (id) => set({ activeBookId: id }),
  setOpenProjectError: (error) => set({ openProjectError: error }),
  setOpenProjectLoading: (loading) => set({ openProjectLoading: loading }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  showToast: (message, duration = 3200) => {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    set({ toast: message });
    toastTimer = setTimeout(() => {
      set({ toast: null });
      toastTimer = null;
    }, duration);
  },

  clearToast: () => {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    set({ toast: null });
  },
}));
