import { useCallback, useEffect, useState } from "react";
import { fetchUsage, saveUsagePrice, type UsagePriceView, type UsageSummaryView, type UsageTotalsView } from "../../../api/usageClient.js";
import { TASK_LABELS } from "../../ModelSettingsDialogTypes.js";

type GroupTab = "book" | "task" | "model";

const GROUP_TABS: readonly { readonly id: GroupTab; readonly label: string }[] = [
  { id: "book", label: "按书" },
  { id: "task", label: "按功能" },
  { id: "model", label: "按模型" },
];

/** token 数：一万以上按万，一亿以上按亿。 */
export function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  return String(n);
}

/** 钱：没填单价是空串；不到一分钱写「不到 ¥0.01」。 */
export function formatCost(totals: UsageTotalsView): string {
  if (totals.cost === undefined) return "";
  return totals.cost > 0 && totals.cost < 0.01 ? "不到 ¥0.01" : `约 ¥${totals.cost.toFixed(2)}`;
}

const tokensOf = (totals: UsageTotalsView) => totals.input + totals.output;

function taskName(key: string): string {
  return TASK_LABELS[key] ?? "其他";
}

/** 单价输入：空 = 不填；只认不小于 0 的数。 */
function parsePrice(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 设置 · 用量（P10）：今天、本月；近 30 天每天一根柱；近 30 天按书 / 功能 / 模型分列。
 * 钱要按模型填单价（元 / 百万 token）才算；没填的只给 token。
 */
export function UsageSection({ api = { fetchUsage, saveUsagePrice } }: {
  readonly api?: { readonly fetchUsage: typeof fetchUsage; readonly saveUsagePrice: typeof saveUsagePrice };
}) {
  const [summary, setSummary] = useState<UsageSummaryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<GroupTab>("book");
  const [editing, setEditing] = useState<{ readonly key: string; readonly input: string; readonly cachedInput: string; readonly output: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await api.fetchUsage());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);

  const savePrice = async (key: string, price: UsagePriceView | null) => {
    setBusy(true);
    try {
      await api.saveUsagePrice(key, price);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const openPrice = (key: string, price: UsagePriceView | undefined) => setEditing({
    key,
    input: price ? String(price.input) : "",
    cachedInput: price?.cachedInput !== undefined ? String(price.cachedInput) : "",
    output: price ? String(price.output) : "",
  });

  const editInput = editing ? parsePrice(editing.input) : undefined;
  const editCached = editing ? parsePrice(editing.cachedInput) : undefined;
  const editOutput = editing ? parsePrice(editing.output) : undefined;
  const priceValid = editInput !== undefined && editInput !== null && editOutput !== undefined && editOutput !== null && editCached !== null;

  const peak = Math.max(1, ...(summary?.days.map(tokensOf) ?? [1]));
  const noCostAtAll = summary !== null && summary.month.cost === undefined && summary.month.calls > 0;

  return (
    <section className="msk-embedded ms-dialog se-usage" role="region" aria-label="用量">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">用量</h2>
          <p className="ms-subtitle">每次调模型记一笔。钱要在「按模型」里填单价才算。</p>
        </div>
      </header>
      <div className="ms-body">
        {error ? <div className="ms-error" role="alert">{error}</div> : null}
        {summary === null && !error ? <div className="ms-loading">正在读…</div> : null}
        {summary ? (
          <>
            <div className="se-usage-top">
              {([["今天", summary.today], ["本月", summary.month]] as const).map(([label, totals]) => (
                <div className="se-usage-stat" key={label}>
                  <b>{formatTokens(tokensOf(totals))}</b>
                  <span>{label} token</span>
                  {formatCost(totals) ? <em>{formatCost(totals)}{totals.unpriced ? "（有模型没填单价）" : ""}</em> : null}
                </div>
              ))}
            </div>
            {noCostAtAll ? <p className="se-usage-hint">还没填单价，只算 token。</p> : null}

            <div className="se-usage-bars" aria-label="近 30 天每天用量">
              {summary.days.map((day) => (
                <i
                  className={tokensOf(day) > 0 ? "is-on" : ""}
                  key={day.date}
                  style={{ height: `${Math.max(2, Math.round((tokensOf(day) / peak) * 100))}%` }}
                  title={`${day.date}：${formatTokens(tokensOf(day))} token${formatCost(day) ? `，${formatCost(day)}` : ""}`}
                />
              ))}
            </div>

            <div className="ms-theme-seg se-usage-tabs" role="group" aria-label="近 30 天分列">
              {GROUP_TABS.map((item) => (
                <button aria-pressed={tab === item.id} className={`ms-display-btn${tab === item.id ? " is-on" : ""}`} key={item.id} onClick={() => setTab(item.id)} type="button">
                  {item.label}
                </button>
              ))}
            </div>

            {summary.days.every((day) => day.calls === 0) ? <p className="se-usage-hint">近 30 天还没调过模型。</p> : null}

            <ul className="se-usage-list">
              {tab === "book" ? summary.byBook.map((group) => (
                <li key={group.key || "none"}>
                  <span className="se-usage-name">{group.key ? `《${group.title}》` : "没归到书"}</span>
                  <span className="se-usage-num">{formatTokens(tokensOf(group))}</span>
                  <span className="se-usage-cost">{formatCost(group)}</span>
                </li>
              )) : null}
              {tab === "task" ? summary.byTask.map((group) => (
                <li key={group.key}>
                  <span className="se-usage-name">{taskName(group.key)}</span>
                  <span className="se-usage-num">{formatTokens(tokensOf(group))}</span>
                  <span className="se-usage-cost">{formatCost(group)}</span>
                </li>
              )) : null}
              {tab === "model" ? summary.byModel.map((group) => (
                <li className="se-usage-model" key={group.key}>
                  <div className="se-usage-row">
                    <span className="se-usage-name">{group.providerLabel} · {group.model}</span>
                    <span className="se-usage-num">{formatTokens(tokensOf(group))}</span>
                    <span className="se-usage-cost">{formatCost(group)}</span>
                    <button className="ms-btn ms-btn-xs ms-btn-ghost" disabled={busy} onClick={() => openPrice(group.key, group.price)} type="button">
                      {group.price ? "改单价" : "填单价"}
                    </button>
                  </div>
                  {editing?.key === group.key ? (
                    <div className="se-usage-price" role="group" aria-label={`${group.model} 的单价`}>
                      <span className="se-usage-hint">元 / 百万 token</span>
                      <label>输入<input aria-label="输入单价" className="se-backup-input" disabled={busy} inputMode="decimal" onChange={(event) => setEditing({ ...editing, input: event.target.value })} value={editing.input} /></label>
                      <label>缓存命中<input aria-label="缓存命中单价" className="se-backup-input" disabled={busy} inputMode="decimal" onChange={(event) => setEditing({ ...editing, cachedInput: event.target.value })} placeholder="同输入" value={editing.cachedInput} /></label>
                      <label>输出<input aria-label="输出单价" className="se-backup-input" disabled={busy} inputMode="decimal" onChange={(event) => setEditing({ ...editing, output: event.target.value })} value={editing.output} /></label>
                      <div className="se-backup-edit-actions">
                        {group.price ? <button className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => void savePrice(group.key, null)} type="button">清掉</button> : null}
                        <button className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => setEditing(null)} type="button">算了</button>
                        <button
                          className="ms-btn ms-btn-primary"
                          disabled={busy || !priceValid}
                          onClick={() => void savePrice(group.key, { input: editInput as number, ...(editCached !== undefined ? { cachedInput: editCached as number } : {}), output: editOutput as number })}
                          type="button"
                        >
                          存
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )) : null}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}
