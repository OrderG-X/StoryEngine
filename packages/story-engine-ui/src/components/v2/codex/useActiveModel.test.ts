import { describe, expect, it } from "vitest";
import { activeModelFromSummary, modelSetupStep } from "./useActiveModel.js";

const summary = (over: Record<string, unknown> = {}) => ({
  available: true, status: "ok", configPath: "", providers: [], taskProfiles: {}, issueCount: 0, highRiskIssueCount: 0,
  defaultProfile: "p2",
  profiles: [{ id: "p1", provider: "x", model: "m-one" }, { id: "p2", provider: "x", model: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" }],
  ...over,
}) as never;

describe("activeModelFromSummary：AI 栏头部显示的模型名", () => {
  it("取默认 profile 的 label", () => {
    expect(activeModelFromSummary(summary())).toEqual({ label: "DeepSeek V4.1 Flash", ok: true });
  });
  it("没 label 用 model id；默认 profile 找不到退第一个；不可用标 ok=false", () => {
    expect(activeModelFromSummary(summary({ defaultProfile: "nope", available: false }))).toEqual({ label: "m-one", ok: false });
  });
  it("没有任何 profile → null（不显示标签）", () => {
    expect(activeModelFromSummary(summary({ profiles: [] }))).toBeNull();
    expect(activeModelFromSummary(undefined)).toBeNull();
  });
});

describe("modelSetupStep：没接好就给引导，说清还差哪步", () => {
  const key = (apiKeyStatus: string) => ({ id: "deepseek", type: "openai-compatible", baseUrl: "https://x", apiKeyStatus });
  it("没有设置文件、或服务商都没密钥 → 先接服务商", () => {
    expect(modelSetupStep(summary({ status: "missing", available: false, profiles: [] }))).toBe("connect");
    expect(modelSetupStep(summary({ profiles: [], providers: [key("missing")] }))).toBe("connect");
  });
  it("服务商接好了、一个模型都没选 → 选模型", () => {
    expect(modelSetupStep(summary({ profiles: [], providers: [key("present")] }))).toBe("pick-model");
    expect(modelSetupStep(summary({ profiles: [], providers: [key("not_required")] }))).toBe("pick-model");
  });
  it("有档案（哪怕缺密钥、不可用）→ 不算没接；还没读到 → 不引导", () => {
    expect(modelSetupStep(summary())).toBeNull();
    expect(modelSetupStep(summary({ available: false }))).toBeNull();
    expect(modelSetupStep(undefined)).toBeNull();
  });
});
