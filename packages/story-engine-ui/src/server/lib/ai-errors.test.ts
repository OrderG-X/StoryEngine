// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyAiError, ModelCallError, ModelSetupError, modelFailureText, UpstreamSilentError } from "./ai-errors.js";

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

describe("写进卡上原因的那一句（P2b 真点：记账员连不上时卡上写着 fetch failed）", () => {
  it("认得的类说中文短句，不端 SDK / fetch 的英文原文", () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:59999"), { code: "ECONNREFUSED" }) });
    expect(modelFailureText(refused)).toBe("连不上服务商");
    expect(modelFailureText(new ModelCallError("wrapped", "not_sent", undefined, undefined, { cause: refused }))).toBe("连不上服务商");
    expect(modelFailureText(new ModelCallError("HTTP 401", "rejected", 401))).toBe("服务商说密钥不对");
  });

  it("认不出的用错误本身那句，压成一行、过长截断", () => {
    expect(modelFailureText(new Error("思考太久\n  没出正文"))).toBe("思考太久 没出正文");
    expect(modelFailureText(new Error("长".repeat(200)), 10)).toBe(`${"长".repeat(10)}…`);
    expect(modelFailureText("")).toBe("未知错误");
  });
});
