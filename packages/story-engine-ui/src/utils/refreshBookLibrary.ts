import { fetchDefaultBookLibrary } from "../api/client.js";
import { useRecentBooksStore } from "../stores/recentBooksStore.js";
import { stableBookId } from "./bookUtils.js";

/** 重扫默认书库、归并进书架（开机、恢复书、从备份恢复后都走这一条）。 */
export async function refreshBookLibrary(): Promise<void> {
  const library = await fetchDefaultBookLibrary();
  useRecentBooksStore.getState().syncScannedBooks(library.books, library);
}

/**
 * 书回来了（回收站恢复 / 从备份恢复）：先重扫书库；不在默认书库里的（原先从别处打开的书）扫不到，
 * 就先放一条最简的进书架，打开时再按真数据刷新。
 */
export async function addReturnedBook(projectPath: string, title: string): Promise<void> {
  await refreshBookLibrary().catch(() => undefined);
  const store = useRecentBooksStore.getState();
  if (store.books.some((book) => book.projectPath === projectPath)) return;
  store.upsertBook({
    id: stableBookId(projectPath),
    title,
    genre: "",
    currentChapterTitle: "",
    currentChapterNumber: 1,
    protagonistName: "",
    status: "草稿中",
    updatedAt: "刚刚",
    lastActiveMs: Date.now(),
    logline: "",
    writtenChapters: 0,
    totalWords: 0,
    projectPath,
  });
}
