import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../types.js";
import { settlePendingDraftAgentCards } from "./draftAgentSettlement.js";

describe("draft agent settlement", () => {
  const pendingMessage: ChapterMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "已按要求修改草稿。黄色部分是本次 AI 改动，满意就保存草稿，不满意就拒绝改动。",
    agentCards: [{
      id: "card-1",
      kind: "draft",
      agentName: "draftEditAgent",
      status: "completed",
      title: "草稿已直接修改",
      summary: "已按用户要求修改左侧工作稿，等待保存或拒绝。",
      detail: [
        "route: draftEditAgent",
        "action: direct_edit",
        "target: current_draft",
        "write: 待保存草稿改动",
      ],
    }],
  };

  it("marks pending draft agent cards as saved and preserves route audit lines", () => {
    const [message] = settlePendingDraftAgentCards([pendingMessage], "saved");

    expect(message.content).toContain("本次 AI 工作稿改动已保存到当前章节工作稿。");
    expect(message.content).not.toContain("保存草稿，不满意就拒绝");
    expect(message.agentCards?.[0]).toMatchObject({
      status: "saved",
      title: "工作稿改动已保存",
      summary: "本次工作稿改动已保存到当前章节工作稿文件。",
    });
    expect(message.agentCards?.[0]?.detail).toEqual(expect.arrayContaining([
      "route: draftEditAgent",
      "action: direct_edit",
      "target: current_draft",
      "result: 已保存到当前章节工作稿",
    ]));
    expect(message.agentCards?.[0]?.detail).not.toContain("write: 待保存草稿改动");
  });

  it("marks pending draft agent cards as rejected", () => {
    const [message] = settlePendingDraftAgentCards([pendingMessage], "rejected");

    expect(message.content).toContain("本次 AI 工作稿改动已被拒绝");
    expect(message.agentCards?.[0]).toMatchObject({
      status: "rejected",
      title: "工作稿改动已拒绝",
    });
    expect(message.agentCards?.[0]?.detail).toContain("result: 已撤销到保存前内容");
  });

  it("marks generated draft cards as saved after draft save", () => {
    const generated: ChapterMessage = {
      id: "assistant-draft-1",
      role: "assistant",
      content: "草稿已写入左侧工作区，保存后写入 drafts/fast。",
      agentCards: [{
        id: "card-generated",
        kind: "draft",
        agentName: "draftAgent",
        status: "completed",
        title: "草稿生成完成",
        summary: "已生成第 2 章待保存草稿，保存后写入 drafts/fast。",
        detail: [
          "route: draftAgent",
          "write: 未写正式故事",
        ],
      }],
    };

    const [message] = settlePendingDraftAgentCards([generated], "saved");

    expect(message.content).toContain("本次 AI 工作稿改动已保存到当前章节工作稿。");
    expect(message.agentCards?.[0]).toMatchObject({
      status: "saved",
      title: "工作稿改动已保存",
    });
    expect(message.agentCards?.[0]?.detail).toContain("result: 已保存到当前章节工作稿");
    expect(message.agentCards?.[0]?.detail).not.toContain("write: 未写正式故事");
  });

  it("leaves already settled cards unchanged", () => {
    const settled: ChapterMessage = {
      ...pendingMessage,
      agentCards: pendingMessage.agentCards?.map((card) => ({ ...card, status: "saved" })),
    };

    expect(settlePendingDraftAgentCards([settled], "rejected")).toEqual([settled]);
  });
});
