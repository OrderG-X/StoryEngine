import { openBookProjectFolder, removeBookProject, renameBookProject } from "../api/client.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useRecentBooksStore } from "../stores/recentBooksStore.js";
import { bookSummaryFromOverview, isRealProjectBook } from "../utils/bookUtils.js";
import type { BookSummary } from "../types.js";

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
