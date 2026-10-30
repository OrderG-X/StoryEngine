import { describe, expect, it } from "vitest";
import type { ChapterAgentCard } from "../../api/types.js";
import type { ChapterMessage } from "../../types.js";
import { buildTimelineModel, timelineStepStatusLabel } from "./agentTimelineModel.js";

function message(overrides: Partial<ChapterMessage>): ChapterMessage {
  return { id: "m1", role: "assistant", content: "回复正文", ...overrides };
}

describe("buildTimelineModel", () => {
  it("returns null when the message has no process data", () => {
    expect(buildTimelineModel(message({}))).toBeNull();
  });

  it("merges thinking, toolSteps, agentCards and toolOutput in order", () => {
    const model = buildTimelineModel(message({
      thinking: "先分析上下文",
      toolSteps: [
        { id: "t1", label: "读取故事状态", status: "completed", startedAt: 100, endedAt: 200 },
        { id: "t2", label: "调用模型", status: "completed", startedAt: 200, endedAt: 900 },
      ],
      agentCards: [{
        id: "a1", kind: "draft", agentName: "draftWriterAgent", status: "completed",
        title: "正文生成", summary: "按你的方向写当前章节草稿。",
        detail: ["route: draftWriterAgent", "confidence: 0.80", "会生成当前章节工作稿。"],
      }],
      toolOutput: ["已写入工作稿 1200 字"],
    }));
    expect(model).not.toBeNull();
    expect(model!.steps.map((step) => step.label)).toEqual([
      "AI 分析", "读取故事状态", "调用模型", "正文生成", "执行输出",
    ]);
    expect(model!.steps.every((step) => step.status === "completed")).toBe(true);
  });

  it("sorts toolSteps by startedAt ascending", () => {
    const model = buildTimelineModel(message({
      toolSteps: [
        { id: "t2", label: "调用模型", status: "completed", startedAt: 500, endedAt: 900 },
        { id: "t1", label: "读取故事状态", status: "completed", startedAt: 100, endedAt: 200 },
      ],
    }));
    expect(model!.steps.map((step) => step.id)).toEqual(["t1", "t2"]);
  });

  it("toolStep 状态 needs_confirmation → 整块 state=attention(待确认/暖色)，不是 completed(绿)（删角色待确认展示）", () => {
    const model = buildTimelineModel(message({
      toolSteps: [
        { id: "t1", label: "读取资料", status: "completed", startedAt: 100, endedAt: 200 },
        { id: "t2", label: "写入资料", status: "needs_confirmation", startedAt: 200, endedAt: 300 },
      ],
    }));
    expect(model!.state).toBe("attention");
    expect(model!.steps.find((step) => step.id === "t2")!.status).toBe("needs_confirmation");
    // 块级自动展开（非 completed 都展开，让用户看到「待确认」而非折叠成功态）。
    expect(model!.autoExpanded).toBe(true);
  });

  it("omits detail for an agent card with an empty summary", () => {
    const model = buildTimelineModel(message({
      agentCards: [{
        id: "a1", kind: "draft", agentName: "draftWriterAgent", status: "completed",
        title: "正文生成", summary: "",
      }],
    }));
    expect(model!.steps[0].detail).toBeUndefined();
  });

  it("strips route audit lines from agent card detail", () => {
    const model = buildTimelineModel(message({
      agentCards: [{
        id: "a1", kind: "draft", agentName: "draftWriterAgent", status: "completed",
        title: "正文生成", summary: "概要。",
        detail: ["route: x", "action: y", "target: z", "confidence: 0.8", "reason: r", "判断：走草稿", "普通说明行"],
      }],
    }));
    const step = model!.steps[0];
    expect(step.detail).toEqual(["概要。", "普通说明行"]);
  });

  it("maps agent card statuses to timeline statuses", () => {
    const statuses = {
      queued: "pending", running: "running", completed: "completed", saved: "completed",
      failed: "failed", blocked: "failed", rejected: "failed", needs_confirmation: "needs_confirmation",
    } as const;
    for (const [cardStatus, expected] of Object.entries(statuses)) {
      const model = buildTimelineModel(message({
        agentCards: [{
          id: "a1", kind: "draft", agentName: "draftWriterAgent",
          status: cardStatus as ChapterAgentCard["status"], title: "正文生成", summary: "",
        }],
      }));
      expect(model!.steps[0].status).toBe(expected);
    }
  });

  it("summarizes a fully completed run and collapses it", () => {
    const model = buildTimelineModel(message({
      toolSteps: [{ id: "t1", label: "读取故事状态", status: "completed", startedAt: 1, endedAt: 2 }],
      agentCards: [{ id: "a1", kind: "draft", agentName: "draftWriterAgent", status: "completed", title: "正文生成", summary: "" }],
    }));
    expect(model!.state).toBe("completed");
    expect(model!.autoExpanded).toBe(false);
    expect(model!.summary).toBe("正文生成 · 已完成 2 个步骤");
  });

  it("keeps a running timeline expanded and shows the current step", () => {
    const model = buildTimelineModel(message({
      toolSteps: [{ id: "t1", label: "调用模型", status: "running", startedAt: 1 }],
    }));
    expect(model!.state).toBe("running");
    expect(model!.autoExpanded).toBe(true);
    expect(model!.summary).toBe("执行过程 · 正在调用模型");
  });

  it("keeps a failed timeline expanded", () => {
    const model = buildTimelineModel(message({
      agentCards: [{ id: "a1", kind: "quality", agentName: "qualityAgent", status: "failed", title: "草稿质检", summary: "质检服务超时。" }],
    }));
    expect(model!.state).toBe("failed");
    expect(model!.autoExpanded).toBe(true);
    expect(model!.summary).toBe("硬伤检查 · 执行遇到问题");
  });

  it("prioritizes failed over running when both appear in the same message", () => {
    const model = buildTimelineModel(message({
      toolSteps: [{ id: "t1", label: "调用模型", status: "running", startedAt: 1 }],
      agentCards: [{ id: "a1", kind: "quality", agentName: "qualityAgent", status: "failed", title: "草稿质检", summary: "质检服务超时。" }],
    }));
    expect(model!.state).toBe("failed");
  });

  it("summarizes a completed formal commit with the real result, not a step count", () => {
    const model = buildTimelineModel(message({
      agentCards: [{
        id: "a1", kind: "commit", agentName: "commitApplyAgent", status: "completed",
        title: "正式入库完成", summary: "第 1 章已提交到正式故事状态。",
        detail: ["标题：第一章", "角色状态：1 项"],
      }],
    }));
    expect(model!.state).toBe("completed");
    expect(model!.summary).toBe("定稿 · 已定稿");
    expect(model!.summary).not.toContain("已完成 1 个步骤");
  });

  it("keeps a needs_confirmation timeline expanded and carries primaryActionId", () => {
    const model = buildTimelineModel(message({
      agentCards: [{
        id: "a1", kind: "foundation", agentName: "foundationAgent", status: "needs_confirmation",
        title: "资料写入", summary: "等待确认写入。", primaryActionId: "apply-foundation",
      }],
    }));
    expect(model!.state).toBe("attention");
    expect(model!.autoExpanded).toBe(true);
    expect(model!.steps[0].primaryActionId).toBe("apply-foundation");
  });

  it("有 turnSnapshots → canUndo=true，undoSnapshotId 取首个（整块回退点）", () => {
    const m = buildTimelineModel({
      id: "x", role: "assistant", content: "",
      agentCards: [{ id: "c", kind: "commit", agentName: "commitApplyAgent", status: "completed", title: "定稿", summary: "" }],
      turnSnapshots: [{ toolName: "commit_apply", snapshotId: "a".repeat(40) }, { toolName: "foundation_write", snapshotId: "b".repeat(40) }],
      affectedScopes: ["full", "foundation"], turnStartedAt: 1000, turnEndedAt: 4200,
    });
    expect(m?.canUndo).toBe(true);
    expect(m?.undoSnapshotId).toBe("a".repeat(40));
    expect(m?.affectedLabel).toBe("设定本·正文·工作稿");
    expect(m?.totalElapsedMs).toBe(3200);
  });

  it("无 turnSnapshots → canUndo=false（纯读/草稿回合不可块级撤销）", () => {
    const m = buildTimelineModel({ id: "y", role: "assistant", content: "", toolSteps: [{ id: "s", label: "读取", status: "completed", startedAt: 1, endedAt: 2 }] });
    expect(m?.canUndo).toBe(false);
    expect(m?.undoSnapshotId).toBeUndefined();
  });

  it("intentTitle 透传到模型块头", () => {
    const m = buildTimelineModel({
      id: "z", role: "assistant", content: "",
      intentTitle: "把第3段改冷峻",
      toolSteps: [{ id: "s", label: "润色", status: "completed", startedAt: 1, endedAt: 2 }],
    });
    expect(m?.intentTitle).toBe("把第3段改冷峻");
  });
});

describe("stopped 步骤的时间线归并（A-5）", () => {
  it("含 stopped 步 → state=attention 且摘要说「已停止」（不说「待确认/已完成」）", () => {
    const model = buildTimelineModel(message({
      toolSteps: [
        { id: "a", label: "读取", toolName: "read_state_overview", status: "completed", startedAt: 1, endedAt: 2 },
        { id: "b", label: "生成正文", toolName: "change_draft", status: "stopped", startedAt: 3, endedAt: 4 },
      ],
    }))!;
    expect(model.state).toBe("attention");
    expect(model.summary).toContain("已停止");
  });

  it("stopped 与 failed 并存 → failed 优先（真失败如实报失败）", () => {
    const model = buildTimelineModel(message({
      toolSteps: [
        { id: "a", label: "生成正文", toolName: "change_draft", status: "stopped", startedAt: 1, endedAt: 2 },
        { id: "b", label: "质检", toolName: "quality_check", status: "failed", startedAt: 3, endedAt: 4 },
      ],
    }))!;
    expect(model.state).toBe("failed");
  });

  it("timelineStepStatusLabel 如实翻译 stopped", () => {
    expect(timelineStepStatusLabel("stopped")).toBe("已停止");
  });

  it("timelineStepStatusLabel 如实翻译 verdict（裁决未过，不混进失败/停止）", () => {
    expect(timelineStepStatusLabel("verdict")).toBe("裁决未过");
  });

  // 复审 T4 三轮：verdict 步是落定形态——不把时间线整体态拖进 failed/attention，按 completed 收口。
  it("含 verdict 步 → state=completed（否定裁决不是失败、不需要引导注意）", () => {
    const model = buildTimelineModel(message({
      toolSteps: [
        { id: "a", label: "定稿预览", toolName: "commit_preview", status: "verdict", startedAt: 1, endedAt: 2 },
        { id: "b", label: "建议下一步", toolName: "suggest_next_steps", status: "completed", startedAt: 3, endedAt: 4 },
      ],
    }))!;
    expect(model.state).toBe("completed");
  });
});
