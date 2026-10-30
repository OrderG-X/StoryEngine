import { describe, expect, it } from "vitest";
import { isFreshBook } from "./isFreshBook.js";
import type { StateOverview } from "../api/types.js";

/**
 * 构造一本「刚建好、还没动过的空书」的真实 overview。
 *
 * 关键：历史上建书会种 1 个 status:"active" 的 arc-goal（旧 V4 漏判的根因——旧 isFreshBook 把这个建书噪声
 * 当成「非空书」）。该种子来源已随极简空建退役（新建不再种 arc-goal），但基线**仍默认带 arcGoalsActiveCount:1**，
 * 以锁住「即便是历史/带噪声的项目，isFreshBook 也不看 threads/arcGoals 计数」这条护栏。
 */
function freshOverview(overrides: Partial<{
  currentChapter: number | null;
  knownCharacters: readonly { readonly id: string; readonly name: string }[];
  threadsTotal: number;
  arcGoalsActiveCount: number;
  uiChapterFiles: readonly { readonly chapter: number; readonly hasDraftFile: boolean; readonly hasCommittedChapter: boolean }[];
}> = {}): StateOverview {
  return {
    project: { currentChapter: overrides.currentChapter ?? null },
    characters: {
      knownCharacters: overrides.knownCharacters ?? [{ id: "protagonist", name: "主角" }],
    },
    threads: { total: overrides.threadsTotal ?? 0 },
    arcGoals: { activeCount: overrides.arcGoalsActiveCount ?? 1 },
    ...(overrides.uiChapterFiles !== undefined ? { uiChapterFiles: overrides.uiChapterFiles } : {}),
  } as unknown as StateOverview;
}

describe("isFreshBook", () => {
  it("真实空书（无章节·仅占位主角·建书种了1个主线目标但用户没动过·无草稿）→ true", () => {
    // 实测真机新建书 arcGoals.activeCount=1（默认 premise 种的），仍应判为空书。
    expect(isFreshBook(freshOverview())).toBe(true);
  });

  it("空书且无占位主角（knownCharacters 为空）→ 仍 true", () => {
    expect(isFreshBook(freshOverview({ knownCharacters: [] }))).toBe(true);
  });

  it("建书种的伏笔/线程/主线目标计数都不算「动过」→ 仍 true（不再用这些噪声判定）", () => {
    expect(isFreshBook(freshOverview({ threadsTotal: 2, arcGoalsActiveCount: 3 }))).toBe(true);
  });

  it("已有章节（currentChapter 非 null）→ false", () => {
    expect(isFreshBook(freshOverview({ currentChapter: 1 }))).toBe(false);
  });

  it("已有多个角色（>1）→ false", () => {
    expect(isFreshBook(freshOverview({
      knownCharacters: [
        { id: "protagonist", name: "主角" },
        { id: "c2", name: "对手" },
      ],
    }))).toBe(false);
  });

  it("已有草稿文件（hasDraftFile）→ false", () => {
    expect(isFreshBook(freshOverview({
      uiChapterFiles: [{ chapter: 1, hasDraftFile: true, hasCommittedChapter: false }],
    }))).toBe(false);
  });

  it("已有已提交章节（hasCommittedChapter）→ false", () => {
    expect(isFreshBook(freshOverview({
      uiChapterFiles: [{ chapter: 1, hasDraftFile: false, hasCommittedChapter: true }],
    }))).toBe(false);
  });

  it("有 uiChapterFiles 但都没草稿/没提交 → 仍按空书 true", () => {
    expect(isFreshBook(freshOverview({
      uiChapterFiles: [{ chapter: 1, hasDraftFile: false, hasCommittedChapter: false }],
    }))).toBe(true);
  });

  it("currentChapter 缺失（非明确 null）→ 安全默认 false", () => {
    const overview = {
      characters: { knownCharacters: [{ id: "protagonist", name: "主角" }] },
    } as unknown as StateOverview;
    expect(isFreshBook(overview)).toBe(false);
  });

  it("缺 characters 块 → 安全默认 false（不误伤已有书）", () => {
    const overview = {
      project: { currentChapter: null },
    } as unknown as StateOverview;
    expect(isFreshBook(overview)).toBe(false);
  });
});
