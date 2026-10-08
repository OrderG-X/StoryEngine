// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { withUpstreamSilenceGuard } from "./model.js";

// 2026-10-08 十章验收第三轮：服务商临时故障时请求一直等不到响应头，底层 5 分钟才判死且不重试。
const IDLE = 40;

function streamOf(chunks: readonly string[], gapMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
  })) as unknown as typeof fetch;
}

describe("withUpstreamSilenceGuard", () => {
  it("响应头迟迟不来 → 掐掉并自动重发一次，第二次成功", async () => {
    const hang = hangingFetch();
    const base = vi.fn()
      .mockImplementationOnce(hang)
      .mockImplementationOnce(async () => new Response(streamOf(["ok"])));
    const guarded = withUpstreamSilenceGuard(base as unknown as typeof fetch, IDLE);
    const response = await guarded("https://x.invalid/v1/chat/completions", { method: "POST", body: "{}" });
    expect(await response.text()).toBe("ok");
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("两次都没反应 → 如实报错，不无限重试", async () => {
    const base = vi.fn(hangingFetch());
    const guarded = withUpstreamSilenceGuard(base as unknown as typeof fetch, IDLE);
    await expect(guarded("https://x.invalid", { body: "{}" })).rejects.toThrow("没有任何响应");
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("连接级错误（还没拿到响应）→ 重发一次", async () => {
    const base = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))
      .mockResolvedValueOnce(new Response("ok"));
    const guarded = withUpstreamSilenceGuard(base as unknown as typeof fetch, IDLE);
    expect(await (await guarded("https://x.invalid", { body: "{}" })).text()).toBe("ok");
  });

  it("作者自己停了 → 不重发", async () => {
    const caller = new AbortController();
    const base = vi.fn(hangingFetch());
    const guarded = withUpstreamSilenceGuard(base as unknown as typeof fetch, 5_000);
    const pending = guarded("https://x.invalid", { body: "{}", signal: caller.signal });
    caller.abort(new Error("用户停止"));
    await expect(pending).rejects.toThrow("用户停止");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("流式中有内容就续命（总时长可以远超空闲阈值）；彻底静默才掐断", async () => {
    const steady = withUpstreamSilenceGuard((async () => new Response(streamOf(["a", "b", "c", "d"], IDLE / 2))) as unknown as typeof fetch, IDLE);
    expect(await (await steady("https://x.invalid", { body: "{}" })).text()).toBe("abcd");

    const stalled = withUpstreamSilenceGuard((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("a")); },
    }))) as unknown as typeof fetch, IDLE);
    const response = await stalled("https://x.invalid", { body: "{}" });
    await expect(response.text()).rejects.toBeTruthy();
  });
});
