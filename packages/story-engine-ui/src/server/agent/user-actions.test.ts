import { RequestContext } from "@mastra/core/di";
import { describe, expect, it } from "vitest";

import { isUserConfirmedTool } from "./request-context.js";
import {
  commitApplyNextSteps,
  humanizeToolNames,
  parseUserAction,
  runUserAction,
  type UserActionToolExecutor,
} from "./user-actions.js";

describe("parseUserAction 结构化动作解析", () => {
  it("缺省 → none（普通对话）", () => {
    expect(parseUserAction(undefined)).toEqual({ kind: "none" });
    expect(parseUserAction(null)).toEqual({ kind: "none" });
  });

  it("合法定稿动作 → action（previewToken 可选、去空白）", () => {
    expect(parseUserAction({ toolName: "commit_apply", chapter: 5 })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 5 },
    });
    expect(parseUserAction({ toolName: "commit_apply", chapter: 5, previewToken: " tok " })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 5, previewToken: "tok" },
    });
  });

  it("核账动作：fresh=true 才带上（再细核一遍）", () => {
    expect(parseUserAction({ toolName: "check_continuity", chapter: 3, fresh: true })).toEqual({
      kind: "action",
      action: { toolName: "check_continuity", chapter: 3, fresh: true },
    });
    expect(parseUserAction({ toolName: "check_continuity", chapter: 3, fresh: "yes" })).toEqual({
      kind: "action",
      action: { toolName: "check_continuity", chapter: 3 },
    });
  });

  it("账本清单去掉的条目随定稿动作带上（去空白、去重、丢非字符串）", () => {
    expect(parseUserAction({ toolName: "commit_apply", chapter: 5, excluded: [" fact:1 ", "fact:1", 3, "", "hook:hook-a"] })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 5, excluded: ["fact:1", "hook:hook-a"] },
    });
    expect(parseUserAction({ toolName: "commit_apply", chapter: 5, excluded: "fact:1" })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 5 },
    });
  });

  it("章号数字字符串宽容还原；空 previewToken 丢掉", () => {
    expect(parseUserAction({ toolName: "commit_apply", chapter: "7", previewToken: "" })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 7 },
    });
  });

  it.each([
    ["非对象", "commit_apply"],
    ["数组", []],
    ["白名单外工具", { toolName: "foundation_write", chapter: 1 }],
    ["缺章号", { toolName: "commit_apply" }],
    ["章号 0", { toolName: "commit_apply", chapter: 0 }],
    ["章号小数", { toolName: "commit_apply", chapter: 1.5 }],
    ["章号乱写", { toolName: "commit_apply", chapter: "abc" }],
  ])("%s → invalid（路由回 400，不当普通对话静默处理）", (_label, raw) => {
    expect(parseUserAction(raw).kind).toBe("invalid");
  });
});

describe("commitApplyNextSteps 定稿收尾的下一步（确定性）", () => {
  it("定稿成功 → 推荐写下一章（带结构化动作：R4.7 点击直达 generate_draft，不经模型）", () => {
    expect(commitApplyNextSteps(5, { committed: true })).toEqual({
      question: "第 5 章定稿了，接下来？",
      choices: [{ label: "写第 6 章", intent: "继续写第 6 章的正文", recommended: true, action: { toolName: "generate_draft", chapter: 6 } }],
    });
  });

  it("定稿成功 + 线索堆积加重档 → 加「清理线索」（开放式选项，不带结构化动作，照旧发文本给 agent）", () => {
    const steps = commitApplyNextSteps(5, { committed: true, threadMaintenanceHint: "escalated" });
    expect(steps.choices.map((c) => c.label)).toEqual(["写第 6 章", "清理线索"]);
    expect(steps.choices[1]).not.toHaveProperty("action");
  });

  it("没定稿 → 只给「重新预览」（带结构化动作：直达 commit_preview）", () => {
    expect(commitApplyNextSteps(5, { committed: false }).choices).toEqual([
      { label: "重新预览", intent: "生成第 5 章定稿预览", recommended: true, action: { toolName: "commit_preview", chapter: 5 } },
    ]);
  });
});

describe("humanizeToolNames", () => {
  it("工具名换人话", () => {
    expect(humanizeToolNames("尚未对该章执行 commit_preview，不能 commit_apply")).toBe("尚未对该章执行 定稿预览，不能 定稿");
  });
});

describe("runUserAction 执行结构化动作", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  function collect() {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    return { events, sendEvent: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }) };
  }

  it("成功定稿：按 agent 回合同款事件推送 tool-call/tool-result + 摘要 + 下一步卡；执行期间带确认标记、结束即清", async () => {
    const requestContext = new RequestContext();
    let markedDuringExecution = false;
    let receivedInput: Record<string, unknown> | undefined;
    const executeTool: UserActionToolExecutor = async (toolName, input, context) => {
      markedDuringExecution = isUserConfirmedTool({ requestContext: context } as never, toolName);
      receivedInput = input;
      return { ok: true, committed: true, chapter: 5, summary: "第 5 章已定稿，资料已更新。" };
    };
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 5, previewToken: "tok" },
      requestContext,
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
    });

    expect(markedDuringExecution).toBe(true);
    expect(isUserConfirmedTool({ requestContext } as never, "commit_apply")).toBe(false);
    expect(receivedInput).toEqual({ chapter: 5, previewToken: "tok" });
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-result", "text-delta", "tool-call", "tool-result"]);
    expect(events[0]!.data.toolName).toBe("commit_apply");
    expect(events[1]!.data.toolCallId).toBe(events[0]!.data.toolCallId);
    expect(events[1]!.data.output).toMatchObject({ committed: true });
    expect(events[2]!.data.text).toBe("第 5 章已定稿，资料已更新。");
    expect(events[3]!.data.toolName).toBe("suggest_next_steps");
    expect(events[4]!.data.output).toMatchObject({ ok: true, choices: [{ label: "写第 6 章" }] });
  });

  it("被拒（如预览后改过稿）：如实转述 summary（工具名换人话）+ 「重新预览」选项", async () => {
    const executeTool: UserActionToolExecutor = async () => ({
      ok: false,
      committed: false,
      summary: "未定稿：尚未对该章执行 commit_preview，按规则不能直接定稿；请先预览确认。",
    });
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 3 },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
    });

    const text = events.filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
    expect(text).toBe("未定稿：尚未对该章执行 定稿预览，按规则不能直接定稿；请先预览确认。");
    expect(events.at(-1)!.data.output).toMatchObject({ choices: [{ label: "重新预览", intent: "生成第 3 章定稿预览" }] });
  });

  it("工具抛错：tool-error（可重试）+ 如实文案，不推下一步卡，标记照样清掉", async () => {
    const requestContext = new RequestContext();
    const executeTool: UserActionToolExecutor = async () => {
      throw new Error("磁盘满了");
    };
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 2 },
      requestContext,
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-error", "text-delta"]);
    expect(events[1]!.data).toMatchObject({ toolName: "commit_apply", error: "磁盘满了", retryable: true });
    expect(events[2]!.data.text).toContain("第 2 章定稿没有完成：磁盘满了");
    expect(isUserConfirmedTool({ requestContext } as never, "commit_apply")).toBe(false);
  });
});

describe("「定稿」按钮结构化动作（commit_preview）", () => {
  it("解析；执行时不带确认标记（只读），推 tool-call/tool-result + 工具自己的摘要（工具名换人话），不调模型", async () => {
    expect(parseUserAction({ toolName: "commit_preview", chapter: "4" })).toEqual({ kind: "action", action: { toolName: "commit_preview", chapter: 4 } });
    const requestContext = new RequestContext();
    let marked = true;
    const executeTool: UserActionToolExecutor = async (toolName, _input, context) => {
      marked = isUserConfirmedTool({ requestContext: context } as never, toolName);
      return { ok: true, canCommit: true, chapter: 4, summary: "第 4 章可以定稿，点 commit_apply 前先看清单。" };
    };
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "commit_preview", chapter: 4 },
      requestContext,
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    expect(marked).toBe(false);
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-result", "text-delta"]);
    expect(events[1]!.data.output).toMatchObject({ canCommit: true });
    expect(events[2]!.data.text).toBe("第 4 章可以定稿，点 定稿 前先看清单。");
  });
});

describe("「核账」按钮结构化动作（check_continuity，R4.1：没核成不装作核过）", () => {
  const runCheck = async (executeTool: UserActionToolExecutor) => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "check_continuity", chapter: 5 },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    return events;
  };
  const nextStepsOutput = (events: readonly { event: string; data: Record<string, unknown> }[]) =>
    events.at(-1)!.data.output as { question: string; choices: { label: string; intent: string; recommended?: boolean }[] };
  const textOf = (events: readonly { event: string; data: Record<string, unknown> }[]) =>
    events.filter((e) => e.event === "text-delta").map((e) => String(e.data.text)).join("");

  it("没核成（还在读，ok:false + pending）→ 问句「这次没核成，接下来？」，只有再核一次/先写下一章；不写「做完了」、不给「预览定稿」", async () => {
    const events = await runCheck(async () => ({
      ok: false,
      chapter: 5,
      sure: [],
      maybe: [],
      failures: ["核账员还在读前文（第 4 / 57 章），这次没核"],
      pending: { done: 4, total: 57 },
      summary: "核账员还在读这本书的前文：第 4 / 57 章。这次没有核（不糊弄）。",
    }));
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-result", "text-delta", "tool-call", "tool-result"]);
    // 收尾文本只回工具自己的如实 summary（说清还在读、这次没核）。
    expect(textOf(events)).toContain("这次没有核");
    expect(textOf(events)).not.toContain("做完了");
    const next = nextStepsOutput(events);
    expect(next.question).toBe("这次没核成，接下来？");
    expect(next.question).not.toContain("做完了");
    expect(next.choices.map((c) => c.label)).toEqual(["再核一次", "先写下一章"]);
    const labels = JSON.stringify(next.choices);
    expect(labels).not.toContain("预览定稿");
    expect(labels).not.toContain("改掉确定");
  });

  it("没核成（出错，ok:false 无 pending）且 summary 缺失 → 兜底文案也不写「核账做完了」", async () => {
    const events = await runCheck(async () => ({ ok: false, chapter: 5, sure: [], maybe: [], failures: ["第 1 遍（盯东西）没跑成"] }));
    expect(textOf(events)).toContain("没核成");
    expect(textOf(events)).not.toContain("做完了");
    const next = nextStepsOutput(events);
    expect(next.question).toBe("这次没核成，接下来？");
    expect(next.choices.map((c) => c.label)).toEqual(["再核一次", "先写下一章"]);
  });

  it("没核成（还在读）且 summary 缺失 → 兜底文案用结构化 pending 说「还在读」，不解析 failures 文字", async () => {
    const events = await runCheck(async () => ({ ok: false, chapter: 5, sure: [], maybe: [], pending: { done: 4, total: 57 } }));
    expect(textOf(events)).toContain("还在读前文（第 4 / 57 章）");
  });

  it("核成且 0 处（ok:true）→ 问句「核账做完了，接下来？」、推荐「预览定稿」照旧（正常路不回归）", async () => {
    const events = await runCheck(async () => ({
      ok: true,
      chapter: 5,
      sure: [],
      maybe: [],
      failures: [],
      summary: "核了第 5 章，没发现和前文对不上的地方。",
    }));
    expect(textOf(events)).toContain("没发现和前文对不上的地方");
    const next = nextStepsOutput(events);
    expect(next.question).toBe("核账做完了，接下来？");
    expect(next.choices.map((c) => c.label)).toEqual(["预览定稿", "写下一章"]);
    expect(next.choices[0]).toMatchObject({ label: "预览定稿", recommended: true });
  });

  it("核成且确定 N 处 → 下一步只给次要选项（我自己改/预览定稿），不再出笼统的「改掉确定的 N 处」（R4.5：主按钮挪进核账卡）", async () => {
    const events = await runCheck(async () => ({
      ok: true,
      chapter: 5,
      sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 4, reason: "r" }],
      maybe: [],
      failures: [],
      summary: "核了第 5 章：确定对不上 1 处。",
    }));
    const next = nextStepsOutput(events);
    expect(next.question).toBe("核账做完了，这几处怎么处理？");
    expect(next.choices.map((c) => c.label)).toEqual(["我自己改", "预览定稿"]);
    expect(next.choices[0]).toMatchObject({ label: "我自己改", recommended: true });
    expect(JSON.stringify(next.choices)).not.toContain("改掉确定");
  });

  it("核成且确定 N 处、结果复用 → 次要选项后仍带「再细核一遍」", async () => {
    const events = await runCheck(async () => ({
      ok: true,
      chapter: 5,
      reused: true,
      sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 4, reason: "r" }],
      maybe: [],
      failures: [],
      summary: "核了第 5 章：确定对不上 1 处。",
    }));
    const next = nextStepsOutput(events);
    expect(next.choices.map((c) => c.label)).toEqual(["我自己改", "预览定稿", "再细核一遍"]);
  });
});

describe("服务端生成的下一步选项带结构化动作（R4.7/验收 3.8：点击直达 body.action，不再发文本给模型）", () => {
  const runCheck = async (executeTool: UserActionToolExecutor, chapter = 5) => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "check_continuity", chapter },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    return events.at(-1)!.data.output as { question: string; choices: { label: string; intent: string; recommended?: boolean; action?: { toolName: string; chapter?: number; fresh?: boolean } }[] };
  };

  it("没核成 → 「再核一次」直达 check_continuity 本章、「先写下一章」直达 generate_draft 下一章", async () => {
    const next = await runCheck(async () => ({ ok: false, chapter: 5, sure: [], maybe: [], pending: { done: 4, total: 57 } }));
    expect(next.choices[0]).toMatchObject({ label: "再核一次", action: { toolName: "check_continuity", chapter: 5 } });
    expect(next.choices[0]!.action).not.toHaveProperty("fresh");
    expect(next.choices[1]).toMatchObject({ label: "先写下一章", action: { toolName: "generate_draft", chapter: 6 } });
  });

  it("核成且 0 处 → 「预览定稿」直达 commit_preview 本章、「写下一章」直达 generate_draft 下一章", async () => {
    const next = await runCheck(async () => ({ ok: true, chapter: 5, sure: [], maybe: [], failures: [], summary: "核了第 5 章，没发现对不上的地方。" }));
    expect(next.choices[0]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview", chapter: 5 } });
    expect(next.choices[1]).toMatchObject({ label: "写下一章", action: { toolName: "generate_draft", chapter: 6 } });
  });

  it("核成且确定 N 处 → 「我自己改」不带 action（开放式，照旧发文本），「预览定稿」直达", async () => {
    const next = await runCheck(async () => ({ ok: true, chapter: 5, sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 4, reason: "r" }], maybe: [], failures: [], summary: "核了第 5 章：确定对不上 1 处。" }));
    expect(next.choices[0]).toMatchObject({ label: "我自己改" });
    expect(next.choices[0]).not.toHaveProperty("action");
    expect(next.choices[1]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview", chapter: 5 } });
  });

  it("结果复用 → 「再细核一遍」直达 check_continuity 且 fresh=true（重新核，不是给上次结果）", async () => {
    const next = await runCheck(async () => ({ ok: true, chapter: 5, reused: true, sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 4, reason: "r" }], maybe: [], failures: [], summary: "核了第 5 章：确定对不上 1 处。" }));
    expect(next.choices[2]).toMatchObject({ label: "再细核一遍", action: { toolName: "check_continuity", chapter: 5, fresh: true } });
  });

  it("出稿写好 → 「预览定稿」直达 commit_preview、「看核账结果」直达 check_continuity（复用核账记忆）；「我自己改」不带 action", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext: new RequestContext(),
      executeTool: async () => ({ ok: true, summary: "本章章纲：苏晚找书。写好了。" }),
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: { toolName: string; chapter?: number } }[] };
    expect(next.choices[0]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview", chapter: 2 } });
    expect(next.choices[1]).toMatchObject({ label: "看核账结果", action: { toolName: "check_continuity", chapter: 2 } });
    expect(next.choices[2]).toMatchObject({ label: "我自己改" });
    expect(next.choices[2]).not.toHaveProperty("action");
  });

  it("出稿没写成 → 「再写一次」直达 generate_draft 本章", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext: new RequestContext(),
      executeTool: async () => ({ ok: false, summary: "没写成。" }),
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: { toolName: string; chapter?: number } }[] };
    expect(next.choices[0]).toMatchObject({ label: "再写一次", action: { toolName: "generate_draft", chapter: 2 } });
  });

  // R7.1 结构化意图标记：按钮/选项点击本身就是写作授权，generate_draft 的写作意图门见标记优先放行
  // （不赌回显文案命中正向词表）。标记只在执行期间存在，结束即清（与 prune 同款）。
  it("出稿动作带用户确认标记：执行期间在场、结束即清（写作意图门优先认标记）", async () => {
    const requestContext = new RequestContext();
    let markedDuringExecution = false;
    const executeTool: UserActionToolExecutor = async (toolName, _input, context) => {
      markedDuringExecution = isUserConfirmedTool({ requestContext: context } as never, toolName);
      return { ok: true, summary: "写好了。" };
    };
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext,
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    expect(markedDuringExecution).toBe(true);
    expect(isUserConfirmedTool({ requestContext } as never, "generate_draft")).toBe(false);
    expect(events.at(-1)!.event).toBe("tool-result");
  });
});

describe("「确认裁剪」结构化动作（prune_snapshots）", () => {
  it("parseUserAction：keep 可缺省、数字字符串宽容、0=缺省、负数/小数拒绝；不需要章号", () => {
    expect(parseUserAction({ toolName: "prune_snapshots" })).toEqual({ kind: "action", action: { toolName: "prune_snapshots" } });
    expect(parseUserAction({ toolName: "prune_snapshots", keep: "50" })).toEqual({ kind: "action", action: { toolName: "prune_snapshots", keep: 50 } });
    expect(parseUserAction({ toolName: "prune_snapshots", keep: 0 })).toEqual({ kind: "action", action: { toolName: "prune_snapshots" } });
    expect(parseUserAction({ toolName: "prune_snapshots", keep: -1 }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "prune_snapshots", keep: 2.5 }).kind).toBe("invalid");
  });

  it("runUserAction：带确认标记执行 confirm=true，结束即清；结果摘要如实转述，不出下一步卡", async () => {
    const requestContext = new RequestContext();
    let markedDuringExecution = false;
    let receivedInput: Record<string, unknown> | undefined;
    const executeTool: UserActionToolExecutor = async (toolName, input, context) => {
      markedDuringExecution = isUserConfirmedTool({ requestContext: context } as never, toolName);
      receivedInput = input;
      return { ok: true, dryRun: false, summary: "已把操作历史裁到最近 50 条。" };
    };
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "prune_snapshots", keep: 50 },
      requestContext,
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    expect(markedDuringExecution).toBe(true);
    expect(isUserConfirmedTool({ requestContext } as never, "prune_snapshots")).toBe(false);
    expect(receivedInput).toEqual({ confirm: true, keep: 50 });
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-result", "text-delta"]);
    expect(events[2]!.data.text).toBe("已把操作历史裁到最近 50 条。");
  });

  it("执行抛错：tool-error + 如实说没完成、历史没动、可再点", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "prune_snapshots" },
      requestContext: new RequestContext(),
      executeTool: async () => { throw new Error("磁盘满了"); },
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: (e) => (e instanceof Error ? e.message : String(e)),
    });
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-error", "text-delta"]);
    expect(String(events[2]!.data.text)).toContain("没有完成");
    expect(String(events[2]!.data.text)).toContain("确认裁剪");
  });
});

describe("「写这一章」结构化动作（2026-10-10 出稿一条路）", () => {
  it("解析章号和可选方向；方向去空白、过长截断", async () => {
    const { parseUserAction } = await import("./user-actions.js");
    expect(parseUserAction({ toolName: "generate_draft", chapter: 3 })).toEqual({ kind: "action", action: { toolName: "generate_draft", chapter: 3 } });
    expect(parseUserAction({ toolName: "generate_draft", chapter: "3", chapterGoal: "  苏晚去槐树巷  " })).toEqual({
      kind: "action",
      action: { toolName: "generate_draft", chapter: 3, chapterGoal: "苏晚去槐树巷" },
    });
    expect(parseUserAction({ toolName: "generate_draft" })).toMatchObject({ kind: "invalid" });
  });

  it("执行 generate_draft、推结果和下一步选项；工具抛错如实说没写成", async () => {
    const { runUserAction } = await import("./user-actions.js");
    const events: { event: string; data: unknown }[] = [];
    const scrubber = { push: (text: string) => text, flush: () => "" };
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext: new RequestContext(),
      executeTool: async () => ({ ok: true, summary: "本章章纲：苏晚找书。写好了。" }),
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber,
      scrubError: (error) => String(error),
    });
    expect(events.map((item) => item.event)).toEqual(["tool-call", "tool-result", "text-delta", "tool-call", "tool-result"]);
    expect(JSON.stringify(events.at(-1)!.data)).toContain("预览定稿");
    const failed: { event: string; data: unknown }[] = [];
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext: new RequestContext(),
      executeTool: async () => { throw new Error("服务商超时"); },
      sendEvent: (event, data) => failed.push({ event, data }),
      scrubber,
      scrubError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    expect(failed.map((item) => item.event)).toEqual(["tool-call", "tool-error", "text-delta"]);
    expect(JSON.stringify(failed.at(-1)!.data)).toContain("原来的稿子没动");
  });
});
