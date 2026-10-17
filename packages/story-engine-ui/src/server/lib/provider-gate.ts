/**
 * 服务商限流闸（模型无关，重构 P0，2026-10-17）。
 *
 * 起因：换智谱 GLM 编程套餐后，核账一章并发 4 遍 + 考卷书间并发，撞「429 / 1302 速率限制」，
 * 一大半调用直接「没跑成」（考卷查全从约 36% 掉到 4%）。此前调模型的三条路都没有 429 处理。
 *
 * 做法（不认任何一家的错误文案，只看 HTTP 状态码）：
 * - 按服务商地址（origin）各一道闸，限同时在飞的请求数。许可一直占到响应体读完（流式也算），
 *   不是拿到响应头就放。
 * - 并发上限自适应：开局宽（initialLimit），撞 429 就减半（最少 1），连续成功够多再慢慢 +1。
 *   不同服务商、不同套餐的上限不用人配。
 * - 429 / 503 退避重试：有 Retry-After 就照它等，否则指数退避加抖动，封顶 maxDelayMs；
 *   重试 maxRetries 次后把最后那个响应原样交回调用方，由调用方照常如实报错。
 * - 排队和退避期间每隔几秒调一次 onWait：调用方拿它给自己的空闲计时器续命，
 *   免得「排队等许可」被误判成「连接静默」。
 */

export interface ProviderGateOptions {
  readonly initialLimit?: number;
  readonly maxLimit?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly log?: (message: string) => void;
}

export interface GatedFetchOptions {
  /** 排队、退避期间约每 5 秒调一次，供调用方给空闲计时器续命。 */
  readonly onWait?: () => void;
}

const RETRYABLE_STATUS = new Set([429, 503]);
const WAIT_PULSE_MS = 5000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class AdaptiveGate {
  limit: number;
  private active = 0;
  private successes = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(initialLimit: number, private readonly maxLimit: number) {
    this.limit = initialLimit;
  }

  /** 拿一个许可；返回只能调一次的释放函数。 */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.drain();
        });
      };
      if (this.active < this.limit) {
        grant();
        return;
      }
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        grant();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  rateLimited(): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.successes = 0;
  }

  succeeded(): void {
    this.successes += 1;
    if (this.limit < this.maxLimit && this.successes >= this.limit * 2) {
      this.limit += 1;
      this.successes = 0;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      this.waiters.shift()?.();
    }
  }
}

function originOf(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw).origin;
  } catch {
    return "unknown";
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** 许可占到响应体读完 / 出错 / 被取消为止。 */
function holdUntilBodyDone(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  response.body.pipeTo(writable).catch(() => undefined).finally(release);
  return new Response(readable, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createProviderGate(options: ProviderGateOptions = {}) {
  const initialLimit = options.initialLimit ?? 8;
  const maxLimit = options.maxLimit ?? 16;
  const maxRetries = options.maxRetries ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 1500;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((message: string) => console.warn(message));
  const gates = new Map<string, AdaptiveGate>();

  const gateFor = (origin: string): AdaptiveGate => {
    let gate = gates.get(origin);
    if (!gate) {
      gate = new AdaptiveGate(initialLimit, maxLimit);
      gates.set(origin, gate);
    }
    return gate;
  };

  /** 等待期间按节拍调 onWait。 */
  const withPulse = async <T>(work: Promise<T>, onWait?: () => void): Promise<T> => {
    if (!onWait) return work;
    const pulse = setInterval(onWait, WAIT_PULSE_MS);
    (pulse as unknown as { unref?: () => void }).unref?.();
    try {
      return await work;
    } finally {
      clearInterval(pulse);
    }
  };

  async function gatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    opts: GatedFetchOptions & { readonly baseFetch?: typeof fetch } = {},
  ): Promise<Response> {
    const baseFetch = opts.baseFetch ?? fetch;
    const origin = originOf(input);
    const gate = gateFor(origin);
    const signal = init?.signal ?? undefined;
    for (let attempt = 0; ; attempt += 1) {
      const release = await withPulse(gate.acquire(signal), opts.onWait);
      let response: Response;
      try {
        response = await baseFetch(input, init);
      } catch (error) {
        release();
        throw error;
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) {
        if (response.ok) gate.succeeded();
        return holdUntilBodyDone(response, release);
      }
      if (response.status === 429) gate.rateLimited();
      await response.body?.cancel().catch(() => undefined);
      release();
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.75 + random() * 0.5);
      const delay = Math.min(maxDelayMs, retryAfterMs(response) ?? backoff);
      log(`[provider-gate] ${origin} 返回 ${response.status}，并发上限降到 ${gate.limit}，${Math.round(delay / 1000)} 秒后第 ${attempt + 1} 次重试`);
      await withPulse(sleep(delay, signal), opts.onWait);
    }
  }

  /** 包成 fetch 形状（给 AI SDK 的 fetch 注入点用）。 */
  function wrap(baseFetch: typeof fetch = fetch): typeof fetch {
    return (input, init) => gatedFetch(input, init, { baseFetch });
  }

  return { fetch: gatedFetch, wrap, limitFor: (origin: string) => gates.get(origin)?.limit };
}

/** 进程内共用一道闸：对话 AI、编辑部、出稿都打同一个服务商时，按同一个上限排队。 */
export const providerGate = createProviderGate();
