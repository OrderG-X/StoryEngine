// @vitest-environment node
import { describe, expect, it } from "vitest";
import { appendFactNoteToSummary } from "./commit-apply.js";

describe("appendFactNoteToSummary", () => {
  it("有硬事实摘要 → 折进入库摘要", () => {
    const out = appendFactNoteToSummary("第7章已定稿，资料已更新。", "这章记下 2 条硬事实（后文不得改写）。");
    expect(out).toContain("已定稿，资料已更新");
    expect(out).toContain("2 条硬事实");
  });
  it("空硬事实摘要 → 原样返回", () => {
    expect(appendFactNoteToSummary("第7章已定稿，资料已更新。", "")).toBe("第7章已定稿，资料已更新。");
  });
});
