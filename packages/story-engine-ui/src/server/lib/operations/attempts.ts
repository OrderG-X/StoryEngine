/**
 * 模型调用的记账（写作版本 P2a 设计第四节，契约 `model-attempt/1`）：每次物理发送（含闸里 429 重发、备用、对冲）一份
 * `attempts/<attemptId>.json`。只做三件事：记账、判「结果不明」、溯源；**不拿来复用**（恢复只认步骤检查点）。
 *
 * - beforeSend：短拿记录锁，核本次执行没被停、记录还是 running 且是这一次、额度够，落 attempt（sending）才放行。
 *   额度不够 → 放掉记录锁之后走暂停入口（paused:budget）、抛 OperationStopped。拿着记录锁不等书锁。
 * - 结算：只改这一个 attempt 文件（类别、计费、用量），不发请求、不写别的、不动 runEpoch，取消、终态之后照样能结。
 *   已经结算过的不再改。判出 unknown 的：结算完（记录锁外）走暂停入口（paused:attempt_unknown）。
 * - 额度只数可能计费的：sending 的、结算后占额度的（not_sent、429 不占）。
 * 不存密钥、不存认证头。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../project-io.js";
import { OperationStopped, type OperationContext } from "./context.js";
import { pauseOperation, stoppedError } from "./fence.js";
import { operationDir, readOperation, withRecordLock } from "./store.js";

export const MODEL_ATTEMPT_SCHEMA = "model-attempt/1" as const;

/** 失败分类（设计 4.2；只看结构化事实，不看文案）。ok = 拿到了完整可用的结果。 */
export type AttemptClass = "ok" | "cancelled" | "policy_abort" | "not_sent" | "rejected" | "unusable" | "unknown";

export interface AttemptTarget {
  readonly task?: string;
  readonly provider: string;
  readonly model: string;
  readonly quotaGroup: string;
}

export interface ModelAttempt extends AttemptTarget {
  readonly schema: typeof MODEL_ATTEMPT_SCHEMA;
  readonly attemptId: string;
  readonly opId: string;
  readonly runEpoch: number;
  readonly stepId?: string;
  readonly exec?: string;
  readonly state: "sending" | "settled";
  readonly class?: AttemptClass;
  /** HTTP 状态码（拿到了的话）。 */
  readonly status?: number;
  /** 计费：known = 服务端给了结果（用量已知或明确答复了）；unknown = 发出去了、结果不明；none = 没发出去。 */
  readonly billing?: "known" | "unknown" | "none";
  /** 占不占额度。 */
  readonly counted?: boolean;
  readonly usage?: unknown;
  /** 我们自己掐的原因、或报错的一句（不含密钥、认证头）。 */
  readonly note?: string;
  readonly sentAt: string;
  readonly endedAt?: string;
}

export interface AttemptOutcome {
  readonly class: AttemptClass;
  readonly status?: number;
  readonly usage?: unknown;
  readonly note?: string;
}

const attemptsDir = (bookDir: string, opId: string): string => join(operationDir(bookDir, opId), "attempts");
const attemptPath = (bookDir: string, opId: string, attemptId: string): string => join(attemptsDir(bookDir, opId), `${attemptId}.json`);

/** 结算后占不占额度（设计 4.2 表的「额度」列）。 */
export function countsTowardBudget(outcome: AttemptOutcome): boolean {
  if (outcome.class === "not_sent") return false;
  if (outcome.class === "rejected" && outcome.status === 429) return false;
  return true;
}

function billingOf(outcome: AttemptOutcome): "known" | "unknown" | "none" {
  if (outcome.class === "not_sent") return "none";
  if (outcome.class === "ok" || outcome.class === "unusable" || outcome.class === "rejected") return "known";
  return "unknown";
}

export async function listAttempts(bookDir: string, opId: string): Promise<readonly ModelAttempt[]> {
  let names: string[];
  try {
    names = await readdir(attemptsDir(bookDir, opId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const attempts: ModelAttempt[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(join(attemptsDir(bookDir, opId), name), "utf-8")) as ModelAttempt;
      if (value.schema === MODEL_ATTEMPT_SCHEMA && typeof value.attemptId === "string") attempts.push(value);
    } catch {
      // 半截的 attempt 文件（原子写不会留下，除非盘坏了）：按「发出去了、结果不明」算进额度，见 usedBudget。
      attempts.push({ schema: MODEL_ATTEMPT_SCHEMA, attemptId: name.slice(0, -5), opId, runEpoch: -1, state: "sending", provider: "", model: "", quotaGroup: "", sentAt: "" });
    }
  }
  return attempts;
}

/** 已经用掉的额度：在发的、结算后占额度的。 */
export function usedBudget(attempts: readonly ModelAttempt[]): number {
  return attempts.filter((attempt) => attempt.state === "sending" || attempt.counted !== false).length;
}

/** 还没被作者处理过的结果不明（sending 或 unknown）。 */
export function unsettledUnknowns(attempts: readonly ModelAttempt[], settled: readonly string[]): readonly ModelAttempt[] {
  return attempts.filter((attempt) => !settled.includes(attempt.attemptId) && (attempt.state === "sending" || attempt.class === "unknown"));
}

export interface SendTicket {
  readonly attemptId: string;
  /** 结算这一次（只结一次，再调不动）。判出 unknown 的结完走暂停入口。 */
  settle(outcome: AttemptOutcome): Promise<void>;
}

export class BudgetExceededError extends OperationStopped {
  constructor(readonly used: number, readonly limit: number) {
    super("budget_exceeded", `这次的调用到上限了（用了 ${used} 次），先停下。`);
    this.name = "BudgetExceededError";
  }
}

/**
 * 发一次请求之前（闸在排队、退避之后、真正 fetch 之前调）。limit 是这次操作此刻的额度上限（executor 按算式给，接着做时加）。
 */
export async function beforeSend(context: OperationContext, target: AttemptTarget, limit: number, now: () => Date = () => new Date()): Promise<SendTicket> {
  const { bookDir, opId, runEpoch } = context;
  const verdict = await withRecordLock(bookDir, opId, async (): Promise<{ readonly ok: true; readonly attempt: ModelAttempt } | { readonly ok: false; readonly error: OperationStopped }> => {
    if (context.signal.aborted) return { ok: false, error: stoppedError(context) };
    const stored = await readOperation(bookDir, opId);
    if (stored.kind !== "record" || stored.record.state !== "running" || stored.record.runEpoch !== runEpoch) {
      return { ok: false, error: new OperationStopped("operation_stopped", "这次已经停掉了，没有再发请求。") };
    }
    const used = usedBudget(await listAttempts(bookDir, opId));
    if (used + 1 > limit) return { ok: false, error: new BudgetExceededError(used, limit) };
    const attempt: ModelAttempt = {
      schema: MODEL_ATTEMPT_SCHEMA,
      attemptId: `a-${randomUUID()}`,
      opId,
      runEpoch,
      ...(context.step ? { stepId: context.step.id, exec: context.step.exec } : {}),
      ...target,
      state: "sending",
      sentAt: now().toISOString(),
    };
    await mkdir(attemptsDir(bookDir, opId), { recursive: true });
    await writeFileAtomic(attemptPath(bookDir, opId, attempt.attemptId), `${JSON.stringify(attempt, null, 2)}\n`);
    return { ok: true, attempt };
  });
  if (!verdict.ok) {
    if (verdict.error instanceof BudgetExceededError) await pauseOperation(bookDir, opId, runEpoch, "budget");
    throw verdict.error;
  }
  const attempt = verdict.attempt;
  let settled = false;
  return {
    attemptId: attempt.attemptId,
    async settle(outcome) {
      if (settled) return;
      settled = true;
      const written: ModelAttempt = {
        ...attempt,
        state: "settled",
        class: outcome.class,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        billing: billingOf(outcome),
        counted: countsTowardBudget(outcome),
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(outcome.note ? { note: outcome.note.slice(0, 500) } : {}),
        endedAt: now().toISOString(),
      };
      try {
        await writeFileAtomic(attemptPath(bookDir, opId, attempt.attemptId), `${JSON.stringify(written, null, 2)}\n`);
      } catch (error) {
        // 书删了、操作目录清掉了：没处可记，也不在原处建目录。
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (outcome.class === "unknown") await pauseOperation(bookDir, opId, runEpoch, "attempt_unknown");
    },
  };
}
