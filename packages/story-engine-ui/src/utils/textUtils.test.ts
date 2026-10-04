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
    expect(cleanUiText("chapter_1_committed")).toBe("第1章已定稿");
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

// 长跑 2026-10-04 #5 复核钉测：三口径（AI 读稿 read_draft.charCount / UI 写作区 countTextWords /
// 引擎定稿执法 countDraftChineseCharacters）必须同字符集。两侧分属 UI/引擎两个包，靠字符串/正则各自维护——
// 本测试用边缘字符文本把两边钉在一起：任何一侧单独改字符集（比如加回 〇/扩展B、或换 \p{Script=Han}）
// 都会在此红，防止「三口径打架」回归（真机第 2 章 2989 纯汉字被 AI 报成 3616 的根因）。
describe("countTextWords 与引擎执法口径同源（长跑 #5 跨包契约）", () => {
  it("边缘字符文本：countTextWords(全文) === 引擎 countDraftChineseCharacters(去标题正文)", async () => {
    const { countDraftChineseCharacters } = await import("@actalk/story-engine");
    const body =
      "檐角的铜铃轻响，他说：“先记下来。”\n" + // 常规汉字 + 全/半角标点 + 引号
      "㐀䶵㒱㥯赹\n" + // 扩展 A 区（\u3400-\u4DBF，属于 [\u3400-\u9fff]）
      "〇㈠<pre>标签</pre>42hello world\n" + // 〇 U+3007（\p{Script=Han} 认、本口径不认）+ 括号字 + 西文数字
      "𠀀𠀁"; // 扩展 B（U+20000+，surrogate pair，两口径都不认）
    const fullText = `---\ntitle: 标题不该计数\n---\n# 第1章 章节标题同样不该计\n\n${body}\n`;
    const uiCount = countTextWords(fullText);
    const engineCount = countDraftChineseCharacters(body); // 引擎执法侧收到的是去标题正文
    expect(uiCount).toBe(engineCount);
    // 明确钉住字符集语义本身（不是同假）：常规汉字与扩展 A 区（㐀䶵㒱㥯赹）计、〇（U+3007）与
    // 扩展 B（𠀀）不计、frontmatter/标题/西文数字不计。20 = 13（檐角…来）+ 5（扩展A）+ 2（标签）。
    expect(uiCount).toBe(20);
    expect(countTextWords("〇𠀀𠀁")).toBe(0);
    expect(countTextWords("㐀䶵")).toBe(2);
  });

  it("口径统一去标点去标题：含标点全字符口径（旧 read_draft 行为）必大于纯汉字口径", async () => {
    const { countDraftChineseCharacters } = await import("@actalk/story-engine");
    const draft = "# 第1章 标题\n\n他站在门口，风把信纸吹得沙沙作响。\n";
    const legacyNoWhitespace = draft.replace(/\s/gu, "").length; // 旧 read_draft「去空白全字符」
    expect(countTextWords(draft)).toBe(countDraftChineseCharacters("他站在门口，风把信纸吹得沙沙作响。"));
    expect(countTextWords(draft)).toBeLessThan(legacyNoWhitespace); // 旧口径把标点+标题都计入（#5 元凶）
  });
});
