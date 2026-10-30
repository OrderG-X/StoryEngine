/**
 * 调模型失败的分类（P11）：给作者的错误卡说清「为什么、该做什么」，不再一律「AI 服务暂时没响应」。
 *
 * 只看结构，不看文案：自家抛的类型（没配好 / 上游没动静）、服务商回的 HTTP 状态码、网络层的错误码。
 * 顺着 cause / lastError / errors 往里找（AI SDK 的重试错误、fetch 的 TypeError 都把真原因包在里面）。
 */

import { aiErrorCause } from "../../lib/ai-error-text.js";
import type { AttemptClass } from "./operations/attempts.js";

/** 模型没配好：没配、缺密钥、档案指向的服务商没了。重试没用，得去设置里补。 */
export class ModelSetupError extends Error {
  override readonly name = "ModelSetupError";
}

/** 上游彻底没动静（空闲超时，见 STREAM_IDLE_TIMEOUT_MS）：响应头一直不来，或流到一半断了。 */
export class UpstreamSilentError extends Error {
  override readonly name = "UpstreamSilentError";
}

/** 见了结束标记、产物却不能用的是哪一种（写作版本 P2a 4.2 的 unusable）。 */
export type UnusableReason = "error_frame" | "bad_frames" | "truncated" | "empty" | "thinking_only";

/** 我们自己按策略掐的是哪一种（attemptClass = policy_abort）：思考超长（登记了关思考重来）、正文跑飞（这一步停发）、对冲输家。 */
export type PolicyStop = "thinking_too_long" | "runaway" | "hedge_loser";

export interface ModelCallErrorOptions extends ErrorOptions {
  readonly policy?: PolicyStop;
}

/**
 * 一次模型调用没成（写作版本 P2a 4.2）：带失败类别（`attempt-class`），换不换备用、能不能再发都只看它，不看文案。
 * statusCode：拿到了 HTTP 状态码的（服务商回了非 2xx），给作者看的分类按它。
 * policy：策略掐的是哪一种。上层（关思考重来、这一步停发）只认这一栏，换备用没成包一层也原样带着（Astra 第 7 轮第 2 条：别靠子类型）。
 */
export class ModelCallError extends Error {
  override readonly name: string = "ModelCallError";
  readonly policy?: PolicyStop;
  constructor(
    message: string,
    readonly attemptClass: AttemptClass,
    readonly statusCode?: number,
    readonly unusable?: UnusableReason,
    options?: ModelCallErrorOptions,
  ) {
    super(message, options);
    if (options?.policy) this.policy = options.policy;
  }
}

/**
 * 同一步里刚有一次调用被拒、结果不明或跑飞（写作版本 P2a 4.2 的兜底）：这一步不再物理发送，这次没发出去、没落 attempt。
 * 类别沿用拦下它的那次（不带状态码）：canCallAgain、canFallBack 照类别都不放，哪个外层循环漏改了也只是本地失败一次。
 */
export class StepHaltedError extends ModelCallError {
  override readonly name = "StepHaltedError";
  constructor(readonly halted: ModelCallError) {
    super(`这一步刚才有一次调用没成（${halted.message}），同一步不再发请求。`, halted.attemptClass, undefined, undefined, { cause: halted });
  }
}

export type AiErrorReason =
  | "setup"
  | "auth"
  | "quota"
  | "rate-limit"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

function reasonOfStatus(status: number): AiErrorReason | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  if (status >= 500 && status <= 599) return "server";
  return null;
}

/** 一层层往里看，先碰到哪个认得的就算哪个；都不认得就是 unknown。 */
export function classifyAiError(error: unknown): AiErrorReason {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < 12) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ModelSetupError) return "setup";
    if (current instanceof UpstreamSilentError) return "timeout";
    if (typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    const status = typeof record.statusCode === "number" ? record.statusCode : typeof record.status === "number" ? record.status : null;
    if (status !== null) {
      const byStatus = reasonOfStatus(status);
      if (byStatus) return byStatus;
    }
    if (typeof record.code === "string" && NETWORK_CODES.has(record.code)) return "network";
    queue.push(record.cause, record.lastError);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return "unknown";
}

/**
 * 模型调用没成、写进给作者看的原因里的那一句：认得的类（连不上、密钥、额度、限流、服务商故障、超时、没设好）说中文短句，
 * 不把 SDK / fetch 的英文原文（「fetch failed」）端给作者；认不出的用错误本身那句（自家抛的都是中文），压成一行。
 */
export function modelFailureText(error: unknown, max = 160): string {
  const reason = classifyAiError(error);
  if (reason !== "unknown") return aiErrorCause(reason);
  const text = (error instanceof Error ? error.message : String(error)).trim().split(/\s+/u).join(" ");
  return text.length > max ? `${text.slice(0, max)}…` : text || "未知错误";
}
