/**
 * 稿纸（重构 P5）：工作稿只有这一个主人。
 *
 * - `body` 是作者眼前的字；`savedBody` 是盘上 `baseVersion` 那一版的字。两者不一样 = 有没存的字。
 * - 盘上来了新版本（AI 写完、撤销后、打开章节）：没有没存的字就直接换上；有就放进 `incoming`，
 *   由作者选「换成那一版」还是「保留我这版」，绝不悄悄互相覆盖。
 * - 存稿撞版本（409）同样进 `incoming`。
 * - AI 出稿流式的字放 `streaming`（只读显示），不进作者的稿子。
 *
 * 存盘的调度在 `drafts/draftSync.ts`，这里只管状态。
 */
import { create } from "zustand";
import type { ChapterPaper, WorkingDraft } from "../api/workingDraftClient.js";

export interface PaperIncoming {
  readonly title?: string;
  readonly body: string;
  /** 盘上那一版的版本号；盘上没有工作稿是 null。 */
  readonly version: string | null;
  /** conflict = 存稿撞了版本；update = 别处（AI、撤销）写了新版本而你有没存的字。 */
  readonly cause: "conflict" | "update";
}

export type DraftSaveStatus = "idle" | "saving" | "saved" | "error";

/** 这一章正文处在哪一步（从盘上算，不另存）。 */
export type PaperStage = "empty" | "draft" | "committed" | "edited";

export interface DraftStoreState {
  readonly projectPath: string | null;
  /** 0 = 还没打开任何一章。 */
  readonly chapter: number;
  readonly title: string;
  readonly body: string;
  readonly savedBody: string;
  /** 盘上那一版的章名。 */
  readonly savedTitle: string;
  readonly baseVersion: string | null;
  readonly committed: { readonly title?: string; readonly body: string } | null;
  readonly loaded: boolean;
  readonly saveStatus: DraftSaveStatus;
  readonly saveError: string | null;
  readonly incoming: PaperIncoming | null;
  readonly streaming: string | null;

  /** 打开一章：整份换上，不管有没有没存的字（调用方先存掉旧章）。 */
  readonly loadPaper: (projectPath: string, paper: ChapterPaper, fallbackTitle?: string) => void;
  /** 盘上来了新版本：force（作者自己点的撤销）直接换；否则按有没有没存的字决定换还是提示。 */
  readonly receivePaper: (projectPath: string, paper: ChapterPaper, options?: { readonly force?: boolean }) => void;
  /** 作者在稿纸上改字。 */
  readonly edit: (body: string, title?: string) => void;
  /** 改章名（不动正文）。 */
  readonly setTitle: (title: string) => void;
  readonly markSaving: () => void;
  /** 存成功：sentBody 是这次发出去的字（发出后作者可能又打了字）。 */
  readonly markSaved: (version: string, sentBody: string, sentTitle: string) => void;
  readonly markSaveError: (message: string) => void;
  /** 存稿撞版本。 */
  readonly markConflict: (current: WorkingDraft | null) => void;
  readonly acceptIncoming: () => void;
  readonly keepMine: () => void;
  readonly setStreaming: (text: string | null) => void;
  readonly reset: () => void;
}

const EMPTY = {
  projectPath: null,
  chapter: 0,
  title: "",
  body: "",
  savedBody: "",
  savedTitle: "",
  baseVersion: null,
  committed: null,
  loaded: false,
  saveStatus: "idle" as DraftSaveStatus,
  saveError: null,
  incoming: null,
  streaming: null,
} satisfies Partial<DraftStoreState>;

/** 盘上这一章该显示的字：有工作稿用工作稿，没有就用定稿，都没有是空。 */
function diskText(paper: ChapterPaper): { readonly body: string; readonly title?: string; readonly version: string | null } {
  if (paper.draft) return { body: paper.draft.body, ...(paper.draft.title ? { title: paper.draft.title } : {}), version: paper.draft.version };
  if (paper.committed) return { body: paper.committed.body, ...(paper.committed.title ? { title: paper.committed.title } : {}), version: null };
  return { body: "", version: null };
}

export const useDraftStore = create<DraftStoreState>((set, get) => ({
  ...EMPTY,

  loadPaper: (projectPath, paper, fallbackTitle) => {
    const disk = diskText(paper);
    const title = disk.title ?? fallbackTitle ?? "";
    set({
      ...EMPTY,
      projectPath,
      chapter: paper.chapter,
      title,
      savedTitle: title,
      body: disk.body,
      savedBody: disk.body,
      baseVersion: disk.version,
      committed: paper.committed,
      loaded: true,
    });
  },

  receivePaper: (projectPath, paper, options = {}) => {
    const state = get();
    if (state.projectPath !== projectPath || state.chapter !== paper.chapter) return;
    const disk = diskText(paper);
    const dirty = isDraftDirty(state);
    if (disk.version === state.baseVersion && disk.body === state.savedBody) {
      set({ committed: paper.committed });
      return;
    }
    if (options.force || !dirty) {
      const title = disk.title ?? state.title;
      set({
        title,
        savedTitle: title,
        body: disk.body,
        savedBody: disk.body,
        baseVersion: disk.version,
        committed: paper.committed,
        incoming: null,
        streaming: null,
      });
      return;
    }
    set({ committed: paper.committed, incoming: { ...(disk.title ? { title: disk.title } : {}), body: disk.body, version: disk.version, cause: "update" } });
  },

  edit: (body, title) => set({ body, ...(title !== undefined ? { title } : {}) }),

  setTitle: (title) => set({ title }),

  markSaving: () => set({ saveStatus: "saving", saveError: null }),

  markSaved: (version, sentBody, sentTitle) => set({
    baseVersion: version,
    savedBody: sentBody,
    savedTitle: sentTitle,
    saveStatus: "saved",
    saveError: null,
  }),

  markSaveError: (message) => set({ saveStatus: "error", saveError: message }),

  markConflict: (current) => set({
    saveStatus: "idle",
    incoming: current
      ? { ...(current.title ? { title: current.title } : {}), body: current.body, version: current.version, cause: "conflict" }
      : { body: "", version: null, cause: "conflict" },
  }),

  acceptIncoming: () => {
    const incoming = get().incoming;
    if (!incoming) return;
    set((state) => ({
      title: incoming.title ?? state.title,
      savedTitle: incoming.title ?? state.title,
      body: incoming.body,
      savedBody: incoming.body,
      baseVersion: incoming.version,
      incoming: null,
      saveStatus: "idle",
      saveError: null,
    }));
  },

  keepMine: () => {
    const incoming = get().incoming;
    if (!incoming) return;
    // 以盘上那一版为底再存一次：savedBody 记成盘上的字，作者的字和它不一样 → 下一笔存稿照写。
    set({ baseVersion: incoming.version, savedBody: incoming.body, savedTitle: incoming.title ?? "", incoming: null, saveStatus: "idle", saveError: null });
  },

  setStreaming: (text) => set({ streaming: text }),

  reset: () => set({ ...EMPTY }),
}));

export function isDraftDirty(state: Pick<DraftStoreState, "body" | "savedBody" | "title" | "savedTitle">): boolean {
  return state.body !== state.savedBody || state.title !== state.savedTitle;
}

/** 正文处在哪一步：有工作稿且和定稿一样 / 没工作稿只有定稿 = 已定稿；不一样 = 定稿后改过。 */
export function paperStage(state: Pick<DraftStoreState, "body" | "committed">): PaperStage {
  const hasText = state.body.trim().length > 0;
  if (!state.committed) return hasText ? "draft" : "empty";
  return sameText(state.body, state.committed.body) ? "committed" : "edited";
}

function sameText(a: string, b: string): boolean {
  const tidy = (text: string) => text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return tidy(a) === tidy(b);
}
