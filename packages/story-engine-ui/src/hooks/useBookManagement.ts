import type { StateOverview } from "../api/types.js";
import { openBookProjectFolder, removeBookProject, renameBookProject } from "../api/client.js";
import { mockSidebarData, mockWorkspaceData } from "../mockData.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useRecentBooksStore } from "../stores/recentBooksStore.js";
import type { BookSummary, ChapterNavItem, ChapterWorkflowState, ChapterWorkspaceData, SidebarData } from "../types.js";

function isRealProjectBook(book: BookSummary): boolean {
  return Boolean(book.projectPath.trim()) && !book.projectPath.startsWith("/mock/");
}

function stableBookId(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `project-${hash.toString(16)}`;
}

function bookSummaryFromOverview(overview: StateOverview, projectPath: string): BookSummary {
  const currentChapterNumber = overview.project.currentChapter ?? overview.timeline.recentEvents.at(-1)?.chapter ?? 1;
  const currentEvent =
    overview.timeline.recentEvents.find((event) => event.chapter === currentChapterNumber) ??
    overview.timeline.recentEvents.at(-1);
  const writtenChapters = Math.max(
    overview.project.currentChapter ?? overview.timeline.recentEvents.length,
    overview.timeline.recentEvents.length,
    0,
  );
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

function titleFromEvent(
  event: StateOverview["timeline"]["recentEvents"][number] | undefined,
  chapter: number,
): string {
  const source = event?.mainEvent ?? event?.summary;
  if (!source?.trim()) return `第${chapter}章`;
  const cleaned = source.replace(/\s+/gu, " ").trim();
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
}

function estimateWordsFromOverview(overview: StateOverview): number {
  const timelineWords = overview.timeline.recentEvents.reduce(
    (total, event) => total + event.summary.length + (event.mainEvent?.length ?? 0),
    0,
  );
  return Math.max(timelineWords * 20, (overview.project.currentChapter ?? 0) * 3000);
}

export function workspaceFromBook(book: BookSummary): ChapterWorkspaceData {
  const chapterWindow: readonly ChapterNavItem[] = Array.from({ length: 5 }, (_, index) => {
    const chapterNumber = Math.max(1, book.currentChapterNumber - 2) + index;
    return {
      id: `${book.id}-ch-${chapterNumber}`,
      chapterNumber,
      title:
        chapterNumber === book.currentChapterNumber
          ? book.currentChapterTitle
          : mockWorkspaceData.chapters[index]?.title ?? `第${chapterNumber}章`,
      status: (
        chapterNumber < book.currentChapterNumber
          ? "committed"
          : chapterNumber === book.currentChapterNumber
            ? "current"
            : "planned"
      ) as ChapterNavItem["status"],
    };
  });
  const currentChapter =
    chapterWindow.find((chapter) => chapter.chapterNumber === book.currentChapterNumber) ??
    chapterWindow[0] ??
    mockWorkspaceData.currentChapter;
  const flowStatus: ChapterWorkflowState = (
    book.status === "待确认"
      ? "waiting_commit_confirmation"
      : book.status === "可继续下一章"
        ? "ready_for_next"
        : "idle"
  );

  return {
    ...mockWorkspaceData,
    projectName: book.title,
    currentChapter,
    chapters: chapterWindow,
    flowStatus,
    draft: {
      ...mockWorkspaceData.draft,
      chapterNumber: book.currentChapterNumber,
      title: book.currentChapterTitle,
      status: flowStatus === "ready_for_next" ? "committed" : "draft",
      wordCount: Math.max(1200, Math.round(book.totalWords / Math.max(book.writtenChapters, 1))),
      content: [
        `这里是《${book.title}》第${book.currentChapterNumber}章「${book.currentChapterTitle}」的章节工作区。`,
        isRealProjectBook(book)
          ? "本区域会读取项目状态、生成本章方案、工作稿和定稿预览。"
          : "这条书架记录还没有绑定本地项目目录。打开或创建真实项目后，本区域会读取项目状态。",
        book.logline,
      ].join("\n\n"),
    },
    messages: [
      {
        id: `${book.id}-system`,
        role: "assistant",
        content: `已进入《${book.title}》的章节工作台。当前章节：第${book.currentChapterNumber}章 · ${book.currentChapterTitle}。`,
      },
    ],
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
    characters: [
      book.protagonistName,
      ...mockSidebarData.characters.filter((item) => item !== book.protagonistName),
    ],
  };
}

export function useBookManagement() {
  const projectPath = useNavigationStore((s) => s.projectPath);

  const upsertRecentBook = (book: BookSummary): void => {
    useRecentBooksStore.getState().upsertBook(book);
  };

  const removeRecentBookById = (bookId: string): void => {
    useRecentBooksStore.getState().removeBook(bookId);
  };

  const renameRecentBook = async (bookId: string, nextTitle: string): Promise<string> => {
    const books = useRecentBooksStore.getState().books;
    const book = books.find((item) => item.id === bookId);
    if (!book) throw new Error("未找到这本书。");
    if (!isRealProjectBook(book)) {
      const renamed = { ...book, title: nextTitle, updatedAt: "刚刚", lastActiveMs: Date.now() };
      upsertRecentBook(renamed);
      return `已重命名《${book.title}》。`;
    }
    const renamed = await renameBookProject({ projectPath: book.projectPath, title: nextTitle });
    upsertRecentBook(bookSummaryFromOverview(renamed.overview, book.projectPath));
    return `已重命名为《${renamed.title}》。`;
  };

  const removeRecentBook = async (bookId: string): Promise<string> => {
    const books = useRecentBooksStore.getState().books;
    const book = books.find((item) => item.id === bookId);
    removeRecentBookById(bookId);
    return book ? `已从最近书籍移除《${book.title}》。` : "已从最近书籍移除。";
  };

  const deleteRecentBook = async (bookId: string): Promise<string> => {
    const books = useRecentBooksStore.getState().books;
    const book = books.find((item) => item.id === bookId);
    if (!book) throw new Error("未找到这本书。");
    if (!isRealProjectBook(book)) {
      removeRecentBookById(bookId);
      return `已从书架删除《${book.title}》。`;
    }
    // 删盘失败也要把它移出书架——用户就是想让它从书架消失。常见失败=目录已不存在（早期残留条目，
    // 服务端现已幂等返回成功）；其它失败（权限等）则移出书架并如实提示磁盘没删掉，不让一条删不掉的书卡住书架。
    let diskNote = "";
    try {
      await removeBookProject({
        projectPath: book.projectPath,
        confirmDelete: true,
        confirmTitle: book.title,
        confirmProjectPath: book.projectPath,
      });
    } catch (error) {
      diskNote = `（本地目录未能删除：${error instanceof Error ? error.message : String(error)}）`;
    }
    removeRecentBookById(bookId);
    if (projectPath === book.projectPath) {
      useNavigationStore.getState().setWorkspaceReady(false);
      useNavigationStore.getState().setActiveBookId(null);
      useNavigationStore.getState().setProjectPath(null);
    }
    return diskNote ? `已从书架移除《${book.title}》${diskNote}。` : `已删除《${book.title}》的本地项目目录。`;
  };

  const openRecentBookFolder = async (bookId: string): Promise<string> => {
    const books = useRecentBooksStore.getState().books;
    const book = books.find((item) => item.id === bookId);
    if (!book) throw new Error("未找到这本书。");
    if (!isRealProjectBook(book)) {
      throw new Error("这是一条示例书籍记录，没有对应的本地项目目录。");
    }
    await openBookProjectFolder(book.projectPath);
    return `已打开《${book.title}》所在文件夹。`;
  };

  return {
    upsertRecentBook,
    removeRecentBookById,
    renameRecentBook,
    removeRecentBook,
    deleteRecentBook,
    openRecentBookFolder,
  };
}
