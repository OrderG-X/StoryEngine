// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { withTokenMeter } from "../lib/token-meter.js";
import { withModelFallback, type AgentModelFallback } from "./model.js";

function fallbackOf(fetchImpl: typeof fetch): AgentModelFallback {
  return {
    fetch: fetchImpl,
    fromBaseURL: "https://a.invalid/v1",
    toBaseURL: "https://b.invalid/api",
    apiKey: "key-b",
    modelId: "b-model",
    notice: "这次用了备用",
  };
}

const request = (signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { authorization: "Bearer key-a", "content-type": "application/json" },
  body: JSON.stringify({ model: "a-model", messages: [] }),
  ...(signal ? { signal } : {}),
});

describe("对话 AI 备用模型（P10）", () => {
  it("主模型回错误状态 → 改地址、密钥、模型名重发给备用；成了留一句告诉作者", async () => {
    const primary = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const backup = vi.fn(async () => new Response("ok", { status: 200 }));
    const guarded = withModelFallback(primary as unknown as typeof fetch, fallbackOf(backup as unknown as typeof fetch));
    const { result, notices } = await withTokenMeter(() => guarded("https://a.invalid/v1/chat/completions", request()));
    expect(await result.text()).toBe("ok");
    const [url, init] = backup.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://b.invalid/api/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key-b");
    expect(JSON.parse(init.body as string).model).toBe("b-model");
    expect(notices).toEqual(["这次用了备用"]);
  });

  it("主模型连不上、备用也没成 → 原样抛主模型的错；主模型成了不碰备用", async () => {
    const backup = vi.fn(async () => new Response("nope", { status: 500 }));
    const down = withModelFallback((async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch, fallbackOf(backup as unknown as typeof fetch));
    await expect(down("https://a.invalid/v1/chat/completions", request())).rejects.toThrow("fetch failed");
    expect(backup).toHaveBeenCalledTimes(1);

    const fine = withModelFallback((async () => new Response("主", { status: 200 })) as unknown as typeof fetch, fallbackOf(backup as unknown as typeof fetch));
    expect(await (await fine("https://a.invalid/v1/chat/completions", request())).text()).toBe("主");
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it("作者自己停了 → 不换备用", async () => {
    const controller = new AbortController();
    const backup = vi.fn();
    const guarded = withModelFallback((async () => { controller.abort(); throw new Error("aborted"); }) as unknown as typeof fetch, fallbackOf(backup as unknown as typeof fetch));
    await expect(guarded("https://a.invalid/v1/chat/completions", request(controller.signal))).rejects.toThrow("aborted");
    expect(backup).not.toHaveBeenCalled();
  });
});
