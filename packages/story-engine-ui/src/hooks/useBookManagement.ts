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
    // 删书是挪进回收站（P10）：没挪成就如实报错、书留在书架上；目录早就不在了服务端照样回成功，这条移出书架。
    await removeBookProject({
      projectPath: book.projectPath,
      confirmDelete: true,
      confirmTitle: book.title,
      confirmProjectPath: book.projectPath,
    });
    removeRecentBookById(bookId);
    if (projectPath === book.projectPath) {
      useNavigationStore.getState().setWorkspaceReady(false);
      useNavigationStore.getState().setActiveBookId(null);
      useNavigationStore.getState().setProjectPath(null);
    }
    return `已把《${book.title}》移到回收站，30 天内能恢复。`;
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
