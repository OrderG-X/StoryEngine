import { describe, expect, it } from "vitest";
import { createProviderGate } from "./provider-gate.js";

const URL_A = "https://api.example.com/v1/chat/completions";
const noSleep = async () => undefined;
const quiet = () => undefined;

function streamingResponse(chunks: string[], status = 200): { response: Response; finish: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
    },
  });
  return { response: new Response(body, { status }), finish: () => controller?.close() };
}

describe("provider-gate", () => {
  it("429 后退避重试，成功就把正文交回", async () => {
    const statuses = [429, 429, 200];
    const calls: number[] = [];
    const gate = createProviderGate({ sleep: noSleep, log: quiet });
    const response = await gate.fetch(URL_A, { method: "POST" }, {
      baseFetch: async () => {
        const status = statuses[calls.length];
        calls.push(status);
        return new Response(status === 200 ? "ok" : "slow down", { status });
      },
    });
    expect(calls).toEqual([429, 429, 200]);
    expect(await response.text()).toBe("ok");
  });

  it("重试用完仍是 429：把最后的响应原样交回，由调用方如实报错", async () => {
    let count = 0;
    const gate = createProviderGate({ sleep: noSleep, log: quiet, maxRetries: 2 });
    const response = await gate.fetch(URL_A, undefined, {
      baseFetch: async () => {
        count += 1;
        return new Response("limit", { status: 429 });
      },
    });
    expect(count).toBe(3);
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("limit");
  });

  it("照 Retry-After 等", async () => {
    const waits: number[] = [];
    let first = true;
    const gate = createProviderGate({ sleep: async (ms) => { waits.push(ms); }, log: quiet });
    await gate.fetch(URL_A, undefined, {
      baseFetch: async () => {
        if (first) {
          first = false;
          return new Response("", { status: 429, headers: { "retry-after": "3" } });
        }
        return new Response("ok");
      },
    });
    expect(waits).toEqual([3000]);
  });

  it("撞 429 后并发上限减半；400 等其他错误不重试", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 8 });
    let first = true;
    await gate.fetch(URL_A, undefined, {
      baseFetch: async () => {
        if (first) {
          first = false;
          return new Response("", { status: 429 });
        }
        return new Response("ok");
      },
    });
    expect(gate.limitFor("https://api.example.com")).toBe(4);

    let badCalls = 0;
    const bad = await gate.fetch(URL_A, undefined, {
      baseFetch: async () => {
        badCalls += 1;
        return new Response("bad", { status: 400 });
      },
    });
    expect(badCalls).toBe(1);
    expect(bad.status).toBe(400);
  });

  it("许可占到流式正文读完：上限 1 时第二个请求要等第一个读完", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 1, maxLimit: 1 });
    const first = streamingResponse(["a"]);
    const order: string[] = [];
    const r1 = await gate.fetch(URL_A, undefined, { baseFetch: async () => { order.push("start1"); return first.response; } });
    const p2 = gate.fetch(URL_A, undefined, { baseFetch: async () => { order.push("start2"); return new Response("b"); } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["start1"]);
    first.finish();
    expect(await r1.text()).toBe("a");
    const r2 = await p2;
    expect(order).toEqual(["start1", "start2"]);
    expect(await r2.text()).toBe("b");
  });

  it("不同服务商各走各的闸", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 1, maxLimit: 1 });
    const held = streamingResponse(["x"]);
    await gate.fetch(URL_A, undefined, { baseFetch: async () => held.response });
    const other = await gate.fetch("https://other.example.org/v1/chat/completions", undefined, {
      baseFetch: async () => new Response("free"),
    });
    expect(await other.text()).toBe("free");
    held.finish();
  });

  it("排队期间取消：拒绝并让出位置", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 1, maxLimit: 1 });
    const held = streamingResponse(["x"]);
    const r1 = await gate.fetch(URL_A, undefined, { baseFetch: async () => held.response });
    const controller = new AbortController();
    const queued = gate.fetch(URL_A, { signal: controller.signal }, { baseFetch: async () => new Response("never") });
    controller.abort(new Error("用户停了"));
    await expect(queued).rejects.toThrow("用户停了");
    held.finish();
    await r1.text();
    const next = await gate.fetch(URL_A, undefined, { baseFetch: async () => new Response("next") });
    expect(await next.text()).toBe("next");
  });
});
