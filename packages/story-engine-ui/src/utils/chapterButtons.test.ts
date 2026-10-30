import { describe, expect, it } from "vitest";

import { chapterButtonAction, nextUncommittedChapter } from "./chapterButtons.js";
import type { ChapterNavItem } from "../types.js";

const nav = (chapterNumber: number, status: ChapterNavItem["status"]): ChapterNavItem =>
  ({ chapterNumber, title: `第${chapterNumber}章`, status }) as ChapterNavItem;

describe("chapterButtonAction：按钮 → 结构化动作（不靠文案）", () => {
  const chapters = [nav(1, "committed"), nav(2, "committed"), nav(3, "draft")];

  it("各按钮带当前章号发对应动作；检查交一次新的（每点一下一个请求号）", () => {
    for (const mode of ["continuity", "review", "quality"] as const) {
      expect(chapterButtonAction(mode, { chapter: 3, chapters })).toEqual({
        kind: "new", type: "inspect.run", mode, params: { chapter: 3 }, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u), issuedAt: expect.any(String),
      });
    }
    const first = chapterButtonAction("review", { chapter: 3, chapters }) as { requestKey: string };
    const second = chapterButtonAction("review", { chapter: 3, chapters }) as { requestKey: string };
    expect(first.requestKey).not.toBe(second.requestKey);
    expect(chapterButtonAction("commit", { chapter: 3, chapters })).toEqual({ kind: "new", type: "commit.prepare", params: { chapter: 3 }, requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u), issuedAt: expect.any(String) });
  });

  it("写这一章：方向框有字就带上（原样），空白不带", () => {
    expect(chapterButtonAction("write", { chapter: 3, chapters, direction: "  林澈夜探旧泵站 " })).toEqual({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 3, direction: "林澈夜探旧泵站" }, requestKey: expect.any(String), issuedAt: expect.any(String) });
    expect(chapterButtonAction("write", { chapter: 3, chapters, direction: "   " })).toEqual({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 3 }, requestKey: expect.any(String), issuedAt: expect.any(String) });
  });

  it("写下一章：跳过已定稿的章", () => {
    expect(chapterButtonAction("write_next", { chapter: 1, chapters })).toEqual({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 3 }, requestKey: expect.any(String), issuedAt: expect.any(String) });
    expect(chapterButtonAction("write_next", { chapter: 3, chapters })).toEqual({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 4 }, requestKey: expect.any(String), issuedAt: expect.any(String) });
  });

  it("撤销上一步不要章号；其余没选章返回 undefined（调用方如实提示）", () => {
    expect(chapterButtonAction("undo", { chapters })).toEqual({ toolName: "undo" });
    expect(chapterButtonAction("review", { chapters })).toBeUndefined();
    expect(chapterButtonAction("write", { chapter: 0, chapters })).toBeUndefined();
  });
});

describe("nextUncommittedChapter", () => {
  it("hasCommittedChapter 也算已定稿", () => {
    const chapters = [{ ...nav(2, "current"), hasCommittedChapter: true } as ChapterNavItem];
    expect(nextUncommittedChapter(1, chapters)).toBe(3);
  });
});
