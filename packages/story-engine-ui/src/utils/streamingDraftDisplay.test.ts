import { describe, expect, it } from "vitest";
import { streamingDraftDisplay } from "./streamingDraftDisplay.js";

describe("streamingDraftDisplay：流式期间不在稿纸顶上露出 Markdown 标题行", () => {
  it("标题行没写完 → 先不显示", () => {
    expect(streamingDraftDisplay("# 第一章 · 退回")).toBe("");
  });
  it("标题行写完 → 整行去掉，正文照常", () => {
    expect(streamingDraftDisplay("# 第一章 · 退回的挂号信\n\n下午两点四十分。")).toBe("下午两点四十分。");
    expect(streamingDraftDisplay("\n# 第一章\n下午")).toBe("下午");
  });
  it("没有标题行 → 原样", () => {
    expect(streamingDraftDisplay("下午两点四十分。\n\n# 不是开头")).toBe("下午两点四十分。\n\n# 不是开头");
  });
});
