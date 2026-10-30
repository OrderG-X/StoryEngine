import { describe, expect, it } from "vitest";
import type { OperationViewData } from "../api/agentChatClient.js";
import { agentFlowStatusForTool, flowAfterOperation } from "./agentFlowStatus.js";

describe("agentFlowStatusForTool", () => {
  it("方向方案 → steering_ready", () => {
    expect(agentFlowStatusForTool("generate_chapter_steering", {}, "idle")).toBe("steering_ready");
  });

  it("写稿做完了（操作）：换上了工作稿 → draft_ready（重写已定稿的章也是）；留成候选、没做成的不推", () => {
    const op = (applied: boolean | undefined, state: OperationViewData["state"] = "succeeded"): OperationViewData => ({
      opId: "op-0123456789abcdef0123", kind: "draft.change", mode: "write", chapter: 3, what: "写稿", state, stateText: "", allowed: [], summary: "", conclusion: "", eventSeq: 1, origin: { kind: "chat" },
      ...(applied !== undefined ? { draft: { chapter: 3, applied } } : {}),
    });
    expect(flowAfterOperation(op(true), "draft_generating")).toBe("draft_ready");
    expect(flowAfterOperation(op(true), "committed")).toBe("draft_ready");
    expect(flowAfterOperation(op(false), "draft_generating")).toBe("draft_generating");
    expect(flowAfterOperation(op(undefined, "failed"), "steering_ready")).toBe("steering_ready");
  });

  it("硬伤检查 / 内容审阅做完（操作）→ quality_checked；核账、查 AI 味、没做成的不推；已定稿不退", () => {
    const op = (mode: string, state: OperationViewData["state"] = "succeeded"): OperationViewData => ({
      opId: "op-0123456789abcdef0123", kind: "inspect.run", mode, chapter: 3, what: "检查", state, stateText: "", allowed: [], summary: "", conclusion: "", eventSeq: 1, origin: { kind: "chat" },
    });
    expect(flowAfterOperation(op("quality"), "draft_ready")).toBe("quality_checked");
    expect(flowAfterOperation(op("review"), "draft_ready")).toBe("quality_checked");
    expect(flowAfterOperation(op("continuity"), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("flavor"), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("quality", "failed"), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("quality"), "committed")).toBe("committed");
  });

  it("定稿（操作）：出了清单等作者点 → waiting_commit_confirmation（已定稿不往回拨）；定成了 → committed；定不了、没做完的不推", () => {
    const op = (state: OperationViewData["state"], committed?: boolean): OperationViewData => ({
      opId: "op-0123456789abcdef0123", kind: "commit.prepare", chapter: 3, what: "定稿", state, stateText: "", allowed: [], summary: "", conclusion: "", eventSeq: 1, origin: { kind: "chat" },
      ...(committed !== undefined ? { commit: { chapter: 3, committed } } : {}),
    });
    expect(flowAfterOperation(op("waiting_author"), "quality_checked")).toBe("waiting_commit_confirmation");
    expect(flowAfterOperation(op("waiting_author"), "committed")).toBe("committed");
    expect(flowAfterOperation(op("succeeded", true), "waiting_commit_confirmation")).toBe("committed");
    expect(flowAfterOperation(op("succeeded", false), "draft_ready")).toBe("draft_ready");
    expect(flowAfterOperation(op("obsolete"), "waiting_commit_confirmation")).toBe("waiting_commit_confirmation");
    expect(flowAfterOperation(op("running"), "draft_ready")).toBe("draft_ready");
  });

  it("工具失败（ok:false）不推进——不把失败当进度", () => {
    expect(agentFlowStatusForTool("generate_chapter_steering", { ok: false }, "idle")).toBe("idle");
  });

  it("读类/资料类/体检类工具不改本章生命周期", () => {
    for (const t of ["read_state_overview", "read_foundation", "foundation_write", "check_ai_flavor"]) {
      expect(agentFlowStatusForTool(t, {}, "draft_ready")).toBe("draft_ready");
    }
  });
});
