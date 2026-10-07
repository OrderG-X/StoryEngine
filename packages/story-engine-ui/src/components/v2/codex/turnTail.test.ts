import { describe, expect, it } from "vitest";
import type { ToolStep } from "../../../api/types.js";
import { turnTailSummary } from "./turnTail.js";
import type { FoldedRenderItem } from "./processLogFold.js";

const step = (toolName: string, status: ToolStep["status"], detail?: string): ToolStep => ({
  id: `${toolName}-1`, label: toolName, toolName, status, startedAt: 1, ...(detail ? { detail } : {}),
});

describe("turnTailSummary 回合收尾一句话", () => {
  it("出完稿就结束、没再说话 → 显示出稿工具的原话", () => {
    const items: FoldedRenderItem[] = [
      { kind: "text", text: "现在出第一章。" },
      { kind: "tool", step: step("generate_draft", "completed", "第 1 章已生成正文并写入工作稿。") },
    ];
    expect(turnTailSummary(items, true)).toBe("第 1 章已生成正文并写入工作稿。");
  });

  it("聚合成「操作记录」时取其中最后一个工具；失败也照实显示", () => {
    const items: FoldedRenderItem[] = [
      { kind: "process", steps: [
        { kind: "tool", step: step("foundation_write", "completed", "已写入") },
        { kind: "reasoning", text: "想一下" },
        { kind: "tool", step: step("revise_draft", "failed", "改稿没成功：定位不到原句。") },
      ] },
    ];
    expect(turnTailSummary(items, true)).toBe("改稿没成功：定位不到原句。");
  });

  it("回合还在进行 / 最后是正文 / 读类或自带卡片的工具 / 没结果文字 → 不补", () => {
    const tail = (s: ToolStep): FoldedRenderItem[] => [{ kind: "tool", step: s }];
    expect(turnTailSummary(tail(step("generate_draft", "completed", "x")), false)).toBeNull();
    expect(turnTailSummary([{ kind: "tool", step: step("generate_draft", "completed", "x") }, { kind: "text", text: "好了" }], true)).toBeNull();
    expect(turnTailSummary(tail(step("read_foundation", "completed", "x")), true)).toBeNull();
    expect(turnTailSummary(tail(step("commit_apply", "completed", "x")), true)).toBeNull();
    expect(turnTailSummary(tail(step("generate_draft", "completed")), true)).toBeNull();
    expect(turnTailSummary(tail(step("generate_draft", "running", "x")), true)).toBeNull();
  });
});
