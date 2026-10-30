import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../types.js";
import { newDraftAction, type OperationViewData } from "../api/agentChatClient.js";
import {
  emptyAssistantMessage,
  presentationFor,
  resolveToolStepLabel,
  projectAgentEvent,
  settleUnfinishedAgentTurn,
  type AgentProjectionEvent,
} from "./agentEventProjection.js";
import { cardOf } from "../utils/messageCards.js";

function project(events: readonly AgentProjectionEvent[], seed?: ChapterMessage): ChapterMessage {
  let message = seed ?? emptyAssistantMessage("assistant-1");
  for (const event of events) {
    message = projectAgentEvent(message, event);
  }
  return message;
}

describe("projectAgentEvent", () => {
  it("creates an empty assistant message with the given id", () => {
    const message = emptyAssistantMessage("assistant-x");
    expect(message).toEqual({ id: "assistant-x", role: "assistant", content: "" });
  });

  it("accumulates text-delta events into content in order", () => {
    const message = project([
      { type: "text-delta", text: "你好" },
      { type: "text-delta", text: "，" },
      { type: "text-delta", text: "我看了一下。" },
    ]);
    expect(message.content).toBe("你好，我看了一下。");
    // 纯文本对话不产生工具步骤。
    expect(message.toolSteps ?? []).toEqual([]);
  });

  it("accumulates reasoning-delta events into thinking, separate from content", () => {
    const message = project([
      { type: "reasoning-delta", text: "先看看" },
      { type: "reasoning-delta", text: "当前章节状态…" },
      { type: "text-delta", text: "好的，我来写。" },
    ]);
    expect(message.thinking).toBe("先看看当前章节状态…");
    expect(message.content).toBe("好的，我来写。");
  });

  it("pushes a running toolStep on tool-call and maps a known tool to its agentName", () => {
    const message = project([
      { type: "tool-call", toolCallId: "call-1", toolName: "read_state_overview", startedAt: 1000 },
    ]);
    expect(message.toolSteps).toHaveLength(1);
    const step = message.toolSteps![0];
    expect(step.id).toBe("call-1");
    expect(step.status).toBe("running");
    expect(step.startedAt).toBe(1000);
    expect(step.endedAt).toBeUndefined();
    // agentCard 命中 agentTimelineModel 的 agentDisplayLabel 字典（stateOverviewReader → 资料助手）。
    expect(message.agentCards).toHaveLength(1);
    const card = message.agentCards![0];
    expect(card.agentName).toBe("stateOverviewReader");
    expect(card.status).toBe("running");
  });

  it("marks the matching toolStep and agentCard completed on tool-result", () => {
    const message = project([
      { type: "tool-call", toolCallId: "call-1", toolName: "read_state_overview", startedAt: 1000 },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_state_overview",
        endedAt: 1500,
        output: { summary: "写到第 2 章。", refreshScope: "full", overview: {} },
      },
    ]);
    const step = message.toolSteps![0];
    expect(step.status).toBe("completed");
    expect(step.endedAt).toBe(1500);
    expect(message.agentCards![0].status).toBe("completed");
  });

  it("改设定（change_settings，老会话里的 foundation_write）只出步骤「改设定本」，不再出卡（结论在操作卡上）", () => {
    for (const toolName of ["change_settings", "foundation_write"]) {
      const message = project([{ type: "tool-call", toolCallId: "call-2", toolName, startedAt: 1 }]);
      expect(message.toolSteps![0].label).toBe("改设定本");
      expect(message.agentCards ?? []).toEqual([]);
    }
  });

  it("interleaves text and tool steps for a read-then-write run", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "read_state_overview", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read_state_overview",
        endedAt: 20,
        output: { summary: "读到了。", refreshScope: "full", overview: {} },
      },
      { type: "tool-call", toolCallId: "c2", toolName: "foundation_write", startedAt: 30 },
      {
        type: "tool-result",
        toolCallId: "c2",
        toolName: "foundation_write",
        endedAt: 40,
        output: { summary: "记下了。", refreshScope: "foundation", snapshotId: "snap-1", overview: {} },
      },
      { type: "text-delta", text: "已经帮你记好了。" },
    ]);
    expect(message.content).toBe("已经帮你记好了。");
    expect(message.toolSteps!.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(message.toolSteps!.every((s) => s.status === "completed")).toBe(true);
    expect(message.agentCards!.map((c) => c.agentName)).toEqual(["stateOverviewReader"]);
  });

  it("marks the matching toolStep failed and the card failed on tool-error", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "read_state_overview", startedAt: 10 },
      { type: "tool-error", toolCallId: "c1", toolName: "read_state_overview", endedAt: 20, error: "读盘失败" },
    ]);
    expect(message.toolSteps![0].status).toBe("failed");
    expect(message.toolSteps![0].endedAt).toBe(20);
    expect(message.agentCards![0].status).toBe("failed");
  });

  it("出完稿这一轮别的工具没让执行（skipped）：步骤「已停止」、不当失败也不当裁决未过，不挂定稿预览卡", () => {
    const message = project([
      { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "p1",
        toolName: "commit_preview",
        endedAt: 20,
        output: { ok: false, skipped: true, summary: "这一轮已经写好第 25 章的工作稿，这一步先不做，等作者看完稿再说。" },
      },
    ]);
    expect(message.toolSteps![0]).toMatchObject({ status: "stopped", detail: "这一轮已经写好第 25 章的工作稿，这一步先不做，等作者看完稿再说。" });
    expect(cardOf(message, "commit-preview")).toBeUndefined();
  });

  it("marks the toolStep FAILED when a tool result reports ok:false (结构性防谎报)", () => {
    const message = project([
      { type: "tool-call", toolCallId: "d1", toolName: "generate_draft", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "d1",
        toolName: "generate_draft",
        endedAt: 20,
        output: { ok: false, summary: "第 1 章出稿未通过，未写入工作稿：正文过短。", refreshScope: "full", overview: {} },
      },
    ]);
    // 即使 agent 文本可能幻觉「已写入 1800 字」，工具步骤必须按真实 ok:false 置 failed，不显示成完成。
    expect(message.toolSteps![0].status).toBe("failed");
    expect(message.toolSteps![0].endedAt).toBe(20);
  });

  it("keeps the toolStep COMPLETED when a tool result reports ok:true (写类成功)", () => {
    const message = project([
      { type: "tool-call", toolCallId: "d2", toolName: "generate_draft", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "d2",
        toolName: "generate_draft",
        endedAt: 20,
        output: { ok: true, summary: "第 1 章已生成正文并写入工作稿。", refreshScope: "full", overview: {} },
      },
    ]);
    expect(message.toolSteps![0].status).toBe("completed");
  });

  it("falls back to a generic step label for an unknown tool but never crashes", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "some_future_tool", startedAt: 1 },
    ]);
    expect(message.toolSteps![0].status).toBe("running");
    expect(typeof message.toolSteps![0].label).toBe("string");
    // 未知工具不强行造一张能命中字典的卡（避免误导渲染），但也不报错。
    expect(message.toolSteps![0].label.length).toBeGreaterThan(0);
  });

  it("tool-result 带 snapshotId → 回写进 turnSnapshots（块级撤销的回合↔快照映射）", () => {
    let msg = emptyAssistantMessage("m1");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "t1", toolName: "commit_apply", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "t1",
      toolName: "commit_apply",
      endedAt: 2,
      output: { ok: true, snapshotId: "a".repeat(40), refreshScope: "full" },
    });
    expect(msg.turnSnapshots).toEqual([{ toolName: "commit_apply", snapshotId: "a".repeat(40) }]);
    expect(msg.affectedScopes).toEqual(["full"]);
  });

  it("tool-result 带 chapter → turnSnapshots entry 记下 chapterNumber（撤销写回该回合实际操作的章）", () => {
    // 单聊天走天涯后用户可能在第5章撤销一个属于第1章的回合：撤销须按回合实际操作的章（chapter:1）写回，
    // 而非当前停留章。工具回报的 chapter 透传→回写进 turnSnapshots entry 的 chapterNumber。
    let msg = emptyAssistantMessage("m-chapter");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "t1", toolName: "commit_apply", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "t1",
      toolName: "commit_apply",
      endedAt: 2,
      output: { ok: true, snapshotId: "a".repeat(40), refreshScope: "full", chapter: 5 },
    });
    expect(msg.turnSnapshots).toEqual([
      { toolName: "commit_apply", snapshotId: "a".repeat(40), chapterNumber: 5 },
    ]);
  });

  it("tool-result 不带 chapter → turnSnapshots entry 无 chapterNumber 字段（旧快照退化当前章）", () => {
    let msg = emptyAssistantMessage("m-no-chapter");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "t1", toolName: "commit_apply", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "t1",
      toolName: "commit_apply",
      endedAt: 2,
      output: { ok: true, snapshotId: "a".repeat(40), refreshScope: "full" },
    });
    expect(msg.turnSnapshots).toEqual([{ toolName: "commit_apply", snapshotId: "a".repeat(40) }]);
    expect(msg.turnSnapshots![0]).not.toHaveProperty("chapterNumber");
  });

  it("读类工具无 snapshotId → 不产生 turnSnapshots（纯读回合不可撤销）", () => {
    let msg = emptyAssistantMessage("m2");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "t1", toolName: "read_state_overview", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "t1",
      toolName: "read_state_overview",
      endedAt: 2,
      output: { refreshScope: "full" },
    });
    expect(msg.turnSnapshots).toBeUndefined();
    // #2 守卫：read_state_overview 有 refreshScope:"full" 但无 snapshotId（纯读、没写盘），
    // 不得污染 affectedScopes，否则块头会误标「正文·草稿 已完成」（agentTimelineModel.affectedLabelFromScopes）。
    expect(msg.affectedScopes).toBeUndefined();
  });

  it("foundation 写盘（snapshotId + refreshScope:foundation）→ affectedScopes 含 foundation", () => {
    let msg = emptyAssistantMessage("m3");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "f1", toolName: "foundation_write", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "f1",
      toolName: "foundation_write",
      endedAt: 2,
      output: { ok: true, snapshotId: "b".repeat(40), refreshScope: "foundation" },
    });
    expect(msg.turnSnapshots).toEqual([{ toolName: "foundation_write", snapshotId: "b".repeat(40) }]);
    expect(msg.affectedScopes).toEqual(["foundation"]);
  });

  it("generate_draft 出稿（refreshScope:full、无 snapshotId=草稿待保存）→ affectedScopes 含 full 徽标在、但无撤销点", () => {
    // 回归护栏：generate_draft/revise_draft 是「草稿待保存、不建 git 快照」→ 无 snapshotId 但确实影响正文·草稿。
    // 影响范围徽标必须按「是否只读工具」判定，不能用 snapshotId（那会误伤无快照的出稿回合，让「正文·草稿」徽标消失）。
    let msg = emptyAssistantMessage("m4");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "g1",
      toolName: "generate_draft",
      endedAt: 2,
      output: { ok: true, summary: "第 1 章已生成正文并写入工作稿。", refreshScope: "full" },
    });
    expect(msg.affectedScopes).toEqual(["full"]); // 徽标「正文·草稿」在
    expect(msg.turnSnapshots).toBeUndefined(); // 草稿不进 git → 无「撤销到此」(既有设计)
  });

  it("commit_apply 入库被拒(ok:false+refused) → 步骤 failed、不挂「撤销到此」、不染「影响范围」(H2 防假撤销/假徽标)", () => {
    // 真因：withSnapshot 写前无条件建快照、强并 snapshotId，即便引擎诚实拒绝(committed:false/refused:true)。
    // 若仍据 snapshotId 挂撤销点+据 refreshScope 染徽标，用户会看到「正文·草稿 已撤销点」却啥也没入库，
    // 点假撤销还会把提问删掉+整页刷。守卫：ok===false 的回合不记 turnSnapshots、不染 affectedScopes。
    let msg = emptyAssistantMessage("h2-commit");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "c1", toolName: "commit_apply", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "c1",
      toolName: "commit_apply",
      endedAt: 2,
      output: { ok: false, summary: "未入库：尚未对该章 commit_preview。", snapshotId: "c".repeat(40), refreshScope: "full" },
    });
    expect(msg.toolSteps![0].status).toBe("failed");
    expect(msg.turnSnapshots).toBeUndefined();
    expect(msg.affectedScopes).toBeUndefined();
  });

  it("foundation_write 目标缺失全跳过(ok:false、无 needsConfirmation) → 步骤 failed、不挂「撤销到此」、不染「影响范围」(H1/M2)", () => {
    let msg = emptyAssistantMessage("h1-fw");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "f1", toolName: "foundation_write", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "f1",
      toolName: "foundation_write",
      endedAt: 2,
      output: { ok: false, summary: "本次没有写入任何内容（目标缺失，已跳过）。", snapshotId: "d".repeat(40), refreshScope: "foundation" },
    });
    expect(msg.toolSteps![0].status).toBe("failed");
    expect(msg.turnSnapshots).toBeUndefined();
    expect(msg.affectedScopes).toBeUndefined();
  });

  it("foundation_write 需用户确认(needsConfirmation:true) → 步骤「待确认」(暖色 pending,不是失败/红、不是绿色完成)、不挂「撤销到此」、不染「影响范围」(Codex 删确认展示)", () => {
    // 删角色未确认时工具回 needsConfirmation:true/ok:false。步骤须显示「待确认」(timelineState→attention 暖色),
    // 不能绿色「已完成」(谎报)、也别一律红「失败」(它不是错、是等你确认)。
    let msg = emptyAssistantMessage("needs-confirm");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "f1", toolName: "foundation_write", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "f1",
      toolName: "foundation_write",
      endedAt: 2,
      output: {
        ok: false,
        needsConfirmation: true,
        summary: "删除角色「顾明」需要你先确认——目前没有删除任何内容。",
        snapshotId: "e".repeat(40),
        refreshScope: "foundation",
      },
    });
    expect(msg.toolSteps![0].status).toBe("needs_confirmation");
    expect(msg.turnSnapshots).toBeUndefined(); // 没真删 → 不挂「撤销到此」
    expect(msg.affectedScopes).toBeUndefined(); // 没真删 → 不染「影响范围」
  });

  it("工具 ok:false 落 failed（没有「裁决未过」这一档了：定稿是一次操作，定不了的原因在清单上）", () => {
    let msg = emptyAssistantMessage("read-fail");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "a1", toolName: "read_draft", startedAt: 1 });
    msg = projectAgentEvent(msg, { type: "tool-result", toolCallId: "a1", toolName: "read_draft", endedAt: 2, output: { ok: false, summary: "第 99 章没有工作稿。" } });
    expect(msg.toolSteps![0].status).toBe("failed");
    expect(msg.toolSteps![0].detail).toBe("第 99 章没有工作稿。");
  });

  it("R7.9：Mastra 校验失败（toolValidationFailure）→ 步骤落 failed、summary 进详情，点开不再空", () => {
    // 服务端 agent-chat normalizeForwardedToolResult 归一后的形状：ok:false + 中文 summary + 标记。
    let msg = emptyAssistantMessage("draft-validation-fail");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "g1",
      toolName: "generate_draft",
      endedAt: 78,
      output: { ok: false, toolValidationFailure: true, summary: "AI 传的参数没通过校验（mustHitBeats），这一步没有执行，具体原因已回给 AI 处理。" },
    });
    const step = msg.toolSteps![0];
    expect(step.status).toBe("failed");
    expect(step.label).toBe("生成正文");
    expect(step.detail).toContain("没通过校验");
    // 裁决类工具的校验失败也不是 verdict：工具根本没跑，没有「裁决」。
    let preview = emptyAssistantMessage("preview-validation-fail");
    preview = projectAgentEvent(preview, { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 1 });
    preview = projectAgentEvent(preview, {
      type: "tool-result",
      toolCallId: "p1",
      toolName: "commit_preview",
      endedAt: 2,
      output: { ok: false, toolValidationFailure: true, summary: "AI 传的参数没通过校验（chapter），这一步没有执行，具体原因已回给 AI 处理。" },
    });
    expect(preview.toolSteps![0].status).toBe("failed");
  });

  it("R7.9：failed 却没带 summary 的工具结果 → 详情兜底一句话，失败步骤仍可展开（不编成功也不留空）", () => {
    let msg = emptyAssistantMessage("fail-no-summary");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "f1", toolName: "generate_draft", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "f1",
      toolName: "generate_draft",
      endedAt: 2,
      output: { ok: false },
    });
    expect(msg.toolSteps![0].status).toBe("failed");
    expect(msg.toolSteps![0].detail).toBeTruthy();
    // 非失败状态不带兜底（没说失败的绝不编原因）。
    let ok = emptyAssistantMessage("ok-no-summary");
    ok = projectAgentEvent(ok, { type: "tool-call", toolCallId: "o1", toolName: "read_state_overview", startedAt: 1 });
    ok = projectAgentEvent(ok, { type: "tool-result", toolCallId: "o1", toolName: "read_state_overview", endedAt: 2, output: {} });
    expect(ok.toolSteps![0].detail).toBeUndefined();
  });

  it("status 事件（R4）→ 挂状态说明卡照实展示，且不污染助手正文", () => {
    const msg = project([
      { type: "status", text: "对话历史较长，本次只把最近 12 条发给模型。" },
      { type: "text-delta", text: "我看了一下。" },
    ]);
    expect(cardOf(msg, "status-notes")?.notes).toEqual(["对话历史较长，本次只把最近 12 条发给模型。"]);
    expect(msg.content).toBe("我看了一下。");
  });

  it("usage 事件 → 挂到这条回复上（作者看得见每轮用了多少 token），不进正文", () => {
    const msg = project([
      { type: "text-delta", text: "第 8 章写好了。" },
      { type: "usage", usage: { input: 155000, cachedInput: 106000, output: 9000 } },
    ]);
    expect(msg.tokenUsage).toEqual({ input: 155000, cachedInput: 106000, output: 9000 });
    expect(msg.content).toBe("第 8 章写好了。");
  });

  it("多条 status 事件按序累加（R4）", () => {
    const msg = project([
      { type: "status", text: "第一条说明。" },
      { type: "status", text: "第二条说明。" },
    ]);
    expect(cardOf(msg, "status-notes")?.notes).toEqual(["第一条说明。", "第二条说明。"]);
  });

  it("generate_draft 出稿被拒(ok:false、无 snapshotId) → 步骤 failed 且不染「正文·草稿」徽标(M4)", () => {
    let msg = emptyAssistantMessage("m4-fail");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "g1",
      toolName: "generate_draft",
      endedAt: 2,
      output: { ok: false, summary: "第 1 章出稿未通过：正文过短。", refreshScope: "full" },
    });
    expect(msg.toolSteps![0].status).toBe("failed");
    expect(msg.affectedScopes).toBeUndefined();
    expect(msg.turnSnapshots).toBeUndefined();
  });
});

describe("projectAgentEvent — 有序分段 segments（时间线跟着对话走）", () => {
  it("连续 reasoning-delta 并进同一个 reasoning 段", () => {
    const message = project([
      { type: "reasoning-delta", text: "先看看" },
      { type: "reasoning-delta", text: "状态…" },
    ]);
    expect(message.segments).toEqual([{ kind: "reasoning", text: "先看看状态…" }]);
    // 旧三桶保留（向后兼容）。
    expect(message.thinking).toBe("先看看状态…");
  });

  it("连续 text-delta 并进同一个 text 段", () => {
    const message = project([
      { type: "text-delta", text: "你好" },
      { type: "text-delta", text: "，写好了。" },
    ]);
    expect(message.segments).toEqual([{ kind: "text", text: "你好，写好了。" }]);
    expect(message.content).toBe("你好，写好了。");
  });

  it("tool-call 追加一个 tool 段（只引用 toolCallId）；tool-result 不再产生新段", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "read_state_overview", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read_state_overview",
        endedAt: 20,
        output: { summary: "读到了。", refreshScope: "full", overview: {} },
      },
    ]);
    expect(message.segments).toEqual([{ kind: "tool", toolCallId: "c1" }]);
    // 工具详情仍在 toolSteps（settle 不受影响）。
    expect(message.toolSteps![0].status).toBe("completed");
  });

  it("同一 toolCallId 的重复 tool-call 不重复追加 tool 段（防御重复事件）", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "read_state_overview", startedAt: 10 },
      { type: "tool-call", toolCallId: "c1", toolName: "read_state_overview", startedAt: 10 },
    ]);
    expect(message.segments).toEqual([{ kind: "tool", toolCallId: "c1" }]);
  });

  it("真实多工具回合：想→调工具→再想→答→再调工具→答 的精确分段顺序", () => {
    // 对照实测 story-cbf77f：reasoning → 两工具 → reasoning(大头) → text → 工具 → text。
    const message = project([
      { type: "reasoning-delta", text: "先读状态和资料。" },
      { type: "tool-call", toolCallId: "c1", toolName: "read_foundation", startedAt: 1 },
      { type: "tool-call", toolCallId: "c2", toolName: "read_state_overview", startedAt: 2 },
      { type: "tool-result", toolCallId: "c1", toolName: "read_foundation", endedAt: 3, output: { summary: "ok" } },
      { type: "tool-result", toolCallId: "c2", toolName: "read_state_overview", endedAt: 4, output: { summary: "ok", refreshScope: "full", overview: {} } },
      { type: "reasoning-delta", text: "看完了，接下来适合写开场。" },
      { type: "text-delta", text: "建议先写开场冲突。" },
      { type: "tool-call", toolCallId: "c3", toolName: "suggest_next_steps", startedAt: 5 },
      { type: "tool-result", toolCallId: "c3", toolName: "suggest_next_steps", endedAt: 6, output: { summary: "ok" } },
      { type: "reasoning-delta", text: "再补一句。" },
      { type: "text-delta", text: "需要我直接出稿吗？" },
    ]);
    expect(message.segments).toEqual([
      { kind: "reasoning", text: "先读状态和资料。" },
      { kind: "tool", toolCallId: "c1" },
      { kind: "tool", toolCallId: "c2" },
      { kind: "reasoning", text: "看完了，接下来适合写开场。" },
      { kind: "text", text: "建议先写开场冲突。" },
      { kind: "tool", toolCallId: "c3" },
      { kind: "reasoning", text: "再补一句。" },
      { kind: "text", text: "需要我直接出稿吗？" },
    ]);
    // 向后兼容：三桶仍是各自拼接/聚合的全量。
    expect(message.content).toBe("建议先写开场冲突。需要我直接出稿吗？");
    expect(message.thinking).toBe("先读状态和资料。看完了，接下来适合写开场。再补一句。");
    expect(message.toolSteps!.map((s) => s.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("presentationFor — 全部 32 工具块体详情人话标签（时间线不露英文）", () => {
  // 时间线里「调用工具 · XX」要和整套中文 UI 对齐，story-agent.ts 注册的每个工具
  // 都得有中文 stepLabel；漏一个就会回退到生硬的「执行 generate_worldbuilding」。
  // 这份清单与 story-agent.ts 的 tools 注册一一对应（新增工具两边都要补）。
  const EXPECTED_STEP_LABELS: Record<string, string> = {
    read_state_overview: "查看当前进度",
    read_chapters_overview: "看章节",
    read_timeline: "看时间线",
    read_foundation: "查设定本",
    read_draft: "读稿",
    foundation_write: "改设定本",
    generate_worldbuilding: "补全世界观",
    generate_asset_enrichment: "补全道具与资源",
    generate_location_enrichment: "补全地点",
    generate_character_enrichment: "补全角色",
    generate_matrix_enrichment: "补全角色关系",
    generate_character_relationships: "整理角色关系",
    generate_writing_rules_enrichment: "重新整理写作规则",
    generate_alias_table: "补全别名表",
    generate_chapter_steering: "拟章纲",
    generate_draft: "生成正文",
    revise_draft: "改稿",
    quality_check: "硬伤检查",
    ai_review: "内容审阅",
    check_ai_flavor: "检查机器腔",
    commit_preview: "定稿预览",
    commit_apply: "定稿",
    edit_fact_ledger: "记录故事事实",
    suggest_next_steps: "建议下一步",
    set_foreshadowing_importance: "调整线索轻重",
    resolve_thread: "收口单条线索",
    clean_legacy_threads: "清理历史线索",
    group_related_leads: "归并线索",
    manage_style_exemplars: "管理文风样本",
    undo_last_change: "撤销上一步",
    prune_snapshots: "裁剪操作历史",
    web_search: "联网查资料",
  };

  it("commit_apply 的块体步骤标签是『正式入库』（人话，不是 执行 commit_apply）", () => {
    expect(presentationFor("commit_apply").stepLabel).toBe("定稿");
  });

  it("全部 32 个注册工具有人话 stepLabel（一律不回退到 执行 ${toolName} 英文）", () => {
    expect(Object.keys(EXPECTED_STEP_LABELS)).toHaveLength(32);
    for (const [toolName, label] of Object.entries(EXPECTED_STEP_LABELS)) {
      const stepLabel = presentationFor(toolName).stepLabel;
      expect(stepLabel).toBe(label);
      expect(stepLabel.startsWith("执行 ")).toBe(false); // 绝不露英文兜底
    }
  });

  it("生成正文/润色改写经投影后 step.label 即人话（块体详情可读）", () => {
    const draft = project([
      { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 1 },
    ]);
    expect(draft.toolSteps![0].label).toBe("生成正文");
    const revise = project([
      { type: "tool-call", toolCallId: "r1", toolName: "revise_draft", startedAt: 1 },
    ]);
    expect(revise.toolSteps![0].label).toBe("改稿");
  });

  it("card 仅保留 read_state_overview；其余工具 card:null（不强造误导卡）", () => {
    expect(presentationFor("read_state_overview").card).not.toBeNull();
    for (const toolName of [
      "foundation_write",
      "change_settings",
      "read_foundation",
      "generate_chapter_steering",
      "generate_draft",
      "revise_draft",
      "quality_check",
      "ai_review",
      "commit_preview",
      "commit_apply",
    ]) {
      expect(presentationFor(toolName).card).toBeNull();
    }
  });

  it("未知工具仍回退到带工具名的可读标签（不静默、不崩）", () => {
    expect(presentationFor("some_future_tool").stepLabel).toBe("其他步骤");
    expect(presentationFor("some_future_tool").card).toBeNull();
  });

  it("resolveToolStepLabel：有 toolName 现取中文；无 toolName 从旧『执行 xxx』英文 label 反解中文；都不行回退", () => {
    expect(resolveToolStepLabel("read_draft", "执行 read_draft")).toBe("读稿"); // 有 toolName → 现取
    expect(resolveToolStepLabel(undefined, "执行 suggest_next_steps")).toBe("建议下一步"); // 旧历史无 toolName → 反解
    expect(resolveToolStepLabel(undefined, "执行 read_draft")).toBe("读稿");
    expect(resolveToolStepLabel(undefined, "执行 some_future_tool")).toBe("其他步骤"); // 未知工具：不露英文名
    expect(resolveToolStepLabel(undefined, "思考过程")).toBe("思考过程"); // 非『执行 xxx』形态原样
    expect(resolveToolStepLabel(undefined, undefined)).toBe(""); // 兜底不崩
  });

  it("suggest_next_steps 的 nextStepPrompt 挂到这条消息（驱动「下一步」卡）", () => {
    const prompt = {
      question: "这章入库了，接下来？",
      choices: [
        { label: "先补地点和资产", intent: "帮我把地点和资产补上", recommended: true },
        { label: "开始写第二章", intent: "开始写第二章" },
      ],
    };
    const message = project([
      { type: "tool-call", toolCallId: "ns-1", toolName: "suggest_next_steps", startedAt: 1 },
      { type: "tool-result", toolCallId: "ns-1", toolName: "suggest_next_steps", endedAt: 2, output: { ok: true, nextStepPrompt: prompt } },
    ]);
    expect(cardOf(message, "next-steps")?.prompt).toEqual(prompt);
  });
});

describe("定稿投影（写作版本 P2a 片 4A：定稿是一次操作）", () => {
  const OP = "op-0123456789abcdef0123";
  const checklist = { chapter: 4, canCommit: true, ledgerChecklist: [{ id: "2", kind: "fact", label: "钥匙放回柜台", removable: true }] };
  const view = (overrides: Partial<OperationViewData> = {}): OperationViewData => ({
    opId: OP, kind: "commit.prepare", chapter: 4, what: "定稿·第 4 章", state: "running", stateText: "在做", allowed: ["cancel"], summary: "", conclusion: "", eventSeq: 2, origin: { kind: "chat" },
    ...overrides,
  });

  it("出了清单等作者点 → 挂定稿清单卡（记着是哪一次）；同一次再来不重挂", () => {
    const waiting = view({ state: "waiting_author", allowed: [], eventSeq: 4, pending: { kind: "commit", actionId: "confirm-commit", decisions: ["commit"], preview: checklist } });
    let msg = project([{ type: "operation", operation: view() }]);
    expect(cardOf(msg, "commit-preview")).toBeUndefined();
    msg = projectAgentEvent(msg, { type: "operation", operation: waiting });
    expect(cardOf(msg, "commit-preview")).toEqual({ type: "commit-preview", preview: checklist, opId: OP });
    const again = projectAgentEvent(msg, { type: "operation", operation: { ...waiting, eventSeq: 5 } });
    expect(again.cards?.filter((card) => card.type === "commit-preview")).toHaveLength(1);
  });

  it("定不了 → 挂清单卡照实列原因，不挂回执、不记存档点", () => {
    const blocked = { chapter: 4, canCommit: false, blockingReasons: ["第 4 章还没有工作稿。"] };
    const msg = project([{ type: "operation", operation: view({ state: "succeeded", allowed: [], commit: { chapter: 4, committed: false, blocked } }) }]);
    expect(cardOf(msg, "commit-preview")?.preview).toEqual(blocked);
    expect(cardOf(msg, "commit-report")).toBeUndefined();
    expect(msg.turnSnapshots).toBeUndefined();
  });

  it("定成了 → 挂回执、记下存档点（撤销这次定稿用）、整本重读；同一次只记一次", () => {
    const report = { updatedCharacters: ["c1"], timelineEventIds: [], updatedHooks: [] };
    const done = view({ state: "succeeded", allowed: [], eventSeq: 7, commit: { chapter: 4, committed: true, report, snapshotId: "s-9" } });
    let msg = project([{ type: "operation", operation: done }]);
    msg = projectAgentEvent(msg, { type: "operation", operation: { ...done, eventSeq: 8 } });
    expect(cardOf(msg, "commit-report")?.report).toEqual(report);
    expect(msg.turnSnapshots).toEqual([{ toolName: "prepare_commit", snapshotId: "s-9", chapterNumber: 4 }]);
    expect(msg.affectedScopes).toEqual(["full"]);
    expect(presentationFor("prepare_commit").stepLabel).toBe("定稿");
  });
});

describe("裁剪待确认投影（prune_snapshots 预览后挂「确认裁剪」按钮）", () => {
  it("pruneConfirmAction → 消息挂「确认裁剪」按钮（带保留条数）", () => {
    const message = project([
      {
        type: "tool-result",
        toolCallId: "p1",
        toolName: "prune_snapshots",
        endedAt: 2,
        output: { ok: true, needsConfirmation: true, pruneConfirmAction: { keep: 50 }, summary: "预览：将裁 30 条。" },
      },
    ]);
    expect(message.suggestedActions).toEqual([
      expect.objectContaining({ id: "prune-confirm", label: "确认裁剪", pruneTarget: { keep: 50 } }),
    ]);
  });
});

describe("作者档按钮投影（重构 P4：「重写这一章」「确认改设定」）", () => {
  it("change_draft 遇到有稿的章 → 照服务端给的按钮挂「接着往下写」「重写第 N 章」（点了交的写稿原样带着）；再来一遍不重复挂", () => {
    const continueAction = newDraftAction("continue", { chapter: 3 });
    const rewriteAction = newDraftAction("write", { chapter: 3, direction: "让林溪回来", rewrite: true });
    const output = {
      ok: false,
      chapter: 3,
      rewriteChoices: [
        { label: "接着往下写", mode: "continue" as const, action: continueAction },
        { label: "重写第 3 章", mode: "write" as const, action: rewriteAction },
      ],
      summary: "第 3 章已经有工作稿了…",
    };
    const message = project([
      { type: "tool-call", toolCallId: "g1", toolName: "change_draft", startedAt: 1 },
      { type: "tool-result", toolCallId: "g1", toolName: "change_draft", endedAt: 2, output },
      { type: "tool-call", toolCallId: "g2", toolName: "change_draft", startedAt: 3 },
      { type: "tool-result", toolCallId: "g2", toolName: "change_draft", endedAt: 4, output },
    ]);
    expect(message.suggestedActions).toEqual([
      expect.objectContaining({ id: "continue-confirm", label: "接着往下写", operationAction: continueAction }),
      expect.objectContaining({ id: "rewrite-confirm", label: "重写第 3 章", operationAction: rewriteAction }),
    ]);
  });
});

describe("操作投影（写作版本 P2a：检查交给执行器做）", () => {
  const view = (overrides: Partial<OperationViewData> = {}): OperationViewData => ({
    opId: "op-0123456789abcdef0123", kind: "inspect.run", mode: "quality", chapter: 4, what: "硬伤检查·第 4 章",
    state: "running", stateText: "在做", allowed: ["cancel"], summary: "", conclusion: "", eventSeq: 2, origin: { kind: "chat", messageId: "user-1" },
    ...overrides,
  });
  const refined = { passed: false, blocking: [{ type: "x", label: "硬伤", severity: "error" as const, message: "m" }], soft: [], reference: [], summary: "s" };

  it("改设定、改账做完了：这一轮记下存档点（工具名分开）、块头标「设定本」；同一个存档点只记一次；交的那一步叫「改账」", () => {
    const ledger = view({ kind: "ledger.change", mode: "edit", chapter: undefined, what: "改账", state: "succeeded", allowed: [], eventSeq: 5, changed: { what: "ledger", snapshotId: "s-1" } });
    let msg = project([{ type: "operation", operation: ledger }]);
    msg = projectAgentEvent(msg, { type: "operation", operation: { ...ledger, eventSeq: 6 } });
    msg = projectAgentEvent(msg, { type: "operation", operation: view({ opId: "op-11111111111111111111", kind: "settings.change", mode: "ai", chapter: undefined, state: "succeeded", allowed: [], changed: { what: "settings", snapshotId: "s-2" } }) });
    expect(msg.turnSnapshots).toEqual([{ toolName: "change_ledger", snapshotId: "s-1" }, { toolName: "change_settings", snapshotId: "s-2" }]);
    expect(msg.affectedScopes).toEqual(["foundation"]);
    for (const toolName of ["change_ledger", "manage_ledger"]) expect(presentationFor(toolName).stepLabel).toBe("改账");
  });

  it("在做 → 操作卡；进度只记给在做的那次；做完挂结果卡（带查的版本），进度清掉", () => {
    let msg = project([{ type: "operation", operation: view() }]);
    msg = projectAgentEvent(msg, { type: "operation-progress", opId: "op-0123456789abcdef0123", text: "在查第 4 章" });
    msg = projectAgentEvent(msg, { type: "operation-progress", opId: "op-ffffffffffffffffffff", text: "别的那次" });
    expect(cardOf(msg, "operation")?.op).toMatchObject({ state: "running", progress: "在查第 4 章", what: "硬伤检查·第 4 章" });
    msg = projectAgentEvent(msg, { type: "operation", operation: view({ state: "succeeded", stateText: "做完了", allowed: [], summary: "有 1 处硬伤", eventSeq: 5, inspect: { qualityReport: refined, checkedVersion: "v3" } }), announced: true });
    expect(cardOf(msg, "operation")?.op).toMatchObject({ state: "succeeded", summary: "有 1 处硬伤", announced: true });
    expect(cardOf(msg, "operation")?.op).not.toHaveProperty("progress");
    expect(cardOf(msg, "quality")).toEqual({ type: "quality", report: refined, checkedVersion: "v3" });
  });

  it("迟到的旧记录不盖新的；同一次做完的再来一遍不重挂结果卡（作者在卡上点过的不被冲掉）", () => {
    let msg = project([{ type: "operation", operation: view({ state: "succeeded", eventSeq: 5, inspect: { qualityReport: refined } }) }]);
    msg = projectAgentEvent(msg, { type: "operation", operation: view({ state: "running", eventSeq: 3 }) });
    expect(cardOf(msg, "operation")?.op.state).toBe("succeeded");
    const marked = { ...msg, cards: msg.cards!.map((card) => (card.type === "quality" ? { ...card, report: { ...refined, summary: "作者看过" } } : card)) };
    const again = projectAgentEvent(marked, { type: "operation", operation: view({ state: "succeeded", eventSeq: 6, inspect: { qualityReport: refined } }) });
    expect(cardOf(again, "quality")?.report.summary).toBe("作者看过");
  });

  it("写稿做完了：一次写几版的挂「另外几版」卡；同一次再来一遍不重挂", () => {
    const versions = { chapter: 4, versions: [{ index: 1, candidateId: "0004-op-1", sha: "c".repeat(64), body: "另一版正文。" }] };
    const draftView = (overrides: Partial<OperationViewData> = {}) => view({ kind: "draft.change", mode: "write", what: "写稿·第 4 章", ...overrides });
    let msg = project([{ type: "operation", operation: draftView() }]);
    msg = projectAgentEvent(msg, { type: "operation", operation: draftView({ state: "succeeded", eventSeq: 5, draft: { chapter: 4, applied: true, versions } }) });
    expect(cardOf(msg, "draft-versions")?.versions).toEqual(versions);
    const again = projectAgentEvent(msg, { type: "operation", operation: draftView({ state: "succeeded", eventSeq: 6, draft: { chapter: 4, applied: true, versions } }) });
    expect(again.cards!.filter((card) => card.type === "draft-versions")).toHaveLength(1);
    const single = project([{ type: "operation", operation: draftView({ state: "succeeded", eventSeq: 5, draft: { chapter: 4, applied: true } }) }]);
    expect(cardOf(single, "draft-versions")).toBeUndefined();
  });

  it("写稿做完了：这一轮记下它打的存档点（章纲在前，「撤销到此」从它退）、换上了的标「影响了正文·草稿」；重来一遍不重记", () => {
    const draftView = (overrides: Partial<OperationViewData> = {}) => view({ kind: "draft.change", mode: "write", what: "写稿·第 4 章", ...overrides });
    const done = draftView({ state: "succeeded", eventSeq: 5, draft: { chapter: 4, applied: true, snapshots: ["s-plan", "s-draft"] } });
    let msg = project([{ type: "operation", operation: draftView() }, { type: "operation", operation: done }]);
    expect(msg.turnSnapshots).toEqual([
      { toolName: "change_draft", snapshotId: "s-plan", chapterNumber: 4 },
      { toolName: "change_draft", snapshotId: "s-draft", chapterNumber: 4 },
    ]);
    expect(msg.affectedScopes).toEqual(["full"]);
    msg = projectAgentEvent(msg, { type: "operation", operation: { ...done, eventSeq: 6 } });
    expect(msg.turnSnapshots).toHaveLength(2);
    const kept = project([{ type: "operation", operation: draftView({ state: "succeeded", eventSeq: 5, draft: { chapter: 4, applied: false } }) }]);
    expect(kept.turnSnapshots).toBeUndefined();
    expect(kept.affectedScopes).toBeUndefined();
  });

  it("换上作者挑的 AI 稿：记下存档点、标「影响了正文·草稿」；没换（稿纸上已经是这一版）不记", () => {
    const adoptView = (overrides: Partial<OperationViewData> = {}) => view({ kind: "draft.adopt", what: "换上 AI 稿·第 4 章", ...overrides });
    const msg = project([{ type: "operation", operation: adoptView() }, { type: "operation", operation: adoptView({ state: "succeeded", eventSeq: 5, draft: { chapter: 4, applied: true, snapshots: ["s-adopt"] } }) }]);
    expect(msg.turnSnapshots).toEqual([{ toolName: "change_draft", snapshotId: "s-adopt", chapterNumber: 4 }]);
    expect(msg.affectedScopes).toEqual(["full"]);
    const same = project([{ type: "operation", operation: adoptView({ state: "succeeded", eventSeq: 5, draft: { chapter: 4, applied: false } }) }]);
    expect(same.turnSnapshots).toBeUndefined();
  });

  it("想走法做完了：挂走法卡（稿纸上方给作者挑）；同一次再来一遍不重挂、作者挑过的不被冲掉；不记存档点", () => {
    const plan = { chapter: 4, options: [{ title: "老周开口", steps: ["夜里上楼"], threads: [], problems: [] }], checked: true };
    const planView = (overrides: Partial<OperationViewData> = {}) => view({ kind: "plan.propose", mode: undefined, what: "想走法·第 4 章", ...overrides });
    let msg = project([{ type: "operation", operation: planView() }, { type: "operation", operation: planView({ state: "succeeded", eventSeq: 5, plan }) }]);
    expect(cardOf(msg, "directions")).toEqual({ type: "directions", brainstorm: plan });
    msg = { ...msg, cards: msg.cards!.map((card) => (card.type === "directions" ? { ...card, picked: 0 } : card)) };
    const again = projectAgentEvent(msg, { type: "operation", operation: planView({ state: "succeeded", eventSeq: 6, plan }) });
    expect(again.cards!.filter((card) => card.type === "directions")).toEqual([{ type: "directions", brainstorm: plan, picked: 0 }]);
    expect(again.turnSnapshots).toBeUndefined();
    expect(again.affectedScopes).toBeUndefined();
  });

  it("没做成：只换操作卡，不挂结果卡", () => {
    const msg = project([
      { type: "operation", operation: view() },
      { type: "operation", operation: view({ state: "failed", stateText: "没做成", allowed: [], summary: "模型没回", eventSeq: 4, failure: { message: "模型没回", retryable: true } }) },
    ]);
    expect(cardOf(msg, "operation")?.op).toMatchObject({ state: "failed", summary: "模型没回" });
    expect(cardOf(msg, "quality")).toBeUndefined();
  });
});

describe("settleUnfinishedAgentTurn（A-5 「停止」收尾结算）", () => {
  it("残留 running 的步骤/卡片 → stopped + 补 endedAt；completed/failed 原样保留", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "read_state_overview", startedAt: 100 },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read_state_overview",
        endedAt: 200,
        output: { summary: "读到了。", refreshScope: "full", overview: {} },
      },
      { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 300 },
    ]);
    const settled = settleUnfinishedAgentTurn(message, 999);
    expect(settled.toolSteps).toHaveLength(2);
    // 已完成的步骤原样（状态/endedAt 不动）。
    expect(settled.toolSteps![0]).toMatchObject({ id: "c1", status: "completed", endedAt: 200 });
    // 残留 running → stopped（不是 failed：不是工具失败，是人喊停）+ 补 endedAt。
    expect(settled.toolSteps![1]).toMatchObject({ id: "g1", status: "stopped", endedAt: 999 });
    // 对应的 running agentCard 一并结算（read_state_overview 的卡已 completed、不动）。
    expect(settled.agentCards).toHaveLength(1);
    expect(settled.agentCards![0].status).toBe("completed");
  });

  it("running 的 agentCard（read_state_overview 在飞）→ stopped", () => {
    const message = project([
      { type: "tool-call", toolCallId: "f1", toolName: "read_state_overview", startedAt: 10 },
    ]);
    const settled = settleUnfinishedAgentTurn(message, 20);
    expect(settled.toolSteps![0].status).toBe("stopped");
    expect(settled.agentCards![0].status).toBe("stopped");
  });

  it("没有 running 步骤 → 内容等价（纯问答回合零成本）", () => {
    const message = project([{ type: "text-delta", text: "好的。" }]);
    const settled = settleUnfinishedAgentTurn(message, 5);
    expect(settled.toolSteps ?? []).toEqual([]);
    expect(settled.content).toBe("好的。");
  });

  it("不改入参（纯函数）", () => {
    const message = project([
      { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 1 },
    ]);
    settleUnfinishedAgentTurn(message, 2);
    expect(message.toolSteps![0].status).toBe("running");
  });
});
