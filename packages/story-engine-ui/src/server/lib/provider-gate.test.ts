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

  it("onSend 在请求真发出去前调，排队时不调；429 退避后重发再调一次", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 1, maxLimit: 1 });
    const first = streamingResponse(["a"]);
    const r1 = await gate.fetch(URL_A, undefined, { baseFetch: async () => first.response });
    const sends: string[] = [];
    const statuses = [429, 200];
    const p2 = gate.fetch(URL_A, undefined, {
      onSend: () => sends.push("send"),
      baseFetch: async () => new Response("b", { status: statuses.shift() }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends).toEqual([]);
    first.finish();
    await r1.text();
    expect(await (await p2).text()).toBe("b");
    expect(sends).toEqual(["send", "send"]);
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

  it("同一额度组的两个地址共用一道闸（换入口、换密钥计数不清零）", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 1, maxLimit: 1 });
    const held = streamingResponse(["x"]);
    const first = await gate.fetch(URL_A, undefined, { quotaGroup: "套餐甲", baseFetch: async () => held.response });
    const order: string[] = [];
    const other = gate.fetch("https://other.example.org/v1/chat/completions", undefined, {
      quotaGroup: "套餐甲",
      baseFetch: async () => { order.push("other"); return new Response("y"); },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    held.finish();
    await first.text();
    expect(await (await other).text()).toBe("y");
    expect(gate.limitFor("套餐甲")).toBe(1);
  });

  it("两道都排队：后台至少放 1 位，其余给前台；只有一边排队可以借满", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 3, maxLimit: 3 });
    const holders = [streamingResponse(["a"]), streamingResponse(["b"]), streamingResponse(["c"])];
    // 后台先借满三位。
    const held = await Promise.all(holders.map((holder) => gate.fetch(URL_A, undefined, { lane: "background", baseFetch: async () => holder.response })));
    const started: string[] = [];
    const queued = [
      gate.fetch(URL_A, undefined, { lane: "background", baseFetch: async () => { started.push("bg"); return new Response("bg"); } }),
      gate.fetch(URL_A, undefined, { lane: "foreground", baseFetch: async () => { started.push("fg1"); return new Response("fg1"); } }),
      gate.fetch(URL_A, undefined, { lane: "foreground", baseFetch: async () => { started.push("fg2"); return new Response("fg2"); } }),
    ];
    // 放掉两位：后台还占着一位，两位都给前台。
    holders[0]!.finish();
    holders[1]!.finish();
    await held[0]!.text();
    await held[1]!.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(["fg1", "fg2"]);
    holders[2]!.finish();
    await held[2]!.text();
    await Promise.all(queued.map(async (pending) => (await pending).text()));
    expect(started).toEqual(["fg1", "fg2", "bg"]);
  });

  it("前台占满时后台排队，前台放一位先给后台（后台至少 1 位）", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 2, maxLimit: 2 });
    const holders = [streamingResponse(["a"]), streamingResponse(["b"])];
    const held = await Promise.all(holders.map((holder) => gate.fetch(URL_A, undefined, { baseFetch: async () => holder.response })));
    const started: string[] = [];
    const fg = gate.fetch(URL_A, undefined, { baseFetch: async () => { started.push("fg"); return new Response("fg"); } });
    const bg = gate.fetch(URL_A, undefined, { lane: "background", baseFetch: async () => { started.push("bg"); return new Response("bg"); } });
    holders[0]!.finish();
    await held[0]!.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(["bg"]);
    holders[1]!.finish();
    await held[1]!.text();
    await (await fg).text();
    await (await bg).text();
    expect(started).toEqual(["bg", "fg"]);
  });

  it("上限 1、两道都排队：轮流放", async () => {
    const gate = createProviderGate({ sleep: noSleep, log: quiet, initialLimit: 1, maxLimit: 1 });
    const first = streamingResponse(["a"]);
    const r1 = await gate.fetch(URL_A, undefined, { baseFetch: async () => first.response });
    const started: string[] = [];
    const make = (lane: "foreground" | "background", name: string) =>
      gate.fetch(URL_A, undefined, { lane, baseFetch: async () => { started.push(name); return new Response(name); } }).then((response) => response.text());
    const all = [make("foreground", "fg1"), make("foreground", "fg2"), make("background", "bg1"), make("background", "bg2")];
    first.finish();
    await r1.text();
    await Promise.all(all);
    expect(started).toEqual(["bg1", "fg1", "bg2", "fg2"]);
  });
});

