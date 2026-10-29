import { describe, expect, it } from "vitest";
import { bareChapterName, hasChapterNumberPrefix } from "./chapter-title.js";

describe("章名开头的章号：一条规则（第 17 轮 AE1）", () => {
  it.each(["第1章", "第1章：", "第1章 ·", "第一章—", "第1 章", "第 1 章", "第零一章", "第一〇一章", "第１２章", "第两百章", "第1章 · 第1章"])("%j 只有章号", (title) => {
    expect(hasChapterNumberPrefix(title)).toBe(true);
    expect(bareChapterName(title)).toBe("");
  });

  it.each([
    ["第1章 · 雨夜", "雨夜"],
    ["第 3 章：雨夜", "雨夜"],
    ["第十二章｜雨夜", "雨夜"],
    ["第1章 · 第1章 · 雨夜", "雨夜"],
    ["雨夜", "雨夜"],
    ["第三章的秘密", "第三章的秘密"],
  ])("%j → %j", (title, name) => {
    expect(bareChapterName(title)).toBe(name);
  });

  it("章号后面直接接字的不算章号前缀", () => {
    expect(hasChapterNumberPrefix("第三章的秘密")).toBe(false);
    expect(hasChapterNumberPrefix("雨夜")).toBe(false);
  });
});
