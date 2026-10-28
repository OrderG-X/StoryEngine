/**
 * 稿纸（重构 P5）：工作稿只有这一个主人。
 *
 * - `body` 是作者眼前的字；`savedBody` 是盘上 `baseVersion` 那一版的字。两者不一样 = 有没存的字。
 * - 盘上来了新版本（AI 写完、撤销后、打开章节）：没有没存的字就直接换上；有就放进 `incoming`，
 *   由作者选「换成那一版」还是「保留我这版」，绝不悄悄互相覆盖。
 * - 存稿撞版本（409）同样进 `incoming`（作者手上那份服务端已另存成恢复稿，不会丢）。
 * - 写作版本 P1b：AI 写好、没换上的一版（候选），和上次没存上的一版（恢复稿），开章时也进 `incoming`，由作者选换不换。
 * - AI 出稿流式的字放 `streaming`（只读显示），不进作者的稿子。
 *
 * 存盘的调度在 `drafts/draftSync.ts`，这里只管状态。
 */
import { create } from "zustand";
import type { ChapterPaper, PendingDraft, WorkingDraft } from "../api/workingDraftClient.js";

export interface PaperIncoming {
  readonly title?: string;
  readonly body: string;
  /** 盘上那一版的版本号（conflict / update；盘上没有工作稿是 null）。候选、恢复稿不在工作稿里，也是 null。 */
  readonly version: string | null;
  /**
   * conflict = 存稿撞了版本（作者手上这份服务端另存成了恢复稿 recoveryId）；update = 别处（AI、撤销）写了新版本而你有没存的字；
   * candidate = AI 写好、没换上的一版；recovery = 上次没存上的一版（作者自己的字）。
   */
  readonly cause: "conflict" | "update" | "candidate" | "recovery";
  readonly recoveryId?: string;
  /** candidate / recovery：服务端存着的那一份。 */
  readonly pending?: PendingDraft;
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
  /** 换上盘上这一章。章名只认盘上的：导航上的占位名（「下一章」「第 N 章」）只用来显示，不当章名写进稿子。 */
  readonly loadPaper: (projectPath: string, paper: ChapterPaper) => void;
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
  /** 存稿撞版本（recoveryId：服务端把作者手上这份另存成的恢复稿）。 */
  readonly markConflict: (current: WorkingDraft | null, recoveryId?: string) => void;
  /** conflict / update：换成盘上那一版。（候选、恢复稿要服务端换，见 draftSync 的 acceptPaperIncoming。） */
  readonly acceptIncoming: () => void;
  /** conflict / update：保留手上这版，以盘上那一版为底再存。 */
  readonly keepMine: () => void;
  /** 候选、恢复稿处理完了：收起提示。 */
  readonly clearIncoming: () => void;
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

function pendingIncoming(pending: PendingDraft | undefined): PaperIncoming | null {
  if (!pending) return null;
  return { ...(pending.title ? { title: pending.title } : {}), body: pending.body, version: null, cause: pending.kind, pending };
}

/** 盘上没变时提示条该是什么：撞版本、盘上变了的提示留着（作者还没选）；其余跟着盘上等着选的那一份走。 */
function keepOrPending(current: PaperIncoming | null, paper: ChapterPaper): PaperIncoming | null {
  if (current && (current.cause === "conflict" || current.cause === "update")) return current;
  if (current?.pending && paper.pending && current.pending.id === paper.pending.id && current.pending.sha === paper.pending.sha) return current;
  return pendingIncoming(paper.pending);
}

/** 盘上这一章该显示的字：有工作稿用工作稿，没有就用定稿，都没有是空。 */
function diskText(paper: ChapterPaper): { readonly body: string; readonly title?: string; readonly version: string | null } {
  if (paper.draft) return { body: paper.draft.body, ...(paper.draft.title ? { title: paper.draft.title } : {}), version: paper.draft.version };
  if (paper.committed) return { body: paper.committed.body, ...(paper.committed.title ? { title: paper.committed.title } : {}), version: null };
  return { body: "", version: null };
}

export const useDraftStore = create<DraftStoreState>((set, get) => ({
  ...EMPTY,

  loadPaper: (projectPath, paper) => {
    const disk = diskText(paper);
    const title = disk.title ?? "";
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
      incoming: pendingIncoming(paper.pending),
    });
  },

  receivePaper: (projectPath, paper, options = {}) => {
    const state = get();
    if (state.projectPath !== projectPath || state.chapter !== paper.chapter) return;
    const disk = diskText(paper);
    const dirty = isDraftDirty(state);
    // 版本号是盘上全文的哈希：一样 = 盘上没变（只有定稿那份可能变了）。没有工作稿时按字比。
    const unchanged = disk.version !== null
      ? disk.version === state.baseVersion
      : state.baseVersion === null && sameText(disk.body, state.savedBody);
    if (unchanged) {
      set({ committed: paper.committed, incoming: keepOrPending(state.incoming, paper) });
      return;
    }
    // 盘上那版就是作者眼前的字（自己那笔存稿先落盘、回执还没到）：认下版本号，不算冲突。
    if (dirty && sameText(disk.body, state.body)) {
      set({ baseVersion: disk.version, savedBody: state.body, savedTitle: state.title, committed: paper.committed, incoming: keepOrPending(state.incoming, paper) });
      return;
    }
    if (options.force || !dirty) {
      // 盘上就是准的：盘上没章名就是没有（写稿命令都会保留原章名）。真机试写：撤销「改章名」后盘上没章名了，
      // 沿用眼前的会一直显示改过的那个。
      const title = disk.title ?? "";
      set({
        title,
        savedTitle: title,
        body: disk.body,
        savedBody: disk.body,
        baseVersion: disk.version,
        committed: paper.committed,
        incoming: pendingIncoming(paper.pending),
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

  markConflict: (current, recoveryId) => set({
    saveStatus: "idle",
    incoming: {
      ...(current?.title ? { title: current.title } : {}),
      body: current?.body ?? "",
      version: current?.version ?? null,
      cause: "conflict",
      ...(recoveryId ? { recoveryId } : {}),
    },
  }),

  acceptIncoming: () => {
    const incoming = get().incoming;
    if (!incoming || (incoming.cause !== "conflict" && incoming.cause !== "update")) return;
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
    if (!incoming || (incoming.cause !== "conflict" && incoming.cause !== "update")) return;
    // 以盘上那一版为底再存一次：savedBody 记成盘上的字，作者的字和它不一样 → 下一笔存稿照写。
    set({ baseVersion: incoming.version, savedBody: incoming.body, savedTitle: incoming.title ?? "", incoming: null, saveStatus: "idle", saveError: null });
  },

  clearIncoming: () => set({ incoming: null }),

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
