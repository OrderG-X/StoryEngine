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

  it("「认下」（改设定那次的操作号）才收；号不对、缺号按非法；老的「确认改设定」按钮（foundation_decision）不再认", () => {
    const stamp = { requestKey: "k-1", issuedAt: "2026-10-30T00:00:00.000Z" };
    expect(parseUserAction({ kind: "new", type: "settings.change", params: { accept: "op-0123456789abcdef0123" }, ...stamp })).toEqual({
      kind: "action",
      action: { kind: "new", type: "settings.change", params: { accept: "op-0123456789abcdef0123" }, ...stamp },
    });
    expect(parseUserAction({ kind: "new", type: "settings.change", params: { accept: "op-1" }, ...stamp }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "settings.change", params: { ops: [{ op: "card.delete", card: "顾明" }] }, ...stamp }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "foundation_decision", key: "fw-1", input: { ops: [] } }).kind).toBe("invalid");
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

  it("操作动作（写作版本 P2a）：新检查要种类、章号、请求号、发出时间；接着做 / 不要了要操作号", () => {
    const issuedAt = "2026-10-29T01:02:03.000Z";
    expect(parseUserAction({ kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 3, fresh: true }, requestKey: "k-1", issuedAt })).toEqual({
      kind: "action",
      action: { kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 3, fresh: true }, requestKey: "k-1", issuedAt },
    });
    // fresh 只给核账；别的检查带了也不收。
    expect(parseUserAction({ kind: "new", type: "inspect.run", mode: "review", params: { chapter: 3, fresh: true }, requestKey: "k-1", issuedAt })).toMatchObject({
      action: { params: { chapter: 3 } },
    });
    expect(parseUserAction({ kind: "new", type: "inspect.run", mode: "nope", params: { chapter: 3 }, requestKey: "k-1", issuedAt }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "inspect.run", mode: "quality", params: { chapter: 0 }, requestKey: "k-1", issuedAt }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "inspect.run", mode: "quality", params: { chapter: 3 }, issuedAt }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "inspect.run", mode: "quality", params: { chapter: 3 }, requestKey: "k-1", issuedAt: "昨天" }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "draft.generate", mode: "quality", params: { chapter: 3 }, requestKey: "k-1", issuedAt }).kind).toBe("invalid");
    // 写稿（写这一章 / 重写 / 接着往下写）：参数照服务端口径归一，方向去空白、过长截断；接着写不收重写、几版。
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 3, direction: "  苏晚去槐树巷  ", rewrite: true, candidates: 2 }, requestKey: "k-1", issuedAt })).toEqual({
      kind: "action",
      action: { kind: "new", type: "draft.change", mode: "write", params: { chapter: 3, direction: "苏晚去槐树巷", rewrite: true, candidates: 2 }, requestKey: "k-1", issuedAt },
    });
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "continue", params: { chapter: 3, rewrite: true, candidates: 2 }, requestKey: "k-1", issuedAt })).toMatchObject({
      action: { mode: "continue", params: { chapter: 3 } },
    });
    const long = parseUserAction({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 3, direction: "长".repeat(3000) }, requestKey: "k-1", issuedAt });
    expect(long.kind === "action" && "params" in long.action ? (long.action.params as { direction?: string }).direction?.length : 0).toBe(2000);
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "revise", params: { chapter: 3 }, requestKey: "k-1", issuedAt }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "write", params: {}, requestKey: "k-1", issuedAt }).kind).toBe("invalid");
    // AI 另写几版给作者挑（片 2D）：没给几版就是两版；接着写不收。
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 3, pick: "author", thenPreview: true }, requestKey: "k-1", issuedAt })).toMatchObject({
      action: { mode: "write", params: { chapter: 3, pick: "author", candidates: 2 } },
    });
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "continue", params: { chapter: 3, pick: "author" }, requestKey: "k-1", issuedAt })).toMatchObject({
      action: { mode: "continue", params: { chapter: 3 } },
    });
    // 换上 / 不要了 AI 稿（片 2D）：候选号、指纹必带；换上还要作者眼前那份的版本号（新章是 null）。
    const pick = { chapter: 3, candidateId: "3-0123456789abcdef", sha: "a".repeat(64) };
    expect(parseUserAction({ kind: "new", type: "draft.adopt", params: { ...pick, baseVersion: null }, requestKey: "k-1", issuedAt })).toEqual({
      kind: "action",
      action: { kind: "new", type: "draft.adopt", params: { ...pick, baseVersion: null }, requestKey: "k-1", issuedAt },
    });
    expect(parseUserAction({ kind: "new", type: "draft.discard", params: { ...pick, baseVersion: "v1" }, requestKey: "k-1", issuedAt })).toEqual({
      kind: "action",
      action: { kind: "new", type: "draft.discard", params: pick, requestKey: "k-1", issuedAt },
    });
    for (const params of [pick, { ...pick, sha: "不对", baseVersion: null }, { ...pick, candidateId: "../x", baseVersion: null }, { ...pick, chapter: 0, baseVersion: null }]) {
      expect(parseUserAction({ kind: "new", type: "draft.adopt", params, requestKey: "k-1", issuedAt }).kind).toBe("invalid");
    }
    // 老的出稿按钮（按工具名）不再收。
    expect(parseUserAction({ toolName: "generate_draft", chapter: 3 }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "resume", opId: "op-0123456789abcdef0123" })).toEqual({ kind: "action", action: { kind: "resume", opId: "op-0123456789abcdef0123" } });
    expect(parseUserAction({ kind: "cancel", opId: "op-x" }).kind).toBe("invalid");
    // 老按钮（核账 / 审稿 / 质检按工具名）不再收。
    expect(parseUserAction({ toolName: "check_continuity", chapter: 3 }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "ai_review", chapter: 3 }).kind).toBe("invalid");
    expect(parseUserAction({ toolName: "quality_check", chapter: 3 }).kind).toBe("invalid");
  });

  it("改的天数随定稿动作带上：到第几天只跟着第几天一起认", () => {
    expect(parseUserAction({ toolName: "commit_apply", chapter: 5, dayOverride: "21", dayEndOverride: 22 })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 5, dayOverride: 21, dayEndOverride: 22 },
    });
    expect(parseUserAction({ toolName: "commit_apply", chapter: 5, dayEndOverride: 22 })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 5 },
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
  it("定稿成功 → 推荐写下一章（带结构化动作：R4.7 点击直达，交一次写稿，不经模型）", () => {
    expect(commitApplyNextSteps(5, { committed: true })).toEqual({
      question: "第 5 章定稿了，接下来？",
      choices: [{ label: "AI 写第 6 章", intent: "继续写第 6 章的正文", recommended: true, action: expect.objectContaining({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 6 } }) }],
    });
  });

  it("定稿成功 + 线索堆积加重档 → 加「归并线索」（开放式选项，不带结构化动作，照旧发文本给 agent，改账要作者点确认）", () => {
    const steps = commitApplyNextSteps(5, { committed: true, threadMaintenanceHint: "escalated" });
    expect(steps.choices.map((c) => c.label)).toEqual(["AI 写第 6 章", "归并线索"]);
    expect(steps.choices[1]).not.toHaveProperty("action");
  });

  it("下一章已经有工作稿（回头重定了旧章）→ 推荐核那一章，不推荐「AI 写」（点了会整章重写手头的稿子）", () => {
    expect(commitApplyNextSteps(17, { committed: true }, { chapter: 18, hasDraft: true }).choices).toEqual([
      { label: "核第 18 章", intent: "核第 18 章的账", recommended: true, action: expect.objectContaining({ kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 18 } }) },
    ]);
    expect(commitApplyNextSteps(17, { committed: true }, { chapter: 18, hasDraft: false }).choices[0])
      .toMatchObject({ label: "AI 写第 18 章", action: { kind: "new", type: "draft.change", mode: "write", params: { chapter: 18 } } });
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

  it("重定第 3 章（1～5 章已定稿）→ 建议条推荐「写第 6 章」、直达写第 6 章", async () => {
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
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: unknown }[] };
    expect(next.choices[0]).toMatchObject({ label: "AI 写第 6 章", action: { kind: "new", type: "draft.change", mode: "write", params: { chapter: 6 } } });
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
    const next = events.at(-1)!.data.output as { choices: { label: string; action?: unknown }[] };
    expect(next.choices[0]).toMatchObject({ label: "AI 写第 6 章", action: { kind: "new", type: "draft.change", mode: "write", params: { chapter: 6 } } });
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
    // 「就这么短，照样定稿」只认布尔 true（别的值当没点）。
    expect(parseUserAction({ toolName: "commit_preview", chapter: 4, allowShort: true })).toEqual({ kind: "action", action: { toolName: "commit_preview", chapter: 4, allowShort: true } });
    expect(parseUserAction({ toolName: "commit_preview", chapter: 4, allowShort: "true" })).toEqual({ kind: "action", action: { toolName: "commit_preview", chapter: 4 } });
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

describe("「撤销上一步」按钮结构化动作（重构 P4：走对话通道）", () => {
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

  it("解析：undo 不要章号；manage_snapshots 不收（裁剪另有确认按钮）", () => {
    expect(parseUserAction({ toolName: "undo" })).toEqual({ kind: "action", action: { toolName: "undo" } });
    expect(parseUserAction({ toolName: "manage_snapshots", op: "prune" }).kind).toBe("invalid");
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

describe("改稿按钮（draft.change fix / deai / revise，片 2C）", () => {
  const stamp = { requestKey: "edit-key-1", issuedAt: "2026-10-30T08:00:00.000Z" };
  const fix = (targetText: string) => ({ targetText, revisionGoal: "和第 10 章「八几年就没了」对上" });

  it("核账卡「改这处 / 改掉这 N 处」：章号和每处原句 + 改法；空的 / 超量 / 缺字段都按非法处理", () => {
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "fix", params: { chapter: 11, fixes: [{ targetText: " 甲 ", revisionGoal: " 乙 " }] }, ...stamp })).toEqual({
      kind: "action",
      action: { kind: "new", type: "draft.change", mode: "fix", params: { mode: "fix", chapter: 11, fixes: [{ targetText: "甲", revisionGoal: "乙" }] }, ...stamp },
    });
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "fix", params: { chapter: 11, fixes: [] }, ...stamp }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "fix", params: { chapter: 11, fixes: [{ targetText: "甲" }] }, ...stamp }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "fix", params: { fixes: [fix("甲")] }, ...stamp }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "fix", params: { chapter: 11, fixes: Array.from({ length: 13 }, () => fix("甲")) }, ...stamp }).kind).toBe("invalid");
  });

  it("AI 味卡「改掉这句 / 一键全修」：句子必填，严重度缺了按中等", () => {
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "deai", params: { chapter: 3, violations: [{ id: "v1", text: "那一刻，他心中五味杂陈。", reason: "套路抒情" }] }, ...stamp })).toEqual({
      kind: "action",
      action: { kind: "new", type: "draft.change", mode: "deai", params: { mode: "deai", chapter: 3, violations: [{ id: "v1", text: "那一刻，他心中五味杂陈。", reason: "套路抒情", severity: "medium" }] }, ...stamp },
    });
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "deai", params: { chapter: 3, violations: [{ id: "v1" }] }, ...stamp }).kind).toBe("invalid");
  });

  it("选中文字改写：原文照原样（不去空白），带 preview", () => {
    expect(parseUserAction({ kind: "new", type: "draft.change", mode: "revise", params: { chapter: 2, edits: [{ targetText: "他走了。 ", revisionGoal: "更克制" }], preview: true }, ...stamp })).toEqual({
      kind: "action",
      action: { kind: "new", type: "draft.change", mode: "revise", params: { mode: "revise", chapter: 2, edits: [{ targetText: "他走了。 ", revisionGoal: "更克制" }], preview: true }, ...stamp },
    });
  });

  it("「换上 / 再改一版」：接着做带按钮号和选法；缺了或形状不对按非法处理", () => {
    const opId = "op-0123456789abcdef0123";
    expect(parseUserAction({ kind: "resume", opId, answer: { actionId: "confirm:1", decision: "again" } })).toEqual({
      kind: "action",
      action: { kind: "resume", opId, answer: { actionId: "confirm:1", decision: "again" } },
    });
    expect(parseUserAction({ kind: "resume", opId, answer: { actionId: "confirm:1" } }).kind).toBe("invalid");
    expect(parseUserAction({ kind: "resume", opId, answer: { actionId: "确认", decision: "apply" } }).kind).toBe("invalid");
  });
});

describe("「给我几种走法」「再来几种」按钮（plan.propose，片 2D）", () => {
  const issuedAt = "2026-10-30T08:00:00.000Z";
  it("解析：想法去空白；已给过的走法名去空、去重；缺章号不收；老的按工具名的按钮不认", () => {
    expect(parseUserAction({ kind: "new", type: "plan.propose", params: { chapter: 12, idea: "  让老周开口 ", avoid: [" 老周开口 ", "老周开口", "", 3, "夜里上楼"] }, requestKey: "k-1", issuedAt })).toEqual({
      kind: "action",
      action: { kind: "new", type: "plan.propose", params: { chapter: 12, idea: "让老周开口", avoid: ["老周开口", "夜里上楼"] }, requestKey: "k-1", issuedAt },
    });
    expect(parseUserAction({ kind: "new", type: "plan.propose", params: { chapter: 12, idea: "   " }, requestKey: "k-1", issuedAt })).toEqual({
      kind: "action",
      action: { kind: "new", type: "plan.propose", params: { chapter: 12 }, requestKey: "k-1", issuedAt },
    });
    expect(parseUserAction({ kind: "new", type: "plan.propose", params: {}, requestKey: "k-1", issuedAt })).toEqual({ kind: "invalid", reason: "缺少有效章号。" });
    expect(parseUserAction({ toolName: "brainstorm_chapter", chapter: 12 }).kind).toBe("invalid");
  });
});
