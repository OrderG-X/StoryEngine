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
import { bookKey, canonicalJson, opCommandKey, readBookEpoch, readCommandReceipt, sha256, withBookLock } from "@actalk/story-core";
import { ensureBookOnCore } from "../../book/mirror/ensure.js";
import { clearCandidateTombstones } from "../../lib/draft-candidates.js";
import { clearFixLogKeys } from "../../lib/fix-log.js";
import { clearWordStatsKeys } from "../../lib/word-stats.js";
import { freezeModelChoices, frozenCompatAllowance, isFrozenModels, type FrozenModels, type ModelTaskProfileKey } from "../../lib/llm-client.js";
import { readOperationInput } from "../../lib/operations/inputs.js";
import { coreSnapshotFor } from "../../lib/snapshot.js";
import { outsideTurn } from "../../lib/turn-abort.js";
import { withUsageBook } from "../../lib/usage-scope.js";
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
import { clearDraftStream, draftStreamCatchUp, emitLive, onLive, type LiveEvent } from "../../lib/operations/live.js";
import {
  acceptOperation,
  appliedEffectOf,
  BOOT_ID,
  changeOperation,
  isScheduledHere,
  isTerminal,
  listOperations,
  occupantOf,
  onOperationRecord,
  pruneOperations,
  readOperation,
  updateOperationLocked,
  withBookThenRecord,
  type OperationFailure,
  type OperationOrigin,
  type OperationRecord,
  type OperationTombstone,
  type PendingAction,
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
  /**
   * 应用一步（设计第三节、6.4）：写真相的那一笔（applyAiDraft、核心命令），一步只走一个核心命令。步骤语义同 step；
   * 里面的核心命令带 `op:{opId, stepId}`（幂等键 = opId:stepId，有回执就回放、不再写）和栅栏 precondition。
   * 开始前记「在应用」，做完按回执记进 appliedEffects（崩在中间：这次执行一结束按回执补记）。
   */
  apply<T>(id: string, input: unknown, fn: () => Promise<T>): Promise<T>;
  /**
   * 发布一步不进核心事务的产物（候选、改句记录、出稿统计以外别的按键发布的）：fn 拿着书锁、过了栅栏才跑，
   * 必须按 key（`opId:stepId`）幂等：键在就不再写。输出落盘了才算发布完。
   */
  publish<T>(id: string, input: unknown, fn: (key: string) => Promise<T>): Promise<T>;
  /**
   * 等作者点按钮（设计 6.6）：这个按钮的决定已经落了（检查点 `author:<actionId>`）就返回它；没落就记进 pendingActions、
   * 换成 waiting_author（不占写位），停掉这次执行。作者点了（resume 带 actionId + 决定）从头再跑，走到这里拿到决定接着往下。
   */
  waitForAuthor(action: AuthorAction): Promise<string>;
  /** 一句进度（只推给订阅，不落盘）。 */
  progress(text: string): void;
}

/** 等作者的一个按钮。actionId 在这次操作里唯一（循环里带序号）。 */
export interface AuthorAction {
  readonly actionId: string;
  readonly kind: string;
  /** 作者能点的几个决定。 */
  readonly decisions: readonly string[];
  /** 卡上给作者看的（按 kind 各自的形状，要能存成 JSON）。 */
  readonly preview?: unknown;
}

/** 作者点了的决定存在这一步的检查点里。 */
export const authorStepId = (actionId: string): string => `author:${actionId}`;

/** 配方核不过（作者看的那版、依据变了）：抛它，这次记成 obsolete、说哪样变了。 */
export class OperationObsolete extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OperationObsolete";
  }
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
  /** 这次要用到哪几个模型任务：接着做时按冻结的模型重算兼容改参的余量，和受理时同一口径（设计 4.5）。不调模型的给空。 */
  modelTasks(params: P): readonly ModelTaskProfileKey[];
  /** 这一次执行收尾之后（记录已经换成终态或停着）调一次，拿到的是收尾后的记录（后台补读跑完再看一眼要不要再交一次）。不许抛。 */
  afterRun?(bookDir: string, record: OperationRecord): Promise<void>;
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
  if (!accepted.existing) track(startOperation(bookDir, accepted.record.opId));
  return accepted;
}

/* ------------------------------------------------------------------ */
/*  跑                                                                  */
/* ------------------------------------------------------------------ */

const OBSOLETE_RECIPE: OperationFailure = { code: "recipe_changed", message: "软件升级了，这次停下的接不上，重新来一次。", retryable: true };

/** 记录是按现在登记的这一版配方开工的（配方不在了也算对不上）。 */
function recipeMatches(record: OperationRecord): boolean {
  return recipes.get(record.kind)?.version === record.recipeVersion;
}

function obsoleteByRecipe(record: OperationRecord): OperationRecord {
  const { currentStep: _step, pauseReason: _pause, ...rest } = record;
  return { ...rest, state: "obsolete", failure: OBSOLETE_RECIPE };
}

interface StartOptions {
  /** 接着做（暂停、等作者之后）：额度加多少、哪些结果不明的 attempt 记成作者处理过。 */
  readonly resume?: { readonly addBudget: number; readonly settle: readonly string[] };
}

/**
 * 让一次操作跑起来：书锁 → 记录锁里换成 running、runEpoch + 1，然后在后台跑配方。已经在跑、终态的不动（重复的 resume 拿不到新 runEpoch）。
 * 返回换完的记录（没换返回当前的）。
 */
export async function startOperation(bookDir: string, opId: string, options: StartOptions = {}): Promise<OperationRecord | undefined> {
  const claimed = await claimRun(bookDir, opId, options);
  if (claimed.changed && claimed.record) launch(bookDir, claimed.record);
  return claimed.record;
}

/** 换成 running（书锁 → 记录锁）；changed = 这一下是它换的、该由调用方开跑（在放掉书锁之后开跑）。 */
async function claimRun(bookDir: string, opId: string, options: StartOptions): Promise<{ readonly record?: OperationRecord; readonly changed: boolean }> {
  let changed = false;
  const record = await changeOperation(bookDir, opId, (current) => {
    const runnable = current.state === "queued" || (options.resume !== undefined && (current.state === "paused" || current.state === "waiting_author"));
    if (!runnable) return undefined;
    // 配方换过版本（软件升级了）：旧检查点不能拿新步骤解释，作废、要求重新交（Astra P2a 第 10 轮第 5 条）。
    if (!recipeMatches(current)) return obsoleteByRecipe(current);
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
  return { ...(record ? { record } : {}), changed: changed && record !== undefined };
}

function launch(bookDir: string, record: OperationRecord): void {
  // 不跟着交它的那一轮：作者断开、喊停那一轮都不算停这次操作（停操作走 cancelOperation）。
  track(outsideTurn(() => execute(bookDir, record)));
}

/** 在跑的（连开跑前换状态那一下、收尾那一步）；只给单测等它们跑完。 */
const inFlight = new Set<Promise<unknown>>();
function track(run: Promise<unknown>): void {
  inFlight.add(run);
  const done = () => { inFlight.delete(run); };
  run.then(done, done);
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
    // 用量记到这本书名下（P10）：后台操作可能比交它的那次请求活得久。
    const result = await withUsageBook(bookDir, () => runInOperation(operation, () => recipe.run(contextFor(record, operation))));
    await finish(operation, result);
  } catch (error) {
    await settleError(operation, error);
  } finally {
    execution.unregister();
    clearDraftStream(bookDir, record.opId);
  }
  if (recipe?.afterRun) {
    const settled = await readOperation(bookDir, record.opId).catch(() => undefined);
    if (settled?.kind === "record") await recipe.afterRun(bookDir, settled.record).catch((error: unknown) => console.warn(`[operations] ${record.kind} 收尾后的那一步没成`, error));
  }
}

function contextFor(record: OperationRecord, operation: OperationContext): RecipeContext<unknown> {
  const { bookDir, opId, runEpoch } = operation;
  let currentExec = `${runEpoch}:`;
  const runStep = async <T>(id: string, input: unknown, fn: () => Promise<T>, kind: "step" | "apply" | "publish"): Promise<T> => {
    const inputHash = inputHashOf(input);
    const saved = await readCheckpoint(bookDir, opId, id);
    if (saved && saved.inputHash === inputHash) return saved.output as T;
    if (operation.signal.aborted) throw stoppedError(operation);
    const exec = `${runEpoch}:${id}`;
    currentExec = exec;
    await changeOperation(bookDir, opId, (current) => {
      if (current.state !== "running" || current.runEpoch !== runEpoch) return undefined;
      const applying = kind === "apply" && !current.applying?.includes(id) ? { applying: [...(current.applying ?? []), id] } : {};
      return current.currentStep !== id || "applying" in applying ? { ...current, currentStep: id, ...applying } : undefined;
    });
    emitLive(bookDir, opId, { type: "step", step: id, exec });
    const output = await runInStep(id, exec, fn);
    if (operation.signal.aborted) throw stoppedError(operation);
    await withFence(operation, async () => {
      await writeCheckpoint(bookDir, opId, { schema: "operation-step/1", stepId: id, inputHash, exec, output: output ?? null, finishedAt: new Date().toISOString() });
      if (kind === "apply") await recordApplied(operation, id);
    });
    return output;
  };
  return {
    bookDir,
    record,
    params: record.params,
    signal: operation.signal,
    operation,
    step<T>(id: string, input: unknown, fn: () => Promise<T>): Promise<T> {
      return runStep(id, input, fn, "step");
    },
    apply<T>(id: string, input: unknown, fn: () => Promise<T>): Promise<T> {
      return runStep(id, input, fn, "apply");
    },
    publish<T>(id: string, input: unknown, fn: (key: string) => Promise<T>): Promise<T> {
      return runStep(id, input, () => withFence(operation, () => fn(`${opId}:${id}`)), "publish");
    },
    async waitForAuthor(action: AuthorAction): Promise<string> {
      const decided = await readCheckpoint(bookDir, opId, authorStepId(action.actionId));
      const decision = (decided?.output as { readonly decision?: unknown } | null | undefined)?.decision;
      if (typeof decision === "string" && action.decisions.includes(decision)) return decision;
      if (operation.signal.aborted) throw stoppedError(operation);
      // 先掐这次执行（之后的写过不了栅栏），再在书锁里换状态：记下按钮、换 waiting_author、runEpoch + 1。
      abortExecution(bookDir, opId, { type: "wait" }, runEpoch);
      await changeOperation(bookDir, opId, (current) => {
        if (current.state !== "running" || current.runEpoch !== runEpoch) return undefined;
        const pending: PendingAction = {
          actionId: action.actionId,
          kind: action.kind,
          decisions: [...action.decisions],
          ...(action.preview !== undefined ? { preview: action.preview } : {}),
        };
        // 停在等作者那一步：接着做时额度按它加（配方给「点了按钮之后最多还要再跑的」，比如再改一版）。
        return {
          ...current,
          state: "waiting_author",
          runEpoch: runEpoch + 1,
          currentStep: authorStepId(action.actionId),
          pendingActions: [...current.pendingActions.filter((item) => item.actionId !== action.actionId), pending],
        };
      });
      throw stoppedError(operation);
    },
    progress(text: string) {
      emitLive(bookDir, opId, { type: "progress", text, exec: currentExec });
    },
  };
}

/** 清理一次操作时清它在书里留的发布键（调用方拿着书锁）。 */
async function clearPublishedKeys(bookDir: string, opId: string): Promise<void> {
  await clearFixLogKeys(bookDir, opId);
  await clearWordStatsKeys(bookDir, opId);
  await clearCandidateTombstones(bookDir, opId);
}

/** 一步应用做完（拿着书锁、过了栅栏）：有回执就记进 appliedEffects；没有（这一步没写真相，比如留成了候选）只从 applying 去掉。 */
async function recordApplied(operation: OperationContext, stepId: string): Promise<void> {
  const { bookDir, opId, runEpoch } = operation;
  const receipt = await readCommandReceipt(bookDir, opCommandKey({ opId, stepId }));
  await changeOperation(bookDir, opId, (current) => {
    if (current.state !== "running" || current.runEpoch !== runEpoch) return undefined;
    const applying = (current.applying ?? []).filter((id) => id !== stepId);
    const known = (current.appliedEffects ?? []).some((effect) => effect.stepId === stepId);
    const { applying: _applying, ...rest } = current;
    return {
      ...rest,
      ...(applying.length > 0 ? { applying } : {}),
      ...(receipt && !known ? { appliedEffects: [...(current.appliedEffects ?? []), appliedEffectOf(stepId, receipt)] } : {}),
    };
  });
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
    if (error instanceof OperationObsolete) return { ...rest, state: "obsolete", failure: { code: error.code, message: error.message, retryable: true } };
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

/**
 * 接着做时额度加多少（设计 4.5，Astra P2a 第 9 轮第 5 条）：停下那一步从头做的最坏值 + 冻结的模型现在还没学到的兼容改参
 * （和受理时同一口径，每次接着做都重算：学到的「不认」可能又被作者换模型清掉了）。手动、自动接着做都走这里。
 */
async function resumeAllowance(bookDir: string, record: OperationRecord, recipe: Recipe<unknown>): Promise<number> {
  const step = recipe.stepBudget(record.currentStep, record.params);
  const tasks = recipe.modelTasks(record.params);
  if (tasks.length === 0) return step;
  const models = await readOperationInput(bookDir, record.opId, "models");
  return step + (isFrozenModels(models) ? await frozenCompatAllowance(models, tasks) : 0);
}

export type ResumeOutcome =
  | { readonly ok: true; readonly record: OperationRecord; readonly replayed?: true }
  | {
    readonly ok: false;
    readonly code: "not_paused" | "unknown_operation" | "absent" | "obsolete" | "unknown_action" | "bad_decision" | "decision_conflict" | "target_busy";
    readonly message: string;
    readonly occupant?: OperationRecord;
  };

/** 作者点了等着的那个按钮：哪一个、点的哪个决定。 */
export interface AuthorAnswer {
  readonly actionId: string;
  readonly decision: string;
}

const decisionHashOf = (decision: string): string => sha256(canonicalJson({ decision }));

/**
 * 接着做（暂停之后作者点了「接着做」、等作者时作者点了按钮）：这时还没处理的结果不明的 attempt 记成作者处理过，
 * 额度加上停下那一步的最坏值，从停下那一步整步重做。全在书锁里：先重新认领写位（被排着 / 在跑的占着 → target_busy），
 * 等作者的先核按钮和决定、把决定落进检查点，再换成 running。
 * 等作者的按钮：不在待办里 unknown_action；这个按钮点过同一个决定 → 回放（不再跑）；点过别的 → decision_conflict。
 */
export async function resumeOperation(bookDir: string, opId: string, answer?: AuthorAnswer): Promise<ResumeOutcome> {
  const notPaused: ResumeOutcome = { ok: false, code: "not_paused", message: "这次没有停着，不用接着做。" };
  let toLaunch: OperationRecord | undefined;
  const outcome = await withBookLock(bookDir, async (): Promise<ResumeOutcome> => {
    const stored = await readOperation(bookDir, opId);
    if (stored.kind !== "record") return { ok: false, code: "absent", message: "找不到这次操作了。" };
    const record = stored.record;
    const pending = answer ? record.pendingActions.find((action) => action.actionId === answer.actionId) : undefined;
    if (answer) {
      if (!pending) return { ok: false, code: "unknown_action", message: "这个按钮已经不管用了（这次操作没在等它）。" };
      if (!pending.decisions.includes(answer.decision)) return { ok: false, code: "bad_decision", message: "这个按钮没有这个选法。" };
      if (pending.decisionHash !== undefined) {
        return pending.decisionHash === decisionHashOf(answer.decision)
          ? { ok: true, record, replayed: true }
          : { ok: false, code: "decision_conflict", message: "这个按钮已经点过别的选法了，这次不算。" };
      }
      if (record.state !== "waiting_author") return notPaused;
    } else if (record.state !== "paused") {
      return record.state === "waiting_author" ? { ok: false, code: "unknown_action", message: "这次在等你点卡上的按钮。" } : notPaused;
    }
    const recipe = recipes.get(record.kind);
    if (!recipe) return { ok: false, code: "unknown_operation", message: "这类操作还没有。" };
    if (!recipeMatches(record)) {
      const obsolete = await changeOperation(bookDir, opId, (current) => ((current.state === "paused" || current.state === "waiting_author") && !recipeMatches(current) ? obsoleteByRecipe(current) : undefined));
      return obsolete?.state === "obsolete" ? { ok: false, code: "obsolete", message: OBSOLETE_RECIPE.message } : notPaused;
    }
    const occupant = occupantOf(await listOperations(bookDir), record.writeScope, opId);
    if (occupant) return { ok: false, code: "target_busy", message: "这一章正有别的一次在写，先等它做完或停掉它。", occupant };
    if (answer && pending) {
      // 决定先落进检查点（配方从头跑到这里就拿到它），再记进待办（之后同一个按钮回放、换决定挡下）。
      await writeCheckpoint(bookDir, opId, {
        schema: "operation-step/1",
        stepId: authorStepId(answer.actionId),
        inputHash: inputHashOf({ actionId: answer.actionId }),
        exec: `${record.runEpoch}:${authorStepId(answer.actionId)}`,
        output: { decision: answer.decision },
        finishedAt: new Date().toISOString(),
      });
      await changeOperation(bookDir, opId, (current) => (current.state !== "waiting_author" ? undefined : {
        ...current,
        pendingActions: current.pendingActions.map((action) => (action.actionId === answer.actionId ? { ...action, decisionHash: decisionHashOf(answer.decision) } : action)),
      }));
    }
    const settle = unsettledUnknowns(await listAttempts(bookDir, opId), record.settledUnknowns).map((attempt) => attempt.attemptId);
    const claimed = await claimRun(bookDir, opId, { resume: { addBudget: await resumeAllowance(bookDir, record, recipe), settle } });
    const started = claimed.record;
    if (started?.state === "obsolete") return { ok: false, code: "obsolete", message: OBSOLETE_RECIPE.message };
    if (!started || started.state !== "running" || !claimed.changed) return notPaused;
    toLaunch = started;
    return { ok: true, record: started };
  });
  // 放掉书锁再开跑：执行里的写自己排书锁。
  if (toLaunch) launch(bookDir, toLaunch);
  return outcome;
}

/* ------------------------------------------------------------------ */
/*  开书对账                                                            */
/* ------------------------------------------------------------------ */


/**
 * 开书时对账（设计 6.5）：本进程调度表里的不碰；其余 queued / running 按有没有没处理的结果不明、配方能不能自动续处理。
 * 之后清理过期的操作（留墓碑）。返回自动续了哪几次。
 */
export async function reconcileOperations(bookDir: string): Promise<{ readonly resumed: readonly string[] }> {
  const resumed: string[] = [];
  for (const record of await listOperations(bookDir)) {
    if (isScheduledHere(bookDir, record.opId)) continue;
    // 停着、等作者的：配方换过版本就作废（卡上不再给「接着做」）。
    if ((record.state === "paused" || record.state === "waiting_author") && !recipeMatches(record)) {
      await changeOperation(bookDir, record.opId, (current) => ((current.state === "paused" || current.state === "waiting_author") && !recipeMatches(current) ? obsoleteByRecipe(current) : undefined));
      continue;
    }
    if (record.state !== "queued" && record.state !== "running") continue;
    const recipe = recipes.get(record.kind);
    const attempts = await listAttempts(bookDir, record.opId);
    const unknowns = unsettledUnknowns(attempts, record.settledUnknowns);
    let autoResume = false;
    await withBookLock(bookDir, async () => {
      if (isScheduledHere(bookDir, record.opId)) return;
      for (const attempt of unknowns) if (attempt.state === "sending") await settleAbandonedAttempt(bookDir, record.opId, attempt.attemptId);
      await withBookThenRecord(bookDir, record.opId, () => updateOperationLocked(bookDir, record.opId, (current) => {
        if (current.state !== "queued" && current.state !== "running") return undefined;
        if (!recipeMatches(current)) return obsoleteByRecipe(current);
        if (unknowns.length > 0) return { ...current, state: "paused", pauseReason: "attempt_unknown", runEpoch: current.runEpoch + 1 };
        autoResume = recipe?.autoResume === true;
        return { ...current, state: "paused", pauseReason: "interrupted", runEpoch: current.runEpoch + 1 };
      }));
    });
    if (autoResume && recipe) {
      const started = await startOperation(bookDir, record.opId, { resume: { addBudget: await resumeAllowance(bookDir, record, recipe), settle: [] } });
      if (started?.state === "running") resumed.push(record.opId);
    }
  }
  await withBookLock(bookDir, () => pruneOperations(bookDir, (record) => summaryLine(record), new Date(), (opId) => clearPublishedKeys(bookDir, opId))).catch((error) => {
    console.warn("[operations] 清理过期的操作没成（不影响开书）", error);
  });
  return { resumed };
}

const reconciled = new Map<string, Promise<unknown>>();

/** 开书时对账，这个进程里每本书只对一次（之后的操作都是本进程调度的，不会被判没人管）。对账出错只记一笔、下次开书再对。 */
export async function reconcileOnOpen(bookDir: string): Promise<void> {
  const key = bookKey(bookDir);
  let pending = reconciled.get(key);
  if (!pending) {
    pending = reconcileOperations(bookDir).catch((error: unknown) => {
      reconciled.delete(key);
      console.warn("[operations] 开书对账没成（不影响开书，下次开书再对）", error);
    });
    reconciled.set(key, pending);
  }
  await pending;
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
  // 补发过的正文流到哪一笔：缓冲里、之后再到的同一次执行里不比它新的不再发（补发那份已经含着）。
  let streamedThrough: { readonly exec: string; readonly streamSeq: number } | undefined;
  const deliver = (event: OperationEvent): void => {
    if (buffer) {
      buffer.push(event);
      return;
    }
    if (event.type === "record") {
      if (event.record.eventSeq <= seenSeq) return;
      seenSeq = event.record.eventSeq;
    }
    if (event.type === "live" && event.event.type === "draft-delta" && streamedThrough
      && event.event.exec === streamedThrough.exec && event.event.streamSeq <= streamedThrough.streamSeq) return;
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
  for (const event of draftStreamCatchUp(bookDir, opId)) {
    streamedThrough = { exec: event.exec, streamSeq: event.streamSeq };
    send({ type: "live", event });
  }
  const pending = buffer;
  buffer = undefined;
  for (const event of pending) deliver(event);
  return unsubscribe;
}

/** 测试用：清登记的配方和开书对账的记号。 */
export function __resetRecipesForTests(): void {
  recipes.clear();
  reconciled.clear();
  inFlight.clear();
}

/** 单测：等这个进程里交上的操作都跑完（连收尾那一步、收尾里接着交的）。等过返回 true。 */
export async function __drainOperationsForTests(): Promise<boolean> {
  if (inFlight.size === 0) return false;
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  return true;
}
