// @vitest-environment node
//
// agent-chat 路由辅助：currentChapter 解析 + 「用户当前章」system 上下文构造（H3）。
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_CHAT_HISTORY_MESSAGES,
  SSE_HEARTBEAT_INTERVAL_MS,
  abortOnClientDisconnect,
  buildCurrentChapterSystemMessage,
  buildModelMessages,
  buildWholeBookTruthLine,
  capChatHistoryWindow,
  closingFallbackText,
  endsOnNextSteps,
  formatChapterStatusLine,
  historyToModelMessages,
  isMastraToolValidationError,
  normalizeForwardedToolResult,
  readCurrentChapter,
  readAuthorWords,
  readPickedDirection,
  runAgentTurn,
  type AgentTurnChunk,
} from "./agent-chat.js";
import { readChatMessages } from "../lib/project-io.js";
import { startSseHeartbeat } from "../lib/sse-heartbeat.js";
import { recordUsage } from "../lib/usage-ledger.js";

// E2E 实锤：MIMO 等模型干完工具常沉默收场（用户只看到卡/章节冒出来、AI 一句话不说），偶尔整轮空转。
// 路由兜底保证「绝不静默」：本轮一个 text 都没发就补一条收尾。
describe("closingFallbackText 路由级『绝不静默』兜底（#2 干完不吭声 / #4 空转）", () => {
  it("模型已回话 → 不兜底（返回 null）", () => {
    expect(closingFallbackText({ emittedText: true, sawToolActivity: true, lastToolSummary: "x" })).toBeNull();
    expect(closingFallbackText({ emittedText: true, sawToolActivity: false })).toBeNull();
  });
  it("没回话但工具有摘要 → 用工具摘要如实兜底回报（#2）", () => {
    expect(closingFallbackText({ emittedText: false, sawToolActivity: true, lastToolSummary: "第 1 章已正式入库。" }))
      .toBe("第 1 章已正式入库。");
  });
  it("没回话、工具无摘要 → 中性兜底指向上方结果（#2）", () => {
    const out = closingFallbackText({ emittedText: false, sawToolActivity: true });
    expect(out).toBeTruthy();
    expect(out).not.toBe("");
  });
  it("没回话、也没调任何工具（完全空转）→ 诚实兜底请用户重说（#4）", () => {
    const out = closingFallbackText({ emittedText: false, sawToolActivity: false });
    expect(out).toBeTruthy();
    expect(out).toContain("再说一次");
  });
});

describe("runAgentTurn 单次回合（重构 P4：不读原话、不改写回复、不重做）", () => {
  /** 造一个直通 scrubber（测试不关心实体 id 清洗）。 */
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  function textChunk(text: string): AgentTurnChunk {
    return { type: "text-delta", payload: { text } };
  }
  function toolChunks(toolName: string, result: unknown): AgentTurnChunk[] {
    return [
      { type: "tool-call", payload: { toolCallId: `${toolName}-1`, toolName, args: {} } },
      { type: "tool-result", payload: { toolCallId: `${toolName}-1`, toolName, result } },
    ];
  }
  function collectText(events: { event: string; data: unknown }[]): string {
    return events
      .filter((e) => e.event === "text-delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
  }
  async function* streamOf(chunks: readonly AgentTurnChunk[]): AsyncIterable<AgentTurnChunk> {
    for (const chunk of chunks) yield chunk;
  }
  async function run(chunks: readonly AgentTurnChunk[], endedByFlow?: () => boolean) {
    const events: { event: string; data: unknown }[] = [];
    const result = await runAgentTurn({
      fullStream: streamOf(chunks),
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
      ...(endedByFlow ? { endedByFlow } : {}),
    });
    return { events, result };
  }

  it("步数用完、最后一步还是工具调用 → 如实说没做完（真机：7 处修改改到第 4 处就停）；正常说完的不加", async () => {
    const cut = await run([
      ...toolChunks("revise_draft", { ok: true, summary: "已改第 4 处。" }),
      textChunk("第四处改好，接着改第五处。"),
      { type: "finish", payload: { stepResult: { reason: "tool-calls" } } },
    ]);
    expect(collectText(cut.events)).toContain("步数用完了");
    expect(cut.result.finishReason).toBe("tool-calls");
    const done = await run([
      textChunk("七处都改好了。"),
      { type: "finish", payload: { stepResult: { reason: "stop" } } },
    ]);
    expect(collectText(done.events)).not.toContain("步数用完了");
  });

  it("停在出选项那一步是有意收尾：不报「步数用完」", async () => {
    const out = await run([
      textChunk("改好了三处。"),
      ...toolChunks("suggest_next_steps", { ok: true }),
      { type: "finish", payload: { stepResult: { reason: "tool-calls" } } },
    ]);
    expect(collectText(out.events)).toBe("改好了三处。");
  });

  it("endsOnNextSteps：这一步说了话、又只调了出选项的工具才收尾（长篇连写：不收的话模型把同一段话再说一遍）", () => {
    const step = (text: string, ...names: string[]) => ({ text, toolCalls: names.map((toolName) => ({ toolName })) });
    expect(endsOnNextSteps({ steps: [step("", "revise_draft"), step("改好了。", "suggest_next_steps")] })).toBe(true);
    // 先出选项、下一步才说结果的模型：这一步没说话，不停（长篇连写：停了作者只看到工具摘要）
    expect(endsOnNextSteps({ steps: [step("", "foundation_write"), step("", "suggest_next_steps")] })).toBe(false);
    expect(endsOnNextSteps({ steps: [step("改好了。", "revise_draft", "suggest_next_steps")] })).toBe(false);
    expect(endsOnNextSteps({ steps: [step("", "suggest_next_steps"), step("", "read_draft")] })).toBe(false);
    expect(endsOnNextSteps({ steps: [step("说了")] })).toBe(false);
    expect(endsOnNextSteps({ steps: [] })).toBe(false);
  });

  it("稿写成了：交回章号、结果和要不要写完就预览（结论、核账卡、下一步由服务端接着出）；不转述摘要、不报「步数用完」", async () => {
    const output = { ok: true, chapter: 26, thenPreview: true, summary: "第 26 章写好了，1700 字。" };
    const written = await run([
      textChunk("好，我来写第 26 章。"),
      ...toolChunks("commit_preview", { ok: false, skipped: true, summary: "这一轮在写工作稿，这一步先不做，等稿写完、作者看过再说。" }),
      ...toolChunks("generate_draft", output),
      { type: "finish", payload: { stepResult: { reason: "tool-calls" } } },
    ], () => true);
    expect(written.result.writtenDraft).toEqual({ chapter: 26, output, thenPreview: true });
    expect(written.result.emittedText).toBe(true);
    expect(collectText(written.events)).toBe("好，我来写第 26 章。");
    // 模型一个字没说：也不兜底转述（服务端接着出结论）
    const silent = await run([...toolChunks("generate_draft", { ok: true, chapter: 26, summary: "写好了。" })], () => true);
    expect(silent.result).toMatchObject({ emittedText: false, writtenDraft: { chapter: 26, thenPreview: false } });
    expect(collectText(silent.events)).toBe("");
  });

  it("出稿没写成 / 没执行：不算写成，照常兜底转述", async () => {
    const failed = await run([...toolChunks("generate_draft", { ok: false, chapter: 26, summary: "第 26 章还没章纲。" })]);
    expect(failed.result.writtenDraft).toBeUndefined();
    expect(collectText(failed.events)).toBe("第 26 章还没章纲。");
    const skipped = await run([...toolChunks("generate_draft", { ok: false, skipped: true, summary: "一轮只写一章，这一章这一轮先不写。" })]);
    expect(skipped.result.writtenDraft).toBeUndefined();
    expect(collectText(skipped.events)).not.toContain("一轮只写一章");
  });

  it("一轮结束把对话 AI 的用量记进全局用量账（P10，记在主对话名下、带模型）", async () => {
    vi.mocked(recordUsage).mockClear();
    await runAgentTurn({
      fullStream: streamOf([textChunk("好。"), { type: "finish", payload: { stepResult: { reason: "stop" }, output: { usage: { inputTokens: 300, outputTokens: 20 } } } }]),
      sendEvent: () => undefined,
      scrubber: passthroughScrubber(),
      model: { provider: "glm", providerLabel: "智谱", model: "glm-5" },
    });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ task: "triage", provider: "glm", model: "glm-5", sample: expect.objectContaining({ input: 300, output: 20 }) }));
  });

  it("模型/网络中途出错：只发 error 帧，不再叠「抱歉没能回应」", async () => {
    const { events } = await run([{ type: "error", payload: { error: new Error("terminated") } }]);
    expect(events.some((e) => e.event === "error")).toBe(true);
    expect(collectText(events)).not.toContain("没能生成回应");
  });

  it("AI 说什么就转发什么：零工具说「已经帮你入库了」也不改写、不追加更正（真相看工具卡，P3 走查事故的根治）", async () => {
    const { events } = await run([textChunk("已经帮你入库了。")]);
    expect(collectText(events)).toBe("已经帮你入库了。");
  });

  it("问进度的回复照实转发（P3 走查：「写到第几章」曾被整段换成「定稿没有执行」）", async () => {
    const { events } = await run([
      ...toolChunks("read_chapters_overview", { ok: true, summary: "已定稿第 1～3 章。" }),
      textChunk("目前定稿到第 3 章，第 4 章还没动笔。"),
    ]);
    expect(collectText(events)).toBe("目前定稿到第 3 章，第 4 章还没动笔。");
  });

  it("闷头调完工具不说话 → 兜底转述最后一张卡的摘要（绝不静默）", async () => {
    const { events } = await run(toolChunks("generate_draft", { ok: true, summary: "第 5 章已生成正文。" }));
    expect(collectText(events)).toContain("第 5 章已生成正文。");
  });

  it("什么都没做也没说 → 请作者重说（绝不静默）", async () => {
    const { events } = await run([]);
    expect(collectText(events).length).toBeGreaterThan(0);
  });
});

describe("R7.9：Mastra 工具校验失败结果的归一（步骤卡不再「已完成 + 空」）", () => {
  // @mastra/core tools/validation.ts validateToolInput 的真实返回形状（1.42.0 dist 源码核对）：
  // execute 不跑、无 ok/summary；框架把它当 tool-result 回给模型，模型看到 message 后通常自行修正重调。
  const MASTRA_VALIDATION_FAILURE = {
    error: true,
    message:
      'Tool input validation failed for generate_draft. Please fix the following errors and try again:\n' +
      "- mustHitBeats: Expected array, received object\n\n" +
      'Provided arguments: {"chapter":5,"mustHitBeats":{"1":"要点一"}}',
    validationErrors: { errors: [], fields: { mustHitBeats: { errors: ["Expected array, received object"] } } },
  };

  it("isMastraToolValidationError：只认结构化标记（error+message+validationErrors），不误伤正常工具结果", () => {
    expect(isMastraToolValidationError(MASTRA_VALIDATION_FAILURE)).toBe(true);
    expect(isMastraToolValidationError({ ok: false, summary: "第 4 章还没定稿。" })).toBe(false);
    expect(isMastraToolValidationError({ error: "出错了" })).toBe(false);
    expect(isMastraToolValidationError("Tool input validation failed")).toBe(false);
    expect(isMastraToolValidationError(null)).toBe(false);
  });

  it("归一：ok:false + 中文 summary（列 schema 字段名）+ 标记", () => {
    const result = normalizeForwardedToolResult(MASTRA_VALIDATION_FAILURE) as { ok: boolean; summary: string; toolValidationFailure: boolean };
    expect(result.ok).toBe(false);
    expect(result.toolValidationFailure).toBe(true);
    expect(result.summary).toContain("mustHitBeats");
    expect(result.summary).toContain("没通过校验");
    // 不把 Mastra 的 message 原文（内嵌模型原始参数）进步骤卡。
    expect(result.summary).not.toContain("Provided arguments");
  });

  it("归一：非校验失败结果逐字节原样转发（回归护栏）", () => {
    const verdictResult = { chapter: 99, ok: false, canCommit: false, blockingReasons: ["第 99 章还没有工作稿。"], summary: "第 99 章还没有工作稿。" };
    expect(normalizeForwardedToolResult(verdictResult)).toBe(verdictResult);
    const okResult = { ok: true, summary: "第 5 章已生成正文。" };
    expect(normalizeForwardedToolResult(okResult)).toBe(okResult);
  });

  it("runAgentTurn：校验失败的 tool-result 转发给前端时带 ok:false+summary，不带 Mastra 原文", async () => {
    const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });
    const chunks: AgentTurnChunk[] = [
      { type: "tool-call", payload: { toolCallId: "gd-1", toolName: "generate_draft", args: { mustHitBeats: { "1": "要点一" } } } },
      { type: "tool-result", payload: { toolCallId: "gd-1", toolName: "generate_draft", result: MASTRA_VALIDATION_FAILURE } },
      { type: "tool-call", payload: { toolCallId: "gd-2", toolName: "generate_draft", args: { mustHitBeats: ["要点一"] } } },
      { type: "tool-result", payload: { toolCallId: "gd-2", toolName: "generate_draft", result: { ok: true, summary: "第 11 章已生成正文。" } } },
      { type: "text-delta", payload: { text: "第 11 章写好了。" } },
    ];
    const events: { event: string; data: unknown }[] = [];
    await runAgentTurn({
      fullStream: (async function* () { for (const chunk of chunks) yield chunk; })(),
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    const toolResultEvents = events.filter((e) => e.event === "tool-result");
    expect(toolResultEvents).toHaveLength(2);
    const first = toolResultEvents[0]!.data as { output: { ok?: boolean; summary?: string; toolValidationFailure?: boolean } };
    expect(first.output.ok).toBe(false);
    expect(first.output.toolValidationFailure).toBe(true);
    expect(first.output.summary).toContain("没通过校验");
    expect(JSON.stringify(first)).not.toContain("Provided arguments");
  });
});

describe("空 toolCallId 兜底（治多工具塌进同一个 toolSteps key）", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  async function runToolTurn(chunks: AgentTurnChunk[]): Promise<{ event: string; data: unknown }[]> {
    const events: { event: string; data: unknown }[] = [];
    await runAgentTurn({
      fullStream: (async function* () { for (const chunk of chunks) yield chunk; })(),
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    return events;
  }

  it("两次空 id 的工具调用 → 转发的 id 各不相同、不再互相覆盖", async () => {
    const events = await runToolTurn([
      { type: "tool-call", payload: { toolCallId: "", toolName: "generate_draft", args: {} } },
      { type: "tool-result", payload: { toolCallId: "", toolName: "generate_draft", result: { ok: true, summary: "已生成工作稿。" } } },
      { type: "tool-call", payload: { toolCallId: "", toolName: "commit_chapter", args: {} } },
      { type: "tool-result", payload: { toolCallId: "", toolName: "commit_chapter", result: { ok: true, summary: "已入库。" } } },
    ]);
    const calls = events.filter((e) => e.event === "tool-call").map((e) => (e.data as { toolCallId: string }).toolCallId);
    const results = events.filter((e) => e.event === "tool-result").map((e) => (e.data as { toolCallId: string }).toolCallId);
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(calls[0]).not.toBe("");
    expect(new Set(calls).size).toBe(2);
    // FIFO 配对：结果按序复用对应调用的合成 id（前端按 id 把步骤收尾，配错会卡 running）
    expect(results[0]).toBe(calls[0]);
    expect(results[1]).toBe(calls[1]);
  });

  it("有真实 id 时原样透传，不被合成 id 污染", async () => {
    const events = await runToolTurn([
      { type: "tool-call", payload: { toolCallId: "call-abc", toolName: "generate_draft", args: {} } },
      { type: "tool-result", payload: { toolCallId: "call-abc", toolName: "generate_draft", result: { ok: true, summary: "已生成。" } } },
    ]);
    const calls = events.filter((e) => e.event === "tool-call").map((e) => (e.data as { toolCallId: string }).toolCallId);
    const results = events.filter((e) => e.event === "tool-result").map((e) => (e.data as { toolCallId: string }).toolCallId);
    expect(calls).toEqual(["call-abc"]);
    expect(results).toEqual(["call-abc"]);
  });

  it("tool-error 空 id 也按 FIFO 配对收尾（不把别的步骤置 failed）", async () => {
    const events = await runToolTurn([
      { type: "tool-call", payload: { toolCallId: "", toolName: "generate_draft", args: {} } },
      { type: "tool-error", payload: { toolCallId: "", toolName: "generate_draft", error: "boom" } },
    ]);
    const calls = events.filter((e) => e.event === "tool-call").map((e) => (e.data as { toolCallId: string }).toolCallId);
    const errors = events.filter((e) => e.event === "tool-error").map((e) => (e.data as { toolCallId: string }).toolCallId);
    expect(calls[0]).not.toBe("");
    expect(errors[0]).toBe(calls[0]);
  });

  it("结果事件先于调用事件到达（旧数据/race）→ 自己领一个新 id，不崩、不串", async () => {
    const events = await runToolTurn([
      { type: "tool-result", payload: { toolCallId: "", toolName: "generate_draft", result: { ok: true, summary: "孤儿结果。" } } },
    ]);
    const results = events.filter((e) => e.event === "tool-result").map((e) => (e.data as { toolCallId: string }).toolCallId);
    expect(results).toHaveLength(1);
    expect(results[0]).not.toBe("");
  });
});

// r8 二轮：聊天历史窗口截断。ch84/ch88/ch93 三个病例一致：历史堆到 ≥5 章重复回执剧本后，
// 弱模型开始续写回执而不调工具——正常成功回执也诱发。状态真值源在磁盘/工具，历史只保近程连续性。
describe("capChatHistoryWindow 聊天历史窗口（r8 治回执模式先验）", () => {
  const msg = (i: number) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `消息${i}` });

  it("超窗只保留最近 N 条（最新用户指令必在窗内）", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    const capped = capChatHistoryWindow(messages);
    expect(capped.length).toBe(MAX_CHAT_HISTORY_MESSAGES);
    expect(capped[capped.length - 1]).toEqual(messages[29]);
    expect(capped[0]).toEqual(messages[30 - MAX_CHAT_HISTORY_MESSAGES]);
  });

  it("窗内原样返回（不复制不截断）", () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg(i));
    expect(capChatHistoryWindow(messages)).toBe(messages);
  });
});

describe("historyToModelMessages 历史里的工具（长篇实跑第 17 章：照抄文字注、没调工具就说写好了）", () => {
  it("AI 回合调过的工具还原成真的调用和结果，再接回复原文；没调工具的回合、用户回合原样", () => {
    const messages = readChatMessages([
      { role: "user", content: "写第16章" },
      { role: "assistant", content: "第 16 章写好进工作稿了。", tools: [{ name: "generate_draft", ok: true }, { name: "check_continuity", ok: false }] },
      { role: "user", content: "好" },
      { role: "assistant", content: "嗯。", tools: [] },
      { role: "user", content: "写第17章" },
    ]);
    expect(historyToModelMessages(messages)).toEqual([
      { role: "user", content: "写第16章" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "history-1-0", toolName: "generate_draft", input: {} },
          { type: "tool-call", toolCallId: "history-1-1", toolName: "check_continuity", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "history-1-0", toolName: "generate_draft", output: { type: "text", value: "做完了，结果见下一条回复。" } },
          { type: "tool-result", toolCallId: "history-1-1", toolName: "check_continuity", output: { type: "text", value: "没成功；下一条回复里若说已经做成，不算数。" } },
        ],
      },
      { role: "assistant", content: "第 16 章写好进工作稿了。" },
      { role: "user", content: "好" },
      { role: "assistant", content: "嗯。" },
      { role: "user", content: "写第17章" },
    ]);
  });

  it("给了现有工具名：老会话里已经合并掉的工具不还原（写作版本 P2a），回复文字照留", () => {
    const messages = readChatMessages([
      { role: "assistant", content: "核了一遍。", tools: [{ name: "check_continuity", ok: true }] },
      { role: "assistant", content: "写好了，核了。", tools: [{ name: "generate_draft", ok: true }, { name: "quality_check", ok: true }] },
    ]);
    const history = historyToModelMessages(messages, new Set(["generate_draft", "run_check"]));
    expect(history[0]).toEqual({ role: "assistant", content: "核了一遍。" });
    expect(history[1]).toMatchObject({ role: "assistant", content: [{ type: "tool-call", toolName: "generate_draft" }] });
    expect(JSON.stringify(history)).not.toContain("quality_check");
  });

  it("出的卡作者点了「不改了」：工具结果照实说这张作废、再提就重新调", () => {
    const messages = readChatMessages([{ role: "assistant", content: "查完了。", tools: [{ name: "settle_fact", ok: true, dropped: true }] }]);
    expect(messages[0]).toMatchObject({ tools: [{ name: "settle_fact", ok: true, dropped: true }] });
    const [, result] = historyToModelMessages(messages);
    expect(result).toMatchObject({ role: "tool", content: [{ output: { value: "出了卡，作者在卡上点了「不改了」：这张作废、书里没动。作者再提就重新调。" } }] });
  });

  it("工具记录读进来只认有名字的；用户消息带了也不认", () => {
    expect(readChatMessages([
      { role: "assistant", content: "好了", tools: [{ name: "" }, { ok: true }, { name: "read_draft" }, "x"] },
      { role: "user", content: "嗯", tools: [{ name: "generate_draft", ok: true }] },
    ])).toEqual([
      { role: "assistant", content: "好了", tools: [{ name: "read_draft", ok: true }] },
      { role: "user", content: "嗯" },
    ]);
  });
});

describe("readCurrentChapter body 解析", () => {
  it("正整数原样返回", () => {
    expect(readCurrentChapter(3)).toBe(3);
  });

  it("缺省/非法（undefined/null/0/负/小数/字符串）→ undefined", () => {
    for (const bad of [undefined, null, 0, -2, 2.5, "3", Number.NaN]) {
      expect(readCurrentChapter(bad)).toBeUndefined();
    }
  });
});

describe("readAuthorWords 作者原话（只给工具找原句用）", () => {
  it("按先后取窗口里全部 user 消息，跳过空白", () => {
    expect(readAuthorWords([
      { role: "user", content: "写第59章" },
      { role: "assistant", content: "已出稿" },
      { role: "user", content: "   " },
      { role: "user", content: "让林溪回来" },
    ])).toEqual(["写第59章", "让林溪回来"]);
  });

  it("没有 user → 空数组", () => {
    expect(readAuthorWords([{ role: "assistant", content: "hi" }])).toEqual([]);
  });
});

describe("readPickedDirection 作者挑中的走法（换题材长篇实跑：说「照甲写」AI 不知道甲是什么）", () => {
  it("章号对上当前章、有字 → 去掉首尾空白的原文", () => {
    expect(readPickedDirection({ chapter: 14, text: "  老民警认账翻旧档：1. 去派出所  " }, 14)).toBe("老民警认账翻旧档：1. 去派出所");
  });

  it("章号对不上、没当前章、没字、形状不对 → 当没给", () => {
    expect(readPickedDirection({ chapter: 13, text: "甲" }, 14)).toBeUndefined();
    expect(readPickedDirection({ chapter: 14, text: "甲" }, undefined)).toBeUndefined();
    expect(readPickedDirection({ chapter: 14, text: "   " }, 14)).toBeUndefined();
    expect(readPickedDirection({ chapter: "14", text: "甲" }, 14)).toBeUndefined();
    expect(readPickedDirection("甲", 14)).toBeUndefined();
    expect(readPickedDirection(null, 14)).toBeUndefined();
  });
});

describe("buildCurrentChapterSystemMessage 当前章上下文", () => {
  it("带作者挑中的走法 → 原文进上下文，嘱咐照它写时原样填方向", () => {
    const content = buildCurrentChapterSystemMessage(14, {
      chapter: 14, hasDraftFile: false, hasCommittedChapter: false,
    }, undefined, "老民警认账翻旧档：1. 去派出所 2. 只漏出名字")!.content as string;
    expect(content).toContain("老民警认账翻旧档：1. 去派出所 2. 只漏出名字");
    expect(content).toContain("不用把它抄进 chapterGoal");
  });

  it("这章已定稿 → 不再提挑过的走法", () => {
    const content = buildCurrentChapterSystemMessage(14, {
      chapter: 14, hasDraftFile: true, hasCommittedChapter: true,
    }, undefined, "老民警认账翻旧档")!.content as string;
    expect(content).not.toContain("老民警认账翻旧档");
  });

  it("有章号 → 一条 role=system 消息，点名该章 + 嘱咐别跳最新章", () => {
    const msg = buildCurrentChapterSystemMessage(2);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("system");
    const content = msg!.content as string;
    expect(content).toContain("第 2 章");
    expect(content).toContain("别的章");
    expect(content).toContain("最新章");
  });

  it("无章号 → null（不注入 system 上下文）", () => {
    expect(buildCurrentChapterSystemMessage(undefined)).toBeNull();
  });

  it("带当前章状态 → system 消息含本章状态描述（⑤抓手）", () => {
    const msg = buildCurrentChapterSystemMessage(5, {
      chapter: 5, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "雨夜",
    });
    const content = msg!.content as string;
    expect(content).toContain("第 5 章");
    expect(content).toContain("已有工作稿");
    expect(content).toContain("雨夜");
    expect(content).toContain("继续"); // 引导「继续=在本章继续」
  });

  it("不传状态 → 行为与旧版兼容（仍点名该章，不带状态句）", () => {
    const msg = buildCurrentChapterSystemMessage(2);
    const content = msg!.content as string;
    expect(content).toContain("第 2 章");
    expect(content).not.toContain("已有工作稿");
    expect(content).not.toContain("是空的");
  });

  // codex 真机 P0：入库第 6 章后说「写第 7 章」却落回第 6 章。显式点名的章号必须压过当前章默认。
  it("显式点名章号一律以点名为准（不被当前章顶替）", () => {
    const msg = buildCurrentChapterSystemMessage(6);
    const content = msg!.content as string;
    expect(content).toContain("明确点名");
    expect(content).toContain("以用户点名的章号为准");
    expect(content).toContain("绝不用第 6 章顶替");
  });

  // 当前章已入库时，「继续/写下一章」目标是下一章（往前推进），不是重写本章（治章号 off-by-one）。
  it("当前章已定稿 → 明示「继续/写下一章」目标是下一章（N+1），不是重写本章", () => {
    const msg = buildCurrentChapterSystemMessage(6, {
      chapter: 6, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "灵泉",
    });
    const content = msg!.content as string;
    expect(content).toContain("第 6 章已定稿");
    expect(content).toContain("目标是第 7 章");
    expect(content).toContain("不是重写第 6 章");
  });

  it("当前章未入库（有草稿）→ 仍是「在本章继续」，不推进到下一章", () => {
    const msg = buildCurrentChapterSystemMessage(6, {
      chapter: 6, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "灵泉",
    });
    const content = msg!.content as string;
    expect(content).toContain("在本章继续");
    expect(content).not.toContain("目标是第 7 章");
  });
});

describe("buildWholeBookTruthLine 全书磁盘真相硬约束（A3 防谎报）", () => {
  it("列出已入库章节 + 标注未入库工作稿，并带防谎报硬约束措辞", () => {
    const line = buildWholeBookTruthLine([
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true },
      { chapter: 2, hasDraftFile: false, hasCommittedChapter: true },
      { chapter: 3, hasDraftFile: true, hasCommittedChapter: false },
    ]);
    expect(line).toContain("第 1、2 章"); // 已入库
    expect(line).toContain("第 3 章");   // 未入库工作稿
    expect(line).toContain("磁盘真相");
    expect(line).toContain("绝不能说成已定稿");
  });

  it("没有任何已入库章节 → 明说还没入库", () => {
    const line = buildWholeBookTruthLine([{ chapter: 1, hasDraftFile: false, hasCommittedChapter: false }]);
    expect(line).toContain("还没有任何章节已定稿");
  });

  it("超过 20 章已入库 → 折成『已入库N章，最高到第K章』不逐个列", () => {
    const states = Array.from({ length: 25 }, (_, i) => ({ chapter: i + 1, hasDraftFile: false, hasCommittedChapter: true }));
    const line = buildWholeBookTruthLine(states);
    expect(line).toContain("已定稿 25 章");
    expect(line).toContain("最高到第 25 章");
  });

  it("buildCurrentChapterSystemMessage 传 allStates → 当前章上下文里带上全书磁盘真相", () => {
    const msg = buildCurrentChapterSystemMessage(2, undefined, [
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true },
    ]);
    expect(msg?.content).toContain("磁盘真相");
    expect(msg?.content).toContain("第 1 章"); // 已入库
    expect(msg?.content).toContain("第 2 章"); // 当前章
  });

  it("currentChapter 缺失但有 allStates → 仍注入全书真相（不再返回 null）", () => {
    const msg = buildCurrentChapterSystemMessage(undefined, undefined, [
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true },
    ]);
    expect(msg).not.toBeNull();
    expect(msg?.content).toContain("磁盘真相");
  });
});

describe("buildModelMessages 当前章提示紧贴用户最新指令（对抗 lost-in-the-middle，⑤根因#1）", () => {
  const sys = { role: "system" as const, content: "你在第 5 章" };
  it("当前章 system 提示插在最后一条消息之前（而非开头被历史淹没）", () => {
    const history = [
      { role: "user" as const, content: "第一章怎么开场" },
      { role: "assistant" as const, content: "方案A出第一章" },
      { role: "user" as const, content: "继续。" },
    ];
    const out = buildModelMessages(sys, history);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(history[0]); // 开头不是 system
    expect(out[2]).toBe(sys);           // system 紧贴最后一条用户指令之前
    expect(out[3]).toEqual({ role: "user", content: "继续。" });
  });
  it("history 为空 → 只有 system", () => {
    expect(buildModelMessages(sys, [])).toEqual([sys]);
  });
  it("无 system → 原样返回 history", () => {
    const h = [{ role: "user" as const, content: "hi" }];
    expect(buildModelMessages(null, h)).toEqual(h);
  });
});

describe("formatChapterStatusLine 当前章状态（中性描述）", () => {
  it("已定稿 → 带『已定稿』+标题", () => {
    const line = formatChapterStatusLine(3, { chapter: 3, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "归途" });
    expect(line).toContain("已定稿");
    expect(line).toContain("归途");
  });
  it("有工作稿未定稿 → 带『工作稿』『尚未定稿』", () => {
    const line = formatChapterStatusLine(4, { chapter: 4, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "暗涌" });
    expect(line).toContain("工作稿");
    expect(line).toContain("尚未定稿");
    expect(line).toContain("暗涌");
  });
  it("空章 / 不在列表(undefined) → 带『还没有草稿，是空的』", () => {
    expect(formatChapterStatusLine(6, { chapter: 6, hasDraftFile: false, hasCommittedChapter: false })).toContain("是空的");
    expect(formatChapterStatusLine(9, undefined)).toContain("是空的");
  });
  // 重构 P5：章节状态只看工作稿 / 定稿文件；旧版写作台缓存不再更新，不参与判断。
  it("没有工作稿文件 → 是空的，绝不谎报已有工作稿", () => {
    const line = formatChapterStatusLine(1, { chapter: 1, hasDraftFile: false, hasCommittedChapter: false });
    expect(line).toContain("是空的");
    expect(line).not.toContain("已有工作稿");
  });
  it("题材中立：不含任何题材词", () => {
    const line = formatChapterStatusLine(1, { chapter: 1, hasDraftFile: true, hasCommittedChapter: false });
    expect(line).not.toMatch(/玄幻|修仙|武侠|霸总|穿越|科幻|言情/u);
  });
});

describe("startSseHeartbeat SSE 心跳（治工具长调用期间 90s 误判超时）", () => {
  it("按间隔写 SSE 注释行喂活客户端看门狗，stop 后不再写", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const res = { write: (chunk: string) => writes.push(chunk), writableEnded: false, destroyed: false } as never;
      const heartbeat = startSseHeartbeat(res, 1000);
      vi.advanceTimersByTime(3500);
      expect(writes).toEqual([": ping\n\n", ": ping\n\n", ": ping\n\n"]);
      heartbeat.stop();
      vi.advanceTimersByTime(5000);
      expect(writes).toHaveLength(3); // stop 之后心跳停了
    } finally {
      vi.useRealTimers();
    }
  });

  it("写失败（broken pipe）被吞掉，不冒泡抛错中断收尾", () => {
    vi.useFakeTimers();
    try {
      const res = {
        write: () => {
          throw new Error("EPIPE");
        },
        writableEnded: false,
        destroyed: false,
      } as never;
      const heartbeat = startSseHeartbeat(res, 1000);
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("心跳间隔远低于客户端 90s 空闲看门狗，留足多次丢包余量", () => {
    // agentChatClient.AGENT_IDLE_TIMEOUT_MS = 90_000；心跳要能在其间多次喂活看门狗。
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan(90_000 / 3);
  });
});

describe("abortOnClientDisconnect 客户端断开侦测（停止/空闲掐 fetch → 服务端中止生成）", () => {
  /** 假 res：EventEmitter + writableEnded 标志，模拟 res 'close' 事件。 */
  function makeFakeRes(writableEnded: boolean) {
    const res = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    res.writableEnded = writableEnded;
    return res as unknown as ServerResponse;
  }

  it("响应未完成时连接被掐（close + writableEnded=false）→ abort 触发", () => {
    const res = makeFakeRes(false);
    const controller = abortOnClientDisconnect(res);
    expect(controller.signal.aborted).toBe(false);
    res.emit("close");
    expect(controller.signal.aborted).toBe(true);
  });

  it("正常 res.end() 收尾（close + writableEnded=true）→ 不误杀", () => {
    const res = makeFakeRes(true);
    const controller = abortOnClientDisconnect(res);
    res.emit("close");
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("runAgentTurn shouldStop（客户端断开：停转发）", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  it("流式途中断开 → 之后的 chunk 不再转发（停止流式输出），回合照常收场", async () => {
    let stopped = false;
    const events: { event: string; data: unknown }[] = [];
    await runAgentTurn({
      fullStream: (async function* (): AsyncIterable<AgentTurnChunk> {
        yield { type: "text-delta", payload: { text: "甲" } };
        stopped = true; // 客户端在「甲」之后断开
        yield { type: "text-delta", payload: { text: "乙" } };
        yield { type: "text-delta", payload: { text: "丙" } };
      })(),
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
      shouldStop: () => stopped,
    });
    const text = events.filter((e) => e.event === "text-delta").map((e) => (e.data as { text: string }).text).join("");
    expect(text).toContain("甲");
    expect(text).not.toContain("乙");
    expect(text).not.toContain("丙");
  });
});
