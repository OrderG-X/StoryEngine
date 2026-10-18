/**
 * 设置弹窗「高级」：直接改模型设置文件原文（重构 P6 第 6 步，原来只在书架那套旧设置里有）。
 * 密钥不在这份文件里（另存、读出来是打码的）；任务分配不经这里，保存时原样保留。
 */
import { useEffect, useState } from "react";
import { fetchModelSettings, saveModelSettings } from "../../../api/client.js";

export function RawSettingsSection() {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 不传 signal：读设置有并发去重，开发模式双挂载时第一次的取消会连带第二次（只丢结果，不掐请求）。
    let cancelled = false;
    fetchModelSettings()
      .then((result) => {
        if (cancelled) return;
        setSaved(result.rawText ?? "");
        setDraft(result.rawText ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  const dirty = saved !== null && draft !== saved;
  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveModelSettings(draft);
      setSaved(result.rawText ?? draft);
      setDraft(result.rawText ?? draft);
      setNotice("已保存并校验通过。");
    } catch (err) {
      setError(`没存上：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="msk-embedded ms-dialog se-raw-settings" role="region" aria-label="高级设置">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">高级</h2>
          <p className="ms-subtitle">直接改模型设置文件。密钥另存、这里看到的是打码的；任务分配保存时不动。</p>
        </div>
      </header>
      <div className="ms-body">
        {loadError ? <div className="ms-error">读不到设置文件：{loadError}</div> : null}
        {saved === null && !loadError ? <div className="ms-loading">正在读…</div> : null}
        {saved !== null ? (
          <>
            {notice ? <div className="ms-notice">{notice}</div> : null}
            {error ? <div className="ms-error">{error}</div> : null}
            <textarea
              className="ms-raw-json"
              value={draft}
              spellCheck={false}
              aria-label="model-settings.json 原文"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="se-raw-actions">
              <button className="ms-btn ms-btn-ghost" type="button" disabled={!dirty || saving} onClick={() => setDraft(saved)}>还原</button>
              <button className="ms-btn ms-btn-primary" type="button" disabled={!dirty || saving} onClick={() => { void save(); }}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
