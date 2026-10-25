import { describe, expect, it } from "vitest";
import type { StateOverview } from "../api/types.js";
import type { ChapterNavItem } from "../types.js";
import { bookActiveLabel, bookSummaryFromOverview, carryChapterFileFlags, keepUnlistedChapters, patchChapterFlagsFromPaper } from "./bookUtils.js";

const item = (chapterNumber: number, extra: Partial<ChapterNavItem> = {}): ChapterNavItem => ({
  id: `ch-${chapterNumber}`,
  chapterNumber,
  title: `第${chapterNumber}章`,
  status: "committed",
  ...extra,
});

describe("carryChapterFileFlags", () => {
  it("新表没带文件标记 → 沿用旧表的；新表带了就用新的", () => {
    const previous = [item(1, { hasDraftFile: true, hasCommittedChapter: true }), item(2, { hasDraftFile: true, hasCommittedChapter: false })];
    const next = [item(1), item(2, { hasCommittedChapter: true }), item(3, { status: "planned" })];
    const merged = carryChapterFileFlags(next, previous);
    expect(merged[0]).toMatchObject({ hasDraftFile: true, hasCommittedChapter: true });
    expect(merged[1]).toMatchObject({ hasDraftFile: true, hasCommittedChapter: true });
    expect(merged[2]!.hasCommittedChapter).toBeUndefined();
  });

  it("新表没章名（工具回传的概览不带工作稿章名）→ 沿用旧表的；新表带了就用新的", () => {
    const merged = carryChapterFileFlags(
      [item(12), item(13, { title: "" }), item(11, { title: "门房·改" })],
      [item(12, { title: "第12章 · 存根" }), item(13, { title: "第13章 · 回信" }), item(11, { title: "门房" })],
    );
    expect(merged.map((chapter) => chapter.title)).toEqual(["第12章 · 存根", "第13章 · 回信", "门房·改"]);
  });

  it("章名是按盘上文件读的（开书、撤销恢复）→ 以盘上为准，盘上没章名就是没有，不沿用旧表（真机试写：撤销改章名后章节栏还是新章名）", () => {
    const merged = carryChapterFileFlags([item(1), item(2)], [item(1, { title: "回巷" }), item(2, { title: "上弦" })], undefined, new Set([1]));
    expect(merged.map((chapter) => chapter.title)).toEqual(["第1章", "上弦"]);
  });

  it("新表把有工作稿的后一章当「下一章」占位 → 状态改回工作稿、章名沿用旧表（重定稿前面一章时）", () => {
    const merged = carryChapterFileFlags(
      [item(2, { status: "current" }), item(3, { status: "planned", title: "下一章" })],
      [item(2, { status: "current", hasDraftFile: true, hasCommittedChapter: true }), item(3, { status: "draft", title: "第3章 · 看水", hasDraftFile: true, hasCommittedChapter: false })],
      2,
    );
    expect(merged[1]).toMatchObject({ status: "draft", title: "第3章 · 看水", hasDraftFile: true });
    const statusOnly = carryChapterFileFlags(
      [item(3, { status: "current" }), item(4, { status: "planned", title: "下一章" })],
      [item(3, { status: "committed" }), item(4, { status: "draft", title: "第4章 · 一只胶鞋" })],
      3,
    );
    expect(statusOnly[1]).toMatchObject({ status: "draft", title: "第4章 · 一只胶鞋" });
    const empty = carryChapterFileFlags([item(4, { status: "planned", title: "下一章" })], []);
    expect(empty[0]!.status).toBe("planned");
  });

  it("旧表里只是占位名「下一章」（点「去第 N 章」打开的空章）→ 定稿后不沿用，照新表叫「第N章」", () => {
    const merged = carryChapterFileFlags(
      [item(1, { status: "committed" }), item(2, { status: "committed" }), item(3, { status: "planned", title: "下一章" })],
      [item(1, { status: "committed" }), item(2, { status: "current", title: "下一章" })],
      2,
    );
    expect(merged.map((chapter) => chapter.title)).toEqual(["第1章", "第2章", "下一章"]);
  });

  it("刚定稿的那章直接标已定稿（旧表里它还是工作稿）", () => {
    const merged = carryChapterFileFlags([item(7, { status: "current" })], [item(7, { status: "current", hasDraftFile: true, hasCommittedChapter: false })], 7);
    expect(merged[0]).toMatchObject({ hasDraftFile: true, hasCommittedChapter: true });
  });
});

describe("keepUnlistedChapters", () => {
  it("新表只认得最近几章：旧表里别的章照旧留着、按章号排；还没写的占位章不留", () => {
    const previous = [item(1), item(2), item(3), item(4), item(5, { status: "current", hasCommittedChapter: true }), item(6, { status: "planned" })];
    const next = [item(4), item(5), item(6, { status: "current" }), item(7, { status: "planned" })];
    const merged = keepUnlistedChapters(next, previous);
    expect(merged.map((chapter) => chapter.chapterNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(merged.find((chapter) => chapter.chapterNumber === 6)!.status).toBe("current");
  });

  it("旧表里的当前章不在新表里：按有没有定稿改回已定稿 / 工作稿", () => {
    const merged = keepUnlistedChapters([item(9, { status: "current" })], [item(7, { status: "current", hasCommittedChapter: false }), item(8, { status: "current", hasCommittedChapter: true })]);
    expect(merged.map((chapter) => [chapter.chapterNumber, chapter.status])).toEqual([[7, "draft"], [8, "committed"], [9, "current"]]);
  });

  it("新表全覆盖了：原样返回", () => {
    const next = [item(1), item(2, { status: "current" })];
    expect(keepUnlistedChapters(next, [item(1), item(2)])).toBe(next);
  });
});

describe("patchChapterFlagsFromPaper（P11：AI 改了别的章，按盘上改它的标记）", () => {
  const ch = (chapterNumber: number, status: ChapterNavItem["status"], extra: Partial<ChapterNavItem> = {}): ChapterNavItem => ({
    id: `ch-${chapterNumber}`, chapterNumber, title: `第${chapterNumber}章`, status, ...extra,
  });

  it("已定稿章的工作稿被改过 → 标上「定稿后又改过」；别的章不动", () => {
    const before = [ch(1, "committed", { hasCommittedChapter: true }), ch(2, "current")];
    const after = patchChapterFlagsFromPaper(before, 1, { draft: {}, committed: {}, editedSinceCommit: true });
    expect(after[0]).toMatchObject({ status: "committed", hasDraftFile: true, hasCommittedChapter: true, editedSinceCommit: true });
    expect(after[1]).toBe(before[1]);
  });

  it("还没写的占位章被写了 → 变工作稿；当前章保持 current", () => {
    const after = patchChapterFlagsFromPaper([ch(3, "planned"), ch(4, "current")], 3, { draft: {}, committed: null, editedSinceCommit: null });
    expect(after[0]).toMatchObject({ status: "draft", hasDraftFile: true, hasCommittedChapter: false, editedSinceCommit: false });
    expect(patchChapterFlagsFromPaper([ch(4, "current")], 4, { draft: {}, committed: {}, editedSinceCommit: false })[0]?.status).toBe("current");
  });
});

describe("bookSummaryFromOverview：书架「上次写到」", () => {
  const overview = (currentChapter: number) => ({
    project: { title: "雾港来信", currentChapter },
    timeline: { recentEvents: [{ chapter: 8, title: "第8章 · 代笔", summary: "她把便签压进抽屉" }] },
    characters: { protagonist: "许微" },
    storyStatus: {},
  }) as unknown as StateOverview;

  it("最新章还是工作稿（没有事件）→ 只说章号，不借上一章的章名", () => {
    const book = bookSummaryFromOverview(overview(9), "/books/fog");
    expect(book.currentChapterNumber).toBe(9);
    expect(book.currentChapterTitle).toBe("第9章");
  });

  it("这一章有事件 → 用它的章名", () => {
    expect(bookSummaryFromOverview(overview(8), "/books/fog").currentChapterTitle).toBe("代笔");
  });

  it("字数只认概况里的实数，不按章数估（真机试写：10 章 1.3 万字，开过书后书架显示 3.0 万）", () => {
    expect(bookSummaryFromOverview({ ...overview(10), totalWords: 13210 } as StateOverview, "/books/fog").totalWords).toBe(13210);
    expect(bookSummaryFromOverview(overview(10), "/books/fog").totalWords).toBe(0);
  });
});

describe("bookActiveLabel", () => {
  it("按最后活跃的时刻现算，不用存下来的「刚刚」；没有时刻才用存的", () => {
    const now = Date.UTC(2026, 9, 25, 12);
    const book = { updatedAt: "刚刚", lastActiveMs: now - 3 * 3_600_000 } as Parameters<typeof bookActiveLabel>[0];
    expect(bookActiveLabel(book, now)).toBe("3 小时前");
    expect(bookActiveLabel({ ...book, lastActiveMs: undefined } as unknown as Parameters<typeof bookActiveLabel>[0], now)).toBe("刚刚");
  });
});
