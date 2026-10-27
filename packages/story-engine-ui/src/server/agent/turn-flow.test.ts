// @vitest-environment node
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/di";
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { stepCountIs } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildProjectRequestContext, markUserConfirmedTool } from "./request-context.js";
import { endsAfterDraftClosing, turnFlowProcessor, turnStateOf, withTurnFlow } from "./turn-flow.js";

type Execute = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

/** 照 Mastra 调工具的样子：每次调用拿到的是合并出来的新一份请求上下文，往里 set 的下一次读不到。 */
function perCall(base: RequestContext): ToolExecutionContext {
  const merged = new RequestContext();
  for (const [key, value] of base.entries()) merged.set(key, value);
  return { requestContext: merged } as unknown as ToolExecutionContext;
}

const run = (tool: object, input: unknown, base: RequestContext) => (tool as { execute: Execute }).execute(input, perCall(base));

function fakeTools() {
  const bodies = {
    generate_draft: vi.fn(async () => ({ ok: true, chapter: 26 })),
    commit_preview: vi.fn(async () => ({ ok: true })),
    read_draft: vi.fn(async () => ({ ok: true })),
    suggest_next_steps: vi.fn(async () => ({ ok: true })),
  };
  const tools = withTurnFlow({
    generate_draft: { execute: bodies.generate_draft },
    commit_preview: { execute: bodies.commit_preview },
    read_draft: { execute: bodies.read_draft },
    suggest_next_steps: { execute: bodies.suggest_next_steps },
  });
  return Object.assign(tools, { bodies });
}

/** 框架在执行这一步的工具前把模型这一步要调的工具交给输出处理器。 */
function planStep(turn: RequestContext, tools: readonly string[]): void {
  turnFlowProcessor.processOutputStep({
    toolCalls: tools.map((toolName, index) => ({ toolName, toolCallId: `c${index}`, args: {} })),
    requestContext: turn,
    messageList: undefined,
  } as never);
}

describe("写稿这一轮的流程（外部审查 2026-10-28：工具边界一处处拦，拦一处冒一处）", () => {
  it("这一步里有出稿：先进来的定稿预览也不执行（第 26 章模型先调预览、再调出稿，两个都跑了）；第二份出稿不写", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 26);
    planStep(turn, ["commit_preview", "generate_draft", "generate_draft", "read_draft"]);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "这一轮在写工作稿，这一步先不做，等稿写完、作者看过再说。" });
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: true, chapter: 26 });
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "一轮只写一章，这一章这一轮先不写。" });
    await expect(run(tools.read_draft, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    expect(tools.bodies.commit_preview).not.toHaveBeenCalled();
    expect(tools.bodies.read_draft).not.toHaveBeenCalled();
    expect(tools.bodies.generate_draft).toHaveBeenCalledTimes(1);
  });

  it("出稿跑过：下一步只放出「建议下一步」，模型照样调了别的也不执行；那一步走完这一轮结束", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await run(tools.generate_draft, {}, turn);
    const stop = endsAfterDraftClosing(turn);
    expect(stop()).toBe(false);
    expect(turnFlowProcessor.processInputStep({ requestContext: turn } as never)).toEqual({ activeTools: ["suggest_next_steps"] });
    planStep(turn, ["commit_preview", "suggest_next_steps"]);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "这一轮已经写过稿了，这一步先不做，等作者看完稿再说。" });
    await expect(run(tools.suggest_next_steps, {}, turn)).resolves.toEqual({ ok: true });
    expect(stop()).toBe(true);
  });

  it("没有出稿的轮次照常：读、预览、建议下一步都执行，下一步不收窄", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["read_draft", "commit_preview"]);
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    expect(turnFlowProcessor.processInputStep({ requestContext: turn } as never)).toBeUndefined();
    expect(endsAfterDraftClosing(turn)()).toBe(false);
  });

  it("出稿参数没过校验、工具没跑：不算写过稿，模型改了参数再调照常写", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    expect(turnFlowProcessor.processInputStep({ requestContext: turn } as never)).toBeUndefined();
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: true, chapter: 26 });
  });

  it("作者点的按钮带确认标记，照常执行；套过的不再套", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await run(tools.generate_draft, {}, turn);
    turnFlowProcessor.processInputStep({ requestContext: turn } as never);
    markUserConfirmedTool(turn, "commit_preview");
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    const once = tools.commit_preview.execute;
    withTurnFlow(tools);
    expect(tools.commit_preview.execute).toBe(once);
  });
});

type DoStream = Extract<NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"], (...args: never[]) => unknown>;
type CallOptions = Parameters<DoStream>[0];
type StreamPart = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer T> ? T : never;

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function toolCallStep(calls: readonly { readonly name: string; readonly input?: unknown }[], text?: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...(text ? [
      { type: "text-start", id: "t" } as const,
      { type: "text-delta", id: "t", delta: text } as const,
      { type: "text-end", id: "t" } as const,
    ] : []),
    ...calls.map((call, index) => ({ type: "tool-call", toolCallId: `${call.name}-${index}`, toolName: call.name, input: JSON.stringify(call.input ?? {}) }) as const),
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
  ];
}

describe("写稿这一轮的流程：真框架（Mastra 先跑输出处理器、再执行工具；收窄的工具真传给了模型）", () => {
  it("模型一步里先调预览、再调出稿：只写稿；下一步模型只拿到「建议下一步」；那一步走完不再调模型", async () => {
    const executed: string[] = [];
    const tool = (id: string) => createTool({
      id,
      description: id,
      inputSchema: z.object({}).passthrough(),
      execute: async () => {
        executed.push(id);
        return id === "generate_draft" ? { ok: true, chapter: 26, summary: "第 26 章写好了。" } : { ok: true };
      },
    });
    const offered: string[][] = [];
    const replies = [
      toolCallStep([{ name: "commit_preview" }, { name: "generate_draft" }]),
      toolCallStep([{ name: "read_draft" }, { name: "suggest_next_steps" }], "写好了。"),
      toolCallStep([{ name: "commit_preview" }]),
    ];
    const model = new MockLanguageModelV3({
      doStream: async (options: CallOptions) => {
        offered.push((options.tools ?? []).map((item) => item.name));
        return { stream: simulateReadableStream({ chunks: replies[offered.length - 1] ?? toolCallStep([]) }) };
      },
    });
    const agent = new Agent({
      id: "turn-flow-test",
      name: "turn-flow-test",
      instructions: "test",
      model,
      inputProcessors: [turnFlowProcessor],
      outputProcessors: [turnFlowProcessor],
      tools: withTurnFlow({
        generate_draft: tool("generate_draft"),
        commit_preview: tool("commit_preview"),
        read_draft: tool("read_draft"),
        suggest_next_steps: tool("suggest_next_steps"),
      }),
    });
    const turn = buildProjectRequestContext("/tmp/book", 26);
    const stream = await agent.stream("写第 26 章，写完顺手出定稿预览", {
      requestContext: turn,
      stopWhen: [stepCountIs(12), endsAfterDraftClosing(turn)],
      toolCallConcurrency: 1,
    });
    const results: { name: unknown; skipped: unknown }[] = [];
    for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: { toolName?: string; result?: { skipped?: unknown } } }>) {
      if (chunk.type === "tool-result") results.push({ name: chunk.payload?.toolName, skipped: chunk.payload?.result?.skipped });
    }
    expect(executed).toEqual(["generate_draft", "suggest_next_steps"]);
    expect(offered).toHaveLength(2);
    expect(offered[0]).toEqual(expect.arrayContaining(["generate_draft", "commit_preview", "read_draft", "suggest_next_steps"]));
    expect(offered[1]).toEqual(["suggest_next_steps"]);
    expect(results).toEqual(expect.arrayContaining([
      { name: "commit_preview", skipped: true },
      { name: "generate_draft", skipped: undefined },
      { name: "suggest_next_steps", skipped: undefined },
    ]));
    expect(turnStateOf(turn)).toMatchObject({ draftStarted: true, closing: true });
  });
});
