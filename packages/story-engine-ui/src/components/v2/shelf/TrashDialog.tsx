import { useEffect, useState } from "react";
import { fetchTrash, purgeTrashItem, restoreTrashItem, type TrashItem } from "../../../api/shelfClient.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog.js";

/**
 * 回收站（P10）：删掉的书在这里留 30 天。恢复挪回原处；彻底删除要再点一次确认。
 */
export function TrashDialog({ open, onClose, onRestored, onChanged, api = { fetchTrash, restoreTrashItem, purgeTrashItem } }: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 一本书回来了：书架要把它加回去。 */
  readonly onRestored: (projectPath: string, title: string) => Promise<void> | void;
  /** 回收站里的书数变了（书架底部的数字跟着变）。 */
  readonly onChanged?: (count: number) => void;
  readonly api?: {
    readonly fetchTrash: typeof fetchTrash;
    readonly restoreTrashItem: typeof restoreTrashItem;
    readonly purgeTrashItem: typeof purgeTrashItem;
  };
}) {
  const [items, setItems] = useState<readonly TrashItem[] | null>(null);
  const [keepDays, setKeepDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setItems(null);
    setError(null);
    setMessage(null);
    setArmed(null);
    api.fetchTrash().then(
      (result) => { if (alive) { setItems(result.items); setKeepDays(result.keepDays); onChanged?.(result.items.length); } },
      (caught: unknown) => { if (alive) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const drop = (id: string) => {
    const next = (items ?? []).filter((item) => item.id !== id);
    setItems(next);
    onChanged?.(next.length);
  };

  const restore = async (item: TrashItem) => {
    setBusy(item.id);
    setError(null);
    try {
      const restored = await api.restoreTrashItem(item.id);
      drop(item.id);
      await onRestored(restored.projectPath, restored.title);
      setMessage(`《${restored.title}》回到书架了。`);
    } catch (caught) {
      setError(`没恢复成：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const purge = async (item: TrashItem) => {
    setBusy(item.id);
    setError(null);
    try {
      await api.purgeTrashItem(item.id);
      drop(item.id);
      setArmed(null);
      setMessage(`《${item.title}》已彻底删除。`);
    } catch (caught) {
      setError(`没删成：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="se-trash">
        <DialogHeader>
          <DialogTitle>回收站</DialogTitle>
          <DialogDescription>删掉的书在这里留 {keepDays} 天，之后才真删。</DialogDescription>
        </DialogHeader>
        {items === null && !error ? <p className="se-trash-empty" role="status">正在读…</p> : null}
        {items && items.length === 0 ? <p className="se-trash-empty">回收站是空的。</p> : null}
        {items && items.length > 0 ? (
          <ul className="se-trash-list" aria-label="回收站里的书">
            {items.map((item) => (
              <li key={item.id}>
                <div className="se-trash-info">
                  <strong title={item.title}>{item.title}</strong>
                  <small>{formatDeletedAt(item.deletedAt)}删 · 还剩 {item.daysLeft} 天</small>
                </div>
                {armed === item.id ? (
                  <div className="se-trash-actions is-armed">
                    <span>删了就找不回来</span>
                    <button className="se-v2-dialog-cancel-btn" disabled={busy !== null} onClick={() => setArmed(null)} type="button">算了</button>
                    <button className="se-v2-dialog-danger-btn" disabled={busy !== null} onClick={() => void purge(item)} type="button">彻底删除</button>
                  </div>
                ) : (
                  <div className="se-trash-actions">
                    <button className="se-v2-dialog-confirm-btn" disabled={busy !== null} onClick={() => void restore(item)} type="button">
                      {busy === item.id ? "正在恢复…" : "恢复"}
                    </button>
                    <button className="se-trash-purge" disabled={busy !== null} onClick={() => setArmed(item.id)} type="button">彻底删除</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {message ? <p className="se-trash-note" role="status">{message}</p> : null}
        {error ? <p className="se-open-book-error" role="alert">{error}</p> : null}
        <DialogFooter>
          <button className="se-v2-dialog-cancel-btn" disabled={busy !== null} onClick={onClose} type="button">关闭</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 「今天」「昨天」「3 天前」「10 月 2 日」。 */
export function formatDeletedAt(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return `${at.getMonth() + 1} 月 ${at.getDate()} 日`;
}
