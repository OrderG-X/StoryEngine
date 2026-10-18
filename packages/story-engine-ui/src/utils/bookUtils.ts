import type { BookSummary, ChapterNavItem, ChapterWorkspaceData, SidebarData } from "../types.js";
import type { StateOverview } from "../api/types.js";
import { mockRecentBooks, mockWorkspaceData, mockSidebarData } from "../mockData.js";
import { compactStrings } from "./textUtils.js";

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

export function isRealProjectBook(book: BookSummary): boolean {
  return Boolean(book.projectPath.trim()) && !book.projectPath.startsWith("/mock/");
}

export function bookSummaryFromOverview(overview: StateOverview, projectPath: string): BookSummary {
  const currentChapterNumber = overview.project.currentChapter ?? overview.timeline.recentEvents.at(-1)?.chapter ?? 1;
  const currentEvent = overview.timeline.recentEvents.find((event) => event.chapter === currentChapterNumber) ?? overview.timeline.recentEvents.at(-1);
  const writtenChapters = Math.max(overview.project.currentChapter ?? overview.timeline.recentEvents.length, overview.timeline.recentEvents.length, 0);
  const projectTitle = overview.project.title || "未命名故事";
  return {
    id: stableBookId(projectPath),
    title: projectTitle,
    genre: overview.project.genre || "长篇故事",
    currentChapterTitle: titleFromEvent(currentEvent, currentChapterNumber),
    currentChapterNumber,
    protagonistName: overview.characters.protagonist ?? overview.characters.knownCharacters[0]?.name ?? "主角",
    status: overview.project.currentChapter ? "可继续下一章" : "草稿中",
    updatedAt: "刚刚",
    lastActiveMs: Date.now(),
    logline: overview.world.summary ?? overview.storyStatus.currentObjective ?? "继续当前故事。",
    writtenChapters,
    totalWords: estimateWordsFromOverview(overview),
    projectPath,
  };
}

function stableBookId(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `project-${hash.toString(16)}`;
}

function titleFromEvent(event: StateOverview["timeline"]["recentEvents"][number] | undefined, chapter: number): string {
  const source = event?.mainEvent ?? event?.summary;
  if (!source?.trim()) return `第${chapter}章`;
  const cleaned = source.replace(/\s+/gu, " ").trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
}

function estimateWordsFromOverview(overview: StateOverview): number {
  const timelineWords = overview.timeline.recentEvents.reduce((total, event) => total + event.summary.length + (event.mainEvent?.length ?? 0), 0);
  return Math.max(timelineWords * 20, (overview.project.currentChapter ?? 0) * 3000);
}

export function workspaceFromBook(book: BookSummary): ChapterWorkspaceData {
  const chapterWindow = Array.from({ length: 5 }, (_, index) => {
    const chapterNumber = Math.max(1, book.currentChapterNumber - 2) + index;
    return {
      id: `${book.id}-ch-${chapterNumber}`,
      chapterNumber,
      title: chapterNumber === book.currentChapterNumber ? book.currentChapterTitle : mockWorkspaceData.chapters[index]?.title ?? `第${chapterNumber}章`,
      status: chapterNumber < book.currentChapterNumber
        ? "committed" as const
        : chapterNumber === book.currentChapterNumber
          ? "current" as const
          : "planned" as const,
    };
  });
  const currentChapter = chapterWindow.find((chapter) => chapter.chapterNumber === book.currentChapterNumber) ?? chapterWindow[0] ?? mockWorkspaceData.currentChapter;
  const flowStatus = book.status === "待确认"
    ? "waiting_commit_confirmation" as const
    : book.status === "可继续下一章"
      ? "ready_for_next" as const
      : "idle" as const;

  return {
    ...mockWorkspaceData,
    projectName: book.title,
    currentChapter,
    chapters: chapterWindow,
    flowStatus,
    protagonist: {
      ...mockWorkspaceData.protagonist,
      name: book.protagonistName,
      currentGoal: book.logline,
    },
  };
}

export function sidebarFromBook(book: BookSummary): SidebarData {
  return {
    ...mockSidebarData,
    storySettings: [book.title, book.genre, book.logline],
    characters: [book.protagonistName, ...mockSidebarData.characters.filter((item) => item !== book.protagonistName)],
  };
}

/**
 * 整表刷新时沿用旧的章节文件标记（2026-10-11 真机验收）：工具回传的故事概览不带章节文件状态，
 * 按它重建的章节表全丢了「有稿 / 已定稿」——下一章空稿纸冒出新书引导、刚定稿的章被当成没定稿。
 * 新表自己带了标记就用新的；刚定稿的那章直接标已定稿。
 */
/** 章名不是空、也不是概览补的占位「第N章」。 */
function hasRealTitle(chapter: Pick<ChapterNavItem, "chapterNumber" | "title">): boolean {
  const title = chapter.title?.trim() ?? "";
  return title !== "" && title !== `第${chapter.chapterNumber}章`;
}

export function carryChapterFileFlags(
  next: readonly ChapterNavItem[],
  previous: readonly ChapterNavItem[],
  committedChapter?: number,
): readonly ChapterNavItem[] {
  const before = new Map(previous.map((chapter) => [chapter.chapterNumber, chapter]));
  return next.map((chapter) => {
    const old = before.get(chapter.chapterNumber);
    const carried: ChapterNavItem = {
      ...chapter,
      // 工具回传的概览不带工作稿章的章名（P6 真机：改完稿章节栏第 12 章「存根」变「未命名」）：新表没章名
      // （或只是「下一章」占位）就沿用旧表的。
      ...((!hasRealTitle(chapter) || chapter.status === "planned") && old && hasRealTitle(old) ? { title: old.title } : {}),
      ...(chapter.hasDraftFile === undefined && old?.hasDraftFile !== undefined ? { hasDraftFile: old.hasDraftFile } : {}),
      ...(chapter.hasCommittedChapter === undefined && old?.hasCommittedChapter !== undefined ? { hasCommittedChapter: old.hasCommittedChapter } : {}),
      ...(committedChapter === chapter.chapterNumber ? { hasCommittedChapter: true, hasDraftFile: true } : {}),
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

export function firstChapterSetupDirection(overview: StateOverview | null): string {
  const setup = overview?.storyBible?.firstChapterSetup;
  if (!setup) return "";
  return compactStrings([
    setup.goal,
    setup.openingScene,
    setup.hook,
    setup.conflict,
  ]).join("；");
}
