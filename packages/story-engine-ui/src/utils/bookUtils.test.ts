import { describe, expect, it } from "vitest";
import type { ChapterNavItem } from "../types.js";
import { carryChapterFileFlags, keepUnlistedChapters } from "./bookUtils.js";

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
