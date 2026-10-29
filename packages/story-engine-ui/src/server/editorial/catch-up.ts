/**
 * 后台补读的进度和共用队列（2026-10-12 T5 长书；写作版本 P2a 起补读本身是执行器的 background.backfill 操作）。
 *
 * 补读交给执行器（`lib/reader-backfill.ts` 的提交口 → `services/operations/recipes/background-backfill.ts`）：冻结每个角色的章范围、
 * 一章一步、有额度、能停、进程没了开书自动接着做。这里只剩两件：
 *   - 进度：从这本书在跑的 background.backfill 的冻结范围和当前步骤算（原来的 agents/<角色>/progress.json 删了），
 *     加上核账 / 拟纲 / 记账当场补笔记的进度（只在内存，reader-progress.ts）和「谁在等它读完」（waiting-registry.ts）；
 *   - 每本书一条共用队列（2026-10-12 R1）：后台补读的每一步和导入后的通读记账排在同一条队上，不同时并发打模型服务商。
 */
import { listOperations, type OperationRecord, type PauseReason } from "../lib/operations/store.js";
import { BACKFILL_KIND, parseBackfillStep, readBackfillParams, type BackfillRange } from "../lib/reader-backfill.js";
import { countCommittedChapters } from "./reader-window.js";
import { readInPlaceProgress } from "./reader-progress.js";
import { readerWaitingActions } from "./waiting-registry.js";
import { readRereadState, rereadEtaMinutes } from "./reread-state.js";

/** 编辑部三个跟读角色的 id（跟 index.ts 的 readerRoles() 同序：checker → ledger → planner）。 */
export const READER_ROLE_IDS: readonly string[] = ["checker", "ledger", "planner"];

/** 一个角色的补读进度（进度行 / 轻量轮询接口用的形状）：没在后台补读里、也没当场补的角色当 0/0、不在读。
 *  waiting＝哪个动作在等它读完（R6.1：进程内登记表合进来的，当场补笔记 / 排在后台补读后面干等都带；那个角色在读才带）。 */
export interface ReaderCatchUpRoleState {
  readonly role: string;
  readonly reading: boolean;
  readonly done: number;
  readonly total: number;
  readonly waiting?: string;
  /** 这个角色的后台补读停着、等作者处理（结果不明、额度到了、被打断），不会自己另起一份重来；为什么停的。 */
  readonly paused?: PauseReason;
}

/** 导入已写的书后记账员通读记账的进度（P8）：还没记完才带。stopped＝某章连着记不上，等作者点「接着记」。 */
export interface RereadStatus {
  readonly status: "running" | "stopped";
  readonly done: number;
  readonly total: number;
  readonly etaMinutes?: number;
  readonly stoppedReason?: string;
}

/** 三个角色的补读进度一览：reading＝还有任一角色在读（全读完为 false，界面这行进度就消失）。 */
export interface ReadersCatchUpStatus {
  readonly reading: boolean;
  readonly roles: readonly ReaderCatchUpRoleState[];
  /** 通读记账没记完（P8）：记账员那一行按它显示，停下时界面给「接着记」。 */
  readonly reread?: RereadStatus;
}

interface BackfillView {
  readonly record: OperationRecord;
  readonly ranges: readonly BackfillRange[];
}

/** 这本书的后台补读（排着、跑着的，停着的），新受理的在前。同一个角色同时只在一份排着 / 跑着的里（提交口按角色排）。 */
async function listBackfills(projectDir: string): Promise<{ readonly active: readonly BackfillView[]; readonly paused: readonly BackfillView[] }> {
  const records = await listOperations(projectDir).catch(() => [] as OperationRecord[]);
  const views = records
    .filter((record) => record.kind === BACKFILL_KIND)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((record): BackfillView[] => {
      const params = readBackfillParams(record.params);
      return params ? [{ record, ranges: params.ranges }] : [];
    });
  return {
    active: views.filter((view) => view.record.state === "queued" || view.record.state === "running"),
    paused: views.filter((view) => view.record.state === "paused"),
  };
}

/**
 * 后台补读里各角色读到哪：按冻结的先后，当前步骤那个角色在读（done = 当前章 − 1），前面的读完了（done = to），后面的排队（done = from − 1）。
 * 还没开始跑（queued）就是第一个角色在读、读到 from − 1。
 */
function backfillRoleStates(record: OperationRecord, ranges: readonly BackfillRange[]): Map<string, { readonly reading: boolean; readonly done: number; readonly to: number }> {
  const step = parseBackfillStep(record.currentStep);
  const currentIndex = step ? Math.max(0, ranges.findIndex((range) => range.role === step.role)) : 0;
  const states = new Map<string, { readonly reading: boolean; readonly done: number; readonly to: number }>();
  ranges.forEach((range, index) => {
    if (index < currentIndex) states.set(range.role, { reading: false, done: range.to, to: range.to });
    else if (index > currentIndex) states.set(range.role, { reading: false, done: range.from - 1, to: range.to });
    else states.set(range.role, { reading: true, done: step && step.role === range.role ? Math.max(range.from - 1, step.chapter - 1) : range.from - 1, to: range.to });
  });
  return states;
}

/** 三个角色的补读进度一览（开书概况和 /api/reader-progress 轮询共用这一份形状）。 */
export async function readReadersCatchUpStatus(notesRoot: string, roleIds: readonly string[] = READER_ROLE_IDS): Promise<ReadersCatchUpStatus> {
  // 分母跟当前已定稿章数走（R5.3：读的途中作者又定稿了新章，冻结的范围是旧的）。
  const committed = await countCommittedChapters(notesRoot).catch(() => 0);
  const backfills = await listBackfills(notesRoot);
  // 每个角色看含它的那份排着 / 跑着的（新的在前，先到先得）。
  const fromBackfill = new Map<string, { readonly reading: boolean; readonly done: number; readonly to: number }>();
  for (const view of backfills.active) {
    for (const [role, state] of backfillRoleStates(view.record, view.ranges)) if (!fromBackfill.has(role)) fromBackfill.set(role, state);
  }
  // 停着的：那个角色读到哪（停在的那一步的前一章）、为什么停。
  const pausedRoles = new Map<string, { readonly done: number; readonly to: number; readonly reason: PauseReason }>();
  for (const view of backfills.paused) {
    for (const [role, state] of backfillRoleStates(view.record, view.ranges)) {
      if (!pausedRoles.has(role)) pausedRoles.set(role, { done: state.done, to: state.to, reason: view.record.pauseReason ?? "interrupted" });
    }
  }
  const roles = roleIds.map((roleId): ReaderCatchUpRoleState => {
    // 「（核账在等它读完）」只从进程内登记表来（R6.1），那个角色在读才带。
    const waitingActions = readerWaitingActions(notesRoot, roleId);
    const withWaiting = (state: ReaderCatchUpRoleState): ReaderCatchUpRoleState =>
      (state.reading && waitingActions.length > 0 ? { ...state, waiting: waitingActions.join("、") } : state);
    const inPlace = readInPlaceProgress(notesRoot, roleId);
    if (inPlace) return withWaiting({ role: roleId, reading: true, done: inPlace.done, total: Math.max(inPlace.total, committed) });
    const queued = fromBackfill.get(roleId);
    if (queued) return withWaiting({ role: roleId, reading: queued.reading, done: queued.done, total: Math.max(queued.to, committed) });
    const paused = pausedRoles.get(roleId);
    if (paused) return { role: roleId, reading: false, done: paused.done, total: Math.max(paused.to, committed), paused: paused.reason };
    return { role: roleId, reading: false, done: 0, total: 0 };
  });
  const reading = backfills.active.length > 0 || roles.some((role) => role.reading);
  // P8：通读记账没记完时，记账员那一行按通读状态显示。
  const reread = await readRereadState(notesRoot);
  if (!reread || reread.status === "done") return { reading, roles };
  const withReread = roles.map((role) => (role.role === LEDGER_ROLE_ID ? { role: role.role, reading: reread.status === "running", done: reread.done, total: reread.total } : role));
  const eta = rereadEtaMinutes(reread);
  return {
    reading: reading || withReread.some((role) => role.reading),
    roles: withReread,
    reread: {
      status: reread.status,
      done: reread.done,
      total: reread.total,
      ...(eta !== undefined ? { etaMinutes: eta } : {}),
      ...(reread.stoppedReason ? { stoppedReason: reread.stoppedReason } : {}),
    },
  };
}

const LEDGER_ROLE_ID = "ledger";

/** 每本书一条补读队列（R1）：后台补读的每一步、通读记账共用，不同时并发打模型。 */
const bookCatchUpQueues = new Map<string, Promise<unknown>>();

/** 同一本书的补读任务排成一条队：先来后到，一条跑完再跑下一条（前一条失败不拦后面的）。 */
export async function runInReaderCatchUpQueue<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = bookCatchUpQueues.get(root) ?? Promise.resolve();
  const current = previous.then(task);
  const tail = current.catch(() => undefined);
  bookCatchUpQueues.set(root, tail);
  try {
    return await current;
  } finally {
    if (bookCatchUpQueues.get(root) === tail) bookCatchUpQueues.delete(root);
  }
}

/** 测试用：模拟进程没了（在飞的那一步还占着队，新进程里没有这条队）。 */
export function __resetCatchUpQueuesForTests(): void {
  bookCatchUpQueues.clear();
}
