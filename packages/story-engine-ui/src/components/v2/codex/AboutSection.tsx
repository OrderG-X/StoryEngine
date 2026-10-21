import { useEffect, useState } from "react";
import { fetchAbout, openAboutTarget, type AboutOpenTarget, type AboutView } from "../../../api/aboutClient.js";

const SOURCE_URL = "https://github.com/OrderG-X/StoryEngine";

/**
 * 设置 · 关于（P11）：版本、开源许可和源代码、第三方软件许可、日志和书库文件夹。
 */
export function AboutSection({ api = { fetchAbout, openAboutTarget } }: {
  readonly api?: { readonly fetchAbout: typeof fetchAbout; readonly openAboutTarget: typeof openAboutTarget };
}) {
  const [view, setView] = useState<AboutView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.fetchAbout().then(
      (next) => { if (alive) setView(next); },
      (caught: unknown) => { if (alive) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (what: AboutOpenTarget) => {
    setError(null);
    try {
      await api.openAboutTarget(what);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section className="msk-embedded ms-dialog se-about" role="region" aria-label="关于">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">关于</h2>
          <p className="ms-subtitle">{view ? `StoryEngine ${view.version ?? "开发版"}` : "StoryEngine"}</p>
        </div>
      </header>
      <div className="ms-body">
        {error ? <div className="ms-error" role="alert">{error}</div> : null}
        {view === null && !error ? <div className="ms-loading">正在读…</div> : null}
        {view ? (
          <div className="ms-display-list">
            <div className="ms-display-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">开源许可</span>
                <span className="ms-display-hint">本软件按 AGPL-3.0 开源</span>
              </div>
              <div className="ms-display-control">
                <a className="ms-display-btn" href={SOURCE_URL} target="_blank" rel="noreferrer">源代码</a>
              </div>
            </div>
            <div className="ms-display-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">第三方软件许可</span>
                <span className="ms-display-hint">{view.hasNotices ? "用到的开源软件和它们的许可原文" : "桌面包里才有"}</span>
              </div>
              <div className="ms-display-control">
                <button type="button" className="ms-display-btn" disabled={!view.hasNotices} onClick={() => void open("notices")}>打开</button>
              </div>
            </div>
            <div className="ms-display-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">日志</span>
                <span className="ms-display-hint">{view.hasLogs ? "出了问题，把里面的 main.log 发给我们" : "开发版不写日志文件"}</span>
              </div>
              <div className="ms-display-control">
                <button type="button" className="ms-display-btn" disabled={!view.hasLogs} onClick={() => void open("logs")}>打开文件夹</button>
              </div>
            </div>
            <div className="ms-display-row">
              <div className="ms-display-label-col">
                <span className="ms-display-name">书库</span>
                <span className="ms-display-hint">所有书都存在这个文件夹里</span>
              </div>
              <div className="ms-display-control">
                <button type="button" className="ms-display-btn" onClick={() => void open("books")}>打开文件夹</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
