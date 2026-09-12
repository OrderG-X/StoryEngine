import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../../../types.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";
import { latestTurnSuggestedActions } from "./suggestedActionRail.js";

function action(id: string, endpoint?: string): SuggestedAction {
  return {
    id,
    label: `label-${id}`,
    description: `desc-${id}`,
    permission: "safe_read",
    requiresConfirmation: false,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

function assistant(id: string, actions?: readonly SuggestedAction[]): ChapterMessage {
  return {
    id,
    role: "assistant",
    content: `回复-${id}`,
    ...(actions && actions.length > 0 ? { suggestedActions: actions } : {}),
  };
}

function user(id: string): ChapterMessage {
  return { id, role: "user", content: `提问-${id}` };
}

describe("latestTurnSuggestedActions（A-6 建议动作条取数）", () => {
  it("取「最后一轮」（最后一条用户消息之后）assistant 消息上的动作", () => {
    const messages = [
      user("u1"),
      assistant("a1", [action("undo-foundation-write", "undo-1")]),
    ];
    const rail = latestTurnSuggestedActions(messages);
    expect(rail.map((a) => a.id)).toEqual(["undo-foundation-write"]);
  });

  it("回合边界：撞上最后一条用户消息就停——旧回合的动作不残留", () => {
    const messages = [
      user("u1"),
      assistant("a1", [action("undo-foundation-write", "undo-1")]),
      user("u2"),
      assistant("a2"), // 新回合没有动作
    ];
    expect(latestTurnSuggestedActions(messages)).toEqual([]);
  });

  it("同一回合多条 assistant 消息的动作都收（诚实补丁 + 结果消息同轮）", () => {
    const messages = [
      user("u1"),
      assistant("a1", [action("commit-apply")]),
      assistant("a2", [action("undo-foundation-write", "undo-9")]),
    ];
    const rail = latestTurnSuggestedActions(messages);
    expect(rail.map((a) => a.id)).toEqual(["commit-apply", "undo-foundation-write"]);
  });

  it("retry-agent 不进条（气泡内错误卡已有就地入口）", () => {
    const messages = [
      user("u1"),
      assistant("a1", [action("retry-agent", "原始消息"), action("commit-apply")]),
    ];
    const rail = latestTurnSuggestedActions(messages);
    expect(rail.map((a) => a.id)).toEqual(["commit-apply"]);
  });

  it("按 id+endpoint 去重，新消息优先，展示顺序回到时间正序", () => {
    const messages = [
      user("u1"),
      assistant("a1", [action("undo-foundation-write", "undo-1"), action("commit-apply")]),
      assistant("a2", [action("undo-foundation-write", "undo-1")]), // 同 id+endpoint 重复 → 去重
      assistant("a3", [action("undo-foundation-write", "undo-2")]), // 同 id 不同 endpoint → 两条都留
    ];
    const rail = latestTurnSuggestedActions(messages);
    expect(rail.map((a) => `${a.id}:${a.endpoint ?? ""}`)).toEqual([
      "undo-foundation-write:undo-1",
      "commit-apply:",
      "undo-foundation-write:undo-2",
    ]);
  });

  it("空对话 / 全用户消息 / 无动作 → 空数组", () => {
    expect(latestTurnSuggestedActions([])).toEqual([]);
    expect(latestTurnSuggestedActions([user("u1")])).toEqual([]);
    expect(latestTurnSuggestedActions([user("u1"), assistant("a1")])).toEqual([]);
  });
});
