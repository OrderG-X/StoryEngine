/**
 * 稿纸（重构 P5）：工作稿只有这一个主人。
 *
 * - `body` 是作者眼前的字；`savedBody` 是盘上 `baseVersion` 那一版的字。
 * - **稿 = 章名 + 正文**（第 13、14 轮复核）：比对、存稿都按整份（核心 `draft-format`，前后端同一份）。`body` 是稿纸上的字：
 *   开头可能有作者打的「# 章名」行（只认一级，「#」一个字也没有 = 章名清空），章名就跟着那一行；从章名入口改章名，那一行也跟着换——
 *   两个来处说的始终是同一个。和盘上比、存稿都先过 `paperDraft`（那一行归章名），盘上读来的已经是拆开的，不再拆。
 * - **有没有没存的字只看改动号**（第 12 轮复核 Z3）：作者在稿纸上的每个动作（打字、改章名、在提示上选）都让 `rev` 加一；
 *   `cleanRev` 是盘上确认过的那一下（读盘时盘上就是这份、或存稿回执说存的就是这一下）。两者不一样就是没存，
 *   哪怕字改回了和底版一样——撞版本之后改回原稿也是作者的选择，要存（进工作稿或恢复稿），不能被重读换掉。
 * - 盘上来了新版本（AI 写完、撤销后、打开章节）：没有没存的字就直接换上；有就放进 `incoming`，
 *   由作者选「换成那一版」还是「保留我这版」，绝不悄悄互相覆盖。
 * - 存稿撞版本（409）同样进 `incoming`（作者手上那份服务端已另存成恢复稿，不会丢）。
 * - 写作版本 P1b：AI 写好、没换上的一版（候选），和上次没存上的一版（恢复稿），开章时也进 `incoming`，由作者选换不换。
 * - AI 出稿流式的字放 `streaming`（只读显示），不进作者的稿子。
 *
 * 存盘的调度在 `drafts/draftSync.ts`，这里只管状态。
 */
import { create } from "zustand";
import { leadingHeading, paperDraft, retitleText, sameDraft as sameDraftText } from "@actalk/story-core/draft-format";
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
  /** 作者在稿纸上动过几下（打字、改章名、在提示上选；换稿纸也算）。只增不减。 */
  readonly rev: number;
  /** 盘上确认过的是哪一下（null = 选了「保留我这版」之后还没存上）。和 rev 不一样 = 有没存的字。 */
  readonly cleanRev: number | null;

  /** 打开一章：整份换上，不管有没有没存的字（调用方先存掉旧章）。 */
  /** 换上盘上这一章。章名只认盘上的：导航上的占位名（「下一章」「第 N 章」）只用来显示，不当章名写进稿子。 */
  readonly loadPaper: (projectPath: string, paper: ChapterPaper) => void;
  /**
   * 盘上来了新版本：作者手上没有没存的字就换上，有就提示（谁改的都一样，撤销也不直接盖）。
   * 「没存的字」= 作者动过、盘上还没确认（hasUnsavedEdits），或存稿调度说还没落定、没存上（`unsaved`，第 10 轮复核 X2）。
   * 盘上那版是不是这个窗口自己早先存的，稿纸不猜（第 11 轮复核 Y1）：接着存一笔，服务端按窗口的存稿记号认得出就顺着存上，
   * 认不出就撞版本、存成恢复稿。
   * 返回怎么处理的：unchanged 盘上没变；own 盘上就是作者眼前的字；replaced 换上了；incoming 出了提示；skipped 不是这一章。
   */
  readonly receivePaper: (
    projectPath: string,
    paper: ChapterPaper,
    sync?: { readonly unsaved: boolean },
  ) => "unchanged" | "own" | "replaced" | "incoming" | "skipped";
  /** 作者在稿纸上改字（正文开头有章名行就认它当章名）。 */
  readonly edit: (body: string) => void;
  /** 改章名：正文开头有章名行就一起换。 */
  readonly setTitle: (title: string) => void;
  readonly markSaving: () => void;
  /** 存成功：sentBody / sentTitle / sentRev 是这次发出去的那一下（发出后作者可能又动过，那就还是没存）。 */
  readonly markSaved: (version: string, sentBody: string, sentTitle: string, sentRev: number) => void;
  readonly markSaveError: (message: string) => void;
  /** 存稿撞版本（recoveryId：服务端把作者手上这份另存成的恢复稿）。 */
  /** 存稿撞了版本：盘上那份和它此刻的版本号（没有稿也有版本号；旧服务没给就用那份稿的）。 */
  readonly markConflict: (conflict: { readonly current: WorkingDraft | null; readonly currentVersion?: string | null; readonly recoveryId?: string }) => void;
  /**
   * conflict / update：稿纸换成提示里那一版。这是作者的选择、不是盘上的确认：提示说的那版可能已经被别处又改了，
   * 存上之前都算没存（draftSync 接着存一笔核盘，第 13 轮复核 AA1）。候选、恢复稿要服务端换，见 acceptPaperIncoming。
   */
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

/** 稿纸换成盘上那一份：改动号往前走一下，盘上确认的就是这一下。 */
const freshRev = (state: Pick<DraftStoreState, "rev">) => ({ rev: state.rev + 1, cleanRev: state.rev + 1 });

function pendingIncoming(pending: PendingDraft | undefined): PaperIncoming | null {
  if (!pending) return null;
  return { ...(pending.title ? { title: pending.title } : {}), body: pending.body, version: null, cause: pending.kind, pending };
}

/** 撞版本、盘上变了的提示（说的是盘上的哪一版）。 */
const aboutDisk = (incoming: PaperIncoming | null): boolean => incoming?.cause === "conflict" || incoming?.cause === "update";

/**
 * 读到盘上这一份之后提示条该是什么：撞版本、盘上变了的提示只在它说的那一版还在盘上时留着（作者还没选）——
 * 盘上又变了（撤销、作者那份存上了），它指着的那版已经不在，留着就是失效提示（第 11 轮复核 Y2）。其余跟着盘上等着选的那一份走。
 */
function keepOrPending(current: PaperIncoming | null, paper: ChapterPaper, diskVersion: string | null): PaperIncoming | null {
  if (aboutDisk(current) && current!.version === diskVersion) return current;
  if (current?.pending && paper.pending && current.pending.id === paper.pending.id && current.pending.sha === paper.pending.sha) return current;
  return pendingIncoming(paper.pending);
}

/**
 * 盘上这一章该显示的字：有工作稿用工作稿，没有就用定稿，都没有是空。版本号是工作稿此刻的（没有稿也有，
 * 撤销回「没有稿」以后旧的「没有稿」对不上，第 4 轮复核 R1）；老书没有稿是 null。
 */
function diskText(paper: ChapterPaper): { readonly body: string; readonly title?: string; readonly version: string | null } {
  if (paper.draft) return { body: paper.draft.body, ...(paper.draft.title ? { title: paper.draft.title } : {}), version: paper.draft.version };
  const version = paper.draftVersion ?? null;
  if (paper.committed) return { body: paper.committed.body, ...(paper.committed.title ? { title: paper.committed.title } : {}), version };
  return { body: "", version };
}

export const useDraftStore = create<DraftStoreState>((set, get) => ({
  ...EMPTY,

  rev: 0,
  cleanRev: 0,

  loadPaper: (projectPath, paper) => {
    const disk = diskText(paper);
    const title = disk.title ?? "";
    set((state) => ({
      ...EMPTY,
      ...freshRev(state),
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
    }));
  },

  receivePaper: (projectPath, paper, sync) => {
    const state = get();
    if (state.projectPath !== projectPath || state.chapter !== paper.chapter) return "skipped";
    const disk = diskText(paper);
    const dirty = (sync?.unsaved ?? false) || hasUnsavedEdits(state);
    // 版本号是盘上全文的哈希：一样 = 盘上没变（只有定稿那份可能变了）。没有工作稿时按字比。
    const unchanged = disk.version !== null
      ? disk.version === state.baseVersion
      : state.baseVersion === null && sameText(disk.body, state.savedBody);
    if (unchanged) {
      set({ committed: paper.committed, incoming: keepOrPending(state.incoming, paper, disk.version) });
      return "unchanged";
    }
    // 盘上那版就是作者眼前的整份稿（正文和章名都一样；自己那笔存稿先落盘、回执还没到）：认下版本号，不算冲突；
    // 说盘上别的版本的提示没得选了。只比正文会把「别处改了章名、作者另起了章名」当成存好了（第 12 轮复核 Z2）。
    if (dirty && sameDraft(disk, state)) {
      set({ baseVersion: disk.version, savedBody: state.body, savedTitle: state.title, cleanRev: state.rev, committed: paper.committed, incoming: keepOrPending(aboutDisk(state.incoming) ? null : state.incoming, paper, disk.version) });
      return "own";
    }
    if (!dirty) {
      // 盘上就是准的：盘上没章名就是没有（写稿命令都会保留原章名）。真机试写：撤销「改章名」后盘上没章名了，
      // 沿用眼前的会一直显示改过的那个。
      const title = disk.title ?? "";
      set({
        ...freshRev(state),
        title,
        savedTitle: title,
        body: disk.body,
        savedBody: disk.body,
        baseVersion: disk.version,
        committed: paper.committed,
        incoming: pendingIncoming(paper.pending),
        streaming: null,
      });
      return "replaced";
    }
    // 已经在提示的就是盘上这一版（撞版本那条带着恢复稿号）：留着，不换成一条新的。
    const current = state.incoming;
    const incoming = aboutDisk(current) && current!.version === disk.version
      ? current
      : { ...(disk.title ? { title: disk.title } : {}), body: disk.body, version: disk.version, cause: "update" as const };
    set({ committed: paper.committed, incoming });
    return "incoming";
  },

  edit: (body) => set((state) => {
    const title = leadingHeading(body)?.title ?? state.title;
    return body === state.body && title === state.title ? state : { body, title, rev: state.rev + 1 };
  }),

  setTitle: (title) => set((state) => {
    const body = retitleText(state.body, title);
    return title === state.title && body === state.body ? state : { title, body, rev: state.rev + 1 };
  }),

  markSaving: () => set({ saveStatus: "saving", saveError: null }),

  // 存上了 = 盘上就是发出去的那一下：说盘上别的版本的提示都过时了（第 11 轮复核 Y2）；AI 候选、恢复稿不在工作稿里，照旧等作者选。
  // 发出之后作者又动过（打字、在提示上选了），cleanRev 停在发出的那一下，接着存。
  markSaved: (version, sentBody, sentTitle, sentRev) => set((state) => ({
    baseVersion: version,
    savedBody: sentBody,
    savedTitle: sentTitle,
    cleanRev: sentRev,
    saveStatus: "saved",
    saveError: null,
    incoming: aboutDisk(state.incoming) ? null : state.incoming,
  })),

  markSaveError: (message) => set({ saveStatus: "error", saveError: message }),

  markConflict: ({ current, currentVersion, recoveryId }) => set({
    saveStatus: "idle",
    incoming: {
      ...(current?.title ? { title: current.title } : {}),
      body: current?.body ?? "",
      version: currentVersion !== undefined ? currentVersion : current?.version ?? null,
      cause: "conflict",
      ...(recoveryId ? { recoveryId } : {}),
    },
  }),

  acceptIncoming: () => {
    const incoming = get().incoming;
    if (!incoming || (incoming.cause !== "conflict" && incoming.cause !== "update")) return;
    // 稿纸换成那一版、底版是它：作者动了一下，存上之前都算没存（盘上可能已经不是它）。那一版没章名就是没有，不沿用手上这份的。
    set((state) => ({
      rev: state.rev + 1,
      title: incoming.title ?? "",
      savedTitle: incoming.title ?? "",
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
    // 以盘上那一版为底再存一次：savedBody 记成盘上的字；这一下是作者的选择，存上之前都算没存。
    set((state) => ({ baseVersion: incoming.version, savedBody: incoming.body, savedTitle: incoming.title ?? "", rev: state.rev + 1, incoming: null, saveStatus: "idle", saveError: null }));
  },

  clearIncoming: () => set({ incoming: null }),

  setStreaming: (text) => set({ streaming: text }),

  reset: () => set((state) => ({ ...EMPTY, ...freshRev(state) })),
}));

/** 作者动过、还没被盘上确认（存稿要发、重读不能换）。 */
export function hasUnsavedEdits(state: Pick<DraftStoreState, "rev" | "cleanRev">): boolean {
  return state.rev !== state.cleanRev;
}

/** 盘上那份（拆开的）和稿纸上的是不是同一份稿：稿纸那边先过 paperDraft（开头的章名行归章名），按整份比。 */
function sameDraft(disk: { readonly body: string; readonly title?: string }, paper: Pick<DraftStoreState, "body" | "title">): boolean {
  return sameDraftText(disk, paperDraft(paper.body, paper.title));
}

/** 稿纸上的字和底版那一版不一样（核账、定稿按版本认结果时用：字一样就是同一版）。存不存看 hasUnsavedEdits。 */
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
