import { describe, expect, it } from "vitest";
import { suggestedAction, withAuthorButton } from "./workflowHelpers.js";

describe("suggestedAction", () => {
  it("returns action with correct label", () => {
    expect(suggestedAction("generate-steering").label).toBe("生成本章方案");
    expect(suggestedAction("quality-check").label).toBe("硬伤检查");
    expect(suggestedAction("prune-confirm").label).toBe("确认裁剪");
  });

  it("falls back to generate-steering for unknown id", () => {
    expect(suggestedAction("nonexistent" as any).id).toBe("generate-steering");
  });
});

describe("withAuthorButton（同一种作者档按钮一轮只摆一个）", () => {
  it("裁剪这类一轮只有一个的：后来的换掉先前的", () => {
    const before = { ...suggestedAction("prune-confirm"), pruneTarget: { keep: 30 } };
    const after = { ...suggestedAction("prune-confirm"), pruneTarget: { keep: 50 } };
    expect(withAuthorButton([before], after)).toEqual([after]);
  });
});
