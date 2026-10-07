import { describe, expect, it } from "vitest";
import { stripMarkdownEmphasis } from "../fast-draft-writer.js";

describe("stripMarkdownEmphasis：正文里的 Markdown 粗体记号去掉、原文保留", () => {
  it("成对 ** / __ 去掉", () => {
    expect(stripMarkdownEmphasis("底下一行：**九号，西侧，二层。爷爷图上写了。**")).toBe("底下一行：九号，西侧，二层。爷爷图上写了。");
    expect(stripMarkdownEmphasis("他说__别动__。")).toBe("他说别动。");
  });

  it("单个星号、跨行、空包不动", () => {
    expect(stripMarkdownEmphasis("* * *")).toBe("* * *");
    expect(stripMarkdownEmphasis("**开头\n结尾**")).toBe("**开头\n结尾**");
    expect(stripMarkdownEmphasis("****")).toBe("****");
  });
});
