import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "../ui/dialog";
import NewBookStarter from "../NewBookStarter.js";
import OpenBookDialog from "../OpenBookDialog.js";
import { useCursorSpotlight } from "../../hooks/useCursorSpotlight.js";
import { coverTiltTransform } from "../../hooks/coverTilt.js";
import { useMotionStore } from "../../stores/motionStore.js";
import type { BookSummary, HomePageProps } from "../../types.js";
import apocalypseCover from "../../assets/covers/apocalypse.png";
import fantasyCover from "../../assets/covers/fantasy.png";
import heroStudyCover from "../../assets/covers/hero-study.png";
import literaryCover from "../../assets/covers/literary.png";
import mysteryCover from "../../assets/covers/mystery.png";
import scifiCover from "../../assets/covers/scifi.png";
import urbanCover from "../../assets/covers/urban.png";
import xianxiaCover from "../../assets/covers/xianxia.png";

/** 首页书卡进度条：已写章数 / 当前章号（都是真实章数）。不写死目标章数——长篇没有「12 章就写完」这回事。 */
function bookProgress(book: BookSummary): number {
  return Math.min(100, Math.round((book.writtenChapters / Math.max(1, book.currentChapterNumber)) * 100));
}

export default function HomeLanding({
  recentBooks,
  onChooseFolder,
  onCreateBook,
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
  const [dialog, setDialog] = useState<"create" | "open" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<BookSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const homeRef = useRef<HTMLElement>(null);
  const reduceMotion = useMotionStore((s) => s.reduceMotion);
  useCursorSpotlight(homeRef, !reduceMotion);
  const lastBook = recentBooks[0];

  const showFeedback = (message: string) => setFeedbackMessage(message);
  const findBook = (bookId: string) => recentBooks.find((book) => book.id === bookId);
  const progress = lastBook ? bookProgress(lastBook) : 0;
  const closeDeleteDialog = () => {
    setDeleteTarget(null);
  };

  return (
    <main
      ref={homeRef}
      className={`se-v2-home${reduceMotion ? " is-reduced-motion" : ""}`}
      aria-label="StoryEngine 首页"
    >
      <header className="se-v2-home-header">
        <div aria-label="StoryEngine 品牌" className="se-v2-home-brand">
          <span>SE</span>
          <strong>StoryEngine</strong>
        </div>
        <button className="se-v2-home-settings" onClick={onOpenSettings} type="button">设置</button>
      </header>

      <section className="se-v2-home-main">
        <div className="se-v2-home-hero" aria-hidden="true">
          <img alt="" className="se-v2-home-hero-image" src={heroStudyCover} />
        </div>

        {lastBook ? (
          <button className="se-v2-continue-card" onClick={() => onOpenRecentBook(lastBook.id)} type="button">
            <span>继续上次写作</span>
            <strong>《{lastBook.title}》</strong>
            <small>第 {lastBook.currentChapterNumber} 章 · {lastBook.updatedAt}</small>
            <i><b style={{ width: `${progress}%` }} /></i>
          </button>
        ) : (
          <section className="se-v2-continue-card is-empty">
            <span>继续上次写作</span>
            <strong>还没有最近书籍</strong>
            <small>新建一本书，或打开已有 StoryEngine 项目。</small>
            <i><b style={{ width: "8%" }} /></i>
          </section>
        )}

        <div className="se-v2-home-actions">
          <button onClick={() => setDialog("create")} type="button">
            <span>+</span>
            <strong>新建书籍</strong>
          </button>
          <button onClick={() => setDialog("open")} type="button">
            <span>□</span>
            <strong>打开已有书籍</strong>
          </button>
        </div>

        <section aria-label="最近写作" className="se-v2-recent-section">
          <header>
            <span>最近写作</span>
            {feedbackMessage ? <small>{feedbackMessage}</small> : null}
          </header>
          {recentBooks.length === 0 ? (
            <div className="se-v2-recent-empty">
              <strong>还没有最近写作</strong>
              <p>可以新建一本书，或打开已有项目。</p>
            </div>
          ) : (
            <div className="se-v2-recent-grid">
              {recentBooks.map((book, index) => (
                <RecentBook
                  book={book}
                  index={index}
                  key={book.id}
                  onDelete={(bookId) => {
                    const bookToDelete = findBook(bookId);
                    if (!bookToDelete) return;
                    setDeleteTarget(bookToDelete);
                  }}
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
      </section>

      <NewBookStarter
        open={dialog === "create"}
        onCancel={() => setDialog(null)}
        onCreate={(draft) => {
          onCreateBook(draft);
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
              <DialogTitle>确认删除书籍？</DialogTitle>
              <DialogDescription>
                你正在删除《{deleteTarget.title}》。这会删除本地项目目录，操作不可恢复。
              </DialogDescription>
            </DialogHeader>
            <dl className="se-v2-delete-path">
              <dt>项目路径</dt>
              <dd>{deleteTarget.projectPath}</dd>
            </dl>
            <p className="se-v2-delete-hint">删除后会移出书架并删掉本地项目目录，无法恢复。</p>
            <DialogFooter>
              <button className="se-v2-dialog-cancel-btn" onClick={closeDeleteDialog} type="button">取消</button>
              <button
                className="se-v2-dialog-danger-btn"
                onClick={() => {
                  void onDeleteRecentBook(deleteTarget.id).then(showFeedback).catch((error: unknown) => showFeedback(error instanceof Error ? error.message : String(error)));
                  closeDeleteDialog();
                }}
                type="button"
              >
                永久删除
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
  index,
  onDelete,
  onOpen,
  onOpenFolder,
  onRemove,
  onRename,
}: {
  readonly book: BookSummary;
  readonly index: number;
  readonly onDelete: (bookId: string) => void;
  readonly onOpen: (bookId: string) => void;
  readonly onOpenFolder: (bookId: string) => void;
  readonly onRemove: (bookId: string) => void;
  readonly onRename: (bookId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const progress = bookProgress(book);
  const coverRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLMenuElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useMotionStore((s) => s.reduceMotion);
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
  const onCoverMove = (event: React.MouseEvent) => {
    if (reduceMotion) return;
    const el = coverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.transform = coverTiltTransform(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
  };
  const onCoverLeave = () => {
    if (coverRef.current) coverRef.current.style.transform = "";
  };

  return (
    <article className="se-v2-recent-book">
      <button
        aria-label={`打开《${book.title}》`}
        className="se-v2-cover"
        onClick={() => onOpen(book.id)}
        onMouseLeave={onCoverLeave}
        onMouseMove={onCoverMove}
        ref={coverRef}
        type="button"
      >
        <img alt="" src={coverForGenre(book.genre)} />
      </button>
      <div className="se-v2-recent-info">
        <div>
          <h3>《{book.title}》</h3>
          <button aria-label="书籍管理" onClick={() => setMenuOpen((current) => !current)} ref={menuBtnRef} type="button">···</button>
        </div>
        <p>第 {book.currentChapterNumber} 章 · {book.updatedAt}</p>
        <i><b style={{ width: `${progress}%` }} /></i>
        {menuOpen ? (
          <menu className="se-v2-book-menu" ref={menuRef}>
            <button onClick={() => { setMenuOpen(false); onOpen(book.id); }} type="button">继续写作</button>
            <button onClick={() => { setMenuOpen(false); onRename(book.id); }} type="button">重命名</button>
            <button onClick={() => { setMenuOpen(false); onRemove(book.id); }} type="button">从最近写作移除</button>
            <button onClick={() => { setMenuOpen(false); onOpenFolder(book.id); }} type="button">打开所在文件夹</button>
            <button className="is-danger" onClick={() => { setMenuOpen(false); onDelete(book.id); }} type="button">删除书籍</button>
          </menu>
        ) : null}
      </div>
    </article>
  );
}

function coverForGenre(genre: string): string {
  const normalized = genre.toLowerCase();
  if (/末日|废土|灾变|survival|apocalypse/u.test(normalized)) return apocalypseCover;
  if (/民俗|克苏鲁|诡异|恐怖|惊悚|悬疑|mystery|horror/u.test(normalized)) return mysteryCover;
  if (/科幻|星港|太空|赛博|机甲|sci|cyber|space/u.test(normalized)) return scifiCover;
  if (/修仙|仙侠|玄幻|灵气|cultivation|xianxia/u.test(normalized)) return xianxiaCover;
  if (/都市|异能|英灵|创业|urban/u.test(normalized)) return urbanCover;
  if (/奇幻|魔法|fantasy/u.test(normalized)) return fantasyCover;
  return literaryCover;
}
