/**
 * 执行器（写作版本 P2a，契约 `contracts/操作.md`、设计第六节）：模型、按钮、后台都只把意图交到这里；
 * 这里受理、按配方跑完、取消、接着做、开书对账、订阅。对话 AI 只拿受理回执，进度、结果都从操作记录来。
 *
 * - **唯一执行者**：每次跑起来（受理后、接着做、开书自动续）在书锁 → 记录锁里换成 running、runEpoch + 1，
 *   登记一次执行（signal）。旧 worker 的写过不了栅栏、发不出请求。
 * - **步骤**：配方用 ctx.step 切；做完的步骤输出落盘（栅栏里写）才算做完，恢复时输入指纹对得上就零调用。
 * - **结束**：配方跑完 → 书锁里核还是这一次、书的纪元没换 → succeeded；纪元换了 → obsolete；出错 → failed（一句原因）；
 *   被停（取消、暂停）的不改（停的那一方已经换过状态）。
 * - **开书对账**（6.5）：本进程调度表里的不碰；其余 queued / running：有没处理的结果不明 → paused:attempt_unknown，
 *   后台配方登记了自动续 → 接着跑，其余 → paused:interrupted；配方版本对不上 → obsolete。
 */
import { readBookEpoch, withBookLock } from "@actalk/story-core";
import { ensureBookOnCore } from "../../book/mirror/ensure.js";
import { freezeModelChoices, isFrozenModels, type FrozenModels } from "../../lib/llm-client.js";
import { readOperationInput } from "../../lib/operations/inputs.js";
import { coreSnapshotFor } from "../../lib/snapshot.js";
import { listAttempts, settleAbandonedAttempt, unsettledUnknowns } from "../../lib/operations/attempts.js";
import { inputHashOf, readCheckpoint, writeCheckpoint } from "../../lib/operations/checkpoints.js";
import {
  abortExecution,
  OperationStopped,
  registerExecution,
  runInOperation,
  runInStep,
  StopSignal,
  type OperationContext,
} from "../../lib/operations/context.js";
import { stoppedError, withFence } from "../../lib/operations/fence.js";
import { emitLive, onLive, type LiveEvent } from "../../lib/operations/live.js";
import {
  acceptOperation,
  BOOT_ID,
  changeOperation,
  isScheduledHere,
  isTerminal,
  listOperations,
  onOperationRecord,
  pruneOperations,
  readOperation,
  updateOperationLocked,
  withBookThenRecord,
  type OperationFailure,
  type OperationOrigin,
  type OperationRecord,
  type OperationTombstone,
  type WriteScope,
} from "../../lib/operations/store.js";
import type { GateLane } from "../../lib/provider-gate.js";

export const OPERATION_RESULT_SCHEMA = "operation-result/1" as const;

/** 操作结果（契约第五节）：界面和下一轮模型都只读它。 */
export interface OperationResult {
  readonly schema: typeof OPERATION_RESULT_SCHEMA;
  /** 给作者看的一句结论。 */
  readonly summary: string;
  /** 结构化结果（核账结果、补读进度……），按操作类各自的形状。 */
  readonly body?: unknown;
  /** 看了哪些、没看哪些（如实写，不拿「成功」盖过）。 */
  readonly coverage?: unknown;
  readonly warnings?: readonly string[];
}

export type PrepareOutcome<P> =
  | { readonly ok: true; readonly params: P; readonly mode?: string; readonly writeScope: WriteScope; readonly budget: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface RecipeContext<P> {
  readonly bookDir: string;
  readonly record: OperationRecord;
  readonly params: P;
  readonly signal: AbortSignal;
  readonly operation: OperationContext;
  /**
   * 跑一步：有检查点、输入指纹对得上 → 直接返回存下的输出（零调用）；否则整步跑 fn，输出（要能存成 JSON）在栅栏里落盘后才返回。
   * fn 里不许写书（设计零.3），能写的只有本操作自己的目录和按内容键整份覆盖的缓存。
   */
  step<T>(id: string, input: unknown, fn: () => Promise<T>): Promise<T>;
  /** 一句进度（只推给订阅，不落盘）。 */
  progress(text: string): void;
}

export interface Recipe<P = unknown> {
  readonly kind: string;
  /** 配方版本：开书时记录里的对不上就接不上（obsolete）。 */
  readonly version: number;
  readonly lane: GateLane;
  /** 后台配方：进程没了、开书时自动接着跑（没有结果不明的调用时）。 */
  readonly autoResume?: boolean;
  /** 归一、校验参数，算写位和额度（设计 4.5 的算式，跟模型有关的项按这次冻结的模型选择算）；不受理返回失败。 */
  prepare(bookDir: string, input: { readonly mode?: string; readonly params: unknown; readonly origin: OperationOrigin; readonly models: FrozenModels }): Promise<PrepareOutcome<P>>;
  run(ctx: RecipeContext<P>): Promise<OperationResult>;
  /** 接着做时这一步从头做，额度加多少（这一步的最坏值）。 */
  stepBudget(stepId: string | undefined, params: P): number;
}

const recipes = new Map<string, Recipe<unknown>>();

/** 登记配方（recipes/index.ts 启动时调）。 */
export function registerRecipe<P>(recipe: Recipe<P>): void {
  recipes.set(recipe.kind, recipe as Recipe<unknown>);
}

export function recipeFor(kind: string): Recipe<unknown> | undefined {
  return recipes.get(kind);
}

/* ------------------------------------------------------------------ */
/*  提交                                                                */
/* ------------------------------------------------------------------ */

export interface SubmitInput {
  readonly kind: string;
  readonly mode?: string;
  readonly params: unknown;
  readonly requestKey: string;
  readonly issuedAt: string;
  readonly origin: OperationOrigin;
}

export type SubmitOutcome =
  | { readonly ok: true; readonly record: OperationRecord; readonly existing: boolean }
  | { readonly ok: true; readonly tombstone: OperationTombstone }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly occupant?: OperationRecord };

/**
 * 提交一次操作：老书先接上新核心（一次性迁移，不是操作；没接上不受理）→ 冻结模型选择 → 配方归一参数、算写位和额度
 * → 受理（冻结材料写在记录之前）→ 新受理的马上在后台跑起来。只返回受理回执。
 */
export async function submitOperation(bookDir: string, input: SubmitInput): Promise<SubmitOutcome> {
  const recipe = recipes.get(input.kind);
  if (!recipe) return { ok: false, code: "unknown_operation", message: "这类操作还没有。" };
  const onCore = await ensureBookOnCore(bookDir, { snapshot: coreSnapshotFor(bookDir) });
  if (!onCore.ok) return { ok: false, code: "book_not_on_core", message: `这本书还没接上新格式，没有开始：${onCore.reason}` };
  const models = await freezeModelChoices();
  const prepared = await recipe.prepare(bookDir, { ...(input.mode !== undefined ? { mode: input.mode } : {}), params: input.params, origin: input.origin, models });
  if (!prepared.ok) return prepared;
  const accepted = await acceptOperation(bookDir, {
    requestKey: input.requestKey,
    issuedAt: input.issuedAt,
    kind: input.kind,
    ...(prepared.mode !== undefined ? { mode: prepared.mode } : {}),
    params: prepared.params,
    recipeVersion: recipe.version,
    origin: input.origin,
    writeScope: prepared.writeScope,
    budget: { limit: prepared.budget },
  }, { bookEpoch: () => readBookEpoch(bookDir), inputs: { models } });
  if (!accepted.ok) return accepted;
  if ("tombstone" in accepted) return accepted;
  if (!accepted.existing) void startOperation(bookDir, accepted.record.opId);
  return accepted;
}

/* ------------------------------------------------------------------ */
/*  跑                                                                  */
/* ------------------------------------------------------------------ */

interface StartOptions {
  /** 接着做（暂停、等作者之后）：额度加多少、哪些结果不明的 attempt 记成作者处理过。 */
  readonly resume?: { readonly addBudget: number; readonly settle: readonly string[] };
}

/**
 * 让一次操作跑起来：书锁 → 记录锁里换成 running、runEpoch + 1，然后在后台跑配方。已经在跑、终态的不动（重复的 resume 拿不到新 runEpoch）。
 * 返回换完的记录（没换返回当前的）。
 */
export async function startOperation(bookDir: string, opId: string, options: StartOptions = {}): Promise<OperationRecord | undefined> {
  let changed = false;
  const record = await changeOperation(bookDir, opId, (current) => {
    const runnable = current.state === "queued" || (options.resume !== undefined && (current.state === "paused" || current.state === "waiting_author"));
    if (!runnable) return undefined;
    changed = true;
    const { pauseReason: _pauseReason, failure: _failure, ...rest } = current;
    return {
      ...rest,
      state: "running",
      runEpoch: current.runEpoch + 1,
      bootId: BOOT_ID,
      budget: { limit: current.budget.limit + (options.resume?.addBudget ?? 0) },
      settledUnknowns: [...new Set([...current.settledUnknowns, ...(options.resume?.settle ?? [])])],
    };
  });
  if (!record || !changed) return record;
  void execute(bookDir, record);
  return record;
}

async function execute(bookDir: string, record: OperationRecord): Promise<void> {
  const recipe = recipes.get(record.kind);
  const execution = registerExecution(bookDir, record.opId, record.runEpoch);
  const models = await readOperationInput(bookDir, record.opId, "models");
  const operation: OperationContext = {
    bookDir,
    opId: record.opId,
    runEpoch: record.runEpoch,
    bookEpoch: record.bookEpoch,
    signal: execution.signal,
    lane: recipe?.lane ?? "foreground",
    ...(isFrozenModels(models) ? { models } : {}),
  };
  try {
    if (!recipe) throw Object.assign(new Error("这类操作还没有。"), { code: "unknown_operation" });
    // 冻结的模型选择受理时写在记录之前；读不到就不按现在的设置凑合着跑（那就不是开工时那一套了）。
    if (!operation.models) throw Object.assign(new Error("开工时记下的模型设置读不到了，这次没法接着做；重新来一次。"), { code: "inputs_missing" });
    const result = await runInOperation(operation, () => recipe.run(contextFor(record, operation)));
    await finish(operation, result);
  } catch (error) {
    await settleError(operation, error);
  } finally {
    execution.unregister();
  }
}

function contextFor(record: OperationRecord, operation: OperationContext): RecipeContext<unknown> {
  const { bookDir, opId, runEpoch } = operation;
  let currentExec = `${runEpoch}:`;
  return {
    bookDir,
    record,
    params: record.params,
    signal: operation.signal,
    operation,
    async step<T>(id: string, input: unknown, fn: () => Promise<T>): Promise<T> {
      const inputHash = inputHashOf(input);
      const saved = await readCheckpoint(bookDir, opId, id);
      if (saved && saved.inputHash === inputHash) return saved.output as T;
      if (operation.signal.aborted) throw stoppedError(operation);
      const exec = `${runEpoch}:${id}`;
      currentExec = exec;
      await changeOperation(bookDir, opId, (current) => (current.state === "running" && current.runEpoch === runEpoch && current.currentStep !== id ? { ...current, currentStep: id } : undefined));
      emitLive(bookDir, opId, { type: "step", step: id, exec });
      const output = await runInStep(id, exec, fn);
      if (operation.signal.aborted) throw stoppedError(operation);
      await withFence(operation, () => writeCheckpoint(bookDir, opId, { schema: "operation-step/1", stepId: id, inputHash, exec, output: output ?? null, finishedAt: new Date().toISOString() }));
      return output;
    },
    progress(text: string) {
      emitLive(bookDir, opId, { type: "progress", text, exec: currentExec });
    },
  };
}

/** 配方跑完：书锁里核还是这一次在跑、书的纪元没换，才记成功；纪元换了记 obsolete。书不在了读不到记录，什么都不写。 */
async function finish(operation: OperationContext, result: OperationResult): Promise<void> {
  const { bookDir, opId, runEpoch } = operation;
  await withBookThenRecord(bookDir, opId, async () => {
    const epoch = await readBookEpoch(bookDir);
    await updateOperationLocked(bookDir, opId, (current) => {
      if (current.state !== "running" || current.runEpoch !== runEpoch) return undefined;
      const { currentStep: _step, ...rest } = current;
      if (epoch !== operation.bookEpoch) return { ...rest, state: "obsolete", failure: EPOCH_CHANGED };
      return { ...rest, state: "succeeded", result: { ...result, schema: OPERATION_RESULT_SCHEMA } };
    });
  });
}

const EPOCH_CHANGED: OperationFailure = {
  code: "book_epoch_changed",
  message: "这本书在这期间整本恢复过（或从备份、回收站搬回过），这次的结果作废了。",
  retryable: true,
};

/**
 * 出错收尾：被停的不改；纪元换了 obsolete；书不在了什么都不写（记录读不到就不写，不在原处建目录）；其余 failed（一句原因）。
 */
async function settleError(operation: OperationContext, error: unknown): Promise<void> {
  const { bookDir, opId, runEpoch } = operation;
  const stoppedByOthers = operation.signal.aborted || error instanceof StopSignal || (error instanceof OperationStopped && error.code === "operation_stopped");
  const code = error instanceof OperationStopped ? error.code : (error as { code?: unknown } | null)?.code;
  if (code === "book_gone") return;
  await withBookThenRecord(bookDir, opId, () => updateOperationLocked(bookDir, opId, (current) => {
    if (current.state !== "running" || current.runEpoch !== runEpoch) return undefined;
    const { currentStep: _step, ...rest } = current;
    if (code === "book_epoch_changed") return { ...rest, state: "obsolete", failure: EPOCH_CHANGED };
    // 停的那一方本该已经换过状态；还是 running 说明它没换成（比如书锁里换状态那一下出错了）：当进程没了，等作者接着做。
    if (stoppedByOthers) return { ...rest, state: "paused", pauseReason: "interrupted", runEpoch: runEpoch + 1 };
    const message = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 300) : "这次没做完（原因不明）。";
    return { ...rest, state: "failed", failure: { code: typeof code === "string" && code ? code : "recipe_failed", message, retryable: true } };
  }));
}

/* ------------------------------------------------------------------ */
/*  取消、接着做                                                        */
/* ------------------------------------------------------------------ */

/**
 * 停掉一次操作：先持久记 cancelled、runEpoch + 1（书锁 → 记录锁），再掐在途请求。终态的不动（cancelled = false，回它现在的样子）。
 * 记录不在返回 undefined。
 */
export async function cancelOperation(bookDir: string, opId: string): Promise<{ readonly record: OperationRecord; readonly cancelled: boolean } | undefined> {
  let cancelled = false;
  const record = await changeOperation(bookDir, opId, (current) => {
    if (isTerminal(current.state)) return undefined;
    cancelled = true;
    const { currentStep: _step, pauseReason: _pause, ...rest } = current;
    return { ...rest, state: "cancelled", runEpoch: current.runEpoch + 1, result: { schema: OPERATION_RESULT_SCHEMA, summary: "这次停掉了。" } satisfies OperationResult };
  });
  if (cancelled) abortExecution(bookDir, opId, { type: "cancel" });
  return record ? { record, cancelled } : undefined;
}

export type ResumeOutcome =
  | { readonly ok: true; readonly record: OperationRecord }
  | { readonly ok: false; readonly code: "not_paused" | "unknown_operation" | "absent"; readonly message: string };

/**
 * 接着做（暂停之后作者点了）：这时还没处理的结果不明的 attempt 记成作者处理过，额度加上停下那一步的最坏值，从停下那一步整步重做。
 */
export async function resumeOperation(bookDir: string, opId: string): Promise<ResumeOutcome> {
  const stored = await readOperation(bookDir, opId);
  if (stored.kind !== "record") return { ok: false, code: "absent", message: "找不到这次操作了。" };
  const record = stored.record;
  if (record.state !== "paused") return { ok: false, code: "not_paused", message: "这次没有停着，不用接着做。" };
  const recipe = recipes.get(record.kind);
  if (!recipe) return { ok: false, code: "unknown_operation", message: "这类操作还没有。" };
  const settle = unsettledUnknowns(await listAttempts(bookDir, opId), record.settledUnknowns).map((attempt) => attempt.attemptId);
  const started = await startOperation(bookDir, opId, { resume: { addBudget: recipe.stepBudget(record.currentStep, record.params), settle } });
  if (!started || started.state !== "running") return { ok: false, code: "not_paused", message: "这次没有停着，不用接着做。" };
  return { ok: true, record: started };
}

/* ------------------------------------------------------------------ */
/*  开书对账                                                            */
/* ------------------------------------------------------------------ */

const OBSOLETE_RECIPE: OperationFailure = { code: "recipe_changed", message: "软件升级了，这次停下的接不上，重新来一次。", retryable: true };

/**
 * 开书时对账（设计 6.5）：本进程调度表里的不碰；其余 queued / running 按有没有没处理的结果不明、配方能不能自动续处理。
 * 之后清理过期的操作（留墓碑）。返回自动续了哪几次。
 */
export async function reconcileOperations(bookDir: string): Promise<{ readonly resumed: readonly string[] }> {
  const resumed: string[] = [];
  for (const record of await listOperations(bookDir)) {
    if (record.state !== "queued" && record.state !== "running") continue;
    if (isScheduledHere(bookDir, record.opId)) continue;
    const recipe = recipes.get(record.kind);
    const attempts = await listAttempts(bookDir, record.opId);
    const unknowns = unsettledUnknowns(attempts, record.settledUnknowns);
    let autoResume = false;
    await withBookLock(bookDir, async () => {
      if (isScheduledHere(bookDir, record.opId)) return;
      for (const attempt of unknowns) if (attempt.state === "sending") await settleAbandonedAttempt(bookDir, record.opId, attempt.attemptId);
      await withBookThenRecord(bookDir, record.opId, () => updateOperationLocked(bookDir, record.opId, (current) => {
        if (current.state !== "queued" && current.state !== "running") return undefined;
        if (!recipe || recipe.version !== current.recipeVersion) return { ...current, state: "obsolete", failure: OBSOLETE_RECIPE };
        if (unknowns.length > 0) return { ...current, state: "paused", pauseReason: "attempt_unknown", runEpoch: current.runEpoch + 1 };
        autoResume = recipe.autoResume === true;
        return { ...current, state: "paused", pauseReason: "interrupted", runEpoch: current.runEpoch + 1 };
      }));
    });
    if (autoResume && recipe) {
      const started = await startOperation(bookDir, record.opId, { resume: { addBudget: recipe.stepBudget(record.currentStep, record.params), settle: [] } });
      if (started?.state === "running") resumed.push(record.opId);
    }
  }
  await withBookLock(bookDir, () => pruneOperations(bookDir, (record) => summaryLine(record))).catch((error) => {
    console.warn("[operations] 清理过期的操作没成（不影响开书）", error);
  });
  return { resumed };
}

/** 一次操作给作者看的一句结果（墓碑、摘要用）。 */
export function summaryLine(record: OperationRecord): string {
  const result = record.result as Partial<OperationResult> | undefined;
  if (typeof result?.summary === "string" && result.summary) return result.summary;
  if (record.failure) return record.failure.message;
  return "";
}

/* ------------------------------------------------------------------ */
/*  订阅                                                                */
/* ------------------------------------------------------------------ */

export type OperationEvent =
  | { readonly type: "snapshot"; readonly record: OperationRecord }
  | { readonly type: "record"; readonly record: OperationRecord }
  | { readonly type: "live"; readonly event: LiveEvent };

/**
 * 订阅一次操作（设计 6.7）：先挂监听、缓冲 → 读快照（eventSeq = n）发出去 → 丢掉缓冲里 ≤ n 的记录事件、按序排空其余 → 之后直通。
 * 读快照和挂监听之间结束的，也收得到终态。记录不在返回 undefined。
 */
export async function subscribeOperation(bookDir: string, opId: string, send: (event: OperationEvent) => void): Promise<(() => void) | undefined> {
  let buffer: OperationEvent[] | undefined = [];
  let seenSeq = 0;
  const deliver = (event: OperationEvent): void => {
    if (buffer) {
      buffer.push(event);
      return;
    }
    if (event.type === "record") {
      if (event.record.eventSeq <= seenSeq) return;
      seenSeq = event.record.eventSeq;
    }
    send(event);
  };
  const offRecord = onOperationRecord(bookDir, opId, (record) => deliver({ type: "record", record }));
  const offLive = onLive(bookDir, opId, (event) => deliver({ type: "live", event }));
  const unsubscribe = () => {
    offRecord();
    offLive();
  };
  const stored = await readOperation(bookDir, opId).catch(() => ({ kind: "absent" as const }));
  if (stored.kind !== "record") {
    unsubscribe();
    return undefined;
  }
  seenSeq = stored.record.eventSeq;
  send({ type: "snapshot", record: stored.record });
  const pending = buffer;
  buffer = undefined;
  for (const event of pending) deliver(event);
  return unsubscribe;
}

/** 测试用：清登记的配方。 */
export function __resetRecipesForTests(): void {
  recipes.clear();
}
