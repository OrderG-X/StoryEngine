// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { withThinkingCap } from "./model.js";

const frame = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta }] })}\n\n`;

/** 每 15ms 吐一帧：先 thinkCount 帧思考，再 answerCount 帧正文（0 = 一直只思考）。被取消就停。 */
function paced(thinkCount: number, answerCount: number, label: string): Response {
  const encoder = new TextEncoder();
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (cancelled) return;
      if (answerCount === 0 || i < thinkCount) controller.enqueue(encoder.encode(frame({ reasoning_content: "想" })));
      else if (i < thinkCount + answerCount) controller.enqueue(encoder.encode(frame({ content: label })));
      else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
      i += 1;
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { status: 200 });
}

async function readAll(response: Response): Promise<string> {
  return new Response(response.body).text();
}

describe("对话 AI 光想不动上限", () => {
  it("思考超过上限还没回答 → 关思考重发，回答接在同一条流后面", async () => {
    const bodies: string[] = [];
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? paced(0, 0, "") : paced(0, 2, "答");
    });
    const capped = withThinkingCap(base as unknown as typeof fetch, (init) => ({ ...init, body: "OFF" }), 80);
    const text = await readAll(await capped("https://x.invalid/v1/chat/completions", { method: "POST", body: "ON" }));
    expect(bodies).toEqual(["ON", "OFF"]);
    expect(text).toContain("reasoning_content");
    expect(text).toContain("\"content\":\"答\"");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    // 每一帧都是完整的（切换时不留半帧）
    for (const chunk of text.split("\n\n").filter(Boolean)) expect(() => JSON.parse(chunk.replace(/^data: /u, "").replace("[DONE]", "{}"))).not.toThrow();
  });

  it("上限内开始回答 → 不重发，之后想多久都不掐", async () => {
    const base = vi.fn(async () => paced(2, 20, "答"));
    const capped = withThinkingCap(base as unknown as typeof fetch, (init) => ({ ...init, body: "OFF" }), 100);
    const text = await readAll(await capped("https://x.invalid/v1/chat/completions", { method: "POST", body: "ON" }));
    expect(base).toHaveBeenCalledTimes(1);
    expect(text.match(/"content":"答"/gu)).toHaveLength(20);
  });

  it("开始就调工具也算动手了", async () => {
    const encoder = new TextEncoder();
    const base = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_draft", arguments: "{}" } }] })));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200 }));
    const capped = withThinkingCap(base as unknown as typeof fetch, (init) => init, 50);
    const text = await readAll(await capped("https://x.invalid", { method: "POST", body: "ON" }));
    expect(base).toHaveBeenCalledTimes(1);
    expect(text).toContain("read_draft");
  });
});
