// @vitest-environment node
import { describe, expect, it } from "vitest";
import { proposeCanonTool } from "./propose-canon.js";

describe("propose_canon 工具说明", () => {
  it("称呼写成名字；一条定论只调一次（换题材长篇实跑 2026-10-27）；交了这一轮就停", () => {
    const schema = proposeCanonTool.inputSchema as unknown as { shape: { canon: { description?: string } } };
    expect(schema.shape.canon.description).toContain("「我爸」「她妈」这类称呼写成那个人卡上的名字");
    expect(proposeCanonTool.description).toContain("一条定论调一次：卡出了就等作者点");
    expect(proposeCanonTool.description).toContain("绝不说『已改齐』");
  });
});
