import { RequestContext } from "@mastra/core/di";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isUserConfirmedTool } from "./request-context.js";
import {
  commitApplyNextSteps,
  humanizeToolNames,
  nextDraftChapterAfter,
  parseUserAction,
  readCommittedChapterNumbers,
  runUserAction,
  type UserActionToolExecutor,
} from "./user-actions.js";

describe("parseUserAction 结构化动作解析", () => {
  it("「确认改账」：带标识和裁定草案才收；缺标识 / 空草案 / 超量都按非法处理", () => {
    const decisions = [{ type: "fact.retract", fact: "c1-1" }];
    expect(parseUserAction({ toolName: "ledger_decision", key: " k1 ", decisions, label: "删掉一条" })).toEqual({
      kind: "action",
      action: { toolName: "ledger_decision", key: "k1", decisions, label: "删掉一条" },
    });
    expect(parseUserAction({ toolName: "ledger_decision", decisions }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "ledger_decision", key: "k", decisions: [] }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "ledger_decision", key: "k", decisions: Array.from({ length: 21 }, () => decisions[0]) }).kind).toBe("invalid");
  });

  it("「确认改设定」：带标识和写入对象才收；缺标识 / 写入不是对象都按非法处理", () => {
    const input = { actionType: "delete_foundation_entry", category: "characters", targetId: "char-x" };
    expect(parseUserAction({ toolName: "foundation_decision", key: " fw-1 ", input, label: "删条目 顾明" })).toEqual({
      kind: "action",
      action: { toolName: "foundation_decision", key: "fw-1", input, label: "删条目 顾明" },
    });
    expect(parseUserAction({ toolName: "foundation_decision", input }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "foundation_decision", key: "k", input: [input] }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "foundation_decision", key: "k", input: "删掉" }).kind).toBe("invalid");
  });

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
      choices: [{ label: "AI 写第 6 章", intent: "继续写第 6 章的正文", recommended: true, action: { toolName: "generate_draft", chapter: 6 } }],
    });
  });

  it("定稿成功 + 线索堆积加重档 → 加「归并线索」（开放式选项，不带结构化动作，照旧发文本给 agent，改账要作者点确认）", () => {
    const steps = commitApplyNextSteps(5, { committed: true, threadMaintenanceHint: "escalated" });
    expect(steps.choices.map((c) => c.label)).toEqual(["AI 写第 6 章", "归并线索"]);
    expect(steps.choices[1]).not.toHaveProperty("action");
  });

  it("没定稿 → 只给「重新预览」（带结构化动作：直达 commit_preview）", () => {
    expect(commitApplyNextSteps(5, { committed: false }).choices).toEqual([
      { label: "重新预览", intent: "生成第 5 章定稿预览", recommended: true, action: { toolName: "commit_preview", chapter: 5 } },
    ]);
  });
});

describe("nextDraftChapterAfter 写作前沿章（R7.7·报告 4.2：重定旧章后别推荐回去写旧章）", () => {
  it("重定第 3 章、第 1～5 章都已定稿 → 推荐第 6 章（不是第 4 章）", () => {
    expect(nextDraftChapterAfter(3, [1, 2, 3, 4, 5])).toBe(6);
  });

  it("正常路：第 5 章刚定稿、第 6 章还没写 → 仍是 6（旧行为不回归）", () => {
    expect(nextDraftChapterAfter(5, [1, 2, 3, 4, 5])).toBe(6);
  });

  it("N 之后有空洞（1、2、3、5 定稿，重定第 3 章）→ 推荐补第 4 章", () => {
    expect(nextDraftChapterAfter(3, [1, 2, 3, 5])).toBe(4);
  });

  it("脏输入（0/负数/小数）不算定稿章", () => {
    expect(nextDraftChapterAfter(2, [1, 2, 0, -3, 2.5])).toBe(3);
  });
});

describe("runUserAction 定稿收尾按书目录现算前沿章（R7.7）", () => {
  const tempDirs = new Set<string>();
  const cleanup = async (): Promise<void> => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  };

  it("重定第 3 章（1～5 章已定稿）→ 建议条推荐「写第 6 章」、直达 generate_draft 第 6 章", async () => {
    const projectDir = await makeProjectWithCommittedChapters([1, 2, 3, 4, 5]);
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "commit_apply", chapter: 3 },
      requestContext: new RequestContext(),
      executeTool: async () => ({ ok: true, committed: true, chapter: 3, summary: "第 3 章已定稿。" }),
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
      projectDir,
    });
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: { toolName: string; chapter?: number } }[] };
    expect(next.choices[0]).toMatchObject({ label: "AI 写第 6 章", action: { toolName: "generate_draft", chapter: 6 } });
    await cleanup();
  });

  it("第 6 章还没定稿时重定第 3 章 → 推荐接着写第 6 章（当前没定稿的前沿章）", async () => {
    const projectDir = await makeProjectWithCommittedChapters([1, 2, 3, 4, 5]);
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "check_continuity", chapter: 3 },
      requestContext: new RequestContext(),
      executeTool: async () => ({
        ok: false,
        chapter: 3,
        sure: [],
        maybe: [],
        pending: { done: 4, total: 57 },
        summary: "核账员还在读前文。",
      }),
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
      projectDir,
    });
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: { toolName: string; chapter?: number } }[] };
    expect(next.choices[1]).toMatchObject({ label: "先让 AI 写下一章", action: { toolName: "generate_draft", chapter: 6 } });
    await cleanup();
  });

  it("书目录读不到定稿章（chapters/ 缺失）→ 旧口径 N+1 兜底，不炸", async () => {
    const projectDir = await makeProjectWithCommittedChapters([]);
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "commit_apply", chapter: 5 },
      requestContext: new RequestContext(),
      executeTool: async () => ({ ok: true, committed: true, chapter: 5, summary: "第 5 章已定稿。" }),
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
      projectDir,
    });
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: { toolName: string; chapter?: number } }[] };
    expect(next.choices[0]).toMatchObject({ label: "AI 写第 6 章", action: { toolName: "generate_draft", chapter: 6 } });
    await cleanup();
  });

  it("readCommittedChapterNumbers 只认 chapters/ 下的 000N.md，别的文件不算", async () => {
    const projectDir = await makeProjectWithCommittedChapters([1, 3]);
    await writeFile(join(projectDir, "chapters", "notes.txt"), "不是章", "utf-8");
    expect(await readCommittedChapterNumbers(projectDir)).toEqual([1, 3]);
    expect(await readCommittedChapterNumbers(join(projectDir, "不存在"))).toEqual([]);
    await cleanup();
  });

  async function makeProjectWithCommittedChapters(chapters: readonly number[]): Promise<string> {
    const projectDir = await mkdtemp(join(tmpdir(), "user-actions-frontier-"));
    tempDirs.add(projectDir);
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    for (const chapter of chapters) {
      await writeFile(join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n正文。\n`, "utf-8");
    }
    return projectDir;
  }
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
    expect(events[4]!.data.output).toMatchObject({ ok: true, choices: [{ label: "AI 写第 6 章" }] });
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
  it("解析；执行时不带确认标记（只读），推 tool-call/tool-result + 一句结论（清单在弹窗里，重构 P6），不调模型", async () => {
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
    expect(events[2]!.data.text).toBe("第 4 章可以定稿，清单打开了。");
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
    expect(next.choices.map((c) => c.label)).toEqual(["再核一遍", "先让 AI 写下一章"]);
    const labels = JSON.stringify(next.choices);
    expect(labels).not.toContain("预览定稿");
    expect(labels).not.toContain("改掉确定");
  });

  it("核出问题 → 回话只说结论那句（headline），清单留给核账卡和稿纸划线（重构 P6）", async () => {
    const events = await runCheck(async () => ({
      ok: true,
      chapter: 5,
      sure: [{ quote: "甲", earlierQuote: "乙", earlierChapter: 2, reason: "对不上" }],
      maybe: [],
      failures: [],
      summary: "核了第 5 章：确定对不上 1 处。\n· 「甲」和第 2 章「乙」：对不上",
      headline: "核了第 5 章：确定对不上 1 处。",
    }));
    expect(textOf(events)).toBe("核了第 5 章：确定对不上 1 处。");
  });

  it("没核成（出错，ok:false 无 pending）且 summary 缺失 → 兜底文案也不写「核账做完了」", async () => {
    const events = await runCheck(async () => ({ ok: false, chapter: 5, sure: [], maybe: [], failures: ["第 1 遍（盯东西）没跑成"] }));
    expect(textOf(events)).toContain("没核成");
    expect(textOf(events)).not.toContain("做完了");
    const next = nextStepsOutput(events);
    expect(next.question).toBe("这次没核成，接下来？");
    expect(next.choices.map((c) => c.label)).toEqual(["再核一遍", "先让 AI 写下一章"]);
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
    expect(next.choices.map((c) => c.label)).toEqual(["预览定稿", "AI 写下一章"]);
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
    expect(next.choices.map((c) => c.label)).toEqual(["我自己改", "预览定稿", "再核一遍"]);
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
    expect(next.choices[0]).toMatchObject({ label: "再核一遍", action: { toolName: "check_continuity", chapter: 5 } });
    expect(next.choices[0]!.action).not.toHaveProperty("fresh");
    expect(next.choices[1]).toMatchObject({ label: "先让 AI 写下一章", action: { toolName: "generate_draft", chapter: 6 } });
  });

  it("核成且 0 处 → 「预览定稿」直达 commit_preview 本章、「写下一章」直达 generate_draft 下一章", async () => {
    const next = await runCheck(async () => ({ ok: true, chapter: 5, sure: [], maybe: [], failures: [], summary: "核了第 5 章，没发现对不上的地方。" }));
    expect(next.choices[0]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview", chapter: 5 } });
    expect(next.choices[1]).toMatchObject({ label: "AI 写下一章", action: { toolName: "generate_draft", chapter: 6 } });
  });

  it("核成且确定 N 处 → 「我自己改」不带 action（开放式，照旧发文本），「预览定稿」直达", async () => {
    const next = await runCheck(async () => ({ ok: true, chapter: 5, sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 4, reason: "r" }], maybe: [], failures: [], summary: "核了第 5 章：确定对不上 1 处。" }));
    expect(next.choices[0]).toMatchObject({ label: "我自己改" });
    expect(next.choices[0]).not.toHaveProperty("action");
    expect(next.choices[1]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview", chapter: 5 } });
  });

  it("结果复用 → 「再细核一遍」直达 check_continuity 且 fresh=true（重新核，不是给上次结果）", async () => {
    const next = await runCheck(async () => ({ ok: true, chapter: 5, reused: true, sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 4, reason: "r" }], maybe: [], failures: [], summary: "核了第 5 章：确定对不上 1 处。" }));
    expect(next.choices[2]).toMatchObject({ label: "再核一遍", action: { toolName: "check_continuity", chapter: 5, fresh: true } });
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

  it("出稿写好且写完核过账 → 回话只一句（字数），接着出核账卡（不再调模型），下一步按核账结果给", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const calls: string[] = [];
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext: new RequestContext(),
      executeTool: async (name) => {
        calls.push(name);
        return name === "generate_draft"
          ? {
            ok: true,
            draftTitle: "存根",
            draftBody: "正文",
            draftLength: { actualLength: 2300, lowerBound: 2400, lengthStatus: "below_lower_bound" },
            qualityPipeline: { continuity: { checked: true } },
            summary: "本章章纲：一大段。第 2 章已生成正文并写入工作稿……",
          }
          : { ok: true, chapter: 2, reused: true, sure: [{ quote: "q", earlierQuote: "e", earlierChapter: 1, reason: "r" }], maybe: [{}], failures: [], headline: "这一章和前文都没改过，结果同上次。" };
      },
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    expect(calls).toEqual(["generate_draft", "check_continuity"]);
    const text = events.filter((item) => item.event === "text-delta").map((item) => item.data.text).join("");
    expect(text).toBe("第 2 章写好了《存根》，2300 字，比下限少 100 字。\n写完核了一遍：确定对不上 1 处、可能 1 处，画在稿纸上了。");
    const next = events.at(-1)!.data.output as { choices: { label: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["我自己改", "预览定稿"]);
  });

  it("出稿写好但写完那遍核账没跑成 → 如实说一句，不出核账卡", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const calls: string[] = [];
    await runUserAction({
      action: { toolName: "generate_draft", chapter: 2 },
      requestContext: new RequestContext(),
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, draftBody: "正文", draftLength: { actualLength: 3000, lowerBound: 2400, lengthStatus: "within_range" }, qualityPipeline: { continuity: { checked: false } }, summary: "长摘要" };
      },
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    expect(calls).toEqual(["generate_draft"]);
    const text = events.filter((item) => item.event === "text-delta").map((item) => item.data.text).join("");
    expect(text).toBe("第 2 章写好了，3000 字。\n写完那遍核账没跑成，可以点「核账」再核。");
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

describe("「内容审阅」「硬伤检查」「撤销上一步」按钮结构化动作（重构 P4：走对话通道，不再走 HTTP 只读路由）", () => {
  const run = async (action: Parameters<typeof runUserAction>[0]["action"], executeTool: UserActionToolExecutor) => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action,
      requestContext: new RequestContext(),
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    return events;
  };

  it("解析：ai_review / quality_check 要章号；undo 不要；manage_snapshots 不收（裁剪另有确认按钮）", () => {
    expect(parseUserAction({ toolName: "ai_review", chapter: "3" })).toEqual({ kind: "action", action: { toolName: "ai_review", chapter: 3 } });
    expect(parseUserAction({ toolName: "quality_check", chapter: 3 })).toEqual({ kind: "action", action: { toolName: "quality_check", chapter: 3 } });
    expect(parseUserAction({ toolName: "ai_review" }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "undo" })).toEqual({ kind: "action", action: { toolName: "undo" } });
    expect(parseUserAction({ toolName: "manage_snapshots", op: "prune" }).kind).toBe("invalid");
  });

  it("内容审阅：只读、不带确认标记；工具卡 + 工具自己的摘要", async () => {
    let marked = true;
    const calls: { toolName: string; input: unknown }[] = [];
    const events = await run({ toolName: "ai_review", chapter: 3 }, async (toolName, input, context) => {
      marked = isUserConfirmedTool({ requestContext: context } as never, toolName);
      calls.push({ toolName, input });
      return { ok: true, summary: "第 3 章审完了：节奏偏慢。" };
    });
    expect(marked).toBe(false);
    expect(calls).toEqual([{ toolName: "ai_review", input: { chapter: 3 } }]);
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-result", "text-delta"]);
    expect(events[2]!.data.text).toBe("第 3 章审完了：节奏偏慢。");
  });

  it("硬伤检查没做成（ok:false 无摘要）→ 如实说没做成，不说做完了", async () => {
    const events = await run({ toolName: "quality_check", chapter: 3 }, async () => ({ ok: false }));
    const text = events.filter((e) => e.event === "text-delta").map((e) => String(e.data.text)).join("");
    expect(text).toContain("没做成");
    expect(text).not.toContain("做完了");
  });

  it("工具抛错 → tool-error（可重试）+ 如实文案", async () => {
    const events = await run({ toolName: "ai_review", chapter: 3 }, async () => { throw new Error("连接断了"); });
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-error", "text-delta"]);
    expect(String(events[2]!.data.text)).toContain("没做成");
  });

  it("撤销上一步：调 manage_snapshots op=undo，工具卡名就是 manage_snapshots（前端据 undone 接管磁盘真值）", async () => {
    const calls: { toolName: string; input: unknown }[] = [];
    const events = await run({ toolName: "undo" }, async (toolName, input) => {
      calls.push({ toolName, input });
      return { ok: true, undone: true, summary: "撤销了上一步：写第 3 章。" };
    });
    expect(calls).toEqual([{ toolName: "manage_snapshots", input: { op: "undo" } }]);
    expect(events[0]).toMatchObject({ event: "tool-call", data: { toolName: "manage_snapshots" } });
    expect(events[1]).toMatchObject({ event: "tool-result", data: { toolName: "manage_snapshots", output: { undone: true } } });
    expect(events.at(-1)!.data.text).toBe("撤销了上一步：写第 3 章。");
  });

  it("没东西可撤 → 如实说没有", async () => {
    const events = await run({ toolName: "undo" }, async () => ({ ok: true, undone: false }));
    expect(events.at(-1)!.data.text).toBe("没有可以撤销的改动。");
  });
});

describe("核账「改这处」结构化动作（revise_draft，重构 P6：按钮直接改，不经模型）", () => {
  const fix = (targetText: string) => ({ targetText, revisionGoal: "和第 10 章「八几年就没了」对上" });
  const run = async (fixes: readonly { targetText: string; revisionGoal: string }[], executeTool: UserActionToolExecutor) => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "revise_draft", chapter: 11, fixes },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: String,
    });
    return events;
  };
  const textOf = (events: readonly { event: string; data: Record<string, unknown> }[]) =>
    events.filter((e) => e.event === "text-delta").map((e) => String(e.data.text)).join("");

  it("解析：要章号和每处原句 + 目标；空的 / 超量 / 缺字段都按非法处理", () => {
    expect(parseUserAction({ toolName: "revise_draft", chapter: 11, fixes: [{ targetText: " 甲 ", revisionGoal: " 乙 " }] })).toEqual({
      kind: "action",
      action: { toolName: "revise_draft", chapter: 11, fixes: [{ targetText: "甲", revisionGoal: "乙" }] },
    });
    expect(parseUserAction({ toolName: "revise_draft", chapter: 11, fixes: [] }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "revise_draft", chapter: 11, fixes: [{ targetText: "甲" }] }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "revise_draft", fixes: [fix("甲")] }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "revise_draft", chapter: 11, fixes: Array.from({ length: 13 }, () => fix("甲")) }).kind).toBe("invalid");
  });

  it("逐处直接调 revise_draft（只改那一段）；都改成 → 一句「改好了」，推荐再核一遍", async () => {
    const calls: unknown[] = [];
    const events = await run([fix("甲"), fix("乙")], async (name, input) => {
      calls.push({ name, input });
      return { ok: true, applied: true, summary: "改好了" };
    });
    expect(calls).toEqual([
      { name: "revise_draft", input: { chapter: 11, targetText: "甲", revisionGoal: fix("甲").revisionGoal, constraints: ["只改这一段，别的不动"] } },
      { name: "revise_draft", input: { chapter: 11, targetText: "乙", revisionGoal: fix("乙").revisionGoal, constraints: ["只改这一段，别的不动"] } },
    ]);
    expect(textOf(events)).toBe("改好了 2 处（可撤销）。");
    const next = events.at(-1)!.data.output as { choices: { label: string; recommended?: boolean; action?: unknown }[] };
    expect(next.choices[0]).toMatchObject({ label: "再核一遍", recommended: true, action: { toolName: "check_continuity", chapter: 11 } });
  });

  it("没改成（原句没找到 / 报错）照实说原因，给「让 AI 改」，不说改好了", async () => {
    const events = await run([fix("甲")], async () => ({ ok: false, applied: false, summary: "原文在稿里没找到" }));
    expect(textOf(events)).toBe("这一处没改成：原文在稿里没找到");
    const next = events.at(-1)!.data.output as { question: string; choices: { label: string; intent: string }[] };
    expect(next.question).toBe("没改成，接下来？");
    expect(next.choices[0]!.label).toBe("让 AI 改");
    expect(next.choices[0]!.intent).toContain("「甲」");
    expect(next.choices.map((c) => c.label)).not.toContain("再核一遍");
  });

  it("一处成一处抛错：两样都如实说", async () => {
    let n = 0;
    const events = await run([fix("甲"), fix("乙")], async () => {
      n += 1;
      if (n === 2) throw new Error("模型没回");
      return { ok: true, applied: true };
    });
    expect(events.some((e) => e.event === "tool-error")).toBe(true);
    expect(textOf(events)).toBe("改好了 1 处（可撤销）。1 处没改成：Error: 模型没回");
  });
});

describe("「给我几种走法」结构化动作（brainstorm_chapter，重构 P6 头脑风暴）", () => {
  it("解析：想法去空白、截长；已给过的走法名去空、去重；缺章号不收", () => {
    expect(parseUserAction({ toolName: "brainstorm_chapter", chapter: 12, idea: "  让老周开口 ", avoid: [" 老周开口 ", "老周开口", "", 3, "夜里上楼"] })).toEqual({
      kind: "action",
      action: { toolName: "brainstorm_chapter", chapter: 12, idea: "让老周开口", avoid: ["老周开口", "夜里上楼"] },
    });
    expect(parseUserAction({ toolName: "brainstorm_chapter", chapter: 12, idea: "   " })).toEqual({
      kind: "action",
      action: { toolName: "brainstorm_chapter", chapter: 12 },
    });
    expect(parseUserAction({ toolName: "brainstorm_chapter" })).toEqual({ kind: "invalid", reason: "缺少有效章号。" });
  });

  const run = async (executeTool: UserActionToolExecutor) => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    await runUserAction({
      action: { toolName: "brainstorm_chapter", chapter: 12, idea: "让老周开口" },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
      scrubber: { push: (t: string) => t, flush: () => "" },
      scrubError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    return events;
  };

  it("直接跑只读工具（带想法），回话一句工具 summary；不追加下一步选项", async () => {
    const executeTool = vi.fn(async () => ({ ok: true, chapter: 12, options: [], summary: "第 12 章想了 3 种走法，在稿纸上挑。" }));
    const events = await run(executeTool);
    expect(executeTool).toHaveBeenCalledWith("brainstorm_chapter", { chapter: 12, idea: "让老周开口" }, expect.anything());
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-result", "text-delta"]);
    expect(events.at(-1)!.data.text).toBe("第 12 章想了 3 种走法，在稿纸上挑。");
  });

  it("工具抛错 → tool-error + 如实说没想出来", async () => {
    const events = await run(async () => { throw new Error("服务商超时"); });
    expect(events.map((e) => e.event)).toEqual(["tool-call", "tool-error", "text-delta"]);
    expect(String(events.at(-1)!.data.text)).toContain("第 12 章的走法没想出来：服务商超时");
  });
});
