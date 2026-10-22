import { describe, expect, it } from "vitest";
import type { ToolStep } from "../../../api/types.js";
import { turnTailSummary } from "./turnTail.js";
import type { TurnFold } from "./processLogFold.js";

const step = (toolName: string, status: ToolStep["status"], detail?: string): ToolStep => ({
  id: `${toolName}-1`, label: toolName, toolName, status, startedAt: 1, ...(detail ? { detail } : {}),
});

const onlyProcess = (...steps: ToolStep[]): TurnFold => ({ process: steps.map((s) => ({ kind: "tool" as const, step: s })), answer: [] });

describe("turnTailSummary 回合收尾一句话", () => {
  it("出完稿就结束、没再说话 → 显示出稿工具的原话", () => {
    const fold: TurnFold = {
      process: [{ kind: "narration", text: "现在出第一章。" }, { kind: "tool", step: step("generate_draft", "completed", "第 1 章已生成正文并写入工作稿。") }],
      answer: [],
    };
    expect(turnTailSummary(fold, true)).toBe("第 1 章已生成正文并写入工作稿。");
  });

  it("取最后一个工具，后面跟着思考也一样；失败也照实显示", () => {
    const fold: TurnFold = {
      process: [
        { kind: "tool", step: step("foundation_write", "completed", "已写入") },
        { kind: "tool", step: step("revise_draft", "failed", "改稿没成功：定位不到原句。") },
        { kind: "reasoning", text: "想一下" },
      ],
      answer: [],
    };
    expect(turnTailSummary(fold, true)).toBe("改稿没成功：定位不到原句。");
  });

  it("出完稿后服务端补发了核账、模型没说话 → 报出稿那步，不报核账", () => {
    expect(turnTailSummary(onlyProcess(step("generate_draft", "completed", "第 3 章写好了。"), step("check_continuity", "completed", "核了第 3 章：……")), true))
      .toBe("第 3 章写好了。");
  });

  it("回合还在进行 / 已有答复 / 读类或自带卡片的工具 / 没结果文字 → 不补", () => {
    expect(turnTailSummary(onlyProcess(step("generate_draft", "completed", "x")), false)).toBeNull();
    expect(turnTailSummary({ ...onlyProcess(step("generate_draft", "completed", "x")), answer: ["好了"] }, true)).toBeNull();
    expect(turnTailSummary(onlyProcess(step("read_foundation", "completed", "x")), true)).toBeNull();
    expect(turnTailSummary(onlyProcess(step("commit_apply", "completed", "x")), true)).toBeNull();
    expect(turnTailSummary(onlyProcess(step("generate_draft", "completed")), true)).toBeNull();
    expect(turnTailSummary(onlyProcess(step("generate_draft", "running", "x")), true)).toBeNull();
  });
});
