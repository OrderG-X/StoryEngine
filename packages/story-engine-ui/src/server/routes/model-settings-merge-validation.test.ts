/**
 * 复审第四轮 P2-1 验收测试：表单合并产物必须过真引擎 validateModelSettingsV0、零 error/high。
 * 探针 E/F/G 三场景（磁盘手写明文 apiKey 经合并带回 / 任务指向已删非 preset 服务商 /
 * 同 id 磁盘 profile 五件套类型非法）此前各自把 PUT 打成 400，codex 页无 raw 编辑器自救即死锁。
 *
 * 本文件为何住在 src/server/：scripts/check-import-boundary.mjs 禁止 src/server/ 以外的文件
 * value-import @actalk/story-engine（防引擎服务端代码进前端 bundle）；要把合并产物喂真引擎校验，
 * 只能放在允许引引擎的 server 侧。生产清洗逻辑在 src/components/ModelSettingsDialogLogic.ts，
 * 是引擎校验规则的同口径镜像——本文件就是「镜像没漂」的锁定器。
 */
import { describe, expect, it } from "vitest";
import { validateModelSettingsV0 } from "@actalk/story-engine";
import { buildModelSettingsConfig, taskProfileId } from "../../components/ModelSettingsDialogLogic.js";

const provider = {
  id: "deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  apiKeyStatus: "present" as const,
};
const profId = taskProfileId("deepseek", "deepseek-chat");

/** 与 routes/model-settings.ts PUT 同口径：severity error 或 high 即阻断（400）。 */
function blockingIssues(config: Record<string, unknown>) {
  const res = validateModelSettingsV0(config, { env: {} });
  return res.issues.filter((issue) => issue.severity === "error" || issue.severity === "high");
}

describe("表单合并产物过真引擎 validateModelSettingsV0（P2-1 验收）", () => {
  it("F：手写明文 apiKey（provider 层 + 顶层）带回——清洗后零 error/high，密钥值不进配置也不进警告", () => {
    const { config, cleaningWarnings } = buildModelSettingsConfig(
      [provider],
      { fastDraft: "deepseek|deepseek-chat" },
      {
        previousRawText: JSON.stringify({
          version: 1,
          apiKey: "sk-top-level",
          providers: {
            deepseek: {
              id: "deepseek", type: "openai-compatible",
              baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-handwritten",
            },
          },
          profiles: {},
          taskProfiles: {},
        }),
      },
    );
    expect(blockingIssues(config)).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("sk-handwritten");
    expect(JSON.stringify(config)).not.toContain("sk-top-level");
    expect(cleaningWarnings.length).toBeGreaterThan(0);
    expect(cleaningWarnings.join("\n")).not.toContain("sk-handwritten");
  });

  it("E：任务指向已删非 preset 服务商——清洗后零 error/high，config 与 cleanedTasks 同口径剔除", () => {
    const { config, cleanedTasks, cleaningWarnings } = buildModelSettingsConfig(
      [provider],
      { fastDraft: "my-llm|m1" },
      {
        previousRawText: JSON.stringify({
          version: 1,
          providers: { deepseek: { id: "deepseek", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" } },
          profiles: { old: { id: "old", provider: "my-llm", model: "m1" } },
          taskProfiles: { fastDraft: "old" },
        }),
      },
    );
    expect(blockingIssues(config)).toEqual([]);
    // 旁路 taskAssignments 载荷用 cleanedTasks 构建即过路由 findInvalidTaskProfile 交叉校验
    // （profileId 只指向 config.profiles 里真实存在的档案）。
    expect(Object.keys(cleanedTasks)).toEqual([]);
    expect(config.taskProfiles).toEqual({});
    expect(cleaningWarnings.some((w) => w.includes("my-llm"))).toBe(true);
  });

  it("G：同 id 磁盘 profile 五件套类型非法——清洗后零 error/high，全部回默认", () => {
    const { config, cleaningWarnings } = buildModelSettingsConfig(
      [provider],
      { fastDraft: "deepseek|deepseek-chat" },
      {
        previousRawText: JSON.stringify({
          version: 1,
          providers: {},
          profiles: {
            [profId]: {
              id: profId, provider: "deepseek", model: "deepseek-chat",
              temperature: "high", maxTokens: -1, timeoutMs: 0, retries: "x", stream: "yes",
            },
          },
          taskProfiles: {},
        }),
      },
    );
    expect(blockingIssues(config)).toEqual([]);
    const profile = (config.profiles as Record<string, Record<string, unknown>>)[profId];
    expect(profile?.temperature).toBe(0.7);
    expect(cleaningWarnings.length).toBeGreaterThan(0);
  });

  it("回归基线：三审 P1-1 主场景（手写 defaultProfile 悬空）与正常合并照旧零 error/high", () => {
    const danglingDefault = buildModelSettingsConfig(
      [provider],
      { fastDraft: "deepseek|deepseek-chat" },
      {
        previousRawText: JSON.stringify({
          version: 1,
          defaultProfile: "balanced",
          defaultProvider: "deepseek",
          taskProfiles: { fastDraft: "balanced", triage: "balanced" },
          providers: { deepseek: { id: "deepseek", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" } },
          profiles: { balanced: { id: "balanced", provider: "deepseek", model: "deepseek-chat", temperature: 0.31 } },
        }),
      },
    );
    expect(blockingIssues(danglingDefault.config)).toEqual([]);
    expect(danglingDefault.cleaningWarnings).toEqual([]);

    const clean = buildModelSettingsConfig([provider], { fastDraft: "deepseek|deepseek-chat" });
    expect(blockingIssues(clean.config)).toEqual([]);
    expect(clean.cleaningWarnings).toEqual([]);
  });
});
