import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../types.js";
import { detectUnbackedCompletionClaim } from "./detectUnbackedCompletion.js";
import {
  emptyAssistantMessage,
  presentationFor,
  resolveToolStepLabel,
  projectAgentEvent,
  settleStoppedAgentTurn,
  type AgentProjectionEvent,
} from "./agentEventProjection.js";

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

  it("maps foundation_write to the foundationAgent agentName", () => {
    const message = project([
      { type: "tool-call", toolCallId: "call-2", toolName: "foundation_write", startedAt: 1 },
    ]);
    expect(message.agentCards![0].agentName).toBe("foundationAgent");
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
    expect(message.agentCards!.map((c) => c.agentName)).toEqual([
      "stateOverviewReader",
      "foundationAgent",
    ]);
  });

  it("marks the matching toolStep failed and the card failed on tool-error", () => {
    const message = project([
      { type: "tool-call", toolCallId: "c1", toolName: "foundation_write", startedAt: 10 },
      { type: "tool-error", toolCallId: "c1", toolName: "foundation_write", endedAt: 20, error: "落盘失败" },
    ]);
    expect(message.toolSteps![0].status).toBe("failed");
    expect(message.toolSteps![0].endedAt).toBe(20);
    expect(message.agentCards![0].status).toBe("failed");
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

  it("tool-result 带 dryRun/action → 累加进 toolStep（诚实背书粒度，对齐服务端 honesty-detection 字段名）", () => {
    const message = project([
      { type: "tool-call", toolCallId: "p1", toolName: "prune_snapshots", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "p1",
        toolName: "prune_snapshots",
        endedAt: 20,
        output: { ok: true, dryRun: true, summary: "预览：将裁 3 条快照。" },
      },
      { type: "tool-call", toolCallId: "e1", toolName: "manage_style_exemplars", startedAt: 30 },
      {
        type: "tool-result",
        toolCallId: "e1",
        toolName: "manage_style_exemplars",
        endedAt: 40,
        output: { ok: true, action: "add", summary: "已存文风样本「雨夜开场」。" },
      },
    ]);
    expect(message.toolSteps![0]).toMatchObject({ status: "completed", dryRun: true });
    expect(message.toolSteps![1]).toMatchObject({ status: "completed", action: "add" });
  });

  it("exemplars add 成功经投影后不再被诚实探针误判「操作未完成」；list 只读照旧判谎报（P2③ 端到端）", () => {
    const added = project([
      { type: "tool-call", toolCallId: "e1", toolName: "manage_style_exemplars", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "e1",
        toolName: "manage_style_exemplars",
        endedAt: 20,
        output: { ok: true, action: "add", summary: "已存文风样本「雨夜开场」。" },
      },
    ]);
    // action:"add" 累加进 step → stepBacksWriteClaim 认它背书——修复前字段在投影层丢失、被误盖「操作未完成」。
    expect(detectUnbackedCompletionClaim("已保存文风样本。", added.toolSteps)).toBe(false);

    const listed = project([
      { type: "tool-call", toolCallId: "e2", toolName: "manage_style_exemplars", startedAt: 10 },
      {
        type: "tool-result",
        toolCallId: "e2",
        toolName: "manage_style_exemplars",
        endedAt: 20,
        output: { ok: true, action: "list", summary: "当前共 2 条样本。" },
      },
    ]);
    // 对照：list 是只读 action，completed 也不背书「已保存」——同一投影链下照旧判谎报。
    expect(detectUnbackedCompletionClaim("已保存文风样本。", listed.toolSteps)).toBe(true);
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

  it("commit_preview 不可入库(ok:false=canCommit:false) → 「入库预览」步骤 failed,不再绿色谎报(问题1)", () => {
    // commit_preview 是只读工具,但「想入库却不可入库」是 go/no-go 结果——ok=canCommit:false 时步骤须 failed。
    let msg = emptyAssistantMessage("preview-fail");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "p1",
      toolName: "commit_preview",
      endedAt: 2,
      output: { ok: false, summary: "第 1 章还没有草稿，无法预览入库。" },
    });
    expect(msg.toolSteps![0].status).toBe("failed");
    expect(msg.toolSteps![0].label).toBe("定稿影响预览");
  });

  it("commit_preview 带 nameConsistencyWarnings → 挂到消息（固定展示提醒卡，不靠模型转述）", () => {
    let msg = emptyAssistantMessage("preview-name-drift");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "p1",
      toolName: "commit_preview",
      endedAt: 2,
      output: {
        ok: true,
        nameConsistencyWarnings: [{ establishedName: "林澈", driftedVariant: "林棠", message: "疑似写歪" }],
      },
    });
    expect(msg.nameConsistencyWarnings).toEqual([
      { establishedName: "林澈", driftedVariant: "林棠", message: "疑似写歪" },
    ]);
  });

  it("commit_preview 无 nameConsistencyWarnings → 不挂（无名字问题时不产生提醒卡）", () => {
    let msg = emptyAssistantMessage("preview-no-drift");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "p1",
      toolName: "commit_preview",
      endedAt: 2,
      output: { ok: true },
    });
    expect(msg.nameConsistencyWarnings).toBeUndefined();
  });

  it("commit_preview 带 staleThreadWarnings → 挂到消息（固定展示「伏笔/线索待收口」卡）", () => {
    let msg = emptyAssistantMessage("preview-stale");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "p1",
      toolName: "commit_preview",
      endedAt: 2,
      output: {
        ok: true,
        staleThreadWarnings: [{ kind: "线索", title: "师父失踪之谜", lastTouchedChapter: 1, chaptersSinceTouched: 5, message: "已 5 章没推进" }],
      },
    });
    expect(msg.staleThreadWarnings).toEqual([
      { kind: "线索", title: "师父失踪之谜", lastTouchedChapter: 1, chaptersSinceTouched: 5, message: "已 5 章没推进" },
    ]);
  });

  it("commit_preview 同时带名字漂移 + 伏笔/线索待收口 → 两张卡都挂上（不互相顶掉）", () => {
    let msg = emptyAssistantMessage("preview-both");
    msg = projectAgentEvent(msg, { type: "tool-call", toolCallId: "p1", toolName: "commit_preview", startedAt: 1 });
    msg = projectAgentEvent(msg, {
      type: "tool-result",
      toolCallId: "p1",
      toolName: "commit_preview",
      endedAt: 2,
      output: {
        ok: true,
        nameConsistencyWarnings: [{ establishedName: "林澈", driftedVariant: "林棠", message: "疑似写歪" }],
        staleThreadWarnings: [{ kind: "伏笔", title: "破损信物", lastTouchedChapter: 2, chaptersSinceTouched: 4, message: "已 4 章没推进" }],
      },
    });
    expect(msg.nameConsistencyWarnings).toHaveLength(1);
    expect(msg.staleThreadWarnings).toHaveLength(1);
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
    read_chapters_overview: "读取章节概览",
    read_timeline: "读取时间线",
    read_foundation: "查看故事资料",
    read_draft: "读取草稿原文",
    foundation_write: "更新故事资料",
    generate_worldbuilding: "完善世界观",
    generate_asset_enrichment: "完善道具与资源",
    generate_location_enrichment: "完善地点",
    generate_character_enrichment: "完善角色",
    generate_matrix_enrichment: "完善角色关系",
    generate_character_relationships: "完善人物关系",
    generate_writing_rules_enrichment: "重新整理写作规则",
    generate_alias_table: "完善别名表",
    generate_chapter_steering: "生成章节方向",
    generate_draft: "生成正文",
    revise_draft: "修改草稿",
    quality_check: "硬伤检查",
    ai_review: "内容审阅",
    check_ai_flavor: "检查机器腔",
    commit_preview: "定稿影响预览",
    commit_apply: "定稿",
    edit_fact_ledger: "记录故事事实",
    suggest_next_steps: "建议下一步",
    set_foreshadowing_importance: "调整伏笔权重",
    resolve_thread: "收口单条线索",
    clean_legacy_threads: "清理历史线索",
    group_related_leads: "归并相关线索",
    manage_style_exemplars: "管理文风样本",
    undo_last_change: "撤销上一改动",
    prune_snapshots: "裁剪快照历史",
    web_search: "联网检索资料",
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
    expect(revise.toolSteps![0].label).toBe("修改草稿");
  });

  it("card 仅保留 read_state_overview / foundation_write；其余工具 card:null（不强造误导卡）", () => {
    expect(presentationFor("read_state_overview").card).not.toBeNull();
    expect(presentationFor("foundation_write").card).not.toBeNull();
    for (const toolName of [
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
    expect(presentationFor("some_future_tool").stepLabel).toBe("执行 some_future_tool");
    expect(presentationFor("some_future_tool").card).toBeNull();
  });

  it("resolveToolStepLabel：有 toolName 现取中文；无 toolName 从旧『执行 xxx』英文 label 反解中文；都不行回退", () => {
    expect(resolveToolStepLabel("read_draft", "执行 read_draft")).toBe("读取草稿原文"); // 有 toolName → 现取
    expect(resolveToolStepLabel(undefined, "执行 suggest_next_steps")).toBe("建议下一步"); // 旧历史无 toolName → 反解
    expect(resolveToolStepLabel(undefined, "执行 read_draft")).toBe("读取草稿原文");
    expect(resolveToolStepLabel(undefined, "执行 some_future_tool")).toBe("执行 some_future_tool"); // 未知工具回退
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
    expect(message.nextStepPrompt).toEqual(prompt);
  });
});

describe("入库 delta 投影（commit_apply → message.commitReport）", () => {
  it("入库成功带 commitReport → 挂到 message.commitReport", () => {
    const report = { updatedCharacters: ["c1"], timelineEventIds: [], updatedHooks: [] };
    const message = project([
      { type: "tool-call", toolCallId: "t1", toolName: "commit_apply", startedAt: 1 },
      { type: "tool-result", toolCallId: "t1", toolName: "commit_apply", endedAt: 2, output: { ok: true, commitReport: report } },
    ]);
    expect(message.commitReport).toEqual(report);
  });

  it("入库未通过（无 commitReport）→ 不挂", () => {
    const message = project([
      { type: "tool-result", toolCallId: "t2", toolName: "commit_apply", endedAt: 2, output: { ok: false } },
    ]);
    expect(message.commitReport).toBeUndefined();
  });
});

describe("质检明细投影（quality_check → message.qualityReport）", () => {
  it("带 qualityReport → 挂到 message.qualityReport", () => {
    const refined = { passed: false, blocking: [{ type: "x", label: "硬伤", severity: "error" as const, message: "m" }], soft: [], reference: [], summary: "s" };
    const message = project([
      { type: "tool-call", toolCallId: "q", toolName: "quality_check", startedAt: 1 },
      { type: "tool-result", toolCallId: "q", toolName: "quality_check", endedAt: 2, output: { ok: true, qualityReport: refined } },
    ]);
    expect(message.qualityReport).toEqual(refined);
  });
});

describe("settleStoppedAgentTurn（A-5 「停止」收尾结算）", () => {
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
    const settled = settleStoppedAgentTurn(message, 999);
    expect(settled.toolSteps).toHaveLength(2);
    // 已完成的步骤原样（状态/endedAt 不动）。
    expect(settled.toolSteps![0]).toMatchObject({ id: "c1", status: "completed", endedAt: 200 });
    // 残留 running → stopped（不是 failed：不是工具失败，是人喊停）+ 补 endedAt。
    expect(settled.toolSteps![1]).toMatchObject({ id: "g1", status: "stopped", endedAt: 999 });
    // 对应的 running agentCard 一并结算（read_state_overview 的卡已 completed、不动）。
    expect(settled.agentCards).toHaveLength(1);
    expect(settled.agentCards![0].status).toBe("completed");
  });

  it("running 的 agentCard（foundation_write 在飞）→ stopped", () => {
    const message = project([
      { type: "tool-call", toolCallId: "f1", toolName: "foundation_write", startedAt: 10 },
    ]);
    const settled = settleStoppedAgentTurn(message, 20);
    expect(settled.toolSteps![0].status).toBe("stopped");
    expect(settled.agentCards![0].status).toBe("stopped");
  });

  it("没有 running 步骤 → 内容等价（纯问答回合零成本）", () => {
    const message = project([{ type: "text-delta", text: "好的。" }]);
    const settled = settleStoppedAgentTurn(message, 5);
    expect(settled.toolSteps ?? []).toEqual([]);
    expect(settled.content).toBe("好的。");
  });

  it("不改入参（纯函数）", () => {
    const message = project([
      { type: "tool-call", toolCallId: "g1", toolName: "generate_draft", startedAt: 1 },
    ]);
    settleStoppedAgentTurn(message, 2);
    expect(message.toolSteps![0].status).toBe("running");
  });
});
