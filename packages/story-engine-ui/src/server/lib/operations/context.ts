/**
 * 操作上下文（写作版本 P2a 设计 6.1、6.2）：这一刻在跑的是哪次操作的哪次执行。调模型、写盘的地方从这里认身份，
 * 不用一路传参。不在任何操作里（对话 AI 自己选工具那一轮、作者存稿）就是 undefined。
 *
 * 每次让操作跑起来（受理后、resume、启动后自动续）登记一次执行：runEpoch + 一个 AbortController。
 * 停住一次执行 = 打断它的 signal（abort reason 说清为什么）：之后它的栅栏、beforeSend 一律不过。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { bookKey } from "@actalk/story-core";
import type { ModelCallError, PolicyStop } from "../ai-errors.js";
import type { FrozenModels } from "../llm-client.js";
import type { GateLane } from "../provider-gate.js";
import type { PauseReason } from "./store.js";

/** 为什么停：取消、暂停（带原因）、我们自己按策略掐的（思考超长、正文跑飞、对冲输家）。 */
export type StopReason =
  | { readonly type: "cancel" }
  | { readonly type: "pause"; readonly reason: PauseReason }
  /** 停下等作者点按钮（waitForAuthor）。 */
  | { readonly type: "wait" }
  | { readonly type: "policy"; readonly policy: PolicyStop };

/** abort 的 reason 一律用它：失败分类只看结构（类型），不看文案。 */
export class StopSignal extends Error {
  constructor(readonly stop: StopReason) {
    super(stop.type === "cancel" ? "这次已经停掉了" : stop.type === "pause" ? `这次暂停了（${stop.reason}）` : stop.type === "wait" ? "停下等作者点按钮" : `按策略停下（${stop.policy}）`);
    this.name = "StopSignal";
  }
}

export const stopOf = (reason: unknown): StopReason | undefined => (reason instanceof StopSignal ? reason.stop : undefined);

/** 栅栏、beforeSend 不过时抛：降级的 catch 先 rethrowIfStopped，别把它吞成「这一步没成、照常往下走」。 */
export class OperationStopped extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OperationStopped";
  }
}

/** 配方核不过（作者看的那版、依据变了）：抛它，这次记成 obsolete、说哪样变了。 */
export class OperationObsolete extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OperationObsolete";
  }
}

export function rethrowIfStopped(error: unknown): void {
  if (error instanceof OperationStopped) throw error;
  if (error instanceof StopSignal && error.stop.type !== "policy") throw error;
}

export interface OperationContext {
  readonly bookDir: string;
  readonly opId: string;
  readonly runEpoch: number;
  readonly bookEpoch: string;
  readonly signal: AbortSignal;
  readonly lane: GateLane;
  /** 开工时冻结的模型选择（`inputs/models.json`）：这次操作里调模型都按它取（设计 4.5）。 */
  readonly models?: FrozenModels;
  /** 这一刻在跑的步骤和执行号（`runEpoch:stepId:第几次`，整步重做换新的）。 */
  readonly step?: { readonly id: string; readonly exec: string; readonly halt: StepHalt };
}

/**
 * 这一步（这一次执行）里出过不能再发的失败：记下第一次的，之后这一步的 beforeSend、闸真发之前都不放（设计 4.2 兜底）。
 * refused：这一步里明确拒了这次调用身份（401 / 403 / 404）、换了备用的主模型，之后这一步直接用备用，不再重发它（Astra 第 7 轮第 2 条）。
 */
export interface StepHalt {
  failure?: ModelCallError;
  refused?: Set<string>;
}

const storage = new AsyncLocalStorage<OperationContext>();

export function currentOperation(): OperationContext | undefined {
  return storage.getStore();
}

export function runInOperation<T>(context: OperationContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** 在操作外跑：在一次操作里另交一次操作时用（新的那次不带着交它的那次的身份、额度、栅栏）。 */
export function outsideOperation<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** 进入一步：同一次执行、换步骤和执行号。 */
export function runInStep<T>(stepId: string, exec: string, fn: () => T): T {
  const context = storage.getStore();
  if (!context) throw new Error("不在操作里，不能进步骤");
  return storage.run({ ...context, step: { id: stepId, exec, halt: {} } }, fn);
}

/** 记下这一步出过不能再发的失败（只记第一次）。不在步骤里就不记。 */
export function haltStep(error: ModelCallError): void {
  const step = storage.getStore()?.step;
  if (step && !step.halt.failure) step.halt.failure = error;
}

/** 记下这一步里拒过的主模型（模型身份由调用方给）。不在步骤里就不记。 */
export function noteRefusedInStep(model: string): void {
  const step = storage.getStore()?.step;
  if (!step) return;
  (step.halt.refused ??= new Set()).add(model);
}

export function refusedInStep(model: string): boolean {
  return storage.getStore()?.step?.halt.refused?.has(model) ?? false;
}

/** 在后台道跑（拿着前台要等的锁时临时提到前台用的另一面，见设计第五节依赖提权）。 */
export function runInLane<T>(lane: GateLane, fn: () => T): T {
  const context = storage.getStore();
  if (!context) return fn();
  return storage.run({ ...context, lane }, fn);
}

/* ------------------------------------------------------------------ */
/*  执行登记                                                            */
/* ------------------------------------------------------------------ */

interface Execution {
  readonly runEpoch: number;
  readonly controller: AbortController;
}
const executions = new Map<string, Execution>();
const executionKey = (bookDir: string, opId: string): string => `${bookKey(bookDir)}:${opId}`;

/** 登记一次执行，返回它的 signal 和注销函数（注销只注销自己这一次，后来的不动）。 */
export function registerExecution(bookDir: string, opId: string, runEpoch: number): { readonly signal: AbortSignal; readonly unregister: () => void } {
  const key = executionKey(bookDir, opId);
  executions.get(key)?.controller.abort(new StopSignal({ type: "cancel" }));
  const execution: Execution = { runEpoch, controller: new AbortController() };
  executions.set(key, execution);
  return {
    signal: execution.controller.signal,
    unregister: () => {
      if (executions.get(key) === execution) executions.delete(key);
    },
  };
}

/**
 * 停住一次执行（同步、不拿锁）：打断它的 signal。给了 runEpoch 就只停那一次（别的暂停 / 取消已经换过的不动）。
 * 返回停没停到。
 */
export function abortExecution(bookDir: string, opId: string, stop: StopReason, runEpoch?: number): boolean {
  const execution = executions.get(executionKey(bookDir, opId));
  if (!execution || (runEpoch !== undefined && execution.runEpoch !== runEpoch)) return false;
  if (!execution.controller.signal.aborted) execution.controller.abort(new StopSignal(stop));
  return true;
}

export function __resetExecutionsForTests(): void {
  executions.clear();
}
