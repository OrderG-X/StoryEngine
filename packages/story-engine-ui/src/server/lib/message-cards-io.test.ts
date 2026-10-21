// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readMessageCards } from "./message-cards-io.js";

describe("消息卡读回：出错卡（P11）", () => {
  it("原因跟着存、跟着读回；认不得的原因丢掉，不编", () => {
    expect(readMessageCards([{ type: "error", detail: "401 Unauthorized", reason: "auth" }])).toEqual([
      { type: "error", detail: "401 Unauthorized", reason: "auth" },
    ]);
    expect(readMessageCards([{ type: "error", detail: "x", reason: "坏值" }])).toEqual([{ type: "error", detail: "x" }]);
    expect(readMessageCards([{ type: "error" }])).toEqual([{ type: "error" }]);
  });
});
