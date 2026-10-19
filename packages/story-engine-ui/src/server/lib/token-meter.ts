/**
 * 一轮对话的真实 token 用量（2026-10-10 自审：系统从没记过真实计费用量，「省 token」无从举证，砍多少也没法比）。
 *
 * 路由在一轮对话外面套一个计量器（AsyncLocalStorage），这一轮里所有模型调用——对话 AI 自己的每一步、
 * 工具内部的拟章纲 / 出稿 / 核对 / 记账——都往同一个计量器里记。轮末汇总打日志、发给前端。
 * 没套计量器时（单测、脚本）记录调用直接忽略，不影响任何行为。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TokenUsageSample {
  /** 输入 token（含命中缓存的部分）。 */
  readonly input: number;
  /** 输入里命中服务商缓存的部分（价格通常只有一成）。 */
  readonly cachedInput: number;
  readonly output: number;
  /** 输出里的思考部分。 */
  readonly reasoning: number;
}

export interface TokenUsageTotals extends TokenUsageSample {
  readonly calls: number;
}

export interface StepTotals extends TokenUsageTotals {
  /** 这一步累计耗时（毫秒；同名步骤多次进入时相加）。 */
  readonly ms: number;
}

export interface TokenMeterSnapshot {
  /** 对话 AI（聊天大脑）自己的调用。 */
  readonly agent: TokenUsageTotals;
  /** 工具内部的调用（拟章纲、出稿、核对、记账……）。 */
  readonly pipeline: TokenUsageTotals;
  readonly total: TokenUsageTotals;
  /**
   * 分步（2026-10-10 引擎升级第 4 期）：withStep 包起来的步骤各自的耗时和内部调用用量，
   * 名字带层级（「核账/通读」）。没包的内部调用不进这里，只进 pipeline。
   */
  readonly steps?: Readonly<Record<string, StepTotals>>;
}

const EMPTY: TokenUsageTotals = { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };

class TokenMeter {
  private agent: TokenUsageTotals = EMPTY;
  private pipeline: TokenUsageTotals = EMPTY;
  private readonly steps = new Map<string, StepTotals>();
  /** 这一轮要告诉作者的事（如「这次用了备用模型」），同一句只留一条。 */
  readonly notices = new Set<string>();

  record(kind: "agent" | "pipeline", sample: TokenUsageSample, calls = 1, step?: string): void {
    const add = <T extends TokenUsageTotals>(base: T): T => ({
      ...base,
      calls: base.calls + calls,
      input: base.input + sample.input,
      cachedInput: base.cachedInput + sample.cachedInput,
      output: base.output + sample.output,
      reasoning: base.reasoning + sample.reasoning,
    });
    if (kind === "agent") this.agent = add(this.agent);
    else this.pipeline = add(this.pipeline);
    if (kind === "pipeline" && step) this.steps.set(step, add(this.steps.get(step) ?? { ...EMPTY, ms: 0 }));
  }

  addTime(step: string, ms: number): void {
    const base = this.steps.get(step) ?? { ...EMPTY, ms: 0 };
    this.steps.set(step, { ...base, ms: base.ms + ms });
  }

  snapshot(): TokenMeterSnapshot {
    const sum = (a: TokenUsageTotals, b: TokenUsageTotals): TokenUsageTotals => ({
      calls: a.calls + b.calls,
      input: a.input + b.input,
      cachedInput: a.cachedInput + b.cachedInput,
      output: a.output + b.output,
      reasoning: a.reasoning + b.reasoning,
    });
    return {
      agent: this.agent,
      pipeline: this.pipeline,
      total: sum(this.agent, this.pipeline),
      ...(this.steps.size > 0 ? { steps: Object.fromEntries(this.steps) } : {}),
    };
  }
}

const storage = new AsyncLocalStorage<TokenMeter>();
const stepStorage = new AsyncLocalStorage<string>();

/**
 * 把一步包起来计量：耗时 + 这一步里内部模型调用的用量记在步骤名下（嵌套时名字是「外层/里层」）。
 * 没套计量器时照常执行、什么都不记。
 */
export async function withStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const parent = stepStorage.getStore();
  const path = parent ? `${parent}/${name}` : name;
  const started = Date.now();
  try {
    return await stepStorage.run(path, fn);
  } finally {
    storage.getStore()?.addTime(path, Date.now() - started);
  }
}

/** 在一个计量器里跑 fn；返回 fn 的结果、这段时间记下的用量和要告诉作者的事。 */
export async function withTokenMeter<T>(fn: () => Promise<T>): Promise<{
  readonly result: T;
  readonly usage: TokenMeterSnapshot;
  readonly notices: readonly string[];
}> {
  const meter = new TokenMeter();
  const result = await storage.run(meter, fn);
  return { result, usage: meter.snapshot(), notices: [...meter.notices] };
}

/** 记一句本轮要告诉作者的事（轮末作为状态说明发给界面）；不在一轮对话里时只打日志。 */
export function recordTurnNotice(text: string): void {
  const meter = storage.getStore();
  if (meter) meter.notices.add(text);
  else console.info(`[notice] ${text}`);
}

/** 当前计量器的即时快照（没有计量器 → undefined）。 */
export function currentTokenUsage(): TokenMeterSnapshot | undefined {
  return storage.getStore()?.snapshot();
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * OpenAI 兼容接口的 usage 帧（各家字段不一，宽进）：prompt_tokens / completion_tokens；
 * 缓存命中 = prompt_tokens_details.cached_tokens（OpenAI 口径）或 prompt_cache_hit_tokens（DeepSeek 口径）；
 * 思考 = completion_tokens_details.reasoning_tokens。认不出的一律当 0，不抛。
 */
export function sampleFromOpenAIUsage(usage: unknown): TokenUsageSample | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const promptDetails = record.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = record.completion_tokens_details as Record<string, unknown> | undefined;
  const input = num(record.prompt_tokens) || num(record.input_tokens);
  const output = num(record.completion_tokens) || num(record.output_tokens);
  if (input === 0 && output === 0) return undefined;
  return {
    input,
    cachedInput: num(promptDetails?.cached_tokens) || num(record.prompt_cache_hit_tokens),
    output,
    reasoning: num(completionDetails?.reasoning_tokens),
  };
}

/** AI SDK / Mastra 的 LanguageModelUsage（inputTokens / outputTokens / cachedInputTokens / reasoningTokens）。 */
export function sampleFromSdkUsage(usage: unknown): TokenUsageSample | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = num(record.inputTokens);
  const output = num(record.outputTokens);
  if (input === 0 && output === 0) return undefined;
  return { input, cachedInput: num(record.cachedInputTokens), output, reasoning: num(record.reasoningTokens) };
}

/** 工具内部的一次模型调用用量记进当前计量器（没有计量器就忽略）。 */
export function recordPipelineUsage(sample: TokenUsageSample | undefined): void {
  if (sample) storage.getStore()?.record("pipeline", sample, 1, stepStorage.getStore());
}

/** 对话 AI 一次尝试（可能含多步）的用量记进当前计量器。 */
export function recordAgentUsage(sample: TokenUsageSample | undefined, steps = 1): void {
  if (sample) storage.getStore()?.record("agent", sample, steps);
}

/** 日志用的一行：万为单位，作者看得懂。 */
export function describeTokenUsage(usage: TokenMeterSnapshot): string {
  const wan = (value: number) => `${(value / 10000).toFixed(1)} 万`;
  const part = (label: string, totals: TokenUsageTotals) =>
    `${label} ${totals.calls} 次，输入 ${wan(totals.input)}（缓存命中 ${wan(totals.cachedInput)}），输出 ${wan(totals.output)}（思考 ${wan(totals.reasoning)}）`;
  return `${part("对话 AI", usage.agent)}；${part("内部调用", usage.pipeline)}；合计输入 ${wan(usage.total.input)}、输出 ${wan(usage.total.output)}`;
}
