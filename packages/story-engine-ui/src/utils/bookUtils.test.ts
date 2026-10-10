import { describe, expect, it } from "vitest";
import type { ChapterNavItem } from "../types.js";
import { carryChapterFileFlags } from "./bookUtils.js";

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

  it("刚定稿的那章直接标已定稿（旧表里它还是工作稿）", () => {
    const merged = carryChapterFileFlags([item(7, { status: "current" })], [item(7, { status: "current", hasDraftFile: true, hasCommittedChapter: false })], 7);
    expect(merged[0]).toMatchObject({ hasDraftFile: true, hasCommittedChapter: true });
  });
});
