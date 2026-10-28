const inFlightRequests = new Map<string, Promise<unknown>>();

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (const byte of hashArray) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function mergeSignals(userSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (!userSignal) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => controller.abort() };
  }
  if (userSignal.aborted) {
    const controller = new AbortController();
    controller.abort(userSignal.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(userSignal.reason);
  userSignal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      userSignal.removeEventListener("abort", onAbort);
    },
  };
}

function isClientNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function canRetryMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 300;

export class FetchJsonError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly payload: unknown;

  constructor(
    message: string,
    input: {
      readonly status: number;
      readonly method: string;
      readonly url: string;
      readonly payload: unknown;
    },
  ) {
    super(message);
    this.name = "FetchJsonError";
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.payload = input.payload;
  }
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit,
  signal?: AbortSignal,
  retriesLeft: number = MAX_RETRIES,
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const body = typeof options.body === "string" ? options.body : undefined;

  if (method === "GET") {
    const dedupKey = `${method}:${url}:${body ?? ""}`;
    const hash = await sha256Hex(dedupKey);

    if (inFlightRequests.has(hash)) {
      return inFlightRequests.get(hash)! as Promise<T>;
    }

    const promise = executeFetch<T>(url, options, signal, retriesLeft);
    inFlightRequests.set(hash, promise);
    promise.finally(() => {
      inFlightRequests.delete(hash);
    });
    return promise;
  }

  return executeFetch<T>(url, options, signal, retriesLeft);
}

async function executeFetch<T>(
  url: string,
  options: RequestInit,
  signal: AbortSignal | undefined,
  retriesLeft: number,
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const { signal: mergedSignal, cleanup } = mergeSignals(signal);
  try {
    const response = await fetch(url, { ...options, signal: mergedSignal });
    const responseText = await response.text();
    const parsePayload = <TPayload>(): TPayload => {
      if (!responseText.trim()) {
        throw new Error(`接口返回空响应：${method} ${url}`);
      }
      try {
        return JSON.parse(responseText) as TPayload;
      } catch (error) {
        throw new Error(`接口返回不是有效 JSON：${method} ${url}。${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      if (retryable && canRetryMethod(method) && retriesLeft > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, MAX_RETRIES - retriesLeft);
        await sleep(backoff);
        return executeFetch<T>(url, options, signal, retriesLeft - 1);
      }
      const payload = parsePayload<unknown>();
      throw new FetchJsonError(
        buildFetchJsonErrorMessage(payload, response.status),
        { status: response.status, method, url, payload },
      );
    }

    return parsePayload<T>();
  } catch (err) {
    if (mergedSignal.aborted) {
      throw err;
    }
    if (isClientNetworkError(err) && canRetryMethod(method) && retriesLeft > 0) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, MAX_RETRIES - retriesLeft);
      await sleep(backoff);
      return executeFetch<T>(url, options, signal, retriesLeft - 1);
    }
    if (err instanceof Error && !isClientNetworkError(err)) {
      throw err;
    }
    throw err;
  } finally {
    cleanup();
  }
}

/** 给作者看的就是服务端说的那句（中文）；服务端什么都没说才给状态码。不带英文前缀（状态码在 FetchJsonError.status 上）。 */
function buildFetchJsonErrorMessage(payload: unknown, status: number): string {
  const details = payloadErrorDetails(payload);
  if (details.length === 0) return `没成功（HTTP ${status}）`;
  return details.join(" ");
}

function payloadErrorDetails(payload: unknown): readonly string[] {
  if (!isRecord(payload)) return [];
  return uniqueStrings([
    readString(payload.error),
    readString(payload.reason),
    nestedString(payload.transactionPreflight, "code"),
    nestedString(payload.formalPreflight, "code"),
    nestedString(payload.snapshotResult, "reason"),
    nestedString(payload.snapshotResult, "code"),
    readString(payload.finalizeError),
    payload.transactionFinalized === false ? "transactionFinalized:false" : undefined,
  ]);
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return readString(value[key]);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
