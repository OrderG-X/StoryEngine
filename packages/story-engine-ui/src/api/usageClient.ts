/** 用量（P10）：全局用量账的汇总和单价。形状与 server/lib/usage-ledger.ts 一致（前端不引服务端）。 */

export interface UsageTotalsView {
  readonly calls: number;
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  readonly reasoning: number;
  /** 填了单价的那部分算出来的钱（元）；一个都没填就没有。 */
  readonly cost?: number;
  readonly unpriced: boolean;
}

export interface UsagePriceView {
  readonly input: number;
  readonly cachedInput?: number;
  readonly output: number;
}

export interface UsageSummaryView {
  readonly today: UsageTotalsView;
  readonly month: UsageTotalsView;
  readonly days: readonly ({ readonly date: string } & UsageTotalsView)[];
  readonly byBook: readonly ({ readonly key: string; readonly title: string } & UsageTotalsView)[];
  readonly byTask: readonly ({ readonly key: string } & UsageTotalsView)[];
  readonly byModel: readonly ({
    readonly key: string;
    readonly provider: string;
    readonly providerLabel: string;
    readonly model: string;
    readonly price?: UsagePriceView;
  } & UsageTotalsView)[];
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new Error(`连不上本机服务：${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (body.ok !== true) throw new Error(body.error?.trim() || `没成功（${res.status}）。`);
  return body;
}

export async function fetchUsage(): Promise<UsageSummaryView> {
  return (await call<{ summary: UsageSummaryView }>("/api/usage")).summary;
}

/** 填 / 清一个模型的单价（元 / 百万 token）；price 为 null 清掉。 */
export async function saveUsagePrice(key: string, price: UsagePriceView | null): Promise<void> {
  await call("/api/usage/prices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, price }) });
}
