import { describe, expect, it } from "vitest";
import { operationCaption, runningAgentCard } from "./operationCaption.js";

describe("operationCaption 不走对话的操作也要看得见", () => {
  it("认识的操作给人话，不认识的给通用说法，没有操作给 null", () => {
    expect(operationCaption("reroll-candidates")).toBe("正在再写一版");
    expect(operationCaption("something-new")).toBe("正在处理");
    expect(operationCaption(null)).toBeNull();
    expect(operationCaption("selection-rewrite-polish")).toBe("正在润色选中的段落");
  });

  it("找出进行中的卡", () => {
    expect(runningAgentCard([{ status: "done" }, { status: "running", title: "x" }])?.title).toBe("x");
    expect(runningAgentCard([{ status: "done" }])).toBeNull();
    expect(runningAgentCard(undefined)).toBeNull();
  });
});
