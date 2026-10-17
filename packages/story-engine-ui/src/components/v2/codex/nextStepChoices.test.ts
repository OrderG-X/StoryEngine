import { describe, expect, it } from "vitest";
import { lastAssistantNextStepPrompt } from "./nextStepChoices.js";
import type { ChapterMessage } from "../../../types.js";

function msg(partial: Partial<ChapterMessage> & Pick<ChapterMessage, "id" | "role">): ChapterMessage {
  return { content: "", ...partial } as ChapterMessage;
}

describe("lastAssistantNextStepPrompt（下一步选项卡只来自 agent 提议）", () => {
  it("取最近 assistant 消息的提议，recommended→primary", () => {
    const messages = [
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1", role: "assistant", cards: [{ type: "next-steps", prompt: {
        question: "这章入库了，接下来？",
        choices: [
          { label: "先补地点和资产", intent: "帮我把地点和资产补上", recommended: true },
          { label: "开始写第二章", intent: "开始写第二章" },
        ],
      } }] }),
    ];
    const p = lastAssistantNextStepPrompt(messages);
    expect(p?.question).toBe("这章入库了，接下来？");
    expect(p?.choices[0]).toEqual({ label: "先补地点和资产", intent: "帮我把地点和资产补上", primary: true });
    expect(p?.choices[1]).toEqual({ label: "开始写第二章", intent: "开始写第二章" });
  });

  it("最近 assistant 消息没提议 → null（不出选项卡，不翻更老的消息）", () => {
    const messages = [
      msg({ id: "a0", role: "assistant", cards: [{ type: "next-steps", prompt: { question: "旧的", choices: [{ label: "x", intent: "x" }] } }] }),
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1", role: "assistant", content: "好的。" }), // 最近一条无提议
    ];
    expect(lastAssistantNextStepPrompt(messages)).toBeNull();
  });

  it("没有 assistant 消息 → null", () => {
    expect(lastAssistantNextStepPrompt([msg({ id: "u1", role: "user" })])).toBeNull();
    expect(lastAssistantNextStepPrompt([])).toBeNull();
  });

  it("choice 带 action（R4.7：服务端生成的确定性选项）→ 原样透传，点击侧据此直发结构化动作", () => {
    const messages = [
      msg({ id: "a1", role: "assistant", cards: [{ type: "next-steps", prompt: {
        question: "核账做完了，接下来？",
        choices: [
          { label: "预览定稿", intent: "预览第 5 章的定稿改动", recommended: true, action: { toolName: "commit_preview", chapter: 5 } },
          { label: "我自己改", intent: "我自己改，先放着" },
        ],
      } }] }),
    ];
    const p = lastAssistantNextStepPrompt(messages);
    expect(p?.choices[0]).toEqual({
      label: "预览定稿",
      intent: "预览第 5 章的定稿改动",
      primary: true,
      action: { toolName: "commit_preview", chapter: 5 },
    });
    // 模型生成的选项没有 action，照旧只带 label/intent——点击走发文本的老路。
    expect(p?.choices[1]).toEqual({ label: "我自己改", intent: "我自己改，先放着" });
    expect(p?.choices[1]).not.toHaveProperty("action");
  });
});
