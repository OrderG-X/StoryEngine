/**
 * 稿纸存盘的调度（重构 P5）：取代原来 autosave 族的 7 层护栏。
 *
 * 只有一条规矩：存稿带 baseVersion，盘上对不上就不存（服务端回 409，交回盘上那份，稿纸出提示）。
 * 有了它，撤销、AI 改稿、别的窗口改过之后，旧字永远盖不回去，不用再冻结、排空、整页刷新。
 *
 * - 停笔 600ms 存一次；同一时刻只发一笔，发的时候又改了就等这笔回来再发。
 * - 有冲突提示挂着（incoming）就先不存，等作者选。
 * - 换章、撤销、关窗前调 flushDraftSave 把没存的字存掉。
 */
import { fetchChapterPaper, saveWorkingDraft } from "../api/workingDraftClient.js";
import { isDraftDirty, useDraftStore } from "../stores/draftStore.js";

export const DRAFT_SAVE_DELAY_MS = 600;

export type DraftFlushResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<DraftFlushResult> | null = null;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 作者改了字：记下，停笔后存。 */
export function editDraft(body: string, title?: string): void {
  useDraftStore.getState().edit(body, title);
  scheduleDraftSave();
}

export function scheduleDraftSave(delay = DRAFT_SAVE_DELAY_MS): void {
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    void saveDraftNow();
  }, delay);
}

async function sendOnce(): Promise<DraftFlushResult> {
  const state = useDraftStore.getState();
  if (!state.projectPath || state.chapter <= 0 || !state.loaded) return { ok: true };
  if (state.incoming) return { ok: true };
  if (!isDraftDirty(state)) return { ok: true };
  const sent = { projectPath: state.projectPath, chapter: state.chapter, body: state.body, title: state.title, baseVersion: state.baseVersion };
  state.markSaving();
  try {
    const result = await saveWorkingDraft({
      projectPath: sent.projectPath,
      chapter: sent.chapter,
      body: sent.body,
      ...(sent.title.trim() ? { title: sent.title.trim() } : {}),
      baseVersion: sent.baseVersion,
    });
    const live = useDraftStore.getState();
    if (live.projectPath !== sent.projectPath || live.chapter !== sent.chapter) return { ok: true };
    if (result.ok) {
      live.markSaved(result.version, sent.body, sent.title);
      return { ok: true };
    }
    live.markConflict(result.current);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const live = useDraftStore.getState();
    if (live.projectPath === sent.projectPath && live.chapter === sent.chapter) live.markSaveError(message);
    return { ok: false, error: message };
  }
}

/** 现在就存（一笔在路上就等它回来；回来后还有没存的字再发一笔）。 */
export async function saveDraftNow(): Promise<DraftFlushResult> {
  clearTimer();
  while (inFlight) await inFlight;
  inFlight = sendOnce();
  let result: DraftFlushResult;
  try {
    result = await inFlight;
  } finally {
    inFlight = null;
  }
  if (!result.ok) return result;
  const state = useDraftStore.getState();
  // 发出去之后作者又打了字：接着存（没有冲突挂着才存）。
  if (state.loaded && !state.incoming && isDraftDirty(state)) return saveDraftNow();
  return result;
}

/** 换章、撤销、关窗前：把没存的字存掉，等它落盘。 */
export async function flushDraftSave(): Promise<DraftFlushResult> {
  return saveDraftNow();
}

/** 关窗途中的最后一笔（keepalive，不等回执）。 */
export function saveDraftKeepalive(): void {
  const state = useDraftStore.getState();
  if (!state.projectPath || state.chapter <= 0 || !state.loaded || state.incoming || !isDraftDirty(state)) return;
  clearTimer();
  void saveWorkingDraft({
    projectPath: state.projectPath,
    chapter: state.chapter,
    body: state.body,
    ...(state.title.trim() ? { title: state.title.trim() } : {}),
    baseVersion: state.baseVersion,
  }, { keepalive: true }).catch(() => undefined);
}

/** 打开一章：先存掉手上那章，再从盘上读这一章整份换上。 */
export async function openPaper(projectPath: string, chapter: number, fallbackTitle?: string): Promise<void> {
  const state = useDraftStore.getState();
  if (state.loaded && (state.projectPath !== projectPath || state.chapter !== chapter)) await flushDraftSave();
  const paper = await fetchChapterPaper(projectPath, chapter);
  useDraftStore.getState().loadPaper(projectPath, paper, fallbackTitle);
}

/**
 * 盘上可能变了（AI 写完稿、撤销、恢复）：重读这一章。
 * force = 作者自己点的撤销 / 恢复，直接换上；否则有没存的字就出提示让作者选。
 */
export async function refreshPaper(options: { readonly force?: boolean; readonly chapter?: number } = {}): Promise<void> {
  const state = useDraftStore.getState();
  if (!state.projectPath || state.chapter <= 0) return;
  if (options.chapter !== undefined && options.chapter !== state.chapter) return;
  const projectPath = state.projectPath;
  const paper = await fetchChapterPaper(projectPath, state.chapter);
  useDraftStore.getState().receivePaper(projectPath, paper, options.force ? { force: true } : {});
}

/** 只供单测：清掉模块里的计时器和在途。 */
export function __resetDraftSyncForTests(): void {
  clearTimer();
  inFlight = null;
}
