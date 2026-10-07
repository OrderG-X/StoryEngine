import { useEffect, useState } from "react";
import type { OpenBookDialogProps } from "../types.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

/**
 * 「打开已有书籍」：选一本最近打开过的书，或指定书所在的文件夹。
 * 2026-10-07 改用与「新建书籍」同一套弹窗（portal 居中、token 配色）——旧版是手写 fixed 层，
 * 在书架里会偏到右上角，按钮还是早期的青色。
 */
export default function OpenBookDialog({
  open,
  recentBooks,
  error,
  loading,
  onChooseFolder,
  onCancel,
  onOpenProject,
}: OpenBookDialogProps) {
  const [projectPath, setProjectPath] = useState(recentBooks[0]?.projectPath ?? "");

  // 每次打开都从最近一本起选（关掉再开不残留上回手输的半截路径）。
  useEffect(() => {
    if (open) setProjectPath(recentBooks[0]?.projectPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const trimmed = projectPath.trim();
  const submit = () => {
    if (!trimmed || loading) return;
    onOpenProject(trimmed);
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="se-open-book">
        <DialogHeader>
          <DialogTitle>打开已有书籍</DialogTitle>
          <DialogDescription>选一本最近打开过的书，或者指定书所在的文件夹。只读取，不改动任何文件。</DialogDescription>
        </DialogHeader>

        {recentBooks.length > 0 ? (
          <div className="se-open-book-list" role="listbox" aria-label="最近打开过的书">
            {recentBooks.map((book) => {
              const selected = book.projectPath === projectPath;
              return (
                <button
                  key={book.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? "on" : ""}
                  onClick={() => setProjectPath(book.projectPath)}
                  onDoubleClick={() => { if (!loading) onOpenProject(book.projectPath); }}
                >
                  <strong>{book.title}</strong>
                  <small>{book.projectPath}</small>
                </button>
              );
            })}
          </div>
        ) : null}

        <label className="se-v2-new-book-label" htmlFor="open-book-path">书的文件夹</label>
        <div className="se-open-book-path">
          <input
            id="open-book-path"
            className="se-v2-rename-input"
            onChange={(event) => setProjectPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") submit();
            }}
            placeholder="/路径/到/书的文件夹"
            value={projectPath}
          />
          <button className="se-v2-dialog-cancel-btn" onClick={onChooseFolder} type="button">选择文件夹…</button>
        </div>
        {error ? <p className="se-open-book-error" role="alert">{error}</p> : null}

        <DialogFooter>
          <button className="se-v2-dialog-cancel-btn" onClick={onCancel} type="button">取消</button>
          <button className="se-v2-dialog-confirm-btn" disabled={loading || !trimmed} onClick={submit} type="button">
            {loading ? "正在打开…" : "打开"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
