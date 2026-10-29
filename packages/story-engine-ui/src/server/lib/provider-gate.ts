/**
 * 服务商限流闸（模型无关，重构 P0，2026-10-17）。
 *
 * 起因：换智谱 GLM 编程套餐后，核账一章并发 4 遍 + 考卷书间并发，撞「429 / 1302 速率限制」，
 * 一大半调用直接「没跑成」（考卷查全从约 36% 掉到 4%）。此前调模型的三条路都没有 429 处理。
 *
 * 做法（不认任何一家的错误文案，只看 HTTP 状态码）：
 * - 按额度组各一道闸（写作版本 P2a：服务商设置上的 `quotaGroup`，默认 = 服务商地址的 origin；同一套餐的不同密钥、
 *   不同入口由作者填成同一组），限同时在飞的请求数。许可一直占到响应体读完（流式也算），不是拿到响应头就放。
 * - 两道（写作版本 P2a）：前台（对话、按钮、对话 AI）和后台（补读、通读记账）。两边都排着队时后台至少 1 位（上限 ≥ 2）、
 *   前台至少 min(2, 上限 − 1) 位，上限是 1 就轮流；只有一边排队可以借满；在飞的不强杀。
 * - 并发上限自适应：开局宽（initialLimit），撞 429 就减半（最少 1），连续成功够多再慢慢 +1。
 *   不同服务商、不同套餐的上限不用人配。
 * - 只有 429 退避重试（写作版本 P2a：503 和别的 5xx 可能已经转给上游、在算，闸里重发就是悄悄多花一次，交回调用方按结果不明处理）：
 *   有 Retry-After 就照它等，否则指数退避加抖动，封顶 maxDelayMs；
 *   重试 maxRetries 次后把最后那个响应原样交回调用方，由调用方照常如实报错。
 * - 排队和退避期间每隔几秒调一次 onWait：调用方拿它给自己的空闲计时器续命，
 *   免得「排队等许可」被误判成「连接静默」。
 */

import { currentOperation } from "./operations/context.js";

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

export type GateLane = "foreground" | "background";

export interface GatedFetchOptions {
  /** 排队、退避期间约每 5 秒调一次，供调用方给空闲计时器续命。 */
  readonly onWait?: () => void;
  /** 拿到许可、请求真发出去之前调（每次重试都调）：调用方从这时起算「模型多久没出字」。 */
  readonly onSend?: () => void;
  /** 额度组（缺省 = 请求地址的 origin）。 */
  readonly quotaGroup?: string;
  /** 走哪一道（缺省：在操作里按操作的道，不在操作里 = 前台）。 */
  readonly lane?: GateLane;
}

const RETRYABLE_STATUS = new Set([429]);
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

const LANES: readonly GateLane[] = ["foreground", "background"];

class AdaptiveGate {
  limit: number;
  private readonly active: Record<GateLane, number> = { foreground: 0, background: 0 };
  private successes = 0;
  private readonly waiters: Record<GateLane, Array<() => void>> = { foreground: [], background: [] };
  /** 上限是 1、两边都排队时轮流：上一个放进去的是哪一道。 */
  private lastGranted: GateLane = "background";

  constructor(initialLimit: number, private readonly maxLimit: number) {
    this.limit = initialLimit;
  }

  private get inFlight(): number {
    return this.active.foreground + this.active.background;
  }

  /** 拿一个许可；返回只能调一次的释放函数。 */
  acquire(lane: GateLane, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active[lane] += 1;
        this.lastGranted = lane;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active[lane] -= 1;
          this.drain();
        });
      };
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const queue = this.waiters[lane];
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        grant();
      };
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
      this.drain();
    });
  }

  /** 两边都排队时下一个该放哪一道（见文件头）；只有一边排队就放那边。 */
  private nextLane(): GateLane | undefined {
    const waiting = LANES.filter((lane) => this.waiters[lane].length > 0);
    if (waiting.length < 2) return waiting[0];
    if (this.limit === 1) return this.lastGranted === "foreground" ? "background" : "foreground";
    // 后台先保住 1 位，其余都给前台（前台因此至少有 上限 − 1 ≥ min(2, 上限 − 1) 位）。
    return this.active.background < 1 ? "background" : "foreground";
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
    while (this.inFlight < this.limit) {
      const lane = this.nextLane();
      if (!lane) return;
      this.waiters[lane].shift()?.();
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
    const origin = opts.quotaGroup?.trim() || originOf(input);
    const gate = gateFor(origin);
    const signal = init?.signal ?? undefined;
    for (let attempt = 0; ; attempt += 1) {
      const release = await withPulse(gate.acquire(opts.lane ?? currentOperation()?.lane ?? "foreground", signal), opts.onWait);
      let response: Response;
      try {
        opts.onSend?.();
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
  function wrap(baseFetch: typeof fetch = fetch, route: Pick<GatedFetchOptions, "quotaGroup" | "lane"> = {}): typeof fetch {
    return (input, init) => gatedFetch(input, init, { baseFetch, ...route });
  }

  return { fetch: gatedFetch, wrap, limitFor: (group: string) => gates.get(group)?.limit };
}

/** 进程内共用一道闸：对话 AI、编辑部、出稿都打同一个服务商时，按同一个上限排队。 */
export const providerGate = createProviderGate();
