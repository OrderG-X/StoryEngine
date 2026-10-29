import { describe, expect, it } from "vitest";
import { runningAgentCard } from "./operationCaption.js";

describe("runningAgentCard", () => {
  it("找出进行中的卡", () => {
    expect(runningAgentCard([{ status: "done" }, { status: "running", title: "x" }])?.title).toBe("x");
    expect(runningAgentCard([{ status: "done" }])).toBeNull();
    expect(runningAgentCard(undefined)).toBeNull();
  });
});
