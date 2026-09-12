import { describe, expect, it } from "vitest";
import {
  cleanUiText,
  countTextWords,
  compactStrings,
  formatRelativeTimeMs,
  looksLikeDraftBody,
  extractDraftTitle,
} from "./textUtils.js";

describe("cleanUiText", () => {
  it("returns undefined for falsy input", () => {
    expect(cleanUiText(undefined)).toBeUndefined();
    expect(cleanUiText("")).toBeUndefined();
  });

  it("replaces chapter_committed pattern", () => {
    expect(cleanUiText("chapter_1_committed")).toBe("第1章已提交");
  });

  it("replaces backend placeholder", () => {
    expect(cleanUiText("后端未提供")).toBe("尚未配置");
  });

  it("replaces character IDs", () => {
    expect(cleanUiText("char-abc123")).toBe("角色");
  });

  it("replaces multiple rules in one string", () => {
    const input = "HookPool has 3 open hooks in arc 1";
    const result = cleanUiText(input);
    expect(result).toContain("伏笔池");
    expect(result).toContain("主线");
    expect(result).toContain("伏笔");
  });

  it("replaces English narrative terms", () => {
    expect(cleanUiText("Timeline")).toContain("时间线");
    expect(cleanUiText("Character State")).toContain("角色");
    expect(cleanUiText("World State")).toContain("世界");
  });

  it("does not translate story inside filesystem paths", () => {
    expect(cleanUiText("story/hooks.json")).toBe("story/hooks.json");
    expect(cleanUiText("/tmp/project/story/hooks.json")).toBe("/tmp/project/story/hooks.json");
  });

  it("still translates standalone story text outside paths", () => {
    expect(cleanUiText("story")).toBe("章节");
  });
});

describe("countTextWords（T14 统一口径：正文中文字符数，不含标题/frontmatter/占位符）", () => {
  it("只数中文字符：标点、空白、西文不计", () => {
    expect(countTextWords("你好，世界。")).toBe(4);
    expect(countTextWords("hello world")).toBe(0);
  });

  it("去掉 Markdown 标题行", () => {
    expect(countTextWords("# 第一章 · 标题\n正文内容")).toBe(4);
  });

  it("去掉开头 frontmatter 块", () => {
    expect(countTextWords("---\ntitle: 第一章\ndate: 2026-09-12\n---\n正文内容")).toBe(4);
  });

  it("显示用空草稿占位符 → 0（空稿不显示假字数）", () => {
    expect(countTextWords("还没有草稿正文。\n\n你可以在右侧章节对话里输入第 1 章方向。")).toBe(0);
    expect(countTextWords("还没有载入本章草稿正文。")).toBe(0);
  });

  it("handles empty string", () => {
    expect(countTextWords("")).toBe(0);
  });
});

describe("compactStrings", () => {
  it("filters undefined/null and trims", () => {
    expect(compactStrings([" hello ", undefined, null, "foo bar"])).toEqual(["hello", "foo bar"]);
  });

  it("applies cleanUiText", () => {
    expect(compactStrings(["后端未提供"])).toEqual(["尚未配置"]);
  });
});

describe("looksLikeDraftBody", () => {
  it("returns true for long text over 700 chars", () => {
    expect(looksLikeDraftBody("a".repeat(701))).toBe(true);
  });

  it("returns true for multi-paragraph text over 360 chars", () => {
    const text = Array(4).fill("a".repeat(100)).join("\n\n");
    expect(looksLikeDraftBody(text)).toBe(true);
  });

  it("returns false for short text", () => {
    expect(looksLikeDraftBody("short")).toBe(false);
  });
});

describe("extractDraftTitle", () => {
  it("returns null for undefined", () => {
    expect(extractDraftTitle(undefined)).toBeNull();
  });

  it("extracts title from heading", () => {
    expect(extractDraftTitle("# My Title")).toBe("My Title");
  });

  it("strips chapter prefix", () => {
    expect(extractDraftTitle("## 第三章 · 冲突升级")).toBe("冲突升级");
  });

  it("returns null for non-heading first line", () => {
    expect(extractDraftTitle("plain text")).toBeNull();
  });
});

// 书架相对时间标签（修「所有书永远显示刚刚」：此前 updatedAt 硬编码）
describe("formatRelativeTimeMs", () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0);

  it("1 分钟内 → 刚刚", () => {
    expect(formatRelativeTimeMs(now - 30_000, now)).toBe("刚刚");
  });

  it("分钟/小时/天分档", () => {
    expect(formatRelativeTimeMs(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatRelativeTimeMs(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(formatRelativeTimeMs(now - 2 * 86_400_000, now)).toBe("2 天前");
  });

  it("超过 30 天显示具体日期", () => {
    const label = formatRelativeTimeMs(now - 45 * 86_400_000, now);
    expect(label).toMatch(/2026/);
  });

  it("非法/零值兜底为「时间未知」——排序把 0 当最旧，标签不能装「刚刚」（评审加固）", () => {
    expect(formatRelativeTimeMs(0, now)).toBe("时间未知");
    expect(formatRelativeTimeMs(Number.NaN, now)).toBe("时间未知");
  });
});
