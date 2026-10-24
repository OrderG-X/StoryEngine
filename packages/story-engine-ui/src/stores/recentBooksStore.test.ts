import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookSummary } from "../types.js";

const STORAGE_KEY = "story-engine-ng.recent-books";

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("recentBooksStore localStorage guard", () => {
  it("filters malformed localStorage entries instead of trusting parsed JSON", async () => {
    const validBook = bookSummary({ id: "valid-book" });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: "missing-required-fields" },
      validBook,
      null,
      "bad",
    ]));

    const { useRecentBooksStore } = await import("./recentBooksStore.js");

    expect(useRecentBooksStore.getState().books).toEqual([validBook]);
  });

  it("falls back to an empty list when stored recent-book data is present but malformed", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: "bad" }, null, 123]));

    const { useRecentBooksStore } = await import("./recentBooksStore.js");

    expect(useRecentBooksStore.getState().books).toEqual([]);
  });

  it("清除 /mock/ 演示书残留——只保留真实项目书（修真实书架被 mock 数据污染）", async () => {
    const mockBook = bookSummary({ id: "demo", title: "旧城区无线电", projectPath: "/mock/story-engine-ng/旧城区无线电" });
    const realBook = bookSummary({ id: "real", title: "真书", projectPath: "/Users/me/StoryEngine-NG/story-engine/真书" });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([mockBook, realBook]));

    const { useRecentBooksStore } = await import("./recentBooksStore.js");

    // /mock/ 演示书被滤掉，只剩真书；且回写后 localStorage 里也不再有演示书。
    expect(useRecentBooksStore.getState().books).toEqual([realBook]);
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    expect(persisted).toEqual([realBook]);
  });

  it("空 localStorage（全新用户）→ 空书架，绝不种演示书", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    expect(useRecentBooksStore.getState().books).toEqual([]);
  });
});

// 启动扫描归并（修「书架顺序被反转 + 已有条目数据不刷新」）：
// 此前 App 启动对服务端降序列表逐本 upsertBook 头插 → 最旧的书反而排第一、
// 「继续上次写作」永远指向最旧的书；且已存在的条目从不更新章数/时间。
describe("recentBooksStore.syncScannedBooks", () => {
  it("扫描列表按 lastActiveMs 降序落位——最新写的书在最前（不再被头插反转）", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    const oldest = bookSummary({ id: "b-old", title: "最旧", projectPath: "/books/old", lastActiveMs: 1_000, updatedAt: "3 天前" });
    const newest = bookSummary({ id: "b-new", title: "最新", projectPath: "/books/new", lastActiveMs: 3_000, updatedAt: "刚刚" });
    const middle = bookSummary({ id: "b-mid", title: "中间", projectPath: "/books/mid", lastActiveMs: 2_000, updatedAt: "1 小时前" });

    // 服务端本来就是降序返回；就算乱序进来也必须按活跃度落位
    useRecentBooksStore.getState().syncScannedBooks([oldest, newest, middle]);

    expect(useRecentBooksStore.getState().books.map((b) => b.title)).toEqual(["最新", "中间", "最旧"]);
  });

  it("同路径已有条目被扫描真值刷新（章数/时间不再停在旧值）", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    const stale = bookSummary({ id: "b-1", projectPath: "/books/a", currentChapterNumber: 1, updatedAt: "刚刚", lastActiveMs: 500 });
    useRecentBooksStore.getState().upsertBook(stale);

    const fresh = bookSummary({ id: "b-1", projectPath: "/books/a", currentChapterNumber: 10, updatedAt: "2 小时前", lastActiveMs: 9_000 });
    useRecentBooksStore.getState().syncScannedBooks([fresh]);

    const books = useRecentBooksStore.getState().books;
    expect(books).toHaveLength(1);
    expect(books[0].currentChapterNumber).toBe(10);
    expect(books[0].updatedAt).toBe("2 小时前");
  });

  it("老条目缺 lastActiveMs 当 0 沉底，但不丢（自定义路径打开的书仍在书架）", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    const legacy = bookSummary({ id: "b-legacy", title: "老条目", projectPath: "/custom/legacy" });
    useRecentBooksStore.getState().upsertBook(legacy);

    const scanned = bookSummary({ id: "b-scan", title: "扫描书", projectPath: "/books/scan", lastActiveMs: 5_000 });
    useRecentBooksStore.getState().syncScannedBooks([scanned]);

    expect(useRecentBooksStore.getState().books.map((b) => b.title)).toEqual(["扫描书", "老条目"]);
  });

  it("从别处打开的书：服务端查过文件夹不在了（missingPaths）就从书架拿掉，别的照留", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    useRecentBooksStore.getState().upsertBook(bookSummary({ id: "b-gone", title: "删了的", projectPath: "/custom/gone" }));
    useRecentBooksStore.getState().upsertBook(bookSummary({ id: "b-here", title: "还在的", projectPath: "/custom/here" }));
    useRecentBooksStore.getState().syncScannedBooks([], { root: "/books", existingPaths: [], missingPaths: ["/custom/gone"] });
    expect(useRecentBooksStore.getState().books.map((b) => b.title)).toEqual(["还在的"]);
  });

  it("竞态防护：本地条目比扫描新（刚打开/刚改名）→ 保留本地书名/时间/活跃度，扫描只补其余字段（评审加固）", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    // 扫描在飞时用户改了名并打开了书：本地 lastActiveMs 更新、title 是新名
    const now = Date.now();
    const local = bookSummary({ id: "b-r", title: "新书名", projectPath: "/books/race", lastActiveMs: now, updatedAt: "刚刚", currentChapterNumber: 3 });
    useRecentBooksStore.getState().upsertBook(local);

    // 扫描结果带的是改名前的旧数据（lastActiveMs 旧），但章数是盘上真值
    const scanned = bookSummary({ id: "b-r", title: "旧书名", projectPath: "/books/race", lastActiveMs: now - 2 * 3_600_000, updatedAt: "2 小时前", currentChapterNumber: 7 });
    useRecentBooksStore.getState().syncScannedBooks([scanned]);

    const merged = useRecentBooksStore.getState().books.find((b) => b.projectPath === "/books/race");
    expect(merged?.title).toBe("新书名");
    expect(merged?.updatedAt).toBe("刚刚");
    expect(merged?.lastActiveMs).toBe(now);
    expect(merged?.currentChapterNumber).toBe(7); // 盘上字段仍取扫描真值
  });

  it("本地条目比扫描新、但是十几天前开的：时间标签按本地活跃时刻现算，不留打开那一刻存下的「刚刚」（P7 桌面包走查）", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    const now = Date.now();
    const local = bookSummary({ id: "b-o", projectPath: "/books/opened", lastActiveMs: now - 11 * 86_400_000, updatedAt: "刚刚" });
    useRecentBooksStore.getState().upsertBook(local);
    const scanned = bookSummary({ id: "b-o", projectPath: "/books/opened", lastActiveMs: now - 12 * 86_400_000, updatedAt: "12 天前" });
    useRecentBooksStore.getState().syncScannedBooks([scanned]);
    expect(useRecentBooksStore.getState().books[0]?.updatedAt).toBe("11 天前");
  });

  it("归并结果持久化到 localStorage", async () => {
    const { useRecentBooksStore } = await import("./recentBooksStore.js");
    useRecentBooksStore.getState().syncScannedBooks([
      bookSummary({ id: "b-p", title: "持久化", projectPath: "/books/p", lastActiveMs: 42 }),
    ]);
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as BookSummary[];
    expect(persisted.map((b) => b.title)).toContain("持久化");
  });
});

function bookSummary(overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    id: "book-1",
    title: "测试书",
    genre: "长篇",
    currentChapterTitle: "第一章",
    currentChapterNumber: 1,
    protagonistName: "林晓",
    status: "草稿中",
    updatedAt: "刚刚",
    logline: "测试简介",
    writtenChapters: 0,
    totalWords: 0,
    projectPath: "/tmp/story-project",
    ...overrides,
  };
}
