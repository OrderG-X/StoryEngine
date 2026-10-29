/**
 * 操作记录（写作版本 P2a，契约 `contracts/操作.md` 第五节、设计第二节）。
 *
 * 一次操作的东西都在它自己的目录 `agents/operations/<opId>/` 里：`operation.json` 是唯一记录，每次状态变化整份原子重写、
 * eventSeq 递增；冻结材料 `inputs/`、步骤检查点 `steps/`、物理发送记账 `attempts/`、票和结果 `artifacts/`。
 *
 * - opId 由 requestKey 定（同一个键只会落到同一个目录），不另设索引。**一份有效的 operation.json 才算受理了**：
 *   目录在、记录没有或坏了 = 崩在受理中途，照常受理、整份覆盖。
 * - 锁序只有一种：书锁 → 记录锁。改状态的事（受理、取消、暂停、换 runEpoch）先拿书锁再短拿记录锁（changeOperation）；
 *   拿着记录锁不许等书锁（withRecordLock 里再要书锁直接抛错）。beforeSend 只拿记录锁。
 * - 写位：受理后 writeScope 不变；占位 = 状态是 queued / running 的操作的 writeScope。
 * - 本进程调度表：受理时在同一次持书锁里登记；开书对账先排除登记着的（不把刚受理、还没起 worker 的判死）。
 * - 清理留墓碑：同键重送回放结果或拒绝，绝不重新开工。期限都按服务端时钟：请求的 issuedAt 早于 365 天的直接拒；
 *   墓碑留到过了 max(受理时间, issuedAt) + 400 天——客户端时钟偏快偏慢，墓碑都比还能进来的同键请求活得久。
 * 这里只放记录的格式、读写、锁和受理；跑配方在 services/operations/executor.ts。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { bookKey, canonicalJson, withBookLock } from "@actalk/story-core";
import { runExclusive, writeFileAtomic } from "../project-io.js";

export const OPERATION_SCHEMA = "story-operation/1" as const;
export const OPERATIONS_DIR = "agents/operations";
/** 结束了的操作留多久、每本书留几次（之后清目录、留墓碑）。 */
export const OPERATION_KEEP_DAYS = 30;
export const OPERATION_KEEP_COUNT = 200;
/** 墓碑留多久；请求比这个短一截就拒（墓碑过期之后旧键也进不来）。 */
export const TOMBSTONE_KEEP_DAYS = 400;
export const REQUEST_MAX_AGE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export type OperationState = "queued" | "running" | "waiting_author" | "paused" | "succeeded" | "failed" | "cancelled" | "obsolete";
export type PauseReason = "budget" | "material" | "attempt_unknown" | "interrupted";
export const TERMINAL_STATES: ReadonlySet<OperationState> = new Set(["succeeded", "failed", "cancelled", "obsolete"]);
export const isTerminal = (state: OperationState): boolean => TERMINAL_STATES.has(state);
/** 占写位的状态。 */
const OCCUPYING: ReadonlySet<OperationState> = new Set(["queued", "running"]);

/** 允许的状态转换（终态不再改；attempt 结算不改记录，见 attempts.ts）。 */
const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  queued: ["running", "paused", "cancelled", "obsolete"],
  running: ["running", "waiting_author", "paused", "succeeded", "failed", "cancelled", "obsolete"],
  waiting_author: ["running", "cancelled", "obsolete"],
  paused: ["running", "cancelled", "obsolete"],
  succeeded: [],
  failed: [],
  cancelled: [],
  obsolete: [],
};

export type OriginKind = "chat" | "button" | "background";

export interface OperationOrigin {
  readonly kind: OriginKind;
  /** 对话：作者那条消息的 UUID；按钮：出按钮时给的 UUID。 */
  readonly messageId?: string;
  readonly chapter?: number;
  /** 后台操作是谁触发的（opId）。 */
  readonly producedFor?: string;
}

export interface WriteScope {
  /** 这次能写的工作稿章号（只读操作是空）。 */
  readonly chapters: readonly number[];
}

export interface PendingAction {
  readonly actionId: string;
  readonly kind: string;
  readonly ticket?: string;
  /** 第一次点的那个决定的哈希：同一个按钮换决定再来 = decision_conflict。 */
  readonly decisionHash?: string;
}

/** 额度（设计 4.5）：这次最多发几次可能计费的请求。受理时按配方算式给，接着做时加上那一步的最坏值。 */
export interface OperationBudget {
  readonly limit: number;
}

export interface OperationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface OperationRecord {
  readonly schema: typeof OPERATION_SCHEMA;
  readonly opId: string;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly issuedAt: string;
  readonly kind: string;
  readonly mode?: string;
  readonly params: unknown;
  readonly recipeVersion: number;
  readonly origin: OperationOrigin;
  /** 受理时书的纪元（核心 readBookEpoch）：换了 = 书被整本恢复 / 搬回过，这次不能再写。 */
  readonly bookEpoch: string;
  readonly writeScope: WriteScope;
  readonly budget: OperationBudget;
  readonly state: OperationState;
  readonly pauseReason?: PauseReason;
  /** 每次跑起来、取消、暂停都 +1：旧 worker 的写过不了栅栏。 */
  readonly runEpoch: number;
  /** 最后一次让它跑起来的进程。 */
  readonly bootId: string;
  readonly currentStep?: string;
  readonly failure?: OperationFailure;
  readonly pendingActions: readonly PendingAction[];
  /** 作者已经处理过的结果不明的 attempt：开书、resume 不再拿来拦。 */
  readonly settledUnknowns: readonly string[];
  readonly eventSeq: number;
  readonly result?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationTombstone {
  readonly schema: typeof OPERATION_SCHEMA;
  readonly tombstone: true;
  readonly opId: string;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly state: OperationState;
  /** 给作者看的一句结果。 */
  readonly summary: string;
  /** 请求自己带的时间（前端时钟）和服务端受理的时间：墓碑留到 max(两者) + 400 天。 */
  readonly issuedAt: string;
  readonly acceptedAt: string;
  readonly clearedAt: string;
}

export type StoredOperation =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "record"; readonly record: OperationRecord }
  | { readonly kind: "tombstone"; readonly tombstone: OperationTombstone };

/** 进程启动时随机给：开书对账认「上一个进程留下的」。 */
export const BOOT_ID = randomUUID();

/** 操作号的样子（`op-` + 20 位十六进制）：从外面来的号先过它再拼路径。 */
export function isOperationId(value: string): boolean {
  return /^op-[0-9a-f]{20}$/u.test(value);
}

export function opIdFor(requestKey: string): string {
  return `op-${createHash("sha256").update(requestKey, "utf-8").digest("hex").slice(0, 20)}`;
}

export function requestHashOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf-8").digest("hex");
}

export function operationDir(bookDir: string, opId: string): string {
  return join(bookDir, OPERATIONS_DIR, opId);
}

const recordPath = (bookDir: string, opId: string): string => join(operationDir(bookDir, opId), "operation.json");

/** 冻结材料 `inputs/<名>.json`（名字只用字母、数字、横线，配方里写死的）。读在 inputs.ts。 */
export function inputPath(bookDir: string, opId: string, name: string): string {
  if (!/^[0-9A-Za-z-]+$/u.test(name)) throw new Error(`冻结材料的名字不对：${name}`);
  return join(operationDir(bookDir, opId), "inputs", `${name}.json`);
}

async function writeInputFile(bookDir: string, opId: string, name: string, value: unknown): Promise<void> {
  const path = inputPath(bookDir, opId, name);
  await mkdir(join(operationDir(bookDir, opId), "inputs"), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is OperationRecord {
  const record = value as Partial<OperationRecord> | null;
  return (
    record?.schema === OPERATION_SCHEMA &&
    typeof record.opId === "string" &&
    typeof record.requestKey === "string" &&
    typeof record.requestHash === "string" &&
    typeof record.kind === "string" &&
    typeof record.state === "string" &&
    record.state in TRANSITIONS &&
    typeof record.runEpoch === "number" &&
    typeof record.eventSeq === "number" &&
    typeof record.bookEpoch === "string" &&
    Array.isArray(record.writeScope?.chapters) &&
    typeof record.budget?.limit === "number" &&
    Array.isArray(record.pendingActions) &&
    Array.isArray(record.settledUnknowns)
  );
}

function isTombstone(value: unknown): value is OperationTombstone {
  const stone = value as Partial<OperationTombstone> | null;
  return (
    stone?.schema === OPERATION_SCHEMA &&
    stone.tombstone === true &&
    typeof stone.opId === "string" &&
    typeof stone.requestKey === "string" &&
    typeof stone.requestHash === "string" &&
    !Number.isNaN(Date.parse(stone.issuedAt ?? "")) &&
    !Number.isNaN(Date.parse(stone.acceptedAt ?? ""))
  );
}

/** 读一次操作。键对不上（不是这个 opId 的记录）也算坏的。 */
export async function readOperation(bookDir: string, opId: string): Promise<StoredOperation> {
  let raw: string;
  try {
    raw = await readFile(recordPath(bookDir, opId), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (isTombstone(value) && value.opId === opId && opIdFor(value.requestKey) === opId) return { kind: "tombstone", tombstone: value };
  if (isRecord(value) && value.opId === opId && opIdFor(value.requestKey) === opId) return { kind: "record", record: value };
  return { kind: "invalid" };
}

/* ------------------------------------------------------------------ */
/*  锁                                                                  */
/* ------------------------------------------------------------------ */

const holdingRecordLock = new AsyncLocalStorage<boolean>();

/** 短拿一次操作的记录锁（进程内）。里面不许等书锁。 */
export function withRecordLock<T>(bookDir: string, opId: string, task: () => Promise<T>): Promise<T> {
  return runExclusive(`operation:${bookKey(bookDir)}:${opId}`, () => holdingRecordLock.run(true, task));
}

/** 拿书锁之前调：拿着记录锁再要书锁是锁序错了（会和改状态的那条路互等），直接抛错。 */
export function assertNotHoldingRecordLock(): void {
  if (holdingRecordLock.getStore()) throw new Error("锁序错了：拿着操作记录锁时不能再要书锁");
}

/** 按锁序改状态：书锁 → 记录锁。 */
export function withBookThenRecord<T>(bookDir: string, opId: string, task: () => Promise<T>): Promise<T> {
  assertNotHoldingRecordLock();
  return withBookLock(bookDir, () => withRecordLock(bookDir, opId, task));
}

/* ------------------------------------------------------------------ */
/*  写和订阅                                                            */
/* ------------------------------------------------------------------ */

type RecordListener = (record: OperationRecord) => void;
const listeners = new Map<string, Set<RecordListener>>();
const listenerKey = (bookDir: string, opId: string): string => `${bookKey(bookDir)}:${opId}`;

/** 订阅一次操作的记录变化（每次写成之后同步调；订阅交接见 executor）。返回退订。 */
export function onOperationRecord(bookDir: string, opId: string, listener: RecordListener): () => void {
  const key = listenerKey(bookDir, opId);
  const set = listeners.get(key) ?? new Set<RecordListener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

async function writeRecordFile(bookDir: string, record: OperationRecord | OperationTombstone): Promise<void> {
  const dir = operationDir(bookDir, record.opId);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(recordPath(bookDir, record.opId), `${JSON.stringify(record, null, 2)}\n`);
}

export class OperationTransitionError extends Error {
  constructor(readonly from: OperationState, readonly to: OperationState) {
    super(`操作状态不能从 ${from} 改成 ${to}`);
    this.name = "OperationTransitionError";
  }
}

/**
 * 改一次操作的记录：调用方拿着记录锁（changeOperation / withRecordLock 里）。读最新的 → mutate → 核转换 → eventSeq + 1 → 原子写 → 通知订阅。
 * mutate 返回 undefined = 不改。记录不在 / 坏了返回 undefined。
 */
export async function updateOperationLocked(
  bookDir: string,
  opId: string,
  mutate: (current: OperationRecord) => OperationRecord | undefined,
  now: Date = new Date(),
): Promise<OperationRecord | undefined> {
  const stored = await readOperation(bookDir, opId);
  if (stored.kind !== "record") return undefined;
  const current = stored.record;
  const next = mutate(current);
  if (!next) return current;
  if (next.state !== current.state && !TRANSITIONS[current.state].includes(next.state)) throw new OperationTransitionError(current.state, next.state);
  if (isTerminal(current.state)) throw new OperationTransitionError(current.state, next.state);
  const written: OperationRecord = { ...next, opId: current.opId, requestKey: current.requestKey, writeScope: current.writeScope, eventSeq: current.eventSeq + 1, updatedAt: now.toISOString() };
  await writeRecordFile(bookDir, written);
  syncScheduler(bookDir, written);
  for (const listener of listeners.get(listenerKey(bookDir, opId)) ?? []) {
    try {
      listener(written);
    } catch (error) {
      console.warn("[operations] 记录变化的订阅方出错（不影响操作）", error);
    }
  }
  return written;
}

/** 按锁序改状态（取消、暂停换状态、resume 换 runEpoch、等作者）。 */
export function changeOperation(
  bookDir: string,
  opId: string,
  mutate: (current: OperationRecord) => OperationRecord | undefined,
  now?: Date,
): Promise<OperationRecord | undefined> {
  return withBookThenRecord(bookDir, opId, () => updateOperationLocked(bookDir, opId, mutate, now));
}

/* ------------------------------------------------------------------ */
/*  本进程调度表                                                        */
/* ------------------------------------------------------------------ */

interface Scheduled {
  readonly state: "queued" | "running";
  readonly runEpoch: number;
}
const scheduler = new Map<string, Map<string, Scheduled>>();

function syncScheduler(bookDir: string, record: OperationRecord): void {
  const book = bookKey(bookDir);
  const table = scheduler.get(book);
  if (record.state === "queued" || record.state === "running") {
    const next = table ?? new Map<string, Scheduled>();
    next.set(record.opId, { state: record.state, runEpoch: record.runEpoch });
    scheduler.set(book, next);
    return;
  }
  table?.delete(record.opId);
  if (table && table.size === 0) scheduler.delete(book);
}

/** 本进程登记着（queued / running）的操作：开书对账不碰它们。 */
export function isScheduledHere(bookDir: string, opId: string): boolean {
  return scheduler.get(bookKey(bookDir))?.has(opId) ?? false;
}

/* ------------------------------------------------------------------ */
/*  列举和写位                                                          */
/* ------------------------------------------------------------------ */

/** 这本书所有有效的操作记录（墓碑、坏的不算）。一本书非终态的个位数，结束的留 200 次以内，扫一遍是毫秒级。 */
export async function listOperations(bookDir: string): Promise<readonly OperationRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(bookDir, OPERATIONS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: OperationRecord[] = [];
  for (const name of names) {
    const stored = await readOperation(bookDir, name);
    if (stored.kind === "record") records.push(stored.record);
  }
  return records;
}

/** 占着这几章写位的操作（queued / running）。 */
export function occupantOf(records: readonly OperationRecord[], scope: WriteScope, except?: string): OperationRecord | undefined {
  if (scope.chapters.length === 0) return undefined;
  return records.find((record) => record.opId !== except && OCCUPYING.has(record.state) && record.writeScope.chapters.some((chapter) => scope.chapters.includes(chapter)));
}

/* ------------------------------------------------------------------ */
/*  受理                                                                */
/* ------------------------------------------------------------------ */

export interface OperationRequest {
  readonly requestKey: string;
  readonly issuedAt: string;
  readonly kind: string;
  readonly mode?: string;
  readonly params: unknown;
  readonly recipeVersion: number;
  readonly origin: OperationOrigin;
  readonly writeScope: WriteScope;
  readonly budget: OperationBudget;
}

export type AcceptOutcome =
  | { readonly ok: true; readonly record: OperationRecord; readonly existing: boolean }
  | { readonly ok: true; readonly tombstone: OperationTombstone }
  | { readonly ok: false; readonly code: "request_conflict" | "request_expired" | "target_busy" | "invalid_request" | "book_gone"; readonly message: string; readonly occupant?: OperationRecord };

/** 对话键只认键（同一条消息重发、模型这次提交得不一样也回原操作）；按钮、后台键认键 + 参数。 */
const sameRequest = (record: { readonly requestHash: string }, request: OperationRequest, hash: string): boolean =>
  request.origin.kind === "chat" || record.requestHash === hash;

/**
 * 受理一次操作：书锁里算 opId → 读有效记录（去重）/ 墓碑（回放）→ 核写位 → 本进程调度表登记 → 写 queued 记录。
 * 写记录失败就注销登记、如实报没受理。
 */
export async function acceptOperation(
  bookDir: string,
  request: OperationRequest,
  context: {
    readonly bookEpoch: () => Promise<string>;
    readonly now?: Date;
    /** 冻结材料（名 → 内容）：新受理时写进 `inputs/`，在 operation.json 之前；同键回原操作时不动。 */
    readonly inputs?: Readonly<Record<string, unknown>>;
  },
): Promise<AcceptOutcome> {
  const now = context.now ?? new Date();
  const issued = Date.parse(request.issuedAt);
  if (!request.requestKey.trim() || Number.isNaN(issued)) return { ok: false, code: "invalid_request", message: "这次请求缺了标记，没有受理。" };
  if (now.getTime() - issued > REQUEST_MAX_AGE_DAYS * DAY_MS) return { ok: false, code: "request_expired", message: "这是很久以前的一次请求，没有再做。" };
  const opId = opIdFor(request.requestKey);
  const hash = requestHashOf({ kind: request.kind, mode: request.mode ?? null, params: request.params });
  assertNotHoldingRecordLock();
  return withBookLock(bookDir, async () => {
    try {
      if (!(await stat(bookDir)).isDirectory()) return { ok: false, code: "book_gone", message: "这本书已经不在原处了，没有受理。" };
    } catch {
      return { ok: false, code: "book_gone", message: "这本书已经不在原处了，没有受理。" };
    }
    const stored = await readOperation(bookDir, opId);
    if (stored.kind === "tombstone") {
      if (!sameRequest(stored.tombstone, request, hash)) return { ok: false, code: "request_conflict", message: "这个按钮已经按上一次的选择做过了，这次的选择没有执行。" };
      return { ok: true, tombstone: stored.tombstone };
    }
    if (stored.kind === "record") {
      if (!sameRequest(stored.record, request, hash)) return { ok: false, code: "request_conflict", message: "这个按钮已经按上一次的选择做过了，这次的选择没有执行。" };
      return { ok: true, record: stored.record, existing: true };
    }
    const occupant = occupantOf(await listOperations(bookDir), request.writeScope);
    if (occupant) return { ok: false, code: "target_busy", message: "这一章正有别的一次在写，先等它做完或停掉它。", occupant };
    const record: OperationRecord = {
      schema: OPERATION_SCHEMA,
      opId,
      requestKey: request.requestKey,
      requestHash: hash,
      issuedAt: request.issuedAt,
      kind: request.kind,
      ...(request.mode ? { mode: request.mode } : {}),
      params: request.params,
      recipeVersion: request.recipeVersion,
      origin: request.origin,
      bookEpoch: await context.bookEpoch(),
      writeScope: { chapters: [...new Set(request.writeScope.chapters)].sort((a, b) => a - b) },
      budget: { limit: Math.max(0, Math.floor(request.budget.limit)) },
      state: "queued",
      runEpoch: 0,
      bootId: BOOT_ID,
      pendingActions: [],
      settledUnknowns: [],
      eventSeq: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    syncScheduler(bookDir, record);
    try {
      for (const [name, value] of Object.entries(context.inputs ?? {})) await writeInputFile(bookDir, opId, name, value);
      await writeRecordFile(bookDir, record);
    } catch (error) {
      syncScheduler(bookDir, { ...record, state: "cancelled" });
      throw error;
    }
    return { ok: true, record, existing: false };
  });
}

/* ------------------------------------------------------------------ */
/*  清理                                                                */
/* ------------------------------------------------------------------ */

const ageDays = (iso: string, now: Date): number => (now.getTime() - Date.parse(iso)) / DAY_MS;

/** 墓碑什么时候能删：服务端时钟过了 max(受理时间, issuedAt) + 400 天（那时同键请求按它的 issuedAt 早就过期了）。 */
export function tombstoneExpired(stone: Pick<OperationTombstone, "issuedAt" | "acceptedAt">, now: Date): boolean {
  const latest = Math.max(Date.parse(stone.issuedAt), Date.parse(stone.acceptedAt));
  return now.getTime() > latest + TOMBSTONE_KEEP_DAYS * DAY_MS;
}

/**
 * 开书时（书锁里）清：结束超 30 天、或每本书超 200 次的操作目录，留墓碑；墓碑过了期限（tombstoneExpired）的删。
 * summaryOf 给墓碑写一句结果（操作结果的投影，executor 给）。
 */
export async function pruneOperations(bookDir: string, summaryOf: (record: OperationRecord) => string, now: Date = new Date()): Promise<{ readonly cleared: readonly string[] }> {
  let names: string[];
  try {
    names = await readdir(join(bookDir, OPERATIONS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cleared: [] };
    throw error;
  }
  const finished: OperationRecord[] = [];
  const cleared: string[] = [];
  for (const name of names) {
    const stored = await readOperation(bookDir, name);
    if (stored.kind === "tombstone") {
      if (tombstoneExpired(stored.tombstone, now)) await rm(operationDir(bookDir, name), { recursive: true, force: true });
      else await removeAllButRecord(bookDir, name);
    } else if (stored.kind === "record" && isTerminal(stored.record.state)) {
      finished.push(stored.record);
    }
  }
  finished.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const [index, record] of finished.entries()) {
    if (index < OPERATION_KEEP_COUNT && ageDays(record.updatedAt, now) <= OPERATION_KEEP_DAYS) continue;
    const stone: OperationTombstone = {
      schema: OPERATION_SCHEMA,
      tombstone: true,
      opId: record.opId,
      requestKey: record.requestKey,
      requestHash: record.requestHash,
      state: record.state,
      summary: summaryOf(record),
      issuedAt: record.issuedAt,
      acceptedAt: record.createdAt,
      clearedAt: now.toISOString(),
    };
    // 先把记录换成墓碑（原子写），再删别的：崩在中间只多留几个文件，下次清；同键重送读到的已经是墓碑。
    await writeRecordFile(bookDir, stone);
    await removeAllButRecord(bookDir, record.opId);
    cleared.push(record.opId);
  }
  return { cleared };
}

async function removeAllButRecord(bookDir: string, opId: string): Promise<void> {
  const dir = operationDir(bookDir, opId);
  for (const name of await readdir(dir)) {
    if (name !== "operation.json") await rm(join(dir, name), { recursive: true, force: true });
  }
}

/** 测试用：清本进程调度表和订阅。 */
export function __resetOperationStoreForTests(): void {
  scheduler.clear();
  listeners.clear();
}
