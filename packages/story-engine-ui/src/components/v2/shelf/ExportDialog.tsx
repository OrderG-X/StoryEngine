import { useEffect, useState } from "react";
import { exportBookFile, saveBlob, type ExportFormat } from "../../../api/shelfClient.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.js";

const FORMATS: readonly { readonly value: ExportFormat; readonly label: string; readonly hint: string }[] = [
  { value: "txt", label: "txt", hint: "纯文本，投稿、发平台用" },
  { value: "docx", label: "Word", hint: "能用 Word / WPS 打开改" },
  { value: "epub", label: "epub", hint: "电子书，手机阅读器能看" },
];

/**
 * 导出（P10）：格式、范围、导出。默认全部定稿章；可以圈「第 x 到第 y 章」，可以带上还没定稿的工作稿。
 */
export function ExportDialog({ book, onClose, api = { exportBookFile, saveBlob } }: {
  readonly book: { readonly title: string; readonly projectPath: string } | null;
  readonly onClose: () => void;
  readonly api?: { readonly exportBookFile: typeof exportBookFile; readonly saveBlob: typeof saveBlob };
}) {
  const [format, setFormat] = useState<ExportFormat>("txt");
  const [ranged, setRanged] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 换一本书 / 重新打开才清掉上次的结果（book 每次渲染都是新对象，不能拿它当依赖）。
  const bookPath = book?.projectPath;
  useEffect(() => {
    if (!bookPath) return;
    setMessage(null);
    setError(null);
    setBusy(false);
  }, [bookPath]);

  if (!book) return null;

  const fromN = Number(from);
  const toN = Number(to);
  const rangeValid = !ranged || (Number.isInteger(fromN) && fromN > 0 && Number.isInteger(toN) && toN >= fromN);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.exportBookFile({
        projectPath: book.projectPath,
        format,
        ...(ranged ? { from: fromN, to: toN } : {}),
        includeDrafts,
      });
      api.saveBlob(result.blob, result.filename);
      setMessage(`导出了 ${result.chapters} 章：${result.filename}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="se-export">
        <DialogHeader>
          <DialogTitle>导出《{book.title}》</DialogTitle>
          <DialogDescription>{FORMATS.find((item) => item.value === format)?.hint}</DialogDescription>
        </DialogHeader>

        <div className="se-export-formats" role="radiogroup" aria-label="格式">
          {FORMATS.map((item) => (
            <button
              aria-checked={format === item.value}
              className={format === item.value ? "is-on" : ""}
              disabled={busy}
              key={item.value}
              onClick={() => setFormat(item.value)}
              role="radio"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="se-export-range">
          <label>
            <input checked={!ranged} disabled={busy} name="export-range" onChange={() => setRanged(false)} type="radio" />
            全部
          </label>
          <label>
            <input checked={ranged} disabled={busy} name="export-range" onChange={() => setRanged(true)} type="radio" />
            第
            <input aria-label="从第几章" className="se-export-num" disabled={busy} inputMode="numeric" onChange={(event) => { setFrom(event.target.value); setRanged(true); }} value={from} />
            到
            <input aria-label="到第几章" className="se-export-num" disabled={busy} inputMode="numeric" onChange={(event) => { setTo(event.target.value); setRanged(true); }} value={to} />
            章
          </label>
          <label>
            <input checked={includeDrafts} disabled={busy} onChange={(event) => setIncludeDrafts(event.target.checked)} type="checkbox" />
            带上还没定稿的工作稿
          </label>
        </div>

        {message ? <p className="se-trash-note" role="status">{message}</p> : null}
        {error ? <p className="se-open-book-error" role="alert">{error}</p> : null}

        <DialogFooter>
          <button className="se-v2-dialog-cancel-btn" disabled={busy} onClick={onClose} type="button">关闭</button>
          <button className="se-v2-dialog-confirm-btn" disabled={busy || !rangeValid} onClick={() => void submit()} type="button">
            {busy ? "正在导出…" : "导出"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
