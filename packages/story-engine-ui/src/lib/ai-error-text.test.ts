import { describe, expect, it } from "vitest";
import { aiErrorAfterWriteBody, aiErrorBody, aiErrorWantsSettings } from "./ai-error-text.js";

describe("出错卡的一句话（P11）", () => {
  it("每类都说原因、都说「这一步没做完」（不打「没有改动」的包票）；认不出的回到通用那句", () => {
    for (const reason of ["setup", "auth", "quota", "rate-limit", "server", "network", "timeout"] as const) {
      expect(aiErrorBody(reason)).toMatch(/这一步没做完。$/u);
      expect(aiErrorBody(reason)).not.toBe(aiErrorBody(undefined));
    }
    expect(aiErrorBody(undefined)).toBe("AI 服务暂时没响应，这一步没做完。");
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

  it("这一轮已经写好了稿、之后那步才出错：说写好的在稿纸上、不用重来，原因短说", () => {
    expect(aiErrorAfterWriteBody("timeout", "draft")).toBe("正文已经写进稿纸，不用重来；之后那步服务商太久没有反应，没做完。");
    expect(aiErrorAfterWriteBody(undefined, "revise")).toBe("改好的稿已经在稿纸上，不用重来；之后那步服务没响应，没做完。");
  });
});
