import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "../ui/dialog";
import NewBookStarter from "../NewBookStarter.js";
import ImportBookDialog from "../ImportBookDialog.js";
import OpenBookDialog from "../OpenBookDialog.js";
import { useMotionStore } from "../../stores/motionStore.js";
import type { BookSummary, HomePageProps } from "../../types.js";
import { ThemeToggleButton } from "./codex/ThemeToggleButton.js";
import { TrashDialog } from "./shelf/TrashDialog.js";
import { ExportDialog } from "./shelf/ExportDialog.js";
import { fetchTrash } from "../../api/shelfClient.js";
import { addReturnedBook } from "../../utils/refreshBookLibrary.js";
import "./home.css";

const PLACEHOLDER_PROTAGONIST_NAMES = new Set(["主角", "未命名", "待定", "无"]);

/** 章名就是「第 N 章」本身时不再重复显示。 */
function isBareChapterLabel(title: string): boolean {
  // 不猜白名单：章节标题
  return /^第\s*[0-9一二三四五六七八九十百零两]+\s*章$/u.test(title.trim());
}

const COVER_TONES = 7;

/** 书名 → 稳定的封面色号（同一本书永远同色）。 */
export function coverTone(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i += 1) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return h % COVER_TONES;
}

/** 纯中文短书名竖排（像书脊），夹英文/数字或太长的横排，避免竖排里字母横躺。 */
export function coverIsVertical(title: string): boolean {
  return /^[\u4e00-\u9fa5]{1,8}$/u.test(title);
}

function formatWords(totalWords: number): string {
  if (totalWords >= 10000) return `${(totalWords / 10000).toFixed(1)} 万字`;
  return `${totalWords.toLocaleString()} 字`;
}

function BookCover({ title, large = false }: { readonly title: string; readonly large?: boolean }) {
  return (
    <span className={`se-cover tone-${coverTone(title)}${coverIsVertical(title) ? "" : " is-h"}${large ? " is-lg" : ""}`} aria-hidden="true">
      <span className="se-cover-t">{title}</span>
      {large ? <span className="se-cover-seal" /> : null}
    </span>
  );
}

export default function HomeLanding({
  recentBooks,
  onChooseFolder,
  onCreateBook,
  onImportBook,
  onOpenSettings,
  openProjectError,
  openProjectLoading,
  onOpenProject,
  onOpenRecentBook,
  onRenameRecentBook,
  onRemoveRecentBook,
  onDeleteRecentBook,
  onOpenRecentBookFolder,
}: HomePageProps) {
  const [dialog, setDialog] = useState<"create" | "open" | "import" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<BookSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  const [exportTarget, setExportTarget] = useState<BookSummary | null>(null);
  const reduceMotion = useMotionStore((s) => s.reduceMotion);
  const lastBook = recentBooks[0];

  const refreshTrashCount = () => {
    fetchTrash().then((trash) => setTrashCount(trash.items.length), () => undefined);
  };
  useEffect(refreshTrashCount, []);

  const showFeedback = (message: string) => setFeedbackMessage(message);
  const findBook = (bookId: string) => recentBooks.find((book) => book.id === bookId);
  const closeDeleteDialog = () => {
    setDeleteTarget(null);
  };

  return (
    <main
      className={`se-v2-home${reduceMotion ? " is-reduced-motion" : ""}`}
      aria-label="StoryEngine 首页"
    >
      <header className="se-home-top">
        <div aria-label="StoryEngine 品牌" className="se-home-brand">
          <span className="se-home-mark" aria-hidden="true">书</span>
          <strong>StoryEngine</strong>
        </div>
        <div className="se-home-top-r">
          <ThemeToggleButton className="se-home-icon" />
          <button className="se-home-settings" onClick={onOpenSettings} type="button">设置</button>
        </div>
      </header>

      <div className="se-home-scroll">
        <div className="se-home-inner">
          <div className="se-home-head">
            <div>
              <h1>书架</h1>
              <p>{recentBooks.length > 0 ? `${recentBooks.length} 本书` : "还没有书"}</p>
            </div>
            <div className="se-home-actions">
              <button className="se-btn ghost" onClick={() => setDialog("open")} type="button">打开已有书籍</button>
              <button className="se-btn ghost" onClick={() => setDialog("import")} type="button">导入已写的书</button>
              <button className="se-btn primary" onClick={() => setDialog("create")} type="button">新建一本书</button>
            </div>
          </div>

          {lastBook ? (
            <section className="se-hero" aria-label="继续上次写作">
              <button className="se-hero-cover" onClick={() => onOpenRecentBook(lastBook.id)} type="button" aria-label={`打开《${lastBook.title}》`}>
                <BookCover title={lastBook.title} large />
              </button>
              <div className="se-hero-info">
                <p className="se-eyebrow">继续写</p>
                <h2>{lastBook.title}</h2>
                <p className="se-hero-meta">
                  {lastBook.genre ? <span>{lastBook.genre}</span> : null}
                  <span>{lastBook.writtenChapters} 章</span>
                  <span>{formatWords(lastBook.totalWords)}</span>
                  {/* 主角还没起名时数据里是占位词「主角」，不显示「主角 主角」。 */}
                  {lastBook.protagonistName && !PLACEHOLDER_PROTAGONIST_NAMES.has(lastBook.protagonistName.trim()) ? <span>主角 {lastBook.protagonistName}</span> : null}
                </p>
                <div className="se-hero-last">
                  <span className="se-faint">上次写到</span>
                  <b>第 {lastBook.currentChapterNumber} 章{lastBook.currentChapterTitle && !isBareChapterLabel(lastBook.currentChapterTitle) ? ` · ${lastBook.currentChapterTitle}` : ""}</b>
                  {/* 章节状态只在写作台显示（P6 第 6 步）：书架上这里原来的「已定稿」药丸按「有没有定稿过的章」算，最新一章还是工作稿时也说已定稿。 */}
                  <span className="se-faint">· {lastBook.updatedAt}</span>
                </div>
                <div className="se-hero-actions">
                  <button className="se-btn primary" onClick={() => onOpenRecentBook(lastBook.id)} type="button">继续写</button>
                </div>
              </div>
            </section>
          ) : (
            <section className="se-hero is-empty" aria-label="开始">
              <div className="se-hero-info">
                <h2>从一本新书开始</h2>
                <p className="se-hero-meta"><span>起个名字、用一句话说说想写什么，AI 会帮你把开头的设定搭起来。也可以打开已有的 StoryEngine 项目。</span></p>
                <div className="se-hero-actions">
                  <button className="se-btn primary" onClick={() => setDialog("create")} type="button">新建一本书</button>
                  <button className="se-btn ghost" onClick={() => setDialog("import")} type="button">导入已写的书</button>
                  <button className="se-btn ghost" onClick={() => setDialog("open")} type="button">打开已有书籍</button>
                </div>
              </div>
            </section>
          )}

          <section aria-label="最近写作" className="se-shelf-section">
            <header>
              <h2>全部书</h2>
              {feedbackMessage ? <small role="status">{feedbackMessage}</small> : null}
            </header>
            {recentBooks.length === 0 ? (
              <div className="se-shelf-empty">
                <strong>还没有最近写作</strong>
                <p>可以新建一本书，或打开已有项目。</p>
              </div>
            ) : (
              <div className="se-shelf-grid">
                {recentBooks.map((book) => (
                  <RecentBook
                    book={book}
                    key={book.id}
                    onDelete={(bookId) => {
                      const bookToDelete = findBook(bookId);
                      if (!bookToDelete) return;
                      setDeleteTarget(bookToDelete);
                    }}
                    onExport={(bookId) => setExportTarget(findBook(bookId) ?? null)}
                    onOpen={onOpenRecentBook}
                    onOpenFolder={(bookId) => {
                      void onOpenRecentBookFolder(bookId).then(showFeedback).catch((error: unknown) => showFeedback(error instanceof Error ? error.message : String(error)));
                    }}
                    onRemove={(bookId) => {
                      const bookToRemove = findBook(bookId);
                      if (!bookToRemove) return;
                      if (!window.confirm(`从最近写作中移除《${bookToRemove.title}》？不会删除本地项目文件。`)) return;
                      void onRemoveRecentBook(bookId).then(showFeedback).catch((error: unknown) => showFeedback(error instanceof Error ? error.message : String(error)));
                    }}
                    onRename={(bookId) => {
                      const bookToRename = findBook(bookId);
                      if (!bookToRename) return;
                      setRenameTarget(bookToRename);
                      setRenameValue(bookToRename.title);
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          <footer className="se-shelf-foot">
            <button className="se-shelf-link" onClick={() => setTrashOpen(true)} type="button">
              回收站{trashCount > 0 ? `（${trashCount}）` : ""}
            </button>
          </footer>
        </div>
      </div>

      <ExportDialog book={exportTarget} onClose={() => setExportTarget(null)} />

      <TrashDialog
        open={trashOpen}
        onChanged={setTrashCount}
        onClose={() => setTrashOpen(false)}
        onRestored={(projectPath, title) => addReturnedBook(projectPath, title)}
      />

      <NewBookStarter
        open={dialog === "create"}
        onCancel={() => setDialog(null)}
        onCreate={(draft) => {
          onCreateBook(draft);
          setDialog(null);
        }}
      />
      <ImportBookDialog
        open={dialog === "import"}
        onCancel={() => setDialog(null)}
        onImport={async (input) => {
          await onImportBook(input);
          setDialog(null);
        }}
      />
      <OpenBookDialog
        error={openProjectError}
        loading={openProjectLoading}
        open={dialog === "open"}
        recentBooks={recentBooks}
        onChooseFolder={onChooseFolder}
        onCancel={() => setDialog(null)}
        onOpenProject={async (projectPath) => {
          const opened = await onOpenProject(projectPath);
          if (opened !== false) setDialog(null);
        }}
      />
      {renameTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重命名书籍</DialogTitle>
              <DialogDescription>
                《{renameTarget.title}》的新名称
              </DialogDescription>
            </DialogHeader>
            <input
              autoFocus
              className="se-v2-rename-input"
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && renameValue.trim() && renameValue.trim() !== renameTarget.title) {
                  void onRenameRecentBook(renameTarget.id, renameValue.trim()).then(showFeedback).catch((error: unknown) => showFeedback(error instanceof Error ? error.message : String(error)));
                  setRenameTarget(null);
                }
              }}
              value={renameValue}
            />
            <DialogFooter>
              <button className="se-v2-dialog-cancel-btn" onClick={() => setRenameTarget(null)} type="button">取消</button>
              <button
                className="se-v2-dialog-confirm-btn"
                disabled={!renameValue.trim() || renameValue.trim() === renameTarget.title}
                onClick={() => {
                  void onRenameRecentBook(renameTarget.id, renameValue.trim()).then(showFeedback).catch((error: unknown) => showFeedback(error instanceof Error ? error.message : String(error)));
                  setRenameTarget(null);
                }}
                type="button"
              >
                确认重命名
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {deleteTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open) closeDeleteDialog(); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>把《{deleteTarget.title}》移到回收站？</DialogTitle>
              <DialogDescription>
                30 天内可以在书架底部的「回收站」里恢复，过了 30 天才会真删。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button className="se-v2-dialog-cancel-btn" onClick={closeDeleteDialog} type="button">取消</button>
              <button
                className="se-v2-dialog-danger-btn"
                onClick={() => {
                  void onDeleteRecentBook(deleteTarget.id)
                    .then((message) => { showFeedback(message); refreshTrashCount(); })
                    .catch((error: unknown) => showFeedback(`没删成：${error instanceof Error ? error.message : String(error)}`));
                  closeDeleteDialog();
                }}
                type="button"
              >
                移到回收站
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}

function RecentBook({
  book,
  onDelete,
  onExport,
  onOpen,
  onOpenFolder,
  onRemove,
  onRename,
}: {
  readonly book: BookSummary;
  readonly onDelete: (bookId: string) => void;
  readonly onExport: (bookId: string) => void;
  readonly onOpen: (bookId: string) => void;
  readonly onOpenFolder: (bookId: string) => void;
  readonly onRemove: (bookId: string) => void;
  readonly onRename: (bookId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLMenuElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // 菜单收口：点菜单外/按 Esc 关闭。否则菜单(absolute z-index:60)会一直浮在卡上、
  // 盖住「···」按钮，导致改名等动作后再点菜单被拦截(真机 V6 回归根因)。
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <article className="se-book">
      <button aria-label={`打开《${book.title}》`} className="se-book-open" onClick={() => onOpen(book.id)} title={book.title} type="button">
        <BookCover title={book.title} />
      </button>
      <div className="se-book-info">
        <div className="se-book-row">
          <h3 title={book.title}>{book.title}</h3>
          <button aria-label="书籍管理" className="se-book-more" onClick={() => setMenuOpen((current) => !current)} ref={menuBtnRef} type="button">···</button>
        </div>
        <p>{book.writtenChapters} 章 · {book.updatedAt}</p>
        {menuOpen ? (
          <menu className="se-book-menu" ref={menuRef}>
            <button onClick={() => { setMenuOpen(false); onOpen(book.id); }} type="button">继续写作</button>
            <button onClick={() => { setMenuOpen(false); onRename(book.id); }} type="button">重命名</button>
            <button onClick={() => { setMenuOpen(false); onExport(book.id); }} type="button">导出</button>
            <button onClick={() => { setMenuOpen(false); onRemove(book.id); }} type="button">从最近写作移除</button>
            <button onClick={() => { setMenuOpen(false); onOpenFolder(book.id); }} type="button">打开所在文件夹</button>
            <button className="is-danger" onClick={() => { setMenuOpen(false); onDelete(book.id); }} type="button">删除书籍</button>
          </menu>
        ) : null}
      </div>
    </article>
  );
}
