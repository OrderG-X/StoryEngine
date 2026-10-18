import { create } from "zustand";
import type { BookSummary } from "../types.js";
import { isBookSummary } from "../utils/bookUtils.js";
import { formatRelativeTimeMs } from "../utils/textUtils.js";

const STORAGE_KEY = "story-engine-ng.recent-books";
// 书架=真实书库，容量给足（不是只放"最近"几本，超过会把真书丢掉）。
const MAX_BOOKS = 100;

/** /mock/ 开头的演示书（早期 mock 兜底种进 localStorage 的）——真实书架不该出现演示数据，加载时一律滤掉。 */
function isMockBook(book: BookSummary): boolean {
  return book.projectPath.startsWith("/mock/");
}

function loadFromStorage(): readonly BookSummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBookSummary).filter((book) => !isMockBook(book));
  } catch {
    return [];
  }
}

function persist(books: readonly BookSummary[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
}

export interface RecentBooksStore {
  readonly books: readonly BookSummary[];
  readonly upsertBook: (book: BookSummary) => void;
  readonly syncScannedBooks: (
    scanned: readonly BookSummary[],
    library?: { readonly root?: string; readonly existingPaths?: readonly string[] },
  ) => void;
  readonly removeBook: (bookId: string) => void;
  readonly renameBook: (bookId: string, nextTitle: string) => void;
  readonly deleteBook: (bookId: string) => void;
  readonly loadFromStorage: () => void;
  readonly saveToStorage: () => void;
}

// 真实书架：只认 localStorage 里持久化的真书（已滤掉 /mock/ 演示书）。没有就空书架——
// 绝不再用 mockRecentBooks 兜底种演示数据污染用户书库。
function initialBooks(): readonly BookSummary[] {
  return loadFromStorage();
}

export const useRecentBooksStore = create<RecentBooksStore>((set, get) => {
  const books = initialBooks();
  // 加载即回写（把滤掉 /mock/ 后的干净列表落盘，自动清除早期种下的演示书残留）。
  persist(books);

  return {
    books,

    upsertBook: (book) =>
      set((state) => {
        const existing = state.books.filter((b) => b.id !== book.id);
        const next = [book, ...existing].slice(0, MAX_BOOKS);
        persist(next);
        return { books: next };
      }),

    // 启动扫描归并：扫描结果是服务端真值（真实 lastActiveMs/章数），覆盖同路径旧条目，
    // 再按活跃时间降序排。修两个老毛病：① 此前逐本头插会把「最近活跃降序」反转，
    // 最旧的书霸占「继续上次写作」；② 已存在条目从不刷新，章数/时间一直是旧的。
    // 老条目缺 lastActiveMs 当 0（稳定排序，沉底但保持相对顺序），下次打开即被补上。
    // 竞态防护（评审加固）：扫描在飞时用户可能刚打开/改名了某本书（本地 lastActiveMs=当下）——
    // 本地比扫描新时做字段级归并：保留本地的书名/时间/活跃度，扫描只补章数等盘上字段。
    syncScannedBooks: (scanned, library) =>
      set((state) => {
        // 默认书库里已经删掉/挪走的书：书架上不再留着（点了只会报找不到）。只清书库根目录下的条目——
        // 用户从别处「打开已有书籍」加进来的书不在扫描范围内，不能凭扫描结果判它没了。
        const missingInLibrary = missingDefaultLibraryPaths(state.books, library);
        const byPath = new Map(
          state.books.filter((book) => !missingInLibrary.has(book.projectPath)).map((book) => [book.projectPath, book]),
        );
        for (const book of scanned) {
          const local = byPath.get(book.projectPath);
          const localIsNewer = local !== undefined && (local.lastActiveMs ?? 0) > (book.lastActiveMs ?? 0);
          byPath.set(
            book.projectPath,
            localIsNewer
              // 时间标签按本地活跃时刻现算：存下来的是打开那一刻的「刚刚」，原样留着会让十几天前开过的书一直显示「刚刚」（P7 桌面包走查）。
              ? { ...book, title: local.title, updatedAt: formatRelativeTimeMs(local.lastActiveMs ?? 0), lastActiveMs: local.lastActiveMs }
              : book,
          );
        }
        const next = [...byPath.values()]
          .sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0))
          .slice(0, MAX_BOOKS);
        persist(next);
        return { books: next };
      }),

    removeBook: (bookId) =>
      set((state) => {
        const next = state.books.filter((b) => b.id !== bookId);
        persist(next);
        return { books: next };
      }),

    renameBook: (bookId, nextTitle) =>
      set((state) => {
        const next = state.books.map((b) =>
          b.id === bookId ? { ...b, title: nextTitle } : b,
        );
        persist(next);
        return { books: next };
      }),

    deleteBook: (bookId) => {
      get().removeBook(bookId);
    },

    loadFromStorage: () => {
      const books = loadFromStorage();
      persist(books);
      set({ books });
    },

    saveToStorage: () => {
      persist(get().books);
    },
  };
});

/** 书架上位于默认书库根目录下、但盘上已经不存在的书（路径集合）。缺扫描信息时返回空集（不误删）。 */
export function missingDefaultLibraryPaths(
  books: readonly BookSummary[],
  library?: { readonly root?: string; readonly existingPaths?: readonly string[] },
): ReadonlySet<string> {
  if (!library?.root || !library.existingPaths) return new Set();
  const root = library.root.replace(/\/+$/u, "");
  const existing = new Set(library.existingPaths);
  return new Set(
    books
      .filter((book) => book.projectPath.startsWith(`${root}/`) && !existing.has(book.projectPath))
      .map((book) => book.projectPath),
  );
}
