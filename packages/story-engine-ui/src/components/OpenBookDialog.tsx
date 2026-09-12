import { useState } from "react";
import type { OpenBookDialogProps } from "../types.js";

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

  if (!open) return null;

  return (
    <div className="home-dialog-backdrop" role="presentation" onClick={onCancel}>
      <section aria-modal="true" className="home-dialog open-book-dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>打开已有书籍</h2>
            <p>读取本地 StoryEngine 项目的只读状态，不写入任何文件。</p>
          </div>
          <button aria-label="取消" onClick={onCancel} type="button">×</button>
        </header>
        <label>
          <span>项目路径</span>
          <input onChange={(event) => setProjectPath(event.target.value)} value={projectPath} />
        </label>
        <div className="open-book-actions">
          <button className="secondary" onClick={onChooseFolder} type="button">选择文件夹</button>
          <button disabled={loading || !projectPath.trim()} onClick={() => onOpenProject(projectPath)} type="button">
            {loading ? "正在读取…" : "打开项目"}
          </button>
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <section>
          <h3>最近路径</h3>
          <div className="recent-path-list">
            {recentBooks.map((book) => (
              <button key={book.id} onClick={() => setProjectPath(book.projectPath)} type="button">
                <strong>{book.title}</strong>
                <small>{book.projectPath}</small>
              </button>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
