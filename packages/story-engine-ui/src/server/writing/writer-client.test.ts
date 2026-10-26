// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleWriterClient, untilEndMark } from "./writer-client.js";
import { renderFastDraftPromptText, WRITER_END_MARK } from "./prompt-cache-diagnostics.js";

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

  // 长篇实跑：写手在正文后面接了一大段自检（「写完了。检查一遍：……可以定稿。」），原样进了工作稿。
  it("结尾标记后面的（自检、说明）不算正文：返回的正文去掉，流到稿纸上的也停在标记前", async () => {
    expect(renderFastDraftPromptText(ctx)).toContain(WRITER_END_MARK);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第五章正文。\n<<E" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ND>>\n写完了。检查一遍：没有禁词。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const deltas: string[] = [];
    const out = await createOpenAICompatibleWriterClient(writerConfigured(), (d) => deltas.push(d)).generateDraft({ context: ctx, maxOutputTokens: 0 });
    expect(out.content).toBe("第五章正文。");
    expect(deltas.join("")).toBe("第五章正文。\n");
    spy.mockRestore();
  });

  it("流式外发：像标记开头的几个字先压着，不是标记就照发", () => {
    const deltas: string[] = [];
    const send = untilEndMark((d) => deltas.push(d));
    send("他说<");
    expect(deltas.join("")).toBe("他说");
    send("走。");
    expect(deltas.join("")).toBe("他说<走。");
  });
});
