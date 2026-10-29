import { describe, expect, it } from "vitest";
import type { OperationViewData } from "../api/agentChatClient.js";
import { agentFlowStatusForTool, flowAfterOperation, nextFlowAfterToolResult } from "./agentFlowStatus.js";

describe("nextFlowAfterToolResult 出稿失败收尾（含 ok=false 守卫拒绝走 tool-result 这条路）", () => {
  it("generate_draft ok=false + 卡在 draft_generating + 有草稿 → draft_ready（绝不停在「正在生成草稿」谎报）", () => {
    expect(nextFlowAfterToolResult("generate_draft", { ok: false }, "draft_generating", true)).toBe("draft_ready");
  });

  it("generate_draft ok=false + 卡在 draft_generating + 一字未出 → idle", () => {
    expect(nextFlowAfterToolResult("generate_draft", { ok: false }, "draft_generating", false)).toBe("idle");
  });

  it("generate_draft 成功 → 照常推进 draft_ready", () => {
    expect(nextFlowAfterToolResult("generate_draft", {}, "draft_generating", true)).toBe("draft_ready");
  });

  it("失败但不在 draft_generating（如还在 steering_ready 就被拒）→ 照旧不推进、不乱改", () => {
    expect(nextFlowAfterToolResult("generate_draft", { ok: false }, "steering_ready", false)).toBe("steering_ready");
  });

  it("其它工具结果照旧委托 agentFlowStatusForTool", () => {
    expect(nextFlowAfterToolResult("commit_apply", { committed: true }, "waiting_commit_confirmation", true)).toBe("committed");
    expect(nextFlowAfterToolResult("read_foundation", {}, "draft_ready", true)).toBe("draft_ready");
  });
});

describe("agentFlowStatusForTool", () => {
  it("方向方案 → steering_ready", () => {
    expect(agentFlowStatusForTool("generate_chapter_steering", {}, "idle")).toBe("steering_ready");
  });

  it("出稿/改稿 → draft_ready", () => {
    expect(agentFlowStatusForTool("generate_draft", {}, "steering_ready")).toBe("draft_ready");
    expect(agentFlowStatusForTool("revise_draft", {}, "quality_checked")).toBe("draft_ready");
  });

  it("硬伤检查 / 内容审阅做完（操作）→ quality_checked；核账、查 AI 味、没做成的不推；已定稿不退", () => {
    const op = (mode: string, state: OperationViewData["state"] = "succeeded"): OperationViewData => ({
      opId: "op-0123456789abcdef0123", kind: "inspect.run", mode, chapter: 3, what: "检查", state, stateText: "", allowed: [], summary: "", eventSeq: 1, origin: { kind: "chat" },
    });
    expect(flowAfterOperation(op("quality"), "draft_ready")).toBe("quality_checked");
    expect(flowAfterOperation(op("review"), "draft_ready")).toBe("quality_checked");
    expect(flowAfterOperation(op("continuity"), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("flavor"), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("quality", "failed"), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("quality"), "committed")).toBe("committed");
  });

  it("预览入库 → waiting_commit_confirmation", () => {
    expect(agentFlowStatusForTool("commit_preview", {}, "quality_checked")).toBe("waiting_commit_confirmation");
  });

  it("入库成功（committed=true）→ committed；未成功保持原状", () => {
    expect(agentFlowStatusForTool("commit_apply", { committed: true }, "waiting_commit_confirmation")).toBe("committed");
    expect(agentFlowStatusForTool("commit_apply", { committed: false }, "waiting_commit_confirmation")).toBe("waiting_commit_confirmation");
  });

  it("入库 ok:false 时即便 committed 字段异常为 true 也不推进（防御性一致）", () => {
    expect(agentFlowStatusForTool("commit_apply", { committed: true, ok: false }, "waiting_commit_confirmation")).toBe("waiting_commit_confirmation");
  });

  it("工具失败（ok:false）不推进——不把失败当进度", () => {
    expect(agentFlowStatusForTool("generate_draft", { ok: false }, "steering_ready")).toBe("steering_ready");
    expect(agentFlowStatusForTool("quality_check", { ok: false }, "draft_ready")).toBe("draft_ready");
    expect(agentFlowStatusForTool("commit_preview", { ok: false }, "quality_checked")).toBe("quality_checked");
  });

  it("已入库后，打磨/预览类工具不把状态往回拨", () => {
    expect(agentFlowStatusForTool("quality_check", {}, "committed")).toBe("committed");
    expect(agentFlowStatusForTool("commit_preview", {}, "committed")).toBe("committed");
    expect(agentFlowStatusForTool("ai_review", {}, "ready_for_next")).toBe("ready_for_next");
  });

  it("读类/资料类/体检类工具不改本章生命周期", () => {
    for (const t of ["read_state_overview", "read_foundation", "foundation_write", "check_ai_flavor"]) {
      expect(agentFlowStatusForTool(t, {}, "draft_ready")).toBe("draft_ready");
    }
  });
});
