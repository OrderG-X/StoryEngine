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

  it("章号数字字符串宽容还原；空 previewToken 丢掉", () => {
    expect(parseUserAction({ toolName: "commit_apply", chapter: "7", previewToken: "" })).toEqual({
      kind: "action",
      action: { toolName: "commit_apply", chapter: 7 },
    });
  });

  it.each([
    ["非对象", "commit_apply"],
    ["数组", []],
    ["白名单外工具", { toolName: "generate_draft", chapter: 1 }],
    ["缺章号", { toolName: "commit_apply" }],
    ["章号 0", { toolName: "commit_apply", chapter: 0 }],
    ["章号小数", { toolName: "commit_apply", chapter: 1.5 }],
    ["章号乱写", { toolName: "commit_apply", chapter: "abc" }],
  ])("%s → invalid（路由回 400，不当普通对话静默处理）", (_label, raw) => {
    expect(parseUserAction(raw).kind).toBe("invalid");
  });
});

describe("commitApplyNextSteps 定稿收尾的下一步（确定性）", () => {
  it("定稿成功 → 推荐写下一章", () => {
    expect(commitApplyNextSteps(5, { committed: true })).toEqual({
      question: "第 5 章定稿了，接下来？",
      choices: [{ label: "写第 6 章", intent: "继续写第 6 章的正文", recommended: true }],
    });
  });

  it("定稿成功 + 线索堆积加重档 → 加「清理线索」", () => {
    const steps = commitApplyNextSteps(5, { committed: true, threadMaintenanceHint: "escalated" });
    expect(steps.choices.map((c) => c.label)).toEqual(["写第 6 章", "清理线索"]);
  });

  it("没定稿 → 只给「重新预览」", () => {
    expect(commitApplyNextSteps(5, { committed: false }).choices).toEqual([
      { label: "重新预览", intent: "生成第 5 章定稿预览", recommended: true },
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
