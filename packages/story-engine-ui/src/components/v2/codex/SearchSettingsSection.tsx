import { useEffect, useState } from "react";
import {
  fetchSearchSettings,
  saveSearchSettings,
  testSearchSettings,
  type SearchProviderIdView,
  type SearchSettingsView,
} from "../../../api/searchSettingsClient.js";

/**
 * 设置 · 联网搜索（P11）：选一家搜索服务、填自己的密钥，AI 才能查真实资料。
 * 不开也不影响写；密钥只往上存，界面拿不到原文。
 */
export function SearchSettingsSection({ api = { fetchSearchSettings, saveSearchSettings, testSearchSettings } }: {
  readonly api?: {
    readonly fetchSearchSettings: typeof fetchSearchSettings;
    readonly saveSearchSettings: typeof saveSearchSettings;
    readonly testSearchSettings: typeof testSearchSettings;
  };
}) {
  const [view, setView] = useState<SearchSettingsView | null>(null);
  const [choice, setChoice] = useState<SearchProviderIdView | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ readonly works: boolean; readonly text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api.fetchSearchSettings().then(
      (next) => { if (alive) { setView(next); setChoice(next.provider); } },
      (caught: unknown) => { if (alive) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    if (!choice) return;
    const next = await api.saveSearchSettings({ provider: choice, ...(key.trim() ? { apiKey: key.trim() } : {}) });
    setView(next);
    setKey("");
    setStatus(null);
  });

  const turnOff = () => run(async () => {
    const next = await api.saveSearchSettings({ provider: null });
    setView(next);
    setChoice(null);
    setKey("");
    setStatus(null);
  });

  const test = () => run(async () => {
    const out = await api.testSearchSettings();
    setStatus({ works: out.works, text: out.summary });
  });

  const saved = view?.provider ?? null;
  const picked = view?.providers.find((provider) => provider.id === choice) ?? null;
  const keepsKey = Boolean(view?.hasKey && saved === choice);
  const dirty = choice !== saved || Boolean(key.trim());

  return (
    <section className="msk-embedded ms-dialog se-search-settings" role="region" aria-label="联网搜索设置">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">联网搜索</h2>
          <p className="ms-subtitle">让 AI 查真实资料（历史、地理、行业细节）。密钥要你自己去搜索服务那里申请；不开也不影响写。</p>
        </div>
      </header>
      <div className="ms-body">
        {error ? <div className="ms-error" role="alert">{error}</div> : null}
        {view === null && !error ? <div className="ms-loading">正在读…</div> : null}
        {view ? (
          <div className="ms-display-list">
            <div className="ms-display-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">搜索服务</span>
                <span className="ms-display-hint">{saved ? `在用：${view.providers.find((p) => p.id === saved)?.label ?? saved}` : "没开"}</span>
              </div>
              <div className="ms-display-control ms-theme-seg" role="group" aria-label="搜索服务">
                {view.providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`ms-display-btn${choice === provider.id ? " is-on" : ""}`}
                    aria-pressed={choice === provider.id}
                    disabled={busy}
                    onClick={() => { setChoice(provider.id); setKey(""); setStatus(null); }}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
            </div>

            {picked ? (
              <div className="se-backup-edit">
                <input
                  aria-label={`${picked.label}的密钥`}
                  className="se-backup-input"
                  disabled={busy}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={keepsKey ? "已填过（不换就留空）" : `粘贴${picked.label}的密钥`}
                  spellCheck={false}
                  type="password"
                  autoComplete="off"
                  value={key}
                />
                <p className="ms-display-hint">
                  没有密钥？去 <a href={picked.site} target="_blank" rel="noreferrer">{picked.site.replace(/^https:\/\//u, "")}</a> 注册申请。
                </p>
                <div className="se-backup-edit-actions">
                  {saved ? <button type="button" className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => void turnOff()}>关掉</button> : null}
                  {saved && !dirty ? <button type="button" className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => void test()}>试一下</button> : null}
                  <button type="button" className="ms-btn ms-btn-primary" disabled={busy || !dirty || (!keepsKey && !key.trim())} onClick={() => void save()}>存</button>
                </div>
              </div>
            ) : null}

            {status ? (
              <p className={`se-backup-last${status.works ? "" : " is-bad"}`} role="status">{status.text}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
