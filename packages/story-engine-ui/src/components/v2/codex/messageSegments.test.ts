import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../../../types.js";
import type { ToolStep } from "../../../api/types.js";
import { buildMessageRenderSegments } from "./messageSegments.js";

function step(id: string, label = "读取故事状态"): ToolStep {
  return { id, label, status: "completed", startedAt: 1, endedAt: 2 };
}

function msg(partial: Partial<ChapterMessage>): ChapterMessage {
  return { id: "a1", role: "assistant", content: "", ...partial };
}

describe("buildMessageRenderSegments", () => {
  it("无 segments 字段 / 空数组 → 按思考、工具、正文三桶拼", () => {
    expect(buildMessageRenderSegments(msg({ content: "你好" }))).toEqual([{ kind: "text", text: "你好" }]);
    expect(buildMessageRenderSegments(msg({ segments: [], thinking: "想", toolSteps: [step("c1")], content: "好" }))).toEqual([
      { kind: "reasoning", text: "想" },
      { kind: "tool", step: step("c1") },
      { kind: "text", text: "好" },
    ]);
  });

  it("reasoning→tool→text 按序解析，tool 段解析出对应 ToolStep", () => {
    const message = msg({
      content: "建议先写开场。",
      toolSteps: [step("c1")],
      segments: [
        { kind: "reasoning", text: "先读状态。" },
        { kind: "tool", toolCallId: "c1" },
        { kind: "text", text: "建议先写开场。" },
      ],
    });
    const out = buildMessageRenderSegments(message);
    expect(out).toEqual([
      { kind: "reasoning", text: "先读状态。" },
      { kind: "tool", step: step("c1") },
      { kind: "text", text: "建议先写开场。" },
    ]);
  });

  it("tool 段找不到对应 toolStep → 跳过（防御 race，不崩）", () => {
    const message = msg({
      toolSteps: [step("c1")],
      segments: [
        { kind: "tool", toolCallId: "c1" },
        { kind: "tool", toolCallId: "c-missing" },
        { kind: "text", text: "好了。" },
      ],
    });
    const out = buildMessageRenderSegments(message);
    expect(out).toEqual([
      { kind: "tool", step: step("c1") },
      { kind: "text", text: "好了。" },
    ]);
  });

  it("纯空白的 reasoning/text 段被跳过", () => {
    const message = msg({
      content: "正文。",
      segments: [
        { kind: "reasoning", text: "   " },
        { kind: "text", text: "正文。" },
        { kind: "text", text: "\n\n" },
      ],
    });
    expect(buildMessageRenderSegments(message)).toEqual([{ kind: "text", text: "正文。" }]);
  });

  it("segments 非空但全部解析为空（全空白+无匹配工具）→ 退回三桶，不丢正文", () => {
    const message = msg({
      content: "正文。",
      segments: [
        { kind: "reasoning", text: "  " },
        { kind: "tool", toolCallId: "nope" },
      ],
    });
    expect(buildMessageRenderSegments(message)).toEqual([{ kind: "text", text: "正文。" }]);
  });
});
