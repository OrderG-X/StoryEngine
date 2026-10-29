import { describe, expect, it } from "vitest";
import type { OperationViewData } from "../api/agentChatClient.js";
import { agentFlowStatusForTool, flowAfterOperation } from "./agentFlowStatus.js";

describe("agentFlowStatusForTool", () => {
  it("方向方案 → steering_ready", () => {
    expect(agentFlowStatusForTool("generate_chapter_steering", {}, "idle")).toBe("steering_ready");
  });

  it("改稿 → draft_ready", () => {
    expect(agentFlowStatusForTool("revise_draft", {}, "quality_checked")).toBe("draft_ready");
  });

  it("写稿做完了（操作）：换上了工作稿 → draft_ready（重写已定稿的章也是）；留成候选、没做成的不推", () => {
    const op = (applied: boolean | undefined, state: OperationViewData["state"] = "succeeded"): OperationViewData => ({
      opId: "op-0123456789abcdef0123", kind: "draft.change", mode: "write", chapter: 3, what: "写稿", state, stateText: "", allowed: [], summary: "", eventSeq: 1, origin: { kind: "chat" },
      ...(applied !== undefined ? { draft: { chapter: 3, applied } } : {}),
    });
    expect(flowAfterOperation(op(true), "draft_generating")).toBe("draft_ready");
    expect(flowAfterOperation(op(true), "committed")).toBe("draft_ready");
    expect(flowAfterOperation(op(false), "draft_generating")).toBe("draft_generating");
    expect(flowAfterOperation(op(undefined, "failed"), "steering_ready")).toBe("steering_ready");
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
    expect(agentFlowStatusForTool("revise_draft", { ok: false }, "steering_ready")).toBe("steering_ready");
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
