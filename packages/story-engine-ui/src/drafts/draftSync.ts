/**
 * 稿纸存盘的调度（重构 P5）：取代原来 autosave 族的 7 层护栏。
 *
 * 只有一条规矩：存稿带 baseVersion，盘上对不上就不存（服务端回 409，交回盘上那份，稿纸出提示）。
 * 有了它，撤销、AI 改稿、别的窗口改过之后，旧字永远盖不回去，不用再冻结、排空、整页刷新。
 *
 * - 停笔 600ms 存一次；同一时刻只发一笔，发的时候又改了就等这笔回来再发。没存上（网断了、服务端写不进去）过一会儿再试。
 * - 什么时候都存（写作版本 P1b）：AI 回合里也存。AI 写完时稿子已经被作者改过，AI 那版换不上、留成候选，稿纸出提示让作者选。
 * - 撞了版本也接着存：服务端把作者手上那份存进恢复稿（不进工作稿），进程死了也找得回。每笔带这个窗口的号和第几笔，
 *   服务端一个窗口每章留一份、迟到的旧笔不覆盖新字。回执里有恢复稿号才算存下了；没有就当没存上，接着试。
 *   同一份字被拒过（已在恢复稿里）就不再重发。
 * - 稿纸只经这里换（openPaper / replacePaperNow / clearPaperNow）：换之前 drainPaper 等在路上的那笔回来、把没存的字存完，
 *   存不上就不换（抛 UnsavedPaperError）；存完到换上之间不 await。
 * - 从盘上读的（换章、重读）都按「读的期间这一章没发过存稿」才用：发过就再读，免得迟到的旧读数盖掉刚存的字（第 6 轮复核 T1）。
 */
import { decidePendingDraft, fetchChapterPaper, saveWorkingDraft, type ChapterPaper } from "../api/workingDraftClient.js";
import { isDraftDirty, useDraftStore, type DraftStoreState } from "../stores/draftStore.js";

export const DRAFT_SAVE_DELAY_MS = 600;
/** 没存上，过这么久再试一次。 */
export const DRAFT_RETRY_MS = 5000;

export type DraftFlushResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** 换章前手上的字没存上：不换（字还在稿纸上）。 */
export class UnsavedPaperError extends Error {
  constructor(readonly reason: string) {
    super(`你手上这一章的字还没存上（${reason}），先没换章。`);
    this.name = "UnsavedPaperError";
  }
}

function newClientId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return random.toLowerCase().replace(/[^0-9a-z]/gu, "").slice(0, 24).padEnd(12, "0");
}

/** 这个稿纸窗口的号（开页面时给一个）和存了第几笔。 */
let clientId = newClientId();
let seq = 0;
const nextSender = (): { readonly client: string; readonly seq: number } => ({ client: clientId, seq: (seq += 1) });

let timer: ReturnType<typeof setTimeout> | null = null;
/** 上一笔明确没存上、之后还没有一笔存成：重试发出去了也算没存上（关窗照样拦，第 5 轮 S5）。 */
let failedUnsaved = false;
let inFlight: Promise<DraftFlushResult> | null = null;
/** 发出过几笔存稿：读盘前后比一比，读的期间发过就说明读回来的可能比刚存的旧。 */
let savesSent = 0;
/** 这个窗口存成的版本号（最近几十个）：盘上是这些版本就是作者自己的字，不是别处写的（第 6 轮复核 T4）。 */
const ownVersions: string[] = [];
const OWN_VERSIONS_KEPT = 50;

function rememberOwnVersion(version: string | null): void {
  if (!version || ownVersions.includes(version)) return;
  ownVersions.push(version);
  if (ownVersions.length > OWN_VERSIONS_KEPT) ownVersions.shift();
}

/** 盘上这个版本是不是这个窗口自己存的。 */
export function isOwnSavedVersion(version: string | null): boolean {
  return version !== null && ownVersions.includes(version);
}
/** 上一笔撞了版本的那份（同一份字、同一底版不再重发，免得来回打转）。 */
let rejected: { readonly projectPath: string; readonly chapter: number; readonly body: string; readonly title: string; readonly baseVersion: string | null } | null = null;

function rejectedAlready(state: Pick<DraftStoreState, "projectPath" | "chapter" | "body" | "title" | "baseVersion">): boolean {
  return rejected !== null
    && rejected.projectPath === state.projectPath
    && rejected.chapter === state.chapter
    && rejected.body === state.body
    && rejected.title === state.title
    && rejected.baseVersion === state.baseVersion;
}

/** 有要存的字：打开了一章、和盘上不一样、这份没被拒过。 */
function needsSave(state: DraftStoreState): boolean {
  return Boolean(state.projectPath) && state.chapter > 0 && state.loaded && isDraftDirty(state) && !rejectedAlready(state);
}

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
  if (!state.projectPath || !needsSave(state)) return { ok: true };
  const sent = { projectPath: state.projectPath, chapter: state.chapter, body: state.body, title: state.title, baseVersion: state.baseVersion };
  state.markSaving();
  savesSent += 1;
  try {
    const result = await saveWorkingDraft({
      projectPath: sent.projectPath,
      chapter: sent.chapter,
      body: sent.body,
      ...(sent.title.trim() ? { title: sent.title.trim() } : {}),
      baseVersion: sent.baseVersion,
      ...nextSender(),
    });
    const live = useDraftStore.getState();
    if (live.projectPath !== sent.projectPath || live.chapter !== sent.chapter) return { ok: true };
    if (result.ok) {
      rejected = null;
      failedUnsaved = false;
      rememberOwnVersion(result.version);
      live.markSaved(result.version, sent.body, sent.title);
      return { ok: true };
    }
    // 撞了版本：作者这份服务端存成了恢复稿才有号，稿纸出提示。这份不再重发；作者接着改了就再存（更新恢复稿）。
    // 没有号 = 没另外存下来：当没存上，字还在稿纸上，过一会儿再试。
    if (!result.recoveryId) {
      const message = "别处刚改过这一章，你这段也没能另存下来。字还在稿纸上，稍后自动再试。";
      live.markConflict(result);
      live.markSaveError(message);
      failedUnsaved = true;
      return { ok: false, error: message };
    }
    rejected = sent;
    failedUnsaved = false;
    live.markConflict(result);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const live = useDraftStore.getState();
    if (live.projectPath === sent.projectPath && live.chapter === sent.chapter) {
      live.markSaveError(message);
      failedUnsaved = true;
    }
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
  if (!result.ok) {
    // 没存上：字还在稿纸上，过一会儿再试（这期间作者再打字也会重新排）。
    if (timer === null) scheduleDraftSave(DRAFT_RETRY_MS);
    return result;
  }
  // 发出去之后作者又打了字：接着存。
  if (needsSave(useDraftStore.getState())) return saveDraftNow();
  return result;
}

/** 换章、撤销、关窗前：把没存的字存掉，等它落盘（撞了版本的那份在恢复稿里，也算存下了；没存上如实返回）。 */
export async function flushDraftSave(): Promise<DraftFlushResult> {
  return saveDraftNow();
}

/**
 * 关窗前要不要拦：上一笔明确没存上、字还没落盘。keepalive 不等回执，救不了已知存不上的那份（第 4 轮复核 R10）。
 * 撞了版本另存成恢复稿的不算（needsSave 已跳过那份）。
 */
export function hasFailedUnsavedDraft(): boolean {
  return failedUnsaved && needsSave(useDraftStore.getState());
}

/** 关窗途中的最后一笔（keepalive，不等回执）。 */
export function saveDraftKeepalive(): void {
  const state = useDraftStore.getState();
  if (!state.projectPath || !needsSave(state)) return;
  clearTimer();
  void saveWorkingDraft({
    projectPath: state.projectPath,
    chapter: state.chapter,
    body: state.body,
    ...(state.title.trim() ? { title: state.title.trim() } : {}),
    baseVersion: state.baseVersion,
    ...nextSender(),
  }, { keepalive: true }).catch(() => undefined);
}

/**
 * 稿纸要被换掉（另一章、另一本书、回书架）之前的最后一步：把没存的字存完，存不上抛 UnsavedPaperError。
 * 调用方拿到之后要在同一个同步回合里换稿纸（replacePaperNow / clearPaperNow）：这之后再 await，期间打的字就没人管了
 * （第 4 轮 R3、第 5 轮 S6/S7）。
 */
export async function drainPaper(): Promise<void> {
  for (;;) {
    // 在路上的那笔先等它回来：手上的字可能刚改回和底版一样（看着不用存），盘上却正要落下那笔旧的（第 6 轮复核 T2）。
    if (inFlight) {
      await inFlight;
      continue;
    }
    if (!needsSave(useDraftStore.getState())) return;
    const flushed = await flushDraftSave();
    if (!flushed.ok) throw new UnsavedPaperError(flushed.error);
  }
}

/** 每换一次稿纸加一；正在读盘的换法读回来时号不对 = 被后来的换法顶掉了，不换（第 5 轮 S3）。 */
let paperIntent = 0;

/** 手上还有没存的字就不许换（漏了 drainPaper 的入口在这里如实失败，不丢字）。 */
function assertNothingUnsaved(): void {
  const state = useDraftStore.getState();
  if (inFlight || needsSave(state)) throw new UnsavedPaperError("刚打的字还在存");
}

/** 读盘之前记一笔（发过几笔存稿），换上时拿来比：读的期间这一章又存过，读回来的就可能是旧的。 */
export function paperReadMark(): number {
  return savesSent;
}

/**
 * 稿纸换成这一份（调用前 await drainPaper，之后同步调）。read = 读这份之前的 paperReadMark()：
 * 读的就是手上这一章、读的期间又存过稿，手上这份比读回来的新，不换（第 6 轮复核 T1 同类：迟到的旧读数不盖刚存的字）。
 */
export function replacePaperNow(projectPath: string, paper: ChapterPaper, read?: number): void {
  assertNothingUnsaved();
  paperIntent += 1;
  failedUnsaved = false;
  const state = useDraftStore.getState();
  if (read !== undefined && read !== savesSent && state.projectPath === projectPath && state.chapter === paper.chapter && state.loaded) return;
  state.loadPaper(projectPath, paper);
}

/** 稿纸清空（回书架、书没了）。调用前 await drainPaper，之后同步调。 */
export function clearPaperNow(): void {
  assertNothingUnsaved();
  paperIntent += 1;
  failedUnsaved = false;
  useDraftStore.getState().reset();
}

/**
 * 打开一章：先存掉手上那章、从盘上读这一章、换上之前再存一次刚打的字。
 * 存不上抛 UnsavedPaperError、读不出抛原错，稿纸都不动；读的途中有更晚的换法（或 stillWanted 说不要了）就不换，返回 false。
 */
export async function openPaper(projectPath: string, chapter: number, options: { readonly stillWanted?: () => boolean } = {}): Promise<boolean> {
  const intent = ++paperIntent;
  const wanted = (): boolean => intent === paperIntent && options.stillWanted?.() !== false;
  await drainPaper();
  const read = paperReadMark();
  const paper = await fetchChapterPaper(projectPath, chapter);
  if (!wanted()) return false;
  await drainPaper();
  if (!wanted()) return false;
  replacePaperNow(projectPath, paper, read);
  return true;
}

/**
 * 盘上可能变了（AI 写完稿、撤销、恢复）：重读这一章。作者手上没有没存的字就换上；有就出提示让作者选，
 * 撤销也一样（第 4 轮复核 R7：存稿失败时、撤销发出后又打的字，都只在稿纸上，直接换会丢）。
 */
export async function refreshPaper(options: { readonly chapter?: number } = {}): Promise<PaperRefresh> {
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
    // 在路上的那笔先等它落盘，读回来的才是它之后的样子。
    while (inFlight) await inFlight;
    const state = useDraftStore.getState();
    if (!state.projectPath || state.chapter <= 0) return "skipped";
    if (options.chapter !== undefined && options.chapter !== state.chapter) return "skipped";
    const projectPath = state.projectPath;
    const chapter = state.chapter;
    const intent = paperIntent;
    const sentBefore = savesSent;
    const paper = await fetchChapterPaper(projectPath, chapter);
    // 稿纸换过了（换章、换书、开过别的）：这份不是它的。
    if (intent !== paperIntent) return "skipped";
    // 读的期间发过存稿：读回来的可能比刚存的旧，迟到了也不能拿它盖（第 6 轮复核 T1）。再读。
    if (savesSent !== sentBefore || inFlight) continue;
    const outcome = useDraftStore.getState().receivePaper(projectPath, paper);
    if (outcome === "own") rememberOwnVersion(useDraftStore.getState().baseVersion);
    // 盘上变了、作者手上还有没存的字：马上存一笔（撞版本，服务端存成恢复稿），别只留在页面里。
    if (outcome === "incoming") scheduleDraftSave(0);
    return outcome;
  }
  // 作者一直在存：不重读了，盘上要是别处改过，下一笔存稿撞版本自会提示。
  return "skipped";
}

/** 重读一次最多试几回（读的期间一直有存稿发出就不读了）。 */
const REFRESH_ATTEMPTS = 3;

/**
 * 重读的结果：unchanged = 盘上没变；own = 盘上就是作者手上的字（自己的存稿先落盘）；replaced = 盘上别处写了新版、稿纸换上了；
 * incoming = 盘上别处写了新版、作者手上有没存的字，出提示让作者选；skipped = 没读或读回来的不用。
 */
export type PaperRefresh = "unchanged" | "own" | "replaced" | "incoming" | "skipped";

export type PaperDecisionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * 稿纸提示条上「换成那一版」：
 * - 撞版本 / 盘上变了：换成盘上那版（撞版本时那份恢复稿作者不要了，一起删）。
 * - AI 候选 / 恢复稿：先存掉手上的字，再让服务端换上（带作者眼前那份的版本，对不上不换；换前存档、可撤销），换完重读。
 */
export async function acceptPaperIncoming(): Promise<PaperDecisionResult> {
  const state = useDraftStore.getState();
  const incoming = state.incoming;
  if (!incoming || !state.projectPath) return { ok: true };
  if (incoming.cause === "conflict" || incoming.cause === "update") {
    const projectPath = state.projectPath;
    const chapter = state.chapter;
    state.acceptIncoming();
    if (!incoming.recoveryId) return { ok: true };
    // 本窗口自己的那份：带上窗口号和已发到第几笔，还在路上的旧笔到了也不再把它写回来。
    const dropped = await decidePendingDraft({ projectPath, chapter, pending: { kind: "recovery", id: incoming.recoveryId, sha: "" }, decision: "dismiss", baseVersion: null, from: { client: clientId, seq } });
    return dropped.ok ? { ok: true } : { ok: false, error: `换好了，但没存上的那份没删掉（下次开这一章还会提示）：${dropped.error}` };
  }
  const pending = incoming.pending;
  if (!pending) return { ok: true };
  const flushed = await flushDraftSave();
  if (!flushed.ok) return { ok: false, error: `你手上的字还没存上（${flushed.error}），没换。` };
  const live = useDraftStore.getState();
  if (live.incoming?.pending?.id !== pending.id) return { ok: false, error: "稿子刚才存的时候撞了版本，先看一眼上面那条提示。" };
  const result = await decidePendingDraft({
    projectPath: state.projectPath,
    chapter: state.chapter,
    pending,
    decision: "adopt",
    baseVersion: live.baseVersion,
  });
  if (result.ok) live.clearIncoming();
  // 换上了就把新稿读回来；没换上也重读一次（那一份可能已经不在了）。
  await refreshPaper().catch(() => undefined);
  return result;
}

/**
 * 稿纸提示条上「保留我这版」/「不要了」：
 * - 撞版本 / 盘上变了：保留手上的字，以盘上那一版为底再存。
 * - AI 候选 / 恢复稿：不要了（服务端删掉那一份）。
 */
export async function keepPaperMine(): Promise<PaperDecisionResult> {
  const state = useDraftStore.getState();
  const incoming = state.incoming;
  if (!incoming || !state.projectPath) return { ok: true };
  if (incoming.cause === "conflict" || incoming.cause === "update") {
    state.keepMine();
    scheduleDraftSave(0);
    return { ok: true };
  }
  const pending = incoming.pending;
  if (!pending) return { ok: true };
  const result = await decidePendingDraft({ projectPath: state.projectPath, chapter: state.chapter, pending, decision: "dismiss", baseVersion: null });
  if (result.ok && useDraftStore.getState().incoming?.pending?.id === pending.id) useDraftStore.getState().clearIncoming();
  return result;
}

/** 只供单测：清掉模块里的计时器和在途。 */
export function __resetDraftSyncForTests(): void {
  clearTimer();
  inFlight = null;
  rejected = null;
  failedUnsaved = false;
  paperIntent = 0;
  savesSent = 0;
  ownVersions.length = 0;
  clientId = newClientId();
  seq = 0;
}
