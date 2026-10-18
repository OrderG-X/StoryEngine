import { describe, expect, it } from "vitest";
import {
  BUILTIN_ANTI_AI_RULES,
  BUILTIN_ANTI_AI_RULES_VERSION,
  buildFastDraftMessages,
} from "./builtin-anti-ai-rules.js";

describe("builtin-anti-ai-rules", () => {
  it("buildFastDraftMessages 把正文 prompt 拼成 [system 内置铁律, user 正文]", () => {
    const messages = buildFastDraftMessages("正文 prompt 内容");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(BUILTIN_ANTI_AI_RULES);
    expect(messages[1]).toEqual({ role: "user", content: "正文 prompt 内容" });
  });

  it("system 段是固定常量前缀（不随正文变）——prompt-cache 友好", () => {
    const a = buildFastDraftMessages("第一章正文");
    const b = buildFastDraftMessages("完全不同的第二章正文");
    expect(a[0]?.content).toBe(b[0]?.content);
  });

  it("内置铁律覆盖跨源公认的最毒毛病（句式/标点/情绪外化/叙述者姿态）", () => {
    expect(BUILTIN_ANTI_AI_RULES).toContain("不是……而是");
    expect(BUILTIN_ANTI_AI_RULES).toContain("破折号");
    expect(BUILTIN_ANTI_AI_RULES).toContain("情绪外化");
    expect(BUILTIN_ANTI_AI_RULES).toContain("永不替读者下结论");
    expect(BUILTIN_ANTI_AI_RULES).toContain("仿佛");
  });

  it("有版本号（产品内核升级留痕）", () => {
    expect(BUILTIN_ANTI_AI_RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("吸收 novel-deslop 全套缺口：真人基准 / 弱转折排比 / 语气词 / 比喻生活化 / 句长匹配", () => {
    expect(BUILTIN_ANTI_AI_RULES).toContain("真人");   // 真人写作基准对照
    expect(BUILTIN_ANTI_AI_RULES).toContain("虽然");   // 弱转折/排比否定：虽然…但是 / 尽管…却
    expect(BUILTIN_ANTI_AI_RULES).toContain("语气词"); // 嗯/嘶/行吧 等口语语气词
    expect(BUILTIN_ANTI_AI_RULES).toContain("比喻");   // 比喻生活化，不要文学化套路
  });

  it("版本号已升（吸收 novel-deslop）", () => {
    expect(BUILTIN_ANTI_AI_RULES_VERSION).toBe("1.1.0");
  });
});
