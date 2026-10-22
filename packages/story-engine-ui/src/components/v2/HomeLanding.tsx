import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "../ui/dialog";
import NewBookStarter from "../NewBookStarter.js";
import ImportBookDialog from "../ImportBookDialog.js";
import OpenBookDialog from "../OpenBookDialog.js";
import { useMotionStore } from "../../stores/motionStore.js";
import { coverTiltTransform } from "../../hooks/coverTilt.js";
import { useCursorSpotlight } from "../../hooks/useCursorSpotlight.js";
import type { BookSummary, HomePageProps } from "../../types.js";
import { ThemeToggleButton } from "./codex/ThemeToggleButton.js";
import { TrashDialog } from "./shelf/TrashDialog.js";
import { ExportDialog } from "./shelf/ExportDialog.js";
import { downloadBookBackup, fetchBookStats, fetchShelfMeta, fetchTrash, restoreBookBackup, saveBlob, setBookArchived, type ShelfBookMeta, type WordStats } from "../../api/shelfClient.js";
import { BookInfoDialog } from "./shelf/BookInfoDialog.js";
import { addReturnedBook, refreshBookLibrary } from "../../utils/refreshBookLibrary.js";
import { toneOf } from "../../lib/tone.js";
import { useNavigationStore } from "../../stores/navigationStore.js";
import { useActiveModel } from "./codex/useActiveModel.js";
import "./home.css";

const PLACEHOLDER_PROTAGONIST_NAMES = new Set(["主角", "未命名", "待定", "无"]);

/** 章名就是「第 N 章」本身时不再重复显示。 */
function isBareChapterLabel(title: string): boolean {
  // 不猜白名单：章节标题
  return /^第\s*[0-9一二三四五六七八九十百零两]+\s*章$/u.test(title.trim());
}

/** 纯中文短书名竖排（像书脊），夹英文/数字或太长的横排，避免竖排里字母横躺。 */
export function coverIsVertical(title: string): boolean {
  return /^[\u4e00-\u9fa5]{1,8}$/u.test(title);
}

function formatWords(totalWords: number): string {
  if (totalWords >= 10000) return `${(totalWords / 10000).toFixed(1)} 万字`;
  return `${totalWords.toLocaleString()} 字`;
}

function BookCover({ title, large = false, tone }: { readonly title: string; readonly large?: boolean; readonly tone?: number }) {
  return (
    <span className={`se-cover tone-${tone ?? toneOf(title)}${coverIsVertical(title) ? "" : " is-h"}${large ? " is-lg" : ""}`} aria-hidden="true">
      <span className="se-cover-t">{title}</span>
      {large ? <span className="se-cover-seal" /> : null}
    </span>
  );
}

type ShelfSort = "recent" | "title" | "words";
type BookAction = "open" | "info" | "rename" | "export" | "backup" | "archive" | "remove" | "folder" | "delete";

/** 找书：书名或标签包含关键词（不分大小写）。 */
export function matchesShelfQuery(book: BookSummary, meta: ShelfBookMeta | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return book.title.toLowerCase().includes(q) || (meta?.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
}

export function sortShelf(books: readonly BookSummary[], sort: ShelfSort): BookSummary[] {
  const list = [...books];
  if (sort === "title") return list.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  if (sort === "words") return list.sort((a, b) => b.totalWords - a.totalWords);
  return list;
}

/** 「今天 +1,200 字 · 连续 3 天 · 日更 1,200 / 4,000」。 */
export function todayLine(stats: WordStats, dailyGoal?: number): string {
  const net = stats.today.net;
  const parts = [net > 0 ? `今天 +${net.toLocaleString()} 字` : net < 0 ? `今天 −${(-net).toLocaleString()} 字` : "今天还没写"];
  if (stats.streak > 1) parts.push(`连续 ${stats.streak} 天`);
  if (dailyGoal) parts.push(`日更 ${Math.max(0, net).toLocaleString()} / ${dailyGoal.toLocaleString()}`);
  return parts.join(" · ");
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
  const [restoring, setRestoring] = useState(false);
  const [infoTarget, setInfoTarget] = useState<BookSummary | null>(null);
  const [meta, setMeta] = useState<Readonly<Record<string, ShelfBookMeta>>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ShelfSort>("recent");
  const [showArchived, setShowArchived] = useState(false);
  const [heroStats, setHeroStats] = useState<{ readonly stats: WordStats; readonly dailyGoal?: number } | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useMotionStore((s) => s.reduceMotion);
  // 书架背景跟手一团很淡的暖光；减少动效时熄掉。
  const homeRef = useRef<HTMLElement | null>(null);
  useCursorSpotlight(homeRef, !reduceMotion);
  const tilt = reduceMotion ? undefined : coverTiltHandlers;
  // 还没接上 AI（P11）：书架顶上说一句；设置弹窗关上后重读。
  const settingsOpen = useNavigationStore((s) => s.settingsOpen);
  const { setupStep } = useActiveModel(settingsOpen);
  const activeBooks = recentBooks.filter((book) => !meta[book.projectPath]?.archived);
  const archivedBooks = recentBooks.filter((book) => meta[book.projectPath]?.archived);
  const lastBook = activeBooks[0];
  const visibleBooks = sortShelf(activeBooks.filter((book) => matchesShelfQuery(book, meta[book.projectPath], query)), sort);
  // 搜的书在「已归档」里：空架子上提一句，别让人以为书没了。
  const archivedHits = query.trim() ? archivedBooks.filter((book) => matchesShelfQuery(book, meta[book.projectPath], query)).length : 0;

  // 书架上每本书的归档、标签、封面色（存在书自己的 project.json 里）。
  const pathsKey = recentBooks.map((book) => book.projectPath).join("\n");
  const refreshMeta = () => {
    fetchShelfMeta(recentBooks.map((book) => book.projectPath)).then(setMeta, () => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refreshMeta, [pathsKey]);

  // 「继续写」卡片上的今天写了多少。
  const heroPath = lastBook?.projectPath;
  useEffect(() => {
    setHeroStats(null);
    if (!heroPath) return undefined;
    let alive = true;
    fetchBookStats(heroPath).then((result) => { if (alive) setHeroStats(result); }, () => undefined);
    return () => { alive = false; };
  }, [heroPath]);

  // 每回到书架都重扫一次书库，归并进书架（服务端真值刷新已有条目 + 按活跃时间排序；别再逐本 upsertBook 头插——
  // 那会把服务端的「最近活跃降序」反转）。原来只在开机扫：写了几章回书架，章数、「上次写到」还停在开机那会儿（真机试写）。
  // 扫描失败不影响书架。
  useEffect(() => {
    void refreshBookLibrary().catch(() => undefined);
  }, []);

  const refreshTrashCount = () => {
    fetchTrash().then((trash) => setTrashCount(trash.items.length), () => undefined);
  };
  useEffect(refreshTrashCount, []);

  const showFeedback = (message: string) => setFeedbackMessage(message);
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const backupBook = async (book: BookSummary) => {
    showFeedback(`正在备份《${book.title}》…`);
    try {
      const backup = await downloadBookBackup(book.projectPath);
      const saved = await saveBlob(backup.blob, backup.filename);
      showFeedback(saved === "canceled"
        ? "取消了，没备份。"
        : saved === "saved"
          ? `《${book.title}》备份好了：${backup.filename}`
          : `《${book.title}》的备份交给浏览器下载了：${backup.filename}`);
    } catch (error) {
      showFeedback(`没备份成：${errorText(error)}`);
    }
  };

  const toggleArchived = async (book: BookSummary) => {
    const archived = meta[book.projectPath]?.archived === true;
    try {
      await setBookArchived(book.projectPath, !archived);
      setMeta((current) => ({ ...current, [book.projectPath]: { ...current[book.projectPath], archived: !archived } }));
      showFeedback(archived ? `《${book.title}》回到书架了。` : `《${book.title}》收进了底部的「已归档」。`);
    } catch (error) {
      showFeedback(`没改成：${errorText(error)}`);
    }
  };

  const onBookAction = (action: BookAction, book: BookSummary) => {
    switch (action) {
      case "open": onOpenRecentBook(book.id); return;
      case "info": setInfoTarget(book); return;
      case "rename": setRenameTarget(book); setRenameValue(book.title); return;
      case "export": setExportTarget(book); return;
      case "backup": void backupBook(book); return;
      case "archive": void toggleArchived(book); return;
      case "folder":
        void onOpenRecentBookFolder(book.id).then(showFeedback).catch((error: unknown) => showFeedback(errorText(error)));
        return;
      case "remove":
        if (!window.confirm(`从最近写作中移除《${book.title}》？不会删除本地项目文件。`)) return;
        void onRemoveRecentBook(book.id).then(showFeedback).catch((error: unknown) => showFeedback(errorText(error)));
        return;
      case "delete": setDeleteTarget(book); return;
    }
  };

  const restoreFrom = async (file: File | undefined) => {
    if (!file) return;
    setRestoring(true);
    showFeedback(`正在从「${file.name}」恢复…`);
    try {
      const restored = await restoreBookBackup(file);
      await addReturnedBook(restored.projectPath, restored.title);
      showFeedback(`《${restored.title}》恢复好了，在书架上。`);
    } catch (error) {
      showFeedback(errorText(error));
    } finally {
      setRestoring(false);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };
  const closeDeleteDialog = () => {
    setDeleteTarget(null);
  };

  return (
    <main
      ref={homeRef}
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
            {/* 空书架：三个按钮只在下面「从一本新书开始」里出一次（2026-10-22 好上手走查：首屏同一组按钮出了两遍、外加一段空态说明）。 */}
            {recentBooks.length > 0 ? (
              <div className="se-home-actions">
                <button className="se-btn ghost" onClick={() => setDialog("open")} title="打开别处的 StoryEngine 书（比如从别的电脑拷来的书文件夹）" type="button">打开书文件夹</button>
                <button className="se-btn ghost" onClick={() => setDialog("import")} title="把写好的 txt / md 拉进来，按章切开" type="button">导入已写的书</button>
                <button className="se-btn primary" onClick={() => setDialog("create")} type="button">新建一本书</button>
              </div>
            ) : null}
          </div>

          {setupStep ? (
            <div className="se-home-setup" role="note">
              {setupStep === "connect"
                ? <span><b>AI 还没接上。</b>自己写、导入、导出都能用；要 AI 帮你记账、核账，先接一家服务商。</span>
                : <span><b>还差一步：选个模型。</b>服务商接好了，在模型设置里点一个模型就能用。</span>}
              <button className="se-btn primary" onClick={onOpenSettings} type="button">{setupStep === "connect" ? "去接上" : "去选"}</button>
            </div>
          ) : null}

          {lastBook ? (
            <section className="se-hero" aria-label="继续上次写作">
              <button className="se-hero-cover" onClick={() => onOpenRecentBook(lastBook.id)} type="button" aria-label={`打开《${lastBook.title}》`} {...tilt}>
                <BookCover title={lastBook.title} large tone={meta[lastBook.projectPath]?.coverTone} />
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
                {heroStats ? <p className="se-hero-today">{todayLine(heroStats.stats, heroStats.dailyGoal)}</p> : null}
                <div className="se-hero-actions">
                  <button className="se-btn primary" onClick={() => onOpenRecentBook(lastBook.id)} type="button">继续写</button>
                </div>
              </div>
            </section>
          ) : (
            <section className="se-hero is-empty" aria-label="开始">
              <div className="se-hero-info">
                <h2>从一本新书开始</h2>
                <p className="se-hero-meta"><span>起个名字就能开写，AI 在旁边帮你记人物、记事、查前后对不对得上。已经写了一部分？点「导入已写的书」，把 txt 拉进来接着写。</span></p>
                <div className="se-hero-actions">
                  <button className="se-btn primary" onClick={() => setDialog("create")} type="button">新建一本书</button>
                  <button className="se-btn ghost" onClick={() => setDialog("import")} title="把写好的 txt / md 拉进来，按章切开" type="button">导入已写的书</button>
                  <button className="se-btn ghost" onClick={() => setDialog("open")} title="打开别处的 StoryEngine 书（比如从别的电脑拷来的书文件夹）" type="button">打开书文件夹</button>
                </div>
              </div>
            </section>
          )}

          {/* 一本书都没有：上面「从一本新书开始」已经说了怎么办，这里不再放一块空的「全部书」；只在有提示（如刚删了最后一本）时出。 */}
          {recentBooks.length > 0 || feedbackMessage ? (
          <section aria-label="最近写作" className="se-shelf-section">
            <header>
              <h2>全部书</h2>
              {feedbackMessage ? <small role="status">{feedbackMessage}</small> : null}
              {activeBooks.length > 1 || query ? (
                <div className="se-shelf-tools">
                  <input aria-label="找书" className="se-shelf-search" onChange={(event) => setQuery(event.target.value)} placeholder="找书：书名、标签" type="search" value={query} />
                  <select aria-label="排序" className="se-shelf-sort" onChange={(event) => setSort(event.target.value as ShelfSort)} value={sort}>
                    <option value="recent">最近写的</option>
                    <option value="title">书名</option>
                    <option value="words">字数</option>
                  </select>
                </div>
              ) : null}
            </header>
            {recentBooks.length === 0 ? null : visibleBooks.length === 0 ? (
              <div className="se-shelf-empty">
                <p>{query ? `没找到「${query.trim()}」。${archivedHits > 0 ? `已归档里有 ${archivedHits} 本。` : ""}` : "书都归档了。"}</p>
              </div>
            ) : (
              <div className="se-shelf-grid">
                {visibleBooks.map((book, index) => (
                  <RecentBook book={book} index={index} key={book.id} meta={meta[book.projectPath]} onAction={(action) => onBookAction(action, book)} {...(tilt ? { tilt } : {})} />
                ))}
              </div>
            )}
          </section>
          ) : null}

          {archivedBooks.length > 0 ? (
            <section aria-label="已归档" className="se-shelf-section is-archived">
              <button aria-expanded={showArchived} className="se-shelf-link" onClick={() => setShowArchived((current) => !current)} type="button">
                已归档（{archivedBooks.length}）{showArchived ? "▴" : "▾"}
              </button>
              {showArchived ? (
                <div className="se-shelf-grid">
                  {archivedBooks.map((book, index) => (
                    <RecentBook book={book} index={index} key={book.id} meta={meta[book.projectPath]} onAction={(action) => onBookAction(action, book)} {...(tilt ? { tilt } : {})} />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <footer className="se-shelf-foot">
            <input
              accept=".zip,application/zip"
              aria-label="选备份文件"
              className="se-shelf-file"
              onChange={(event) => void restoreFrom(event.target.files?.[0])}
              ref={restoreInputRef}
              type="file"
            />
            <button className="se-shelf-link" disabled={restoring} onClick={() => restoreInputRef.current?.click()} type="button">
              {restoring ? "正在恢复…" : "从备份恢复"}
            </button>
            <button className="se-shelf-link" onClick={() => setTrashOpen(true)} type="button">
              回收站{trashCount > 0 ? `（${trashCount}）` : ""}
            </button>
          </footer>
        </div>
      </div>

      <ExportDialog book={exportTarget} onClose={() => setExportTarget(null)} />
      <BookInfoDialog book={infoTarget} onClose={() => setInfoTarget(null)} onSaved={refreshMeta} />

      <TrashDialog
        open={trashOpen}
        onChanged={setTrashCount}
        onClose={() => setTrashOpen(false)}
        onRestored={async (projectPath, title) => {
          await addReturnedBook(projectPath, title);
          showFeedback(`《${title}》回到书架了。`);
        }}
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

/** 封面跟手微倾（只认鼠标；触屏、减少动效不倾）。直接写封面的 style，不走 React 状态。 */
const coverTiltHandlers = {
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    const cover = event.currentTarget.querySelector<HTMLElement>(".se-cover");
    if (!cover) return;
    const rect = cover.getBoundingClientRect();
    cover.style.transform = coverTiltTransform(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      { maxDeg: 5, lift: 3, scale: 1.02 },
    );
  },
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
    const cover = event.currentTarget.querySelector<HTMLElement>(".se-cover");
    if (cover) cover.style.transform = "";
  },
};

function RecentBook({
  book,
  index,
  meta,
  onAction,
  tilt,
}: {
  readonly book: BookSummary;
  /** 第几本：进书架时错峰浮入（前 12 本错开，后面的一起进）。 */
  readonly index: number;
  readonly meta?: ShelfBookMeta;
  readonly onAction: (action: BookAction) => void;
  readonly tilt?: typeof coverTiltHandlers;
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

  // 底下放不下、上面放得下就往上开：窗口矮、书在最后一排时，后几项（归档、删除）不伸到窗口外面去。
  const [menuUp, setMenuUp] = useState(false);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = menuBtnRef.current;
    if (!menuOpen || !menu || !button) return;
    const need = menu.offsetHeight + 8;
    const rect = button.getBoundingClientRect();
    setMenuUp(window.innerHeight - rect.bottom < need && rect.top >= need);
  }, [menuOpen]);

  const act = (action: BookAction) => {
    setMenuOpen(false);
    onAction(action);
  };

  return (
    <article className="se-book" style={{ "--i": Math.min(index, 12) } as CSSProperties}>
      <button aria-label={`打开《${book.title}》`} className="se-book-open" onClick={() => onAction("open")} title={book.title} type="button" {...tilt}>
        <BookCover title={book.title} tone={meta?.coverTone} />
      </button>
      <div className="se-book-info">
        <div className="se-book-row">
          <h3 title={book.title}>{book.title}</h3>
          <button aria-expanded={menuOpen} aria-label="书籍管理" className="se-book-more" onClick={() => setMenuOpen((current) => !current)} ref={menuBtnRef} type="button">···</button>
        </div>
        <p>{book.writtenChapters} 章 · {book.updatedAt}</p>
        {menuOpen ? (
          <menu className={`se-book-menu${menuUp ? " is-up" : ""}`} ref={menuRef}>
            <button onClick={() => act("open")} type="button">继续写作</button>
            <button onClick={() => act("info")} type="button">书的资料</button>
            <button onClick={() => act("rename")} type="button">重命名</button>
            <button onClick={() => act("export")} type="button">导出</button>
            <button onClick={() => act("backup")} type="button">备份</button>
            <button onClick={() => act("archive")} type="button">{meta?.archived ? "取消归档" : "归档"}</button>
            <button onClick={() => act("remove")} type="button">从最近写作移除</button>
            <button onClick={() => act("folder")} type="button">打开所在文件夹</button>
            <button className="is-danger" onClick={() => act("delete")} type="button">删除书籍</button>
          </menu>
        ) : null}
      </div>
    </article>
  );
}
