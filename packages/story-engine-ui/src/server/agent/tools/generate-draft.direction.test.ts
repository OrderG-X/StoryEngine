// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authorGaveNoDirection } from "./generate-draft.js";

// 第十八轮：作者每章只说「写第 N 章，接着上一章往下走」，助手却自拟一大段「方向」塞给章纲，章纲当作者原话照办。
describe("authorGaveNoDirection", () => {
  it("只说了写哪章 / 接着写 → 没给方向", () => {
    for (const text of ["写第 3 章，接着上一章往下走。", "继续写", "写下一章吧", "好的，写第十章。", "开始写正文"]) {
      expect(authorGaveNoDirection(text)).toBe(true);
    }
  });

  it("有具体内容、或指向前面商量过的方向 → 算给了方向；缺原话不判", () => {
    for (const text of ["写第 5 章，让林溪回来", "按你说的写第 6 章", "写第7章，节奏快一点"]) {
      expect(authorGaveNoDirection(text)).toBe(false);
    }
    expect(authorGaveNoDirection(undefined)).toBe(false);
  });
});
