// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  describeTokenUsage,
  recordAgentUsage,
  recordPipelineUsage,
  sampleFromOpenAIUsage,
  sampleFromSdkUsage,
  withTokenMeter,
} from "./token-meter.js";
import { streamOpenAICompatibleResponse } from "./llm-client.js";

describe("token-meter 一轮对话的真实用量", () => {
  it("计量器里分别记对话 AI 与内部调用；没有计量器时记录被忽略", async () => {
    recordPipelineUsage({ input: 999, cachedInput: 0, output: 1, reasoning: 0 }); // 计量器外：忽略
    const { result, usage } = await withTokenMeter(async () => {
      recordAgentUsage({ input: 30000, cachedInput: 20000, output: 800, reasoning: 300 }, 3);
      await Promise.resolve();
      recordPipelineUsage({ input: 12000, cachedInput: 0, output: 2000, reasoning: 0 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(usage.agent).toEqual({ calls: 3, input: 30000, cachedInput: 20000, output: 800, reasoning: 300 });
    expect(usage.pipeline).toEqual({ calls: 1, input: 12000, cachedInput: 0, output: 2000, reasoning: 0 });
    expect(usage.total.input).toBe(42000);
    expect(describeTokenUsage(usage)).toContain("合计输入 4.2 万");
  });

  it("各家 usage 字段宽进：OpenAI 的 cached_tokens、DeepSeek 的 prompt_cache_hit_tokens、SDK 的 inputTokens", () => {
    expect(sampleFromOpenAIUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } }))
      .toEqual({ input: 100, cachedInput: 60, output: 20, reasoning: 5 });
    expect(sampleFromOpenAIUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 80 })?.cachedInput).toBe(80);
    expect(sampleFromOpenAIUsage({})).toBeUndefined();
    expect(sampleFromOpenAIUsage("nope")).toBeUndefined();
    expect(sampleFromSdkUsage({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 10 })).toEqual({ input: 50, cachedInput: 10, output: 5, reasoning: 0 });
  });

  it("流式响应末帧的 usage 被读出来", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":321,"completion_tokens":7}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const response = new Response(frames, { headers: { "content-type": "text/event-stream" } });
    const parsed = await streamOpenAICompatibleResponse(response, () => undefined);
    expect(parsed.content).toBe("你好");
    expect(sampleFromOpenAIUsage(parsed.usage)).toEqual({ input: 321, cachedInput: 0, output: 7, reasoning: 0 });
  });
});

describe("分步计量（2026-10-10 引擎升级第 4 期）", () => {
  it("withStep：耗时和这一步里的内部调用记在步骤名下，嵌套名字带层级；没包的只进 pipeline", async () => {
    const { withStep } = await import("./token-meter.js");
    const { usage } = await withTokenMeter(async () => {
      await withStep("核账", async () => {
        recordPipelineUsage({ input: 100, cachedInput: 0, output: 10, reasoning: 0 });
        await withStep("复核", async () => {
          recordPipelineUsage({ input: 50, cachedInput: 0, output: 5, reasoning: 0 });
        });
      });
      recordPipelineUsage({ input: 7, cachedInput: 0, output: 1, reasoning: 0 });
    });
    expect(usage.pipeline).toMatchObject({ calls: 3, input: 157 });
    expect(usage.steps?.["核账"]).toMatchObject({ calls: 1, input: 100 });
    expect(usage.steps?.["核账/复核"]).toMatchObject({ calls: 1, input: 50 });
    expect(usage.steps?.["核账"]!.ms).toBeGreaterThanOrEqual(0);
  });

  it("没套计量器时 withStep 照常执行、不报错", async () => {
    const { withStep } = await import("./token-meter.js");
    await expect(withStep("核账", async () => 42)).resolves.toBe(42);
  });
});
