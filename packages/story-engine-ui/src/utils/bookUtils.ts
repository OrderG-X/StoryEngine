import type { BookSummary, ChapterNavItem } from "../types.js";
import type { StateOverview } from "../api/types.js";
import { chapterBareTitle, isPlaceholderChapterTitle } from "../components/v2/v2Utils.js";
import { formatRelativeTimeMs } from "./textUtils.js";

const RECENT_BOOKS_STORAGE_KEY = "story-engine-ng.recent-books";

export function loadRecentBooks(): readonly BookSummary[] {
  try {
    const raw = window.localStorage.getItem(RECENT_BOOKS_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBookSummary);
  } catch {
    return [];
  }
}

export function saveRecentBooks(books: readonly BookSummary[]): void {
  window.localStorage.setItem(RECENT_BOOKS_STORAGE_KEY, JSON.stringify(books));
}

export function isBookSummary(value: unknown): value is BookSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<BookSummary>;
  return typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.genre === "string"
    && typeof item.currentChapterTitle === "string"
    && typeof item.currentChapterNumber === "number"
    && typeof item.protagonistName === "string"
    && typeof item.updatedAt === "string"
    && typeof item.logline === "string"
    && typeof item.writtenChapters === "number"
    && typeof item.totalWords === "number"
    && typeof item.projectPath === "string"
    && (item.status === "草稿中" || item.status === "待确认" || item.status === "可继续下一章");
}

/** 书架上「多久前写过」：按最后活跃的时刻现算（存下来的 updatedAt 是那一刻的「刚刚」，放久了就不对了）。 */
export function bookActiveLabel(book: BookSummary, nowMs: number = Date.now()): string {
  return book.lastActiveMs ? formatRelativeTimeMs(book.lastActiveMs, nowMs) : book.updatedAt;
}

export function isRealProjectBook(book: BookSummary): boolean {
  return Boolean(book.projectPath.trim()) && !book.projectPath.startsWith("/mock/");
}

export function bookSummaryFromOverview(overview: StateOverview, projectPath: string): BookSummary {
  const currentChapterNumber = overview.project.currentChapter ?? overview.timeline.recentEvents.at(-1)?.chapter ?? 1;
  // 只认这一章自己的事件：最新章还是工作稿时没有事件，别拿上一章的章名配这一章的章号（P11 桌面包走查）。
  const currentEvent = overview.timeline.recentEvents.find((event) => event.chapter === currentChapterNumber);
  const writtenChapters = Math.max(overview.project.currentChapter ?? overview.timeline.recentEvents.length, overview.timeline.recentEvents.length, 0);
  const projectTitle = overview.project.title || "未命名故事";
  return {
    id: stableBookId(projectPath),
    title: projectTitle,
    // 题材、主角、简介都是作者在设定本里写的；没写就空着，不拿占位顶（重构 P9）。
    genre: overview.project.genre,
    currentChapterTitle: titleFromEvent(currentEvent, currentChapterNumber),
    currentChapterNumber,
    protagonistName: overview.characters.protagonist ?? "",
    status: overview.project.currentChapter ? "可继续下一章" : "草稿中",
    updatedAt: "刚刚",
    lastActiveMs: Date.now(),
    logline: overview.project.logline || overview.storyStatus.currentObjective || "",
    writtenChapters,
    // 全书字数只认写作统计的实数；读不到记 0，书架重扫时按实数补上（真机试写：原先按时间线估，开过书后书架显示 3.0 万，实际 1.3 万）。
    totalWords: overview.totalWords ?? 0,
    projectPath,
  };
}

export function stableBookId(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `project-${hash.toString(16)}`;
}

export function titleFromEvent(
  event: StateOverview["timeline"]["recentEvents"][number] | undefined,
  chapter: number,
): string {
  // 优先用真章名（时间线事件带 title，剥掉「第N章 ·」前缀）；没有章名才退回事件摘要（截 18 字）。
  // 不猜白名单：章节标题
  const realTitle = (event?.title ?? "").replace(/^(?:第[0-9一二三四五六七八九十百零两]+章\s*[·.．、:：-]?\s*)+/u, "").trim();
  if (realTitle && !isPlaceholderChapterTitle(realTitle)) return realTitle;
  const source = event?.mainEvent ?? event?.summary;
  if (!source?.trim()) return `第${chapter}章`;
  const cleaned = source.replace(/\s+/gu, " ").trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
}

/** 起过名的章：只有章号、或是占位名（章节表给没写的章垫的「下一章」）都不算——占位名被沿用到定稿后的章上，会冒出「第 2 章还没起标题，现在叫「下一章」」。 */
function hasRealTitle(chapter: Pick<ChapterNavItem, "chapterNumber" | "title">): boolean {
  const bare = chapterBareTitle(chapter.title ?? "").trim();
  return bare !== "" && !isPlaceholderChapterTitle(bare);
}

export function carryChapterFileFlags(
  next: readonly ChapterNavItem[],
  previous: readonly ChapterNavItem[],
  committedChapter?: number,
  titledFromDisk: ReadonlySet<number> = new Set(),
): readonly ChapterNavItem[] {
  const before = new Map(previous.map((chapter) => [chapter.chapterNumber, chapter]));
  return next.map((chapter) => {
    const old = before.get(chapter.chapterNumber);
    // 工具回传的概览不带工作稿章的章名（P6 真机：改完稿章节栏第 12 章「存根」变「未命名」）：新表没章名
    // （或只是「下一章」占位）就沿用旧表的。章名是按盘上文件读的（titledFromDisk）就以盘上为准——
    // 真机试写：撤销「改章名」后盘上没章名了，沿用旧表会一直显示改过的章名。
    const carryTitle = !titledFromDisk.has(chapter.chapterNumber)
      && (!hasRealTitle(chapter) || chapter.status === "planned") && old !== undefined && hasRealTitle(old);
    const carried: ChapterNavItem = {
      ...chapter,
      ...(carryTitle ? { title: old.title } : {}),
      ...(chapter.hasDraftFile === undefined && old?.hasDraftFile !== undefined ? { hasDraftFile: old.hasDraftFile } : {}),
      ...(chapter.hasCommittedChapter === undefined && old?.hasCommittedChapter !== undefined ? { hasCommittedChapter: old.hasCommittedChapter } : {}),
      ...(chapter.editedSinceCommit === undefined && old?.editedSinceCommit !== undefined ? { editedSinceCommit: old.editedSinceCommit } : {}),
      ...(committedChapter === chapter.chapterNumber ? { hasCommittedChapter: true, hasDraftFile: true, editedSinceCommit: false } : {}),
    };
    // 新表把它当「下一章」占位（还没写），带过来的标记却说它有稿（2026-10-19 试写：第 3 章有工作稿时重定稿第 2 章，
    // 第 3 章在章节栏变成「写第 3 章」、底栏说「全部已定稿」）：状态按标记改回已定稿 / 工作稿。
    if (carried.status !== "planned") return carried;
    if (carried.hasCommittedChapter === true) return { ...carried, status: "committed" };
    if (carried.hasDraftFile === true) return { ...carried, status: "draft" };
    // 旧表里它是写过的章（AI 刚出完稿那章常只有状态、没带文件标记）：照旧表算，当前章退回工作稿。
    if (old && old.status !== "planned") return { ...carried, status: old.status === "current" ? "draft" : old.status };
    return carried;
  });
}

/**
 * 整表刷新时别丢章（重构 P6 真机：第 12 章出完稿，章节栏从 12 章缩成 9 章）：工具回传的故事概览不带章节文件清单，
 * 只带最近几条时间线事件，按它重建的章节表只剩最近几章。概览带了清单（开书、撤销）就以它为准；
 * 没带时，新表里没有的章照旧留着（还没写的占位章不留；旧表里的「当前章」按它有没有定稿改回已定稿 / 工作稿）。
 */
export function keepUnlistedChapters(
  next: readonly ChapterNavItem[],
  previous: readonly ChapterNavItem[],
): readonly ChapterNavItem[] {
  const listed = new Set(next.map((chapter) => chapter.chapterNumber));
  const kept = previous
    .filter((chapter) => !listed.has(chapter.chapterNumber) && chapter.status !== "planned")
    .map((chapter): ChapterNavItem => chapter.status === "current"
      ? { ...chapter, status: chapter.hasCommittedChapter ? "committed" : "draft" }
      : chapter);
  if (kept.length === 0) return next;
  return [...next, ...kept].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

export function updateChapterListTitle(chapters: readonly ChapterNavItem[], chapterNumber: number, title: string): readonly ChapterNavItem[] {
  return chapters.map((chapter) => (
    chapter.chapterNumber === chapterNumber ? { ...chapter, title } : chapter
  ));
}

export function updateChapterListForActive(chapters: readonly ChapterNavItem[], activeChapterNumber: number, activeTitle: string): readonly ChapterNavItem[] {
  const byNumber = new Map<number, ChapterNavItem>();
  for (const chapter of chapters) {
    byNumber.set(chapter.chapterNumber, chapter);
  }
  if (!byNumber.has(activeChapterNumber)) {
    byNumber.set(activeChapterNumber, {
      id: `ch-${activeChapterNumber}`,
      chapterNumber: activeChapterNumber,
      title: activeTitle,
      status: "current",
    });
  }

  return [...byNumber.values()]
    .map((chapter) => ({
      ...chapter,
      title: chapter.chapterNumber === activeChapterNumber ? activeTitle : chapter.title,
      status: chapter.chapterNumber === activeChapterNumber
        ? "current" as const
        : chapter.chapterNumber < activeChapterNumber
          ? "committed" as const
          : "planned" as const,
    }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
}

/**
 * AI 改了别的章（不是作者开着的这章）之后，按盘上那章的稿纸改章节栏里它的标记（P11）：
 * 有没有工作稿 / 定稿、定稿后又改过没有，状态跟着改（还没写的占位 → 工作稿；有定稿 → 已定稿）。
 */
export function patchChapterFlagsFromPaper(
  chapters: readonly ChapterNavItem[],
  chapterNumber: number,
  paper: { readonly draft: unknown; readonly committed: unknown; readonly editedSinceCommit: boolean | null },
): readonly ChapterNavItem[] {
  return chapters.map((chapter) => {
    if (chapter.chapterNumber !== chapterNumber) return chapter;
    const hasCommittedChapter = paper.committed !== null;
    const hasDraftFile = paper.draft !== null;
    const status: ChapterNavItem["status"] = chapter.status === "current"
      ? "current"
      : hasCommittedChapter ? "committed" : hasDraftFile ? "draft" : chapter.status;
    return { ...chapter, hasDraftFile, hasCommittedChapter, editedSinceCommit: paper.editedSinceCommit === true, status };
  });
}
