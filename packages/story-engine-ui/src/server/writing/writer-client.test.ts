// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleWriterClient } from "./writer-client.js";

describe("createOpenAICompatibleWriterClient（出稿走流式·afterfix 治非流式整章生成卡代理超时间歇 500）", () => {
  function sseResponse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }
  function writerConfigured(): Parameters<typeof createOpenAICompatibleWriterClient>[0] {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "m", temperature: 0.7 },
      apiKey: "",
      thinking: false,
      thinkingDialect: "qwen",
    } as unknown as Parameters<typeof createOpenAICompatibleWriterClient>[0];
  }
  const ctx = { chapter: 5, sections: [] } as unknown as Parameters<ReturnType<typeof createOpenAICompatibleWriterClient>["generateDraft"]>[0]["context"];

  it("发 stream:true 并从 SSE 增量聚合正文（不再非流式一次性等整章→不卡代理超时）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第五章" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const out = await createOpenAICompatibleWriterClient(writerConfigured()).generateDraft({ context: ctx, maxOutputTokens: 0 });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(out.content).toBe("第五章正文。");
    spy.mockRestore();
  });

  it("绝不传 max_tokens（铁律：思考吃额度会截断/写空正文）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    await createOpenAICompatibleWriterClient(writerConfigured()).generateDraft({ context: ctx, maxOutputTokens: 4096 });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.max_tokens).toBeUndefined();
    expect(body.maxTokens).toBeUndefined();
    spy.mockRestore();
  });

  it("传 onDelta → 出稿时逐字外发正文 delta（agent 路流式进编辑器的源头），仍返回完整 content", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第五章" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const deltas: string[] = [];
    const out = await createOpenAICompatibleWriterClient(writerConfigured(), (d) => deltas.push(d)).generateDraft({ context: ctx, maxOutputTokens: 0 });
    expect(deltas.join("")).toBe("第五章正文。");
    expect(out.content).toBe("第五章正文。");
    spy.mockRestore();
  });
});
