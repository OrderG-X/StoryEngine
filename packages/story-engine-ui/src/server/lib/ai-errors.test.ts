// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyAiError, ModelCallError, ModelSetupError, UpstreamSilentError } from "./ai-errors.js";

describe("调模型失败的分类（P11）", () => {
  it("自家的类型直接认", () => {
    expect(classifyAiError(new ModelSetupError("还没接上"))).toBe("setup");
    expect(classifyAiError(new UpstreamSilentError("没动静"))).toBe("timeout");
  });

  it("按状态码：401/403 密钥、402 欠费、429 限流、5xx 服务商故障；别的不认", () => {
    expect(classifyAiError(new ModelCallError("x", "rejected", 401))).toBe("auth");
    expect(classifyAiError(new ModelCallError("x", "rejected", 403))).toBe("auth");
    expect(classifyAiError(new ModelCallError("x", "rejected", 402))).toBe("quota");
    expect(classifyAiError({ status: 429 })).toBe("rate-limit");
    expect(classifyAiError({ statusCode: 503 })).toBe("server");
    expect(classifyAiError({ statusCode: 400 })).toBe("unknown");
  });

  it("顺着 cause / lastError / errors 往里找（AI SDK 重试错误、fetch 的 TypeError）", () => {
    const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    expect(classifyAiError(fetchFailed)).toBe("network");
    expect(classifyAiError({ name: "AI_RetryError", lastError: { statusCode: 401 } })).toBe("auth");
    expect(classifyAiError({ errors: [{ message: "a" }, { statusCode: 402 }] })).toBe("quota");
  });

  it("认不出、空值、绕圈的都回 unknown，不卡死", () => {
    expect(classifyAiError(new Error("随便什么"))).toBe("unknown");
    expect(classifyAiError(undefined)).toBe("unknown");
    expect(classifyAiError("字符串")).toBe("unknown");
    const loop: Record<string, unknown> = {};
    loop.cause = loop;
    expect(classifyAiError(loop)).toBe("unknown");
  });
});
