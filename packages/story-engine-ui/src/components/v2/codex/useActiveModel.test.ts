import { describe, expect, it } from "vitest";
import { activeModelFromSummary } from "./useActiveModel.js";

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
