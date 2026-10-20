import { useEffect, useState } from "react";
import { fetchBookInfo, saveBookInfo, type BookInfo, type BookInfoView } from "../../../api/shelfClient.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.js";
import { TONES } from "../../../lib/tone.js";

const MAX_TAGS = 12;

function formatWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n.toLocaleString()} 字`;
}

/** 输入框里的数字：空 = 不设；只认正整数。 */
function parseCount(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 书的资料（P10）：笔名、简介、标签、目标字数、日更目标、封面色；下面是写作统计和近 30 天小柱图。
 * 导出时书名页用笔名、简介。
 */
export function BookInfoDialog({ book, onClose, onSaved, api = { fetchBookInfo, saveBookInfo } }: {
  readonly book: { readonly title: string; readonly projectPath: string } | null;
  readonly onClose: () => void;
  /** 存好了（书架跟着刷封面色、标签）。 */
  readonly onSaved?: (info: BookInfo) => void;
  readonly api?: { readonly fetchBookInfo: typeof fetchBookInfo; readonly saveBookInfo: typeof saveBookInfo };
}) {
  const [view, setView] = useState<BookInfoView | null>(null);
  const [author, setAuthor] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [tags, setTags] = useState<readonly string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [target, setTarget] = useState("");
  const [daily, setDaily] = useState("");
  const [tone, setTone] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bookPath = book?.projectPath;
  useEffect(() => {
    if (!bookPath) return;
    let alive = true;
    setView(null);
    setError(null);
    setMessage(null);
    api.fetchBookInfo(bookPath).then(
      (next) => {
        if (!alive) return;
        setView(next);
        setAuthor(next.info.author ?? "");
        setSynopsis(next.info.synopsis ?? "");
        setTags(next.info.tags ?? []);
        setTagDraft("");
        setTarget(next.info.targetWords ? String(next.info.targetWords) : "");
        setDaily(next.info.dailyGoal ? String(next.info.dailyGoal) : "");
        setTone(next.info.coverTone);
      },
      (caught: unknown) => { if (alive) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookPath]);

  if (!book) return null;

  const targetN = parseCount(target);
  const dailyN = parseCount(daily);
  const valid = targetN !== null && dailyN !== null;

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    if (!tags.includes(tag) && tags.length < MAX_TAGS) setTags([...tags, tag]);
    setTagDraft("");
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    // 输入框里还有没回车的标签也算上。
    const pending = tagDraft.trim();
    const allTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    const info: BookInfo = {
      ...(author.trim() ? { author: author.trim() } : {}),
      ...(synopsis.trim() ? { synopsis: synopsis.trim() } : {}),
      ...(allTags.length > 0 ? { tags: allTags } : {}),
      ...(targetN ? { targetWords: targetN } : {}),
      ...(dailyN ? { dailyGoal: dailyN } : {}),
      ...(tone !== undefined ? { coverTone: tone } : {}),
    };
    try {
      const saved = await api.saveBookInfo(book.projectPath, info);
      setTags(saved.info.tags ?? []);
      setTagDraft("");
      setMessage("存好了。");
      onSaved?.(saved.info);
    } catch (caught) {
      setError(`没存上：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  const stats = view?.stats;
  const peak = Math.max(1, ...(stats?.recent.map((day) => day.net) ?? [1]));

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="se-book-info">
        <DialogHeader>
          <DialogTitle>《{book.title}》的资料</DialogTitle>
        </DialogHeader>

        {view === null && !error ? <p className="se-trash-empty" role="status">正在读…</p> : null}
        {view ? (
          <>
            {stats ? (
              <section className="se-info-stats" aria-label="写作统计">
                <div className="se-info-nums">
                  <span><b>{formatWords(stats.totalWords)}</b>全书</span>
                  <span><b>{stats.today.net > 0 ? `+${stats.today.net}` : stats.today.net}</b>今天</span>
                  <span><b>{stats.streak}</b>连续天数</span>
                  {stats.today.ai > 0 ? <span><b>{stats.today.ai}</b>今天 AI 写的</span> : null}
                </div>
                <div className="se-info-bars" aria-label="近 30 天每天净增字数">
                  {stats.recent.map((day) => (
                    <i key={day.date} style={{ height: `${Math.max(2, Math.round((Math.max(0, day.net) / peak) * 100))}%` }} title={`${day.date}：${day.net} 字`} className={day.net > 0 ? "is-on" : ""} />
                  ))}
                </div>
              </section>
            ) : null}

            <div className="se-info-form">
              <label className="se-info-field">
                <span>笔名</span>
                <input className="se-v2-rename-input" disabled={busy} maxLength={40} onChange={(event) => setAuthor(event.target.value)} placeholder="导出时印在书名下面" value={author} />
              </label>
              <label className="se-info-field">
                <span>简介</span>
                <textarea className="se-v2-rename-input se-info-synopsis" disabled={busy} maxLength={2000} onChange={(event) => setSynopsis(event.target.value)} rows={3} value={synopsis} />
              </label>
              <div className="se-info-field">
                <span>标签</span>
                <div className="se-info-tags">
                  {tags.map((tag) => (
                    <button aria-label={`去掉标签 ${tag}`} className="se-info-tag" disabled={busy} key={tag} onClick={() => setTags(tags.filter((item) => item !== tag))} type="button">
                      {tag} ×
                    </button>
                  ))}
                  {tags.length < MAX_TAGS ? (
                    <input
                      aria-label="加标签"
                      className="se-info-tag-input"
                      disabled={busy}
                      maxLength={12}
                      onChange={(event) => setTagDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addTag(); } }}
                      placeholder="回车加一个"
                      value={tagDraft}
                    />
                  ) : null}
                </div>
              </div>
              <div className="se-info-row">
                <label className="se-info-field">
                  <span>目标字数</span>
                  <input className="se-v2-rename-input" disabled={busy} inputMode="numeric" onChange={(event) => setTarget(event.target.value)} placeholder="比如 300000" value={target} />
                </label>
                <label className="se-info-field">
                  <span>日更目标</span>
                  <input className="se-v2-rename-input" disabled={busy} inputMode="numeric" onChange={(event) => setDaily(event.target.value)} placeholder="比如 4000" value={daily} />
                </label>
              </div>
              <div className="se-info-field">
                <span>封面色</span>
                <div className="se-info-tones" role="radiogroup" aria-label="封面色">
                  <button aria-checked={tone === undefined} aria-label="自动" className={`se-info-tone is-auto${tone === undefined ? " is-on" : ""}`} disabled={busy} onClick={() => setTone(undefined)} role="radio" type="button">自动</button>
                  {Array.from({ length: TONES }, (_, index) => (
                    <button aria-checked={tone === index} aria-label={`封面色 ${index + 1}`} className={`se-info-tone tone-${index}${tone === index ? " is-on" : ""}`} disabled={busy} key={index} onClick={() => setTone(index)} role="radio" type="button" />
                  ))}
                </div>
              </div>
              {!valid ? <p className="se-open-book-error" role="alert">字数要填正整数。</p> : null}
            </div>
          </>
        ) : null}

        {message ? <p className="se-trash-note" role="status">{message}</p> : null}
        {error ? <p className="se-open-book-error" role="alert">{error}</p> : null}

        <DialogFooter>
          <button className="se-v2-dialog-cancel-btn" disabled={busy} onClick={onClose} type="button">关闭</button>
          <button className="se-v2-dialog-confirm-btn" disabled={busy || view === null || !valid} onClick={() => void save()} type="button">
            {busy ? "正在存…" : "存"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
