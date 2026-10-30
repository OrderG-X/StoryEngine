/**
 * 一次物理发送没拿到响应时怎么归类（写作版本 P2a 设计 4.2）：只看结构——我们自己掐的原因（abort reason）、
 * fetch 抛错的 `cause.code`。不看错误文案。拿到响应之后的分类（状态码、帧、结束标记）在 llm-client 里按读的结果定。
 */
import type { AttemptClass } from "./attempts.js";
import { stopOf } from "./context.js";

/**
 * 只可能发生在请求字节发出之前的连接错：DNS 失败、连接被拒、连不上主机、连接超时（TCP / TLS 握手没完成）、TLS 证书不对。
 * 连接重置（ECONNRESET）、写到一半断了（EPIPE、UND_ERR_SOCKET）可能已经发出去了，不在这里。
 */
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** 顺着 cause / errors 收错误码（Node fetch 把真原因包在 `TypeError: fetch failed` 的 cause 里，多地址时是 AggregateError）。 */
function errorCodes(error: unknown): readonly string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as { readonly code?: unknown; readonly cause?: unknown; readonly errors?: unknown };
    if (typeof record.code === "string") codes.push(record.code);
    queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return codes;
}

/**
 * fetch 抛了错、或读响应体时断了：取消 / 暂停 → cancelled；我们按策略掐的（思考超长、正文跑飞、对冲输家）→ policy_abort；
 * 别的掐法（空闲超时）→ unknown；连接错误码全是「没发出去」那几类 → not_sent；其余 unknown。
 * `afterResponse`：响应头已经到了（读体时断的），连接类错误码也说明不了没发，不会是 not_sent。
 */
export function classifyThrown(error: unknown, signal: AbortSignal | undefined, afterResponse = false): AttemptClass {
  const stop = stopOf(signal?.aborted ? signal.reason : undefined) ?? stopOf(error);
  if (stop) return stop.type === "policy" ? "policy_abort" : "cancelled";
  if (signal?.aborted || afterResponse) return "unknown";
  const codes = errorCodes(error);
  return codes.length > 0 && codes.every((code) => NOT_SENT_CODES.has(code)) ? "not_sent" : "unknown";
}
