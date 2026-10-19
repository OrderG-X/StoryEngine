import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMotionStore } from "../../stores/motionStore.js";
import type { HomePageProps } from "../../types.js";
import HomeLanding, { sortShelf, todayLine } from "./HomeLanding.js";
import * as shelfClient from "../../api/shelfClient.js";

vi.mock("../../utils/refreshBookLibrary.js", () => ({ addReturnedBook: vi.fn(async () => undefined), refreshBookLibrary: vi.fn(async () => undefined) }));

vi.mock("../../api/shelfClient.js", () => ({
  fetchTrash: vi.fn(async () => ({ items: [{ id: "t1", title: "删掉的书", originalPath: "/x", deletedAt: new Date().toISOString(), daysLeft: 30 }], keepDays: 30 })),
  restoreTrashItem: vi.fn(),
  purgeTrashItem: vi.fn(),
  exportBookFile: vi.fn(),
  saveBlob: vi.fn(),
  downloadBookBackup: vi.fn(async () => ({ blob: new Blob(["z"]), filename: "海州账册-备份.zip" })),
  restoreBookBackup: vi.fn(async () => ({ projectPath: "/books/restored", title: "回来的书" })),
  fetchBookInfo: vi.fn(),
  saveBookInfo: vi.fn(),
  fetchShelfMeta: vi.fn(async () => ({})),
  fetchBookStats: vi.fn(async () => { throw new Error("no stats"); }),
  setBookArchived: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
  // 还原降低动效，避免污染其它用例
  useMotionStore.getState().set(false);
});

describe("HomeLanding", () => {
  it("reduceMotion 开 → .se-v2-home 挂 is-reduced-motion 类；关 → 不挂", () => {
    useMotionStore.getState().set(true);
    const { container, rerender } = render(<HomeLanding {...homeProps()} />);
    expect(container.querySelector(".se-v2-home")?.className).toContain("is-reduced-motion");

    useMotionStore.getState().set(false);
    rerender(<HomeLanding {...homeProps()} />);
    expect(container.querySelector(".se-v2-home")?.className).not.toContain("is-reduced-motion");
  });

  it("renders the StoryEngine brand as non-interactive text instead of a fake button", () => {
    render(<HomeLanding {...homeProps()} />);

    expect(screen.getByLabelText("StoryEngine 品牌")).toHaveTextContent("StoryEngine");
    expect(screen.queryByRole("button", { name: /StoryEngine/u })).toBeNull();
  });

  it("删除弹窗 Esc 关闭（Radix 暗金弹窗收口）", () => {
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()] })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    fireEvent.click(screen.getByRole("button", { name: "删除书籍" }));

    const dialog = screen.getByRole("dialog", { name: "把《海州账册》移到回收站？" });
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "把《海州账册》移到回收站？" })).toBeNull();
  });

  it("删书是移到回收站（P10）：弹窗说 30 天能恢复，点「移到回收站」就删；书架底部有回收站入口带数", async () => {
    const onDeleteRecentBook = vi.fn(async () => "deleted");
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()], onDeleteRecentBook })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    fireEvent.click(screen.getByRole("button", { name: "删除书籍" }));

    expect(screen.getByText(/30 天内可以在书架底部的「回收站」里恢复/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "永久删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移到回收站" }));
    expect(onDeleteRecentBook).toHaveBeenCalledWith("book-1");
    expect(await screen.findByRole("button", { name: "回收站（1）" })).toBeInTheDocument();
  });

  it("回收站里恢复：书架上方的提示换成「回到书架了」，不留着「移到回收站」的旧话", async () => {
    vi.mocked(shelfClient.restoreTrashItem).mockResolvedValueOnce({ projectPath: "/x", title: "删掉的书" });
    render(<HomeLanding {...homeProps()} />);
    fireEvent.click(await screen.findByRole("button", { name: "回收站（1）" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("status")).toHaveTextContent("《删掉的书》回到书架了。");
  });

  it("书的菜单「备份」下载整本书；书架底部「从备份恢复」选 zip 解成新书", async () => {
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()] })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    fireEvent.click(screen.getByRole("button", { name: "备份" }));
    expect(await screen.findByText("《海州账册》备份好了：海州账册-备份.zip")).toBeInTheDocument();
    expect(shelfClient.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "海州账册-备份.zip");

    const file = new File(["zip"], "海州账册-备份.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("选备份文件"), { target: { files: [file] } });
    expect(await screen.findByText("《回来的书》恢复好了，在书架上。")).toBeInTheDocument();
    expect(shelfClient.restoreBookBackup).toHaveBeenCalledWith(file);
  });

  it("找书：按书名、标签搜；归档的收进底部「已归档」，继续写卡换成没归档的那本", async () => {
    vi.mocked(shelfClient.fetchShelfMeta).mockResolvedValueOnce({
      "/b/a": { archived: false, tags: ["悬疑"] },
      "/b/b": { archived: true },
    });
    const books = [
      { ...recentBook(), id: "a", title: "雾港来信", projectPath: "/b/a" },
      { ...recentBook(), id: "b", title: "海州账册", projectPath: "/b/b" },
      { ...recentBook(), id: "c", title: "白沙渡", projectPath: "/b/c" },
    ];
    render(<HomeLanding {...homeProps({ recentBooks: books })} />);
    expect(await screen.findByRole("button", { name: /已归档（1）/u })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "雾港来信" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开《海州账册》" })).toBeNull();

    fireEvent.change(screen.getByLabelText("找书"), { target: { value: "悬疑" } });
    const grid = within(screen.getByRole("region", { name: "最近写作" }));
    expect(grid.getByRole("button", { name: "打开《雾港来信》" })).toBeInTheDocument();
    expect(grid.queryByRole("button", { name: "打开《白沙渡》" })).toBeNull();
    fireEvent.change(screen.getByLabelText("找书"), { target: { value: "没有这本" } });
    expect(screen.getByText("没找到「没有这本」。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("找书"), { target: { value: "海州" } });
    expect(screen.getByText("没找到「海州」。已归档里有 1 本。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /已归档（1）/u }));
    expect(screen.getByRole("button", { name: "打开《海州账册》" })).toBeInTheDocument();
  });

  it("菜单「归档」：调接口、书挪进已归档", async () => {
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(await screen.findByText("《海州账册》收进了底部的「已归档」。")).toBeInTheDocument();
    expect(shelfClient.setBookArchived).toHaveBeenCalledWith("/Users/example/story", true);
    expect(screen.getByRole("button", { name: /已归档（1）/u })).toBeInTheDocument();
  });

  it("排序和「今天写了多少」那一行", () => {
    const a = { ...recentBook(), id: "a", title: "乙", totalWords: 10 };
    const b = { ...recentBook(), id: "b", title: "甲", totalWords: 30 };
    expect(sortShelf([a, b], "words").map((book) => book.id)).toEqual(["b", "a"]);
    expect(sortShelf([a, b], "recent").map((book) => book.id)).toEqual(["a", "b"]);
    const stats = { totalWords: 9000, today: { net: 1200, author: 1200, ai: 0 }, streak: 3, recent: [] };
    expect(todayLine(stats, 4000)).toBe("今天 +1,200 字 · 连续 3 天 · 日更 1,200 / 4,000");
    expect(todayLine({ ...stats, today: { net: 0, author: 0, ai: 0 }, streak: 1 })).toBe("今天还没写");
  });

  it("点菜单内动作后菜单关闭（不再常驻盖住「···」按钮，V6 回归根因）", () => {
    const onOpenRecentBook = vi.fn();
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()], onOpenRecentBook })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    expect(screen.getByRole("button", { name: "继续写作" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续写作" }));
    // 菜单已关：继续写作项消失；动作仍触发。
    expect(screen.queryByRole("button", { name: "继续写作" })).toBeNull();
    expect(onOpenRecentBook).toHaveBeenCalledWith("book-1");
  });

  it("点菜单外部 → 菜单关闭（标准下拉收口）", () => {
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()] })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    expect(screen.getByRole("button", { name: "重命名" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
  });

  it("shows a clear empty state when there are no recent books", () => {
    render(<HomeLanding {...homeProps()} />);

    const recentSection = screen.getByRole("region", { name: "最近写作" });
    expect(recentSection).toHaveTextContent("还没有最近写作");
    expect(recentSection).toHaveTextContent("可以新建一本书，或打开已有项目");
  });

  it("改版：书卡与继续写卡显示真实章数和字数（撤掉恒近满格、没信息量的进度条）", () => {
    const book = { ...recentBook(), writtenChapters: 30, currentChapterNumber: 40, totalWords: 123456 };
    const { container } = render(<HomeLanding {...homeProps({ recentBooks: [book] })} />);

    expect(container.querySelector(".se-book-info p")).toHaveTextContent("30 章");
    const hero = screen.getByRole("region", { name: "继续上次写作" });
    expect(hero).toHaveTextContent("30 章");
    expect(hero).toHaveTextContent("12.3 万字");
    expect(hero).toHaveTextContent("第 40 章");
  });
});

function homeProps(overrides: Partial<HomePageProps> = {}): HomePageProps {
  return {
    recentBooks: [],
    onChooseFolder: vi.fn(),
    onCreateBook: vi.fn(),
    onImportBook: vi.fn(async () => undefined),
    onOpenSettings: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecentBook: vi.fn(),
    onRenameRecentBook: vi.fn(async () => "renamed"),
    onRemoveRecentBook: vi.fn(async () => "removed"),
    onDeleteRecentBook: vi.fn(async () => "deleted"),
    onOpenRecentBookFolder: vi.fn(async () => "opened"),
    ...overrides,
  };
}

function recentBook() {
  return {
    id: "book-1",
    title: "海州账册",
    genre: "都市",
    currentChapterTitle: "第一章",
    currentChapterNumber: 1,
    protagonistName: "林序",
    status: "草稿中" as const,
    updatedAt: "刚刚",
    logline: "审计故事",
    writtenChapters: 1,
    totalWords: 1200,
    projectPath: "/Users/example/story",
  };
}
