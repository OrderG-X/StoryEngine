import { describe, expect, it } from "vitest";
import {
  suggestedAction,
  actionsForWorkflowState,
  workflowPromptText,
  verdictLabel,
  ensureWorkflowPrompt,
  createWorkflowMessage,
  suggestedActionForPendingAction,
  describePendingChapterAction,
} from "./workflowHelpers.js";

describe("入库确认引导文案（R3#1-5·与可靠触发措辞一致）", () => {
  it("预览/待确认态引导用『确认正式入库』(单说『确认入库』模型常不触发 commit_apply)", () => {
    expect(workflowPromptText("commit_preview_ready")).toContain("确认定稿");
    expect(workflowPromptText("waiting_commit_confirmation")).toContain("确认定稿");
  });
});

describe("suggestedAction", () => {
  it("returns action with correct label", () => {
    expect(suggestedAction("generate-steering").label).toBe("生成本章方案");
    expect(suggestedAction("quality-check").label).toBe("硬伤检查");
    expect(suggestedAction("commit-apply").label).toBe("确认定稿");
  });

  it("falls back to generate-steering for unknown id", () => {
    expect(suggestedAction("nonexistent" as any).id).toBe("generate-steering");
  });
});

describe("actionsForWorkflowState", () => {
  it("returns 7 actions for idle state", () => {
    expect(actionsForWorkflowState("idle")).toHaveLength(7);
  });

  it("disables quality-check when idle", () => {
    const actions = actionsForWorkflowState("idle");
    const qc = actions.find((a) => a.id === "quality-check");
    expect(qc?.disabledReason).toBe("请先生成工作稿。");
  });

  it("has no disabled reasons for draft_ready quality-check", () => {
    const actions = actionsForWorkflowState("draft_ready");
    const qc = actions.find((a) => a.id === "quality-check");
    expect(qc?.disabledReason).toBeUndefined();
  });
});

describe("workflowPromptText", () => {
  it("returns prompt for each state", () => {
    expect(workflowPromptText("idle")).toContain("读取");
    expect(workflowPromptText("committed")).toContain("已定稿");
    expect(workflowPromptText("draft_generating")).toContain("正在生成");
  });
});

describe("verdictLabel", () => {
  it("labels each verdict", () => {
    expect(verdictLabel("ready_to_commit")).toBe("内容审阅通过");
    expect(verdictLabel("needs_minor_revision")).toBe("建议小修");
    expect(verdictLabel("needs_major_revision")).toBe("建议大修");
    expect(verdictLabel("blocked")).toBe("暂不建议定稿");
  });
});

describe("ensureWorkflowPrompt", () => {
  it("appends workflow message when none has suggestedActions", () => {
    const messages = [{ id: "m1", content: "hello" }];
    const result = ensureWorkflowPrompt(messages, "idle");
    expect(result.length).toBe(2);
    expect(result[1]).toHaveProperty("suggestedActions");
  });

  it("does not duplicate when suggestedActions exist", () => {
    const messages = [{ id: "m1", suggestedActions: [actionsForWorkflowState("idle")[0]] }];
    expect(ensureWorkflowPrompt(messages, "idle")).toHaveLength(1);
  });
});

describe("createWorkflowMessage", () => {
  it("creates message with role and suggestedActions", () => {
    const msg = createWorkflowMessage("idle");
    expect(msg.role).toBe("assistant");
    expect(msg.suggestedActions.length).toBeGreaterThan(0);
  });

  it("uses custom content when provided", () => {
    const msg = createWorkflowMessage("idle", "custom");
    expect(msg.content).toBe("custom");
  });
});

describe("suggestedActionForPendingAction", () => {
  it("maps action types", () => {
    expect(suggestedActionForPendingAction({ type: "generate_steering" }).id).toBe("generate-steering");
    expect(suggestedActionForPendingAction({ type: "commit_apply" }).id).toBe("commit-apply");
    expect(suggestedActionForPendingAction({ type: "unknown" }).id).toBe("generate-steering");
  });
});

describe("describePendingChapterAction", () => {
  it("returns description for each type", () => {
    expect(describePendingChapterAction({ type: "generate_steering", direction: "向前" })).toContain("本章方案");
    expect(describePendingChapterAction({ type: "commit_apply" })).toContain("直接定稿");
    expect(describePendingChapterAction({ type: "unknown" })).toBe("正在执行操作。");
  });
});
