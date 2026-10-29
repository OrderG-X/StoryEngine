// @vitest-environment node
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/di";
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { stepCountIs } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildProjectRequestContext, markUserConfirmedTool } from "./request-context.js";
import { endsAfterDraft, releaseTurnFlow, turnFlowProcessor, turnStateOf, withTurnFlow } from "./turn-flow.js";

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
    // 同一步的工具并排执行：第一份还在写，第二份进来
    const first = run(tools.generate_draft, {}, turn);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "一轮只写一章，这一章这一轮先不写。" });
    await expect(run(tools.read_draft, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    await expect(first).resolves.toEqual({ ok: true, chapter: 26 });
    expect(tools.bodies.commit_preview).not.toHaveBeenCalled();
    expect(tools.bodies.read_draft).not.toHaveBeenCalled();
    expect(tools.bodies.generate_draft).toHaveBeenCalledTimes(1);
  });

  it("稿写成了：这一步走完这一轮就结束（之后的由服务端出）；同一轮模型再调别的也不执行", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    const stop = endsAfterDraft(turn);
    planStep(turn, ["generate_draft"]);
    expect(stop()).toBe(false);
    await run(tools.generate_draft, {}, turn);
    expect(stop()).toBe(true);
    expect(turnStateOf(turn)?.draftWritten).toEqual({ chapter: 26, output: { ok: true, chapter: 26 }, thenPreview: false });
    planStep(turn, ["commit_preview"]);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "这一轮已经写过稿了，这一步先不做，等作者看完稿再说。" });
    expect(tools.bodies.commit_preview).not.toHaveBeenCalled();
  });

  it("模型这一轮走完、服务端接着出定稿预览：放开拦法，照常执行", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await run(tools.generate_draft, {}, turn);
    releaseTurnFlow(turn);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
  });

  it("出稿没写成（被挡下）：不算写过稿，不结束这一轮，模型改了再调照常写", async () => {
    const tools = fakeTools();
    tools.bodies.generate_draft.mockResolvedValueOnce({ ok: false, chapter: 22 } as never);
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: false, chapter: 22 });
    expect(endsAfterDraft(turn)()).toBe(false);
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: true, chapter: 26 });
    expect(endsAfterDraft(turn)()).toBe(true);
  });

  it("写好了但没换上（写的途中作者改过稿，留成候选）：也算这一轮写过稿，结束这一轮，不让模型再写一版", async () => {
    const tools = fakeTools();
    const kept = { ok: false, chapter: 22, kept: { candidateId: "22-x", reason: "draft_moved" } };
    tools.bodies.generate_draft.mockResolvedValueOnce(kept as never);
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await run(tools.generate_draft, {}, turn);
    expect(endsAfterDraft(turn)()).toBe(true);
    expect(turnStateOf(turn)?.draftWritten).toEqual({ chapter: 22, output: kept, thenPreview: false });
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    expect(tools.bodies.generate_draft).toHaveBeenCalledTimes(1);
  });

  it("出稿抛错：不算在写，模型可以再调", async () => {
    const tools = fakeTools();
    tools.bodies.generate_draft.mockRejectedValueOnce(new Error("断了"));
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).rejects.toThrow("断了");
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: true, chapter: 26 });
  });

  it("没有出稿的轮次照常：读、预览、建议下一步都执行，不结束", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["read_draft", "commit_preview"]);
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    expect(endsAfterDraft(turn)()).toBe(false);
  });

  it("出稿参数没过校验、工具没跑：不算写过稿，模型改了参数再调照常写", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    planStep(turn, ["generate_draft"]);
    await expect(run(tools.generate_draft, {}, turn)).resolves.toEqual({ ok: true, chapter: 26 });
  });

  it("作者点的按钮带确认标记，照常执行；套过的不再套", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["generate_draft"]);
    await run(tools.generate_draft, {}, turn);
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

describe("写稿这一轮的流程：真框架（Mastra 先跑输出处理器、再执行工具）", () => {
  it("模型一步里先调预览、再调出稿：只写稿；稿写成这一轮就结束，不再调模型", async () => {
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
      stopWhen: [stepCountIs(12), endsAfterDraft(turn)],
      toolCallConcurrency: 1,
    });
    const results: { name: unknown; skipped: unknown }[] = [];
    for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: { toolName?: string; result?: { skipped?: unknown } } }>) {
      if (chunk.type === "tool-result") results.push({ name: chunk.payload?.toolName, skipped: chunk.payload?.result?.skipped });
    }
    expect(executed).toEqual(["generate_draft"]);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toEqual(expect.arrayContaining(["generate_draft", "commit_preview", "read_draft", "suggest_next_steps"]));
    expect(results).toEqual([
      { name: "commit_preview", skipped: true },
      { name: "generate_draft", skipped: undefined },
    ]);
    expect(turnStateOf(turn)).toMatchObject({ draftStarted: true, draftWritten: { chapter: 26, thenPreview: false } });
  });
});
