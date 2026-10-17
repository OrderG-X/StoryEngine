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
export function carryChapterFileFlags(
  next: readonly ChapterNavItem[],
  previous: readonly ChapterNavItem[],
  committedChapter?: number,
): readonly ChapterNavItem[] {
  const before = new Map(previous.map((chapter) => [chapter.chapterNumber, chapter]));
  return next.map((chapter) => {
    const old = before.get(chapter.chapterNumber);
    return {
      ...chapter,
      ...(chapter.hasDraftFile === undefined && old?.hasDraftFile !== undefined ? { hasDraftFile: old.hasDraftFile } : {}),
      ...(chapter.hasCommittedChapter === undefined && old?.hasCommittedChapter !== undefined ? { hasCommittedChapter: old.hasCommittedChapter } : {}),
      ...(committedChapter === chapter.chapterNumber ? { hasCommittedChapter: true, hasDraftFile: true } : {}),
    };
  });
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
