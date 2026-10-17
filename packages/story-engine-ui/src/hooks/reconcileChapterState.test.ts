import { describe, expect, it } from "vitest";

import { flowStatusAfterGenerateFailure } from "./reconcileChapterState.js";

describe("flowStatusAfterGenerateFailure 出稿失败时复位卡死的「正在生成草稿」", () => {
  it("卡在 draft_generating + 已有草稿内容（流式落了一截/原有草稿）→ draft_ready，别再谎称正在生成", () => {
    expect(flowStatusAfterGenerateFailure("draft_generating", true)).toBe("draft_ready");
  });

  it("卡在 draft_generating + 一字未出 → idle，回到起点（不谎称有草稿）", () => {
    expect(flowStatusAfterGenerateFailure("draft_generating", false)).toBe("idle");
  });

  it("不在 draft_generating（失败发生在别的流程态）→ 返回 null、绝不乱改", () => {
    expect(flowStatusAfterGenerateFailure("draft_ready", true)).toBeNull();
    expect(flowStatusAfterGenerateFailure("committed", false)).toBeNull();
    expect(flowStatusAfterGenerateFailure("idle", false)).toBeNull();
    expect(flowStatusAfterGenerateFailure("quality_checked", true)).toBeNull();
  });
});
