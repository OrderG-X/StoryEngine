import { describe, expect, it } from "vitest";
import type { ToolStep } from "../../../api/types.js";
import { foldTurn, processWorthShowing, summarizeProcess } from "./processLogFold.js";
import type { RenderSegment } from "./messageSegments.js";

function tool(id: string, status: ToolStep["status"] = "completed", toolName = id): ToolStep {
  return { id, label: id, status, startedAt: 1, endedAt: 2, toolName };
}

const labelOf = (step: ToolStep) => step.label;

describe("foldTurn：一轮回复拆成过程和答复", () => {
  it("最后一个工具之后的正文是答复；之前的旁白、思考、工具都进过程", () => {
    const segments: RenderSegment[] = [
      { kind: "reasoning", text: "想一下" },
      { kind: "text", text: "我先读一下正文。" },
      { kind: "tool", step: tool("read") },
      { kind: "text", text: "定位到了。" },
      { kind: "tool", step: tool("revise") },
      { kind: "reasoning", text: "再想" },
      { kind: "text", text: "改好了。" },
    ];
    expect(foldTurn(segments)).toEqual({
      process: [
        { kind: "reasoning", text: "想一下" },
        { kind: "narration", text: "我先读一下正文。" },
        { kind: "tool", step: tool("read") },
        { kind: "narration", text: "定位到了。" },
        { kind: "tool", step: tool("revise") },
        { kind: "reasoning", text: "再想" },
      ],
      answer: ["改好了。"],
    });
  });

  it("做成了的「建议下一步」不占一步，它前面的正文照样是答复；没成功的照样进过程", () => {
    const done: RenderSegment[] = [
      { kind: "tool", step: tool("revise") },
      { kind: "text", text: "改好了。" },
      { kind: "tool", step: tool("s", "completed", "suggest_next_steps") },
    ];
    expect(foldTurn(done)).toEqual({ process: [{ kind: "tool", step: tool("revise") }], answer: ["改好了。"] });

    const failed: RenderSegment[] = [
      { kind: "text", text: "改好了。" },
      { kind: "tool", step: tool("s", "failed", "suggest_next_steps") },
    ];
    expect(foldTurn(failed)).toEqual({
      process: [{ kind: "narration", text: "改好了。" }, { kind: "tool", step: tool("s", "failed", "suggest_next_steps") }],
      answer: [],
    });
  });

  it("自带卡片的工具不算分界：服务端在模型说完后补发的核账，不把模型的答复收进过程", () => {
    const segments: RenderSegment[] = [
      { kind: "text", text: "现在出第 3 章。" },
      { kind: "tool", step: tool("g", "completed", "generate_draft") },
      { kind: "text", text: "第 3 章写好了，3012 字。" },
      { kind: "tool", step: tool("c", "completed", "check_continuity") },
      { kind: "text", text: "核了第 3 章：没发现问题。" },
    ];
    expect(foldTurn(segments)).toEqual({
      process: [
        { kind: "narration", text: "现在出第 3 章。" },
        { kind: "tool", step: tool("g", "completed", "generate_draft") },
        { kind: "tool", step: tool("c", "completed", "check_continuity") },
      ],
      answer: ["第 3 章写好了，3012 字。", "核了第 3 章：没发现问题。"],
    });
  });

  it("没调工具：正文都是答复，只有思考进过程", () => {
    expect(foldTurn([{ kind: "reasoning", text: "想" }, { kind: "text", text: "你好" }])).toEqual({
      process: [{ kind: "reasoning", text: "想" }],
      answer: ["你好"],
    });
  });
});

describe("summarizeProcess：收起那一行", () => {
  it("点名两样事，多了说等 N 步；同名工具只点一次", () => {
    const two = [{ kind: "tool" as const, step: tool("读稿") }, { kind: "tool" as const, step: tool("读稿") }, { kind: "tool" as const, step: tool("改稿") }];
    expect(summarizeProcess(two, labelOf, false).label).toBe("读稿、改稿");
    const many = [...two, { kind: "tool" as const, step: tool("核账") }];
    expect(summarizeProcess(many, labelOf, false).label).toBe("读稿、改稿 等 4 步");
    expect(summarizeProcess([{ kind: "reasoning", text: "想" }], labelOf, false).label).toBe("思考过程");
  });

  it("没成功的步数照实数出来；进行中报正在做的那步", () => {
    const steps = [{ kind: "tool" as const, step: tool("改稿", "failed") }, { kind: "tool" as const, step: tool("核账", "running") }];
    const live = summarizeProcess(steps, labelOf, true);
    expect(live.failed).toBe(1);
    expect(live.current).toBe("核账");
    expect(summarizeProcess([...steps, { kind: "reasoning", text: "想" }], labelOf, true).current).toBe("在想");
    expect(summarizeProcess(steps, labelOf, false).current).toBeNull();
  });
});

describe("processWorthShowing：卡片已经说清的单步不再挂一行", () => {
  const cards = new Set(["continuity"]);
  const step = (status: ToolStep["status"]) => [{ kind: "tool" as const, step: tool("c", status, "check_continuity") }];
  it("只点了核账、做成了、卡在 → 不显示", () => {
    expect(processWorthShowing(step("completed"), cards, false)).toBe(false);
  });
  it("没成功 / 还在跑 / 卡没来 / 不止一步 / 有思考 → 照样显示", () => {
    expect(processWorthShowing(step("failed"), cards, false)).toBe(true);
    expect(processWorthShowing(step("completed"), cards, true)).toBe(true);
    expect(processWorthShowing(step("completed"), new Set(), false)).toBe(true);
    expect(processWorthShowing([...step("completed"), ...step("completed")], cards, false)).toBe(true);
    expect(processWorthShowing([{ kind: "reasoning", text: "想" }], cards, false)).toBe(true);
    expect(processWorthShowing([], cards, false)).toBe(false);
  });
});
