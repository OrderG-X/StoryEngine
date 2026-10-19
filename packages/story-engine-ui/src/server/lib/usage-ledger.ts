/**
 * 全局用量账（P10）：每次调模型记一行 `~/.story-engine/usage/YYYY-MM.jsonl`
 * （时间、书、功能、服务商、模型、输入 / 缓存命中 / 输出 / 思考 token）。
 * 记账点两个：内部调用的唯一出口 streamChatModelToText，和对话 AI 每轮结束。服务商没回用量的调用不记（不知道多少）。
 *
 * 设置里的「用量」页从这里汇总：今天、本月、近 30 天每天一根柱，近 30 天按书 / 功能 / 模型分列。
 * 花费要作者自己按模型填单价（元 / 百万 token），存 `~/.story-engine/usage-prices.json`；填了才算「约 ¥x」。
 * 记账出错不挡调模型：只 warn。读的路径不写盘。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { readBookMeta } from "./book-info.js";
import { resolveGlobalDataDir } from "./data-dirs.js";
import { isRecord, writeFileAtomic } from "./project-io.js";
import type { TokenUsageSample } from "./token-meter.js";
import { currentUsageBook } from "./usage-scope.js";
import { localDate } from "./word-stats.js";

/** 不是 6 个功能之一的调用（体检等）。 */
export const OTHER_TASK = "other";
/** 近多少天分列。 */
const RECENT_DAYS = 30;

export interface UsageLine extends TokenUsageSample {
  /** ISO 时间。 */
  readonly t: string;
  /** 本地日期 YYYY-MM-DD。 */
  readonly d: string;
  /** 书的目录；不知道是哪本书就没有。 */
  readonly book?: string;
  readonly task: string;
  readonly provider: string;
  readonly providerLabel?: string;
  readonly model: string;
}

export interface UsagePrice {
  /** 元 / 百万 token。 */
  readonly input: number;
  /** 缓存命中的输入；不填按输入价算。 */
  readonly cachedInput?: number;
  readonly output: number;
}

export interface UsageTotals {
  readonly calls: number;
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  readonly reasoning: number;
  /** 填了单价的那部分算出来的钱（元）；一个都没填是 undefined。 */
  readonly cost?: number;
  /** 有调用的模型没填单价（钱只算了一部分或没算）。 */
  readonly unpriced: boolean;
}

export interface UsageGroup extends UsageTotals {
  readonly key: string;
}

export interface UsageModelGroup extends UsageGroup {
  readonly provider: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly price?: UsagePrice;
}

export interface UsageSummary {
  readonly today: UsageTotals;
  readonly month: UsageTotals;
  /** 近 30 天（旧在前）。 */
  readonly days: readonly ({ readonly date: string } & UsageTotals)[];
  /** 下面三组都是近 30 天。书的 key 是目录，title 是现在的书名（书没了用目录名）；不知道是哪本书的 key 是 ""。 */
  readonly byBook: readonly (UsageGroup & { readonly title: string })[];
  readonly byTask: readonly UsageGroup[];
  readonly byModel: readonly UsageModelGroup[];
}

export function usageDir(): string {
  return join(resolveGlobalDataDir(), "usage");
}

export function usagePricesPath(): string {
  return join(resolveGlobalDataDir(), "usage-prices.json");
}

function monthFile(date: string): string {
  return join(usageDir(), `${date.slice(0, 7)}.jsonl`);
}

let writeChain: Promise<void> = Promise.resolve();

/** 记一次调用。永不抛；同一进程里按顺序追加。 */
export function recordUsage(input: {
  readonly task?: string;
  readonly provider: string;
  readonly providerLabel?: string;
  readonly model: string;
  readonly sample: TokenUsageSample | undefined;
  readonly now?: Date;
}): Promise<void> {
  const { sample } = input;
  if (!sample) return writeChain;
  const now = input.now ?? new Date();
  const book = currentUsageBook();
  const line: UsageLine = {
    t: now.toISOString(),
    d: localDate(now),
    ...(book ? { book } : {}),
    task: input.task ?? OTHER_TASK,
    provider: input.provider,
    ...(input.providerLabel ? { providerLabel: input.providerLabel } : {}),
    model: input.model,
    input: sample.input,
    cachedInput: sample.cachedInput,
    output: sample.output,
    reasoning: sample.reasoning,
  };
  writeChain = writeChain
    .then(async () => {
      await mkdir(usageDir(), { recursive: true });
      await appendFile(monthFile(line.d), `${JSON.stringify(line)}\n`, "utf-8");
    })
    .catch((error: unknown) => {
      console.warn(`[usage] 用量没记上：${error instanceof Error ? error.message : String(error)}`);
    });
  return writeChain;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function parseLine(text: string): UsageLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const d = str(raw.d);
  const provider = str(raw.provider);
  const model = str(raw.model);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/u.test(d) || !provider || !model) return null;
  const book = str(raw.book);
  const providerLabel = str(raw.providerLabel);
  return {
    t: str(raw.t) ?? "",
    d,
    ...(book ? { book } : {}),
    task: str(raw.task) ?? OTHER_TASK,
    provider,
    ...(providerLabel ? { providerLabel } : {}),
    model,
    input: num(raw.input),
    cachedInput: num(raw.cachedInput),
    output: num(raw.output),
    reasoning: num(raw.reasoning),
  };
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d + days));
}

/** 读覆盖 [from, to] 的月文件里的所有行（坏行跳过）。 */
async function readLines(from: string, to: string): Promise<UsageLine[]> {
  const months = new Set<string>();
  for (let date = from; date <= to; date = shiftDate(date, 1)) months.add(date.slice(0, 7));
  const lines: UsageLine[] = [];
  for (const month of months) {
    const text = await readFile(join(usageDir(), `${month}.jsonl`), "utf-8").catch(() => "");
    for (const row of text.split("\n")) {
      const line = row.trim() ? parseLine(row) : null;
      if (line && line.d >= from && line.d <= to) lines.push(line);
    }
  }
  return lines;
}

function readPrice(raw: unknown): UsagePrice | undefined {
  if (!isRecord(raw)) return undefined;
  const ok = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!ok(raw.input) || !ok(raw.output)) return undefined;
  return {
    input: raw.input as number,
    ...(ok(raw.cachedInput) ? { cachedInput: raw.cachedInput as number } : {}),
    output: raw.output as number,
  };
}

/** 单价表：「服务商|模型」→ 单价。没有或坏了是空表。 */
export async function readUsagePrices(): Promise<Record<string, UsagePrice>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(usagePricesPath(), "utf-8"));
  } catch {
    return {};
  }
  const models = isRecord(raw) && isRecord(raw.models) ? raw.models : {};
  const prices: Record<string, UsagePrice> = {};
  for (const [key, value] of Object.entries(models)) {
    const price = readPrice(value);
    if (price) prices[key] = price;
  }
  return prices;
}

/** 填 / 清一个模型的单价（price 为 null 清掉）。单价不合法抛人话错误。 */
export async function writeUsagePrice(key: string, price: unknown): Promise<Record<string, UsagePrice>> {
  if (!key.includes("|")) throw new Error("模型不对。");
  const prices = await readUsagePrices();
  if (price === null) {
    delete prices[key];
  } else {
    const parsed = readPrice(price);
    if (!parsed) throw new Error("单价要填不小于 0 的数字（元 / 百万 token）。");
    prices[key] = parsed;
  }
  await mkdir(resolveGlobalDataDir(), { recursive: true });
  await writeFileAtomic(usagePricesPath(), `${JSON.stringify({ version: 1, models: prices }, null, 2)}\n`);
  return prices;
}

const modelKey = (line: UsageLine) => `${line.provider}|${line.model}`;

function costOf(line: UsageLine, price: UsagePrice | undefined): number | undefined {
  if (!price) return undefined;
  const cached = Math.min(line.cachedInput, line.input);
  return ((line.input - cached) * price.input + cached * (price.cachedInput ?? price.input) + line.output * price.output) / 1_000_000;
}

function totalsOf(lines: readonly UsageLine[], prices: Readonly<Record<string, UsagePrice>>): UsageTotals {
  let cost: number | undefined;
  let unpriced = false;
  const totals = { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  for (const line of lines) {
    totals.calls += 1;
    totals.input += line.input;
    totals.cachedInput += line.cachedInput;
    totals.output += line.output;
    totals.reasoning += line.reasoning;
    const lineCost = costOf(line, prices[modelKey(line)]);
    if (lineCost === undefined) unpriced = true;
    else cost = (cost ?? 0) + lineCost;
  }
  return { ...totals, ...(cost !== undefined ? { cost } : {}), unpriced };
}

function groupBy(lines: readonly UsageLine[], keyOf: (line: UsageLine) => string): Map<string, UsageLine[]> {
  const groups = new Map<string, UsageLine[]>();
  for (const line of lines) {
    const key = keyOf(line);
    const list = groups.get(key);
    if (list) list.push(line);
    else groups.set(key, [line]);
  }
  return groups;
}

const byTokens = <T extends UsageTotals>(a: T, b: T) => b.input + b.output - (a.input + a.output);

/** 汇总（读路径：不写盘）。 */
export async function readUsageSummary(now: Date = new Date()): Promise<UsageSummary> {
  const today = localDate(now);
  const recentFrom = shiftDate(today, -(RECENT_DAYS - 1));
  const monthFrom = `${today.slice(0, 7)}-01`;
  const from = monthFrom < recentFrom ? monthFrom : recentFrom;
  const [lines, prices] = await Promise.all([readLines(from, today), readUsagePrices()]);
  const recent = lines.filter((line) => line.d >= recentFrom);
  const perDay = groupBy(recent, (line) => line.d);
  const days = Array.from({ length: RECENT_DAYS }, (_, i) => {
    const date = shiftDate(recentFrom, i);
    return { date, ...totalsOf(perDay.get(date) ?? [], prices) };
  });

  const byBook = await Promise.all([...groupBy(recent, (line) => line.book ?? "")].map(async ([key, group]) => ({
    key,
    title: key ? await readBookMeta(key).then((meta) => meta.title, () => basename(key)) : "",
    ...totalsOf(group, prices),
  })));
  const byTask = [...groupBy(recent, (line) => line.task)].map(([key, group]) => ({ key, ...totalsOf(group, prices) }));
  const byModel = [...groupBy(recent, modelKey)].map(([key, group]) => {
    const last = group[group.length - 1]!;
    const price = prices[key];
    return {
      key,
      provider: last.provider,
      providerLabel: last.providerLabel ?? last.provider,
      model: last.model,
      ...(price ? { price } : {}),
      ...totalsOf(group, prices),
    };
  });

  return {
    today: totalsOf(lines.filter((line) => line.d === today), prices),
    month: totalsOf(lines.filter((line) => line.d >= monthFrom), prices),
    days,
    byBook: byBook.sort(byTokens),
    byTask: byTask.sort(byTokens),
    byModel: byModel.sort(byTokens),
  };
}
