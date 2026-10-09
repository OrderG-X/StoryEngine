import { describe, expect, it } from "vitest";

import { railActionsForFlow } from "./ChapterToolRail.js";

describe("railActionsForFlow B1 本章工具条按阶段确定性派生", () => {
  it("还没草稿 → 写本章 / 先给方案", () => {
    expect(railActionsForFlow("idle").map((a) => a.key)).toEqual(["draft", "steer"]);
    expect(railActionsForFlow("steering_ready").map((a) => a.key)).toEqual(["draft", "steer"]);
  });

  it("有草稿 → 核账 / 审稿 / 去AI味 / 定稿（2026-10-10：核账排第一，替下老的硬伤检查）", () => {
    expect(railActionsForFlow("draft_ready").map((a) => a.key)).toEqual(["continuity", "review", "deai", "commit"]);
    expect(railActionsForFlow("quality_checked").map((a) => a.key)).toContain("deai");
    expect(railActionsForFlow("waiting_commit_confirmation").map((a) => a.key)).toContain("commit");
  });

  it("已入库 → 写下一章", () => {
    expect(railActionsForFlow("committed").map((a) => a.key)).toEqual(["next"]);
    expect(railActionsForFlow("ready_for_next").map((a) => a.key)).toEqual(["next"]);
  });

  it("生成中 → 不显工具（agent 正忙）", () => {
    expect(railActionsForFlow("draft_generating")).toEqual([]);
  });

  it("每个动作都有非空中文意图（供 onSendMessage 发给 agent）", () => {
    for (const status of ["idle", "draft_ready", "committed"] as const) {
      for (const action of railActionsForFlow(status)) {
        expect(action.intent.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
