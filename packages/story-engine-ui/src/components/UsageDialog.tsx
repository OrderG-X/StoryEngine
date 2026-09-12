import type { UsageSummary } from "../api/types.js";

interface UsageDialogProps {
  readonly error?: string | null;
  readonly loading?: boolean;
  readonly onClose: () => void;
  readonly summary?: UsageSummary | null;
}

export default function UsageDialog({ error, loading, onClose, summary }: UsageDialogProps) {
  return (
    <div className="usage-backdrop" role="presentation" onClick={onClose}>
      <section aria-modal="true" className="usage-dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p>模型用量</p>
            <h2>当前书籍用量统计</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">×</button>
        </header>
        {loading ? <div className="usage-empty">正在读取底层 diagnostics…</div> : null}
        {error ? <div className="usage-error">{error}</div> : null}
        {!loading && !error && summary ? (
          <>
            <div className="usage-stat-grid">
              <UsageStat label="总 Token" value={formatNumber(summary.totalTokens)} />
              <UsageStat label="输入 Token" value={formatNumber(summary.promptTokens)} />
              <UsageStat label="输出 Token" value={formatNumber(summary.completionTokens)} />
              <UsageStat label="缓存命中率" value={summary.cacheHitRatio === null ? "暂无" : `${Math.round(summary.cacheHitRatio * 100)}%`} />
            </div>
            <div className="usage-cache-row">
              <span>缓存命中：{summary.cacheHitTokens === null ? "暂无" : formatNumber(summary.cacheHitTokens)}</span>
              <span>缓存未命中：{summary.cacheMissTokens === null ? "暂无" : formatNumber(summary.cacheMissTokens)}</span>
              <span>记录数：{summary.diagnosticsCount}</span>
            </div>
            {summary.diagnosticsWarnings.length > 0 ? (
              <div className="usage-empty">
                diagnostics warning：{summary.diagnosticsWarnings.join("、")}
              </div>
            ) : null}
            <section className="usage-recent">
              <h3>最近记录</h3>
              {summary.recent.length === 0 ? (
                <p>暂无 diagnostics 用量记录。流式生成工作稿时可能无法返回 provider usage。</p>
              ) : (
                <div className="usage-table">
                  {summary.recent.map((item, index) => (
                    <article key={`${item.stage}-${item.chapter ?? "n"}-${item.generatedAt ?? index}`}>
                      <strong>{stageLabel(item.stage)}{item.chapter ? ` · 第${item.chapter}章` : ""}</strong>
                      <span>{item.totalTokens === null ? "Token 暂无" : `${formatNumber(item.totalTokens)} tokens`}</span>
                      <small>{item.elapsedMs === null ? "耗时暂无" : `${Math.round(item.elapsedMs / 1000)} 秒`} · {formatDate(item.generatedAt)}</small>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </section>
    </div>
  );
}

function UsageStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="usage-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatDate(value: string | null): string {
  if (!value) return "时间暂无";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function stageLabel(stage: string): string {
  return stage === "fast-draft" ? "工作稿生成" : stage === "commit" ? "定稿" : stage;
}
