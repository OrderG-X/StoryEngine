/**
 * 调模型失败的分类（P11）：给作者的错误卡说清「为什么、该做什么」，不再一律「AI 服务暂时没响应」。
 *
 * 只看结构，不看文案：自家抛的类型（没配好 / 上游没动静）、服务商回的 HTTP 状态码、网络层的错误码。
 * 顺着 cause / lastError / errors 往里找（AI SDK 的重试错误、fetch 的 TypeError 都把真原因包在里面）。
 */

/** 模型没配好：没配、缺密钥、档案指向的服务商没了。重试没用，得去设置里补。 */
export class ModelSetupError extends Error {
  override readonly name = "ModelSetupError";
}

/** 上游彻底没动静（空闲超时，见 STREAM_IDLE_TIMEOUT_MS）：响应头一直不来，或流到一半断了。 */
export class UpstreamSilentError extends Error {
  override readonly name = "UpstreamSilentError";
}

/** 服务商回了非 2xx：带上状态码，分类只看它。 */
export class ModelHttpError extends Error {
  override readonly name = "ModelHttpError";
  constructor(message: string, readonly statusCode: number) {
    super(message);
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
