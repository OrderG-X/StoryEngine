import { describe, expect, it } from "vitest";
import { aiErrorBody, aiErrorWantsSettings } from "./ai-error-text.js";

describe("出错卡的一句话（P11）", () => {
  it("每类都说原因、都带「本次没有改动」；认不出 / 老消息回到原来那句", () => {
    for (const reason of ["setup", "auth", "quota", "rate-limit", "server", "network", "timeout"] as const) {
      expect(aiErrorBody(reason)).toMatch(/本次没有改动。$/u);
      expect(aiErrorBody(reason)).not.toBe(aiErrorBody(undefined));
    }
    expect(aiErrorBody(undefined)).toBe("AI 服务暂时没响应，本次没有改动。");
    expect(aiErrorBody("unknown")).toBe(aiErrorBody(undefined));
    expect(aiErrorBody("setup")).toContain("设置");
    expect(aiErrorBody("quota")).toContain("余额");
  });

  it("只有没接上、密钥不对要去设置", () => {
    expect(aiErrorWantsSettings("setup")).toBe(true);
    expect(aiErrorWantsSettings("auth")).toBe(true);
    for (const reason of ["quota", "rate-limit", "server", "network", "timeout", "unknown", undefined] as const) {
      expect(aiErrorWantsSettings(reason)).toBe(false);
    }
  });
});
