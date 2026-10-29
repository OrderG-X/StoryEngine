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
 *   同一下被拒过（已在恢复稿里）就不再重发。
 * - **要不要存看改动号**（第 12 轮复核 Z3）：作者每动一下稿纸（打字、改章名、在提示上选）都算一下，存稿回执只确认它发出的那一下；
 *   字改回和底版一样也照存。撞版本的回执只在它说的盘上那版不是稿纸的底版时出提示（底版就是它 = 作者已经选过了，Z1）。
 * - 稿纸只经这里换（openPaper / replacePaperNow / clearPaperNow）：换之前 drainPaper 等在路上的那笔回来、把没存的字存完，
 *   存不上就不换（抛 UnsavedPaperError）；存完到换上之间不 await。
 * - 从盘上读的（换章、重读）都按「读的期间这一章没发过存稿」才用：发过就再读，免得迟到的旧读数盖掉刚存的字（第 6 轮复核 T1）；
 *   也按「开读比已换上的那份晚」才用：迟到的旧读数不盖后来读到、已经显示的新稿（第 7 轮复核 U1）。
 * - **待存只有一处记法**（第 9 轮复核）：每发一笔（普通的、关窗补发的）这一章就「没落定」，只有这一章最后发出那笔的回执能把它
 *   落定（存上了 / 撞了另存成恢复稿）或记成没存上；别的回执什么都不改。要不要再发 = 没落定、没存上、或手上的字和盘上不一样。
 *   换章、重读、flush 先等所有还没回来的笔（含关窗补发）都回来再看；关窗拦、重试、换章挡都看同一个状态。
 *   关窗补发的那笔和在路上那笔是同一个底版，服务端按窗口号和序号认出是同一窗口接着写的，顺着接上；序号旧的那笔后到不写。
 */
import { decidePendingDraft, fetchChapterPaper, saveWorkingDraft, type ChapterPaper, type SaveWorkingDraftResult } from "../api/workingDraftClient.js";
import { hasUnsavedEdits, useDraftStore, type DraftStoreState } from "../stores/draftStore.js";

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

/**
 * 这一章的存稿落定没有（第 9 轮复核：待存只有这一处记法，见文件头）。每发一笔（普通的、关窗补发的都算）就 pending；
 * 只有这一章最后发出那笔的回执能改它：存上了、撞了另存成恢复稿 → 落定（failed 也清掉）；没存上 → 落定成 failed。
 * failed 一直留到之后有一笔存成（重试在路上也还算没存上：关窗照样拦，第 5 轮 S5）。别的回执（被后来那笔顶掉的、迟到的）
 * 什么都不改。换稿纸时清掉（换之前已经确认落定、没有 failed）。
 */
let sync: { readonly projectPath: string; readonly chapter: number; readonly lastSeq: number; readonly pending: boolean; readonly failed: boolean; readonly error?: string } | null = null;

function syncOf(state: Pick<DraftStoreState, "projectPath" | "chapter">): { readonly pending: boolean; readonly failed: boolean } {
  return sync !== null && sync.projectPath === state.projectPath && sync.chapter === state.chapter ? sync : { pending: false, failed: false };
}

/** 还没回来的存稿（普通的、关窗补发的都在）：换章、重读、flush 都等它们全回来再看。 */
const requests = new Set<Promise<unknown>>();

/** 发出过几笔存稿：读盘前后比一比，读的期间发过就说明读回来的可能比刚存的旧。 */
let savesSent = 0;
/**
 * 这个窗口真写出来的版本号（最近几十个，服务端回执说写了新版本才记）：AI 回合收尾时分辨盘上的新版是作者自己存的还是 AI 写的
 * （第 6 轮复核 T4）。和盘上一样的空写不记：那一版可能是 AI、撤销、别的窗口写的（第 11 轮复核 Y1）。只拿来说话，不拿来认底版。
 */
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

/** 上一笔撞了版本、存成恢复稿的那一下（同一下、同一底版不再重发，免得来回打转）。 */
let rejected: { readonly projectPath: string; readonly chapter: number; readonly rev: number; readonly baseVersion: string | null } | null = null;

function rejectedAlready(state: Pick<DraftStoreState, "projectPath" | "chapter" | "rev" | "baseVersion">): boolean {
  return rejected !== null
    && rejected.projectPath === state.projectPath
    && rejected.chapter === state.chapter
    && rejected.rev === state.rev
    && rejected.baseVersion === state.baseVersion;
}

const paperOpen = (state: DraftStoreState): boolean => Boolean(state.projectPath) && state.chapter > 0 && state.loaded;

/** 要不要再发一笔：打开了一章，且这一章没落定（没回来、没存上）、或作者动过还没被盘上确认（被拒过、已在恢复稿里的那一下除外）。 */
function needsSave(state: DraftStoreState): boolean {
  if (!paperOpen(state)) return false;
  const current = syncOf(state);
  if (current.pending || current.failed) return true;
  return !rejectedAlready(state) && hasUnsavedEdits(state);
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

type SentPaper = { readonly projectPath: string; readonly chapter: number; readonly body: string; readonly title: string; readonly baseVersion: string | null; readonly rev: number };

/** 这笔是不是这一章最后发出的那笔、稿纸还是这一章：只有它的回执能定下这一章（见 sync）。 */
function decides(sent: SentPaper, seqSent: number): boolean {
  const live = useDraftStore.getState();
  return sync !== null && sync.projectPath === sent.projectPath && sync.chapter === sent.chapter && sync.lastSeq === seqSent
    && live.projectPath === sent.projectPath && live.chapter === sent.chapter;
}

/** 这一章最后那笔没存上：记下，过一会儿自动再试（普通存稿、关窗补发都走这里，第 10 轮复核 X1）。 */
function markFailed(sent: SentPaper, seqSent: number, message: string): DraftFlushResult {
  sync = { projectPath: sent.projectPath, chapter: sent.chapter, lastSeq: seqSent, pending: false, failed: true, error: message };
  useDraftStore.getState().markSaveError(message);
  if (timer === null) scheduleDraftSave(DRAFT_RETRY_MS);
  return { ok: false, error: message };
}

/** 一笔回来了：按 decides 定下这一章，或者什么都不改。 */
function receive(sent: SentPaper, seqSent: number, result: SaveWorkingDraftResult): DraftFlushResult {
  if (result.ok && !result.unchanged) rememberOwnVersion(result.version);
  if (!decides(sent, seqSent)) return { ok: true };
  const live = useDraftStore.getState();
  if ("superseded" in result) return markFailed(sent, seqSent, "这一笔存稿没定下来，稍后自动再试。");
  if (result.ok) {
    sync = { projectPath: sent.projectPath, chapter: sent.chapter, lastSeq: seqSent, pending: false, failed: false };
    rejected = null;
    live.markSaved(result.version, sent.body, sent.title, sent.rev);
    return { ok: true };
  }
  // 撞了版本：作者这份服务端存成了恢复稿才有号，稿纸出提示。这一下不再重发；作者接着动了就再存（更新恢复稿）。
  // 没有号 = 没另外存下来：当没存上，字还在稿纸上，过一会儿再试。
  // 提示只说稿纸不知道的盘上那版：它说的正是稿纸现在的底版 = 作者在提示上已经选过这一版（第 11 轮复核 Y2），不再挂；
  // 选过之后盘上又变了，就是新的事，照挂（第 12 轮复核 Z1：不拿「发出时底版换没换」去猜）。
  const currentVersion = result.currentVersion !== undefined ? result.currentVersion : result.current?.version ?? null;
  if (currentVersion !== live.baseVersion) live.markConflict(result);
  if (!result.recoveryId) return markFailed(sent, seqSent, "别处刚改过这一章，你这段也没能另存下来。字还在稿纸上，稍后自动再试。");
  sync = { projectPath: sent.projectPath, chapter: sent.chapter, lastSeq: seqSent, pending: false, failed: false };
  rejected = sent;
  return { ok: true };
}

/**
 * 发一笔（要发才发）：这一章记成没落定，登记进 requests，回来后 receive。keepalive = 关窗途中那笔，不等前面那笔。
 * 返回这一笔的结果（不是这一章最后那笔的，说明不了什么，算 ok）；不用发返回 undefined。
 */
function send(keepalive: boolean): Promise<DraftFlushResult> | undefined {
  const state = useDraftStore.getState();
  if (!state.projectPath || !needsSave(state)) return undefined;
  const sent: SentPaper = { projectPath: state.projectPath, chapter: state.chapter, body: state.body, title: state.title, baseVersion: state.baseVersion, rev: state.rev };
  const sender = nextSender();
  sync = { projectPath: sent.projectPath, chapter: sent.chapter, lastSeq: sender.seq, pending: true, failed: syncOf(sent).failed };
  savesSent += 1;
  state.markSaving();
  const request = saveWorkingDraft({
    projectPath: sent.projectPath,
    chapter: sent.chapter,
    body: sent.body,
    ...(sent.title.trim() ? { title: sent.title.trim() } : {}),
    baseVersion: sent.baseVersion,
    ...sender,
  }, keepalive ? { keepalive: true } : undefined).then(
    (result) => receive(sent, sender.seq, result),
    (error: unknown) => (decides(sent, sender.seq) ? markFailed(sent, sender.seq, error instanceof Error ? error.message : String(error)) : { ok: true as const }),
  );
  requests.add(request);
  void request.finally(() => requests.delete(request));
  return request;
}

/**
 * 现在就存：等还没回来的那几笔都回来，这一章没落定、或手上的字和盘上不一样就再发一笔，直到落定且没有要存的。
 * 没存上如实返回，过一会儿自动再试。
 */
export async function saveDraftNow(): Promise<DraftFlushResult> {
  clearTimer();
  for (;;) {
    if (requests.size > 0) {
      await Promise.allSettled([...requests]);
      continue;
    }
    const request = send(false);
    if (!request) return { ok: true };
    const result = await request;
    // 没存上：字还在稿纸上，markFailed 已经排好过一会儿再试（这期间作者再打字也会重新排）。
    if (!result.ok) return result;
  }
}

/** 换章、撤销、关窗前：把没存的字存掉，等它落盘（撞了版本的那份在恢复稿里，也算存下了；没存上如实返回）。 */
export async function flushDraftSave(): Promise<DraftFlushResult> {
  return saveDraftNow();
}

/**
 * 关窗前要不要拦：这一章最后那笔明确没存上、之后还没有一笔存成。keepalive 不等回执，救不了已知存不上的那份（第 4 轮复核 R10）。
 * 撞了版本另存成恢复稿的不算（那是落定了）。不拿手上的字和底版比：没存上之后盘上是什么说不准（第 9 轮复核 W1）。
 */
export function hasFailedUnsavedDraft(): boolean {
  const state = useDraftStore.getState();
  return paperOpen(state) && syncOf(state).failed;
}

/** 关窗途中的最后一笔（keepalive，不等前面那笔）：底版和在路上那笔一样，服务端按窗口号和序号顺着接（见文件头）。 */
export function saveDraftKeepalive(): void {
  clearTimer();
  void send(true);
}

/**
 * 稿纸要被换掉（另一章、另一本书、回书架）之前的最后一步：把没存的字存完，存不上抛 UnsavedPaperError。
 * 调用方拿到之后要在同一个同步回合里换稿纸（replacePaperNow / clearPaperNow）：这之后再 await，期间打的字就没人管了
 * （第 4 轮 R3、第 5 轮 S6/S7）。
 */
export async function drainPaper(): Promise<void> {
  const flushed = await saveDraftNow();
  if (!flushed.ok) throw new UnsavedPaperError(flushed.error);
}

/** 每换一次稿纸加一；正在读盘的换法读回来时号不对 = 被后来的换法顶掉了，不换（第 5 轮 S3）。 */
let paperIntent = 0;

/** 手上还有没存的字就不许换（漏了 drainPaper 的入口在这里如实失败，不丢字）。 */
function assertNothingUnsaved(): void {
  const state = useDraftStore.getState();
  if (requests.size > 0 || needsSave(state)) throw new UnsavedPaperError("刚打的字还在存");
}

/** 读盘前领的记号：那时发过几笔存稿、第几次开读。 */
export interface PaperReadMark {
  readonly saves: number;
  readonly ticket: number;
}

/** 开读领号（越晚开读号越大）；稿纸上那份是哪一号读来的。 */
let readTickets = 0;
let shownTicket = 0;

/**
 * 读盘之前记一笔，换上时拿来比：读的期间这一章又存过，读回来的就可能是旧的；
 * 稿纸上这一章已经换上了更晚开读的那份，这份就是迟到的旧读数（第 7 轮复核 U1）。
 */
export function paperReadMark(): PaperReadMark {
  return { saves: savesSent, ticket: (readTickets += 1) };
}

/** 读回来的这一章还能不能用在手上这一章：读的期间没存过稿、没有更晚开读的已经换上。 */
function readStillFresh(read: PaperReadMark): boolean {
  return read.saves === savesSent && read.ticket > shownTicket;
}

/**
 * 稿纸换成这一份（调用前 await drainPaper，之后同步调）。read = 读这份之前的 paperReadMark()：
 * 读的就是手上这一章、读的期间又存过稿，手上这份比读回来的新，不换（第 6 轮复核 T1 同类：迟到的旧读数不盖刚存的字）。
 */
export function replacePaperNow(projectPath: string, paper: ChapterPaper, read?: PaperReadMark): void {
  assertNothingUnsaved();
  paperIntent += 1;
  const state = useDraftStore.getState();
  if (read !== undefined && !readStillFresh(read) && state.projectPath === projectPath && state.chapter === paper.chapter && state.loaded) return;
  state.loadPaper(projectPath, paper);
  sync = null;
  rejected = null;
  shownTicket = read?.ticket ?? (readTickets += 1);
}

/** 稿纸清空（回书架、书没了）。调用前 await drainPaper，之后同步调。 */
export function clearPaperNow(): void {
  assertNothingUnsaved();
  paperIntent += 1;
  sync = null;
  rejected = null;
  useDraftStore.getState().reset();
  shownTicket = (readTickets += 1);
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
    // 还没回来的那几笔先等它们落盘，读回来的才是它们之后的样子。
    while (requests.size > 0) await Promise.allSettled([...requests]);
    const state = useDraftStore.getState();
    if (!state.projectPath || state.chapter <= 0) return "skipped";
    if (options.chapter !== undefined && options.chapter !== state.chapter) return "skipped";
    const projectPath = state.projectPath;
    const chapter = state.chapter;
    const intent = paperIntent;
    const read = paperReadMark();
    const paper = await fetchChapterPaper(projectPath, chapter);
    // 稿纸换过了（换章、换书、开过别的）：这份不是它的。
    if (intent !== paperIntent) return "skipped";
    // 后开读的一次已经换上了：这份是迟到的旧读数，不拿它盖（第 7 轮复核 U1）。
    if (read.ticket <= shownTicket) return "skipped";
    // 读的期间发过存稿：读回来的可能比刚存的旧，迟到了也不能拿它盖（第 6 轮复核 T1）。再读。
    if (read.saves !== savesSent || requests.size > 0) continue;
    shownTicket = read.ticket;
    // 有没有没存的字看统一待存状态（第 10 轮复核 X2）和改动号（第 12 轮复核 Z3）：手上的字正好等于底版也可能没存。
    const live = useDraftStore.getState();
    const outcome = live.receivePaper(projectPath, paper, { unsaved: needsSave(live) });
    // 盘上变了、作者手上还有没存的字：马上存一笔。盘上那版是这个窗口早先存的，服务端认得出、顺着存上（提示随之收起）；
    // 认不出就撞版本、存成恢复稿（第 11 轮复核 Y1：稿纸自己不认底版）。
    if (outcome === "incoming" || (outcome === "own" && needsSave(useDraftStore.getState()))) scheduleDraftSave(0);
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
  requests.clear();
  sync = null;
  readTickets = 0;
  shownTicket = 0;
  rejected = null;
  paperIntent = 0;
  savesSent = 0;
  ownVersions.length = 0;
  clientId = newClientId();
  seq = 0;
}
