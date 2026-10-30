/**
 * 操作的应用步骤里跑一条核心命令（写作版本 P2a 6.3）：幂等键 = opId:stepId（崩了重来回放回执、不再写）、
 * 书锁里先核栅栏再写、写前打存档；栅栏不过抛 OperationStopped（这次停了，不当成「没写成」）。
 * 改设定卡、记裁定、定论改齐、通读记账都走这一条，不各抄一份栅栏码表。
 */
import { resolve } from "node:path";
import { runCommand, type CommandFailure, type CommandOutcome, type CommandReceipt, type CommandSuccess, type TruthBasis, type WriteCommandSpec } from "@actalk/story-core";
import { runWithLazySnapshot } from "../snapshot.js";
import { currentOperation, OperationStopped, type OperationContext } from "./context.js";
import { checkFence } from "./fence.js";

/** 栅栏不过的失败码（checkFence 给的）。 */
export const FENCE_CODES: ReadonlySet<string> = new Set(["operation_stopped", "book_gone", "book_epoch_changed"]);

export class NotInStepError extends Error {
  readonly code = "not_in_step";
  constructor(message: string) {
    super(message);
    this.name = "NotInStepError";
  }
}

/** 在一步里的那次操作（不在操作的应用步骤里抛：这些写只在操作里做）。 */
export function operationStep(projectDir: string, what: string): { readonly operation: OperationContext; readonly stepId: string } {
  const operation = currentOperation();
  const stepId = operation?.step?.id;
  if (!operation || !stepId) throw new NotInStepError(`${what}只在操作的应用步骤里做。`);
  if (resolve(operation.bookDir) !== resolve(projectDir)) throw new OperationStopped("cross_book_write", "这次操作只写它自己那本书，别的书没有写。");
  return { operation, stepId };
}

/**
 * 应用一步回放（ctx.apply 的 replay）用：这一步的回执当成这条命令「回放回执」的结果（和核心回放给的一样），配方照常路那套把结果说出来。
 * 回执不是这几条命令写的（防重复标记撞了）如实失败。
 */
export function replayedOutcome<R>(receipt: CommandReceipt, ...specs: readonly { readonly name: string }[]): CommandSuccess<R> {
  if (!specs.some((spec) => spec.name === receipt.command)) {
    throw Object.assign(new Error("这一步的防重复标记被别的命令用过了，没有执行。"), { code: "idempotency_key_reused" });
  }
  return { ok: true, result: receipt.result as R, version: receipt.version, changed: receipt.changed, replayed: true };
}

export async function runCommandInOperation<A, R>(
  projectDir: string,
  spec: WriteCommandSpec<A, R>,
  args: A,
  options: {
    readonly what: string;
    readonly caller: "author" | "ai";
    readonly basis?: TruthBasis;
    readonly intent?: unknown;
    /** 栅栏之后再核的（材料变没变之类）。 */
    readonly precondition?: () => Promise<CommandFailure | undefined>;
  },
): Promise<{ readonly result: CommandOutcome<R>; readonly snapshotId?: string }> {
  const { operation, stepId } = operationStep(projectDir, options.what);
  const outcome = await runWithLazySnapshot(projectDir, (snapshot) =>
    runCommand(projectDir, spec, args, {
      caller: options.caller,
      snapshot,
      op: { opId: operation.opId, stepId },
      ...(options.basis ? { basis: options.basis } : {}),
      ...(options.intent !== undefined ? { intent: options.intent } : {}),
      precondition: async () => (await checkFence(operation)) ?? (await options.precondition?.()),
    }));
  if (!outcome.result.ok && FENCE_CODES.has(outcome.result.code)) throw new OperationStopped(outcome.result.code, outcome.result.message);
  return outcome;
}
