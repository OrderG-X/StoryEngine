// @vitest-environment node
import { describe, expect, it } from "vitest";
import { settleFactTool } from "./settle-fact.js";

describe("settle_fact 工具说明", () => {
  it("称呼写成名字；一条定论只调一次（换题材长篇实跑 2026-10-27）", () => {
    const schema = settleFactTool.inputSchema as unknown as { shape: { canon: { description?: string } } };
    expect(schema.shape.canon.description).toContain("「我爸」「她妈」这类称呼写成那个人卡上的名字");
    expect(settleFactTool.description).toContain("一条定论调一次：卡出了就等作者点");
  });
});
