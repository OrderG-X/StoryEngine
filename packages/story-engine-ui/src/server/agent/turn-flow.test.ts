// @vitest-environment node
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/di";
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { stepCountIs } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildProjectRequestContext, markUserConfirmedTool } from "./request-context.js";
import { endsByFlow, releaseTurnFlow, turnFlowProcessor, turnStateOf, withTurnFlow } from "./turn-flow.js";

type Execute = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

/** 照 Mastra 调工具的样子：每次调用拿到的是合并出来的新一份请求上下文，往里 set 的下一次读不到。 */
function perCall(base: RequestContext): ToolExecutionContext {
  const merged = new RequestContext();
  for (const [key, value] of base.entries()) merged.set(key, value);
  return { requestContext: merged } as unknown as ToolExecutionContext;
}

const run = (tool: object, input: unknown, base: RequestContext) => (tool as { execute: Execute }).execute(input, perCall(base));

/** 框架在执行这一步的工具前把模型这一步要调的工具交给输出处理器。 */
function planStep(turn: RequestContext, tools: readonly string[]): void {
  turnFlowProcessor.processOutputStep({
    toolCalls: tools.map((toolName, index) => ({ toolName, toolCallId: `c${index}`, args: {} })),
    requestContext: turn,
    messageList: undefined,
  } as never);
}

describe("交操作这一轮的流程（写作版本 P2a 契约第三节）", () => {
  function submitTools() {
    const bodies = {
      run_check: vi.fn(async () => ({ ok: true, accepted: true, opId: "op-1", summary: "交出去了：核账·第 3 章。" })),
      change_draft: vi.fn(async () => ({ ok: true, accepted: true, opId: "op-2", summary: "交出去了：写稿·第 3 章。" })),
      foundation_write: vi.fn(async () => ({ ok: true })),
      commit_preview: vi.fn(async () => ({ ok: true })),
      read_draft: vi.fn(async () => ({ ok: true })),
    };
    const tools = withTurnFlow({
      run_check: { execute: bodies.run_check },
      change_draft: { execute: bodies.change_draft },
      foundation_write: { execute: bodies.foundation_write },
      commit_preview: { execute: bodies.commit_preview },
      read_draft: { execute: bodies.read_draft },
    });
    return Object.assign(tools, { bodies });
  }

  it("同一步交操作、又要改设定：整步不明，一件都不做（ambiguous_plan），读的照常；模型改成一件再交照常受理", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 3);
    planStep(turn, ["read_draft", "run_check", "foundation_write"]);
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    await expect(run(tools.run_check, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true, code: "ambiguous_plan" });
    await expect(run(tools.foundation_write, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true, code: "ambiguous_plan" });
    expect(tools.bodies.run_check).not.toHaveBeenCalled();
    expect(tools.bodies.foundation_write).not.toHaveBeenCalled();
    expect(endsByFlow(turn)()).toBe(false);

    planStep(turn, ["run_check"]);
    await expect(run(tools.run_check, {}, turn)).resolves.toMatchObject({ ok: true, accepted: true, opId: "op-1" });
    expect(endsByFlow(turn)()).toBe(true);
  });

  it("同一步交两件：一件都不交", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 3);
    planStep(turn, ["run_check", "run_check"]);
    await expect(run(tools.run_check, {}, turn)).resolves.toMatchObject({ ok: false, code: "ambiguous_plan" });
    expect(tools.bodies.run_check).not.toHaveBeenCalled();
  });

  it("受理了：这一步走完这一轮就结束；同一轮再要写的不执行，读的照常", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 3);
    planStep(turn, ["run_check"]);
    await run(tools.run_check, {}, turn);
    expect(turnStateOf(turn)?.operationAccepted).toEqual({ opId: "op-1" });
    planStep(turn, ["foundation_write", "read_draft"]);
    await expect(run(tools.foundation_write, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    expect(tools.bodies.foundation_write).not.toHaveBeenCalled();
  });

  it("没受理（参数不对、前提不满足）：不结束，模型照常往下走", async () => {
    const tools = submitTools();
    tools.bodies.run_check.mockResolvedValueOnce({ ok: false, code: "no_draft", summary: "第 3 章还没有正文。" } as never);
    const turn = buildProjectRequestContext("/tmp/book", 3);
    planStep(turn, ["run_check"]);
    await expect(run(tools.run_check, {}, turn)).resolves.toMatchObject({ ok: false, code: "no_draft" });
    expect(endsByFlow(turn)()).toBe(false);
    planStep(turn, ["foundation_write"]);
    await expect(run(tools.foundation_write, {}, turn)).resolves.toEqual({ ok: true });
  });

  it("同一步写稿又出定稿预览（第 26 章模型先调预览、再调出稿，两个都跑了）：一件都不做；写稿、检查一起交也一样", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 26);
    planStep(turn, ["commit_preview", "change_draft", "read_draft"]);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true, code: "ambiguous_plan" });
    await expect(run(tools.change_draft, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true, code: "ambiguous_plan" });
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    planStep(turn, ["change_draft", "run_check"]);
    await expect(run(tools.run_check, {}, turn)).resolves.toMatchObject({ ok: false, code: "ambiguous_plan" });
    expect(tools.bodies.change_draft).not.toHaveBeenCalled();
    expect(tools.bodies.commit_preview).not.toHaveBeenCalled();
    expect(tools.bodies.run_check).not.toHaveBeenCalled();
  });

  it("写稿受理了：这一轮就结束，同一轮再要出预览的不执行", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 3);
    planStep(turn, ["change_draft"]);
    await run(tools.change_draft, {}, turn);
    expect(endsByFlow(turn)()).toBe(true);
    expect(turnStateOf(turn)?.operationAccepted).toEqual({ opId: "op-2" });
    planStep(turn, ["commit_preview"]);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    expect(tools.bodies.commit_preview).not.toHaveBeenCalled();
  });

  it("交操作抛错：不算交上，模型可以再交", async () => {
    const tools = submitTools();
    tools.bodies.change_draft.mockRejectedValueOnce(new Error("断了"));
    const turn = buildProjectRequestContext("/tmp/book", 3);
    planStep(turn, ["change_draft"]);
    await expect(run(tools.change_draft, {}, turn)).rejects.toThrow("断了");
    expect(endsByFlow(turn)()).toBe(false);
    planStep(turn, ["change_draft"]);
    await expect(run(tools.change_draft, {}, turn)).resolves.toMatchObject({ accepted: true });
  });

  it("没交操作的轮次照常：读、预览都执行，不结束", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["read_draft", "commit_preview"]);
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    expect(endsByFlow(turn)()).toBe(false);
  });

  it("作者点的按钮带确认标记，照常执行；套过的不再套；模型这一轮走完放开拦法", async () => {
    const tools = submitTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    planStep(turn, ["change_draft"]);
    await run(tools.change_draft, {}, turn);
    markUserConfirmedTool(turn, "commit_preview");
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    const once = tools.commit_preview.execute;
    withTurnFlow(tools);
    expect(tools.commit_preview.execute).toBe(once);
    releaseTurnFlow(turn);
    await expect(run(tools.foundation_write, {}, turn)).resolves.toEqual({ ok: true });
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

describe("交操作这一轮的流程：真框架（Mastra 先跑输出处理器、再执行工具）", () => {
  it("模型一步里先调预览、再调写稿：一件都不做；改成只写稿就交上，这一轮结束，不再调模型", async () => {
    const executed: string[] = [];
    const tool = (id: string) => createTool({
      id,
      description: id,
      inputSchema: z.object({}).passthrough(),
      execute: async () => {
        executed.push(id);
        return id === "change_draft" ? { ok: true, accepted: true, opId: "op-26", chapter: 26, summary: "交出去了：写稿·第 26 章。" } : { ok: true };
      },
    });
    const offered: string[][] = [];
    const replies = [
      toolCallStep([{ name: "commit_preview" }, { name: "change_draft" }]),
      toolCallStep([{ name: "change_draft" }]),
      toolCallStep([{ name: "read_draft" }, { name: "suggest_next_steps" }], "写好了。"),
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
        change_draft: tool("change_draft"),
        commit_preview: tool("commit_preview"),
        read_draft: tool("read_draft"),
        suggest_next_steps: tool("suggest_next_steps"),
      }),
    });
    const turn = buildProjectRequestContext("/tmp/book", 26);
    const stream = await agent.stream("写第 26 章，写完顺手出定稿预览", {
      requestContext: turn,
      stopWhen: [stepCountIs(12), endsByFlow(turn)],
      toolCallConcurrency: 1,
    });
    const results: { name: unknown; skipped: unknown }[] = [];
    for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: { toolName?: string; result?: { skipped?: unknown } } }>) {
      if (chunk.type === "tool-result") results.push({ name: chunk.payload?.toolName, skipped: chunk.payload?.result?.skipped });
    }
    expect(executed).toEqual(["change_draft"]);
    expect(offered).toHaveLength(2);
    expect(offered[0]).toEqual(expect.arrayContaining(["change_draft", "commit_preview", "read_draft", "suggest_next_steps"]));
    expect(results).toEqual([
      { name: "commit_preview", skipped: true },
      { name: "change_draft", skipped: true },
      { name: "change_draft", skipped: undefined },
    ]);
    expect(turnStateOf(turn)?.operationAccepted).toEqual({ opId: "op-26" });
  });
});
