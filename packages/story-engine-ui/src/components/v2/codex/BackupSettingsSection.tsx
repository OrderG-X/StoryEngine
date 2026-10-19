import { useEffect, useState } from "react";
import { fetchBackupSettings, openBackupFolder, saveBackupSettings, type BackupSettingsView } from "../../../api/shelfClient.js";

/**
 * 设置 · 备份（P10）：定稿后自动备份的开关、备份文件夹、上次结果。
 * 手动备份在书架书的菜单里，从备份恢复在书架底部。
 */
export function BackupSettingsSection({ api = { fetchBackupSettings, saveBackupSettings, openBackupFolder } }: {
  readonly api?: {
    readonly fetchBackupSettings: typeof fetchBackupSettings;
    readonly saveBackupSettings: typeof saveBackupSettings;
    readonly openBackupFolder: typeof openBackupFolder;
  };
}) {
  const [view, setView] = useState<BackupSettingsView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.fetchBackupSettings().then(
      (next) => { if (alive) setView(next); },
      (caught: unknown) => { if (alive) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: { readonly auto?: boolean; readonly dir?: string }) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api.saveBackupSettings(patch));
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    setError(null);
    try {
      await api.openBackupFolder();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section className="msk-embedded ms-dialog se-backup-settings" role="region" aria-label="备份设置">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">备份</h2>
          <p className="ms-subtitle">整本书打包，含存档历史和对话。坏盘、误删都能找回来。</p>
        </div>
      </header>
      <div className="ms-body">
        {error ? <div className="ms-error" role="alert">{error}</div> : null}
        {view === null && !error ? <div className="ms-loading">正在读…</div> : null}
        {view ? (
          <div className="ms-display-list">
            <div className="ms-display-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">定稿后自动备份</span>
                <span className="ms-display-hint">每本书留最近 {view.keep} 份</span>
              </div>
              <div className="ms-display-control ms-theme-seg" role="group" aria-label="定稿后自动备份">
                <button type="button" className={`ms-display-btn${view.auto ? " is-on" : ""}`} aria-pressed={view.auto} disabled={busy} onClick={() => { if (!view.auto) void save({ auto: true }); }}>开</button>
                <button type="button" className={`ms-display-btn${!view.auto ? " is-on" : ""}`} aria-pressed={!view.auto} disabled={busy} onClick={() => { if (view.auto) void save({ auto: false }); }}>关</button>
              </div>
            </div>

            <div className="ms-display-row se-backup-dir-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">备份文件夹</span>
                {editing === null ? <span className="ms-display-hint se-backup-path" title={view.dir}>{view.dir}</span> : null}
              </div>
              {editing === null ? (
                <div className="ms-display-control">
                  <button type="button" className="ms-display-btn" onClick={() => void openFolder()}>打开</button>
                  <button type="button" className="ms-display-btn" disabled={busy} onClick={() => setEditing(view.dir)}>换一个</button>
                </div>
              ) : null}
            </div>
            {editing !== null ? (
              <div className="se-backup-edit">
                <input
                  aria-label="备份文件夹路径"
                  className="se-backup-input"
                  disabled={busy}
                  onChange={(event) => setEditing(event.target.value)}
                  spellCheck={false}
                  value={editing}
                />
                <div className="se-backup-edit-actions">
                  {!view.isDefaultDir ? <button type="button" className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => void save({ dir: "" })}>用默认的</button> : null}
                  <button type="button" className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => setEditing(null)}>算了</button>
                  <button type="button" className="ms-btn ms-btn-primary" disabled={busy || !editing.trim()} onClick={() => void save({ dir: editing })}>存</button>
                </div>
              </div>
            ) : null}

            {view.last ? (
              <p className={`se-backup-last${view.last.ok ? "" : " is-bad"}`} role="status">
                {view.last.ok
                  ? `上次自动备份：《${view.last.title}》，${formatAt(view.last.at)}。`
                  : `上次自动备份没成功（《${view.last.title}》，${formatAt(view.last.at)}）：${view.last.error ?? "原因不明"}`}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function formatAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "时间不明";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
