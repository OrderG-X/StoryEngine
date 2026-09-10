import { describe, expect, it } from "vitest";
import type { ModelProfileSummary } from "../api/types.js";
import {
  buildModelSettingsConfig,
  buildTaskAssignmentsPayload,
  parseTaskViewState,
  taskProfileId,
} from "./ModelSettingsDialogLogic.js";

describe("buildTaskAssignmentsPayload 思考与模型旋钮独立", () => {
  it("纯关思考、没选模型的任务也进 payload（无 profileId），治静默丢弃", () => {
    const tasks = { fastDraft: "prov|gpt" }; // 只有 fastDraft 选了模型
    const thinking = { fastDraft: false, triage: false }; // triage 只关了思考、没选模型
    const payload = buildTaskAssignmentsPayload(tasks, thinking);
    expect(payload.fastDraft).toEqual({ profileId: taskProfileId("prov", "gpt"), thinking: false });
    expect(payload.triage).toEqual({ thinking: false }); // 无 profileId 但思考保住
  });

  it("thinking 未列的任务默认开", () => {
    const payload = buildTaskAssignmentsPayload({ repair: "prov|m" }, {});
    expect(payload.repair).toEqual({ profileId: taskProfileId("prov", "m"), thinking: true });
  });
});

describe("parseTaskViewState 反推面板状态", () => {
  it("profileId 映射回 provider|model；缺 profileId 的任务保留 thinking、tasks 留空", () => {
    const profiles: ModelProfileSummary[] = [{ id: "prov_gpt", provider: "prov", model: "gpt" }];
    const view = { fastDraft: { profileId: "prov_gpt", thinking: false }, triage: { thinking: false } };
    const { tasks, thinking } = parseTaskViewState(view, profiles);
    expect(tasks.fastDraft).toBe("prov|gpt");
    expect(tasks.triage).toBeUndefined(); // 无 profileId → tasks 留空（行显示「分配模型」）
    expect(thinking.fastDraft).toBe(false);
    expect(thinking.triage).toBe(false); // thinking 仍保住
  });
});

describe("buildModelSettingsConfig 保留对话记忆上限", () => {
  it("写入 chatHistoryBudgetTokens 供 PUT 全链落盘", () => {
    const config = buildModelSettingsConfig(
      [{ id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", apiKeyStatus: "present" }],
      { fastDraft: "deepseek|deepseek-chat" },
      { chatHistoryBudgetTokens: 300_000 },
    );
    expect(config.chatHistoryBudgetTokens).toBe(300_000);
  });
});

// 与服务端 MASKED_CUSTOM_HEADER_VALUE（server/routes/model-settings.ts）同字面量；
// 内联而非跨 src/server 引 import，守 components/server 边界。
const MASKED = "__STORY_ENGINE_MASKED__";

describe("buildModelSettingsConfig 表单路径保留 provider 上表单不认识的字段（P2-3）", () => {
  const provider = {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKeyStatus: "present" as const,
  };
  const tasks = { fastDraft: "deepseek|deepseek-chat" };

  function previousRawTextWith(providerEntry: Record<string, unknown>): string {
    return JSON.stringify({ version: 1, providers: { deepseek: providerEntry } });
  }

  it("有 customHeaders：打码哨兵随 provider 合并保留（服务端 PUT 还原真值），表单字段照常覆盖", () => {
    const config = buildModelSettingsConfig([provider], tasks, {
      previousRawText: previousRawTextWith({
        id: "deepseek",
        label: "旧名称",
        type: "openai-compatible",
        baseUrl: "https://old.example/v1",
        apiKeyEnv: "OLD_ENV",
        customHeaders: { "x-opencode-session": MASKED },
        someFutureField: { nested: true },
      }),
    });
    const providers = config.providers as Record<string, Record<string, unknown>>;
    // 表单不认识的字段原样保留（值仍是哨兵，绝不在这里碰真值）
    expect(providers.deepseek?.customHeaders).toEqual({ "x-opencode-session": MASKED });
    expect(providers.deepseek?.someFutureField).toEqual({ nested: true });
    // 表单管理的字段以表单为准（磁盘旧值被覆盖）
    expect(providers.deepseek?.label).toBe("DeepSeek");
    expect(providers.deepseek?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(providers.deepseek?.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
  });

  it("无 customHeaders：磁盘对象只有已知字段时，输出与不传 previousRawText 深相等（零行为漂移）", () => {
    const baseline = buildModelSettingsConfig([provider], tasks, { chatHistoryBudgetTokens: 300_000 });
    const merged = buildModelSettingsConfig([provider], tasks, {
      chatHistoryBudgetTokens: 300_000,
      previousRawText: previousRawTextWith({
        id: "deepseek",
        label: "DeepSeek",
        type: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      }),
    });
    expect(merged).toEqual(baseline);
    const providers = merged.providers as Record<string, Record<string, unknown>>;
    expect("customHeaders" in (providers.deepseek ?? {})).toBe(false);
  });

  it("表单里已删除的 provider 不借合并复活；新增 provider 无磁盘底也不炸", () => {
    const previous = JSON.stringify({
      version: 1,
      providers: {
        deepseek: { id: "deepseek", customHeaders: { "x-a": MASKED } },
        "deleted-prov": { id: "deleted-prov", customHeaders: { "x-b": MASKED } },
      },
    });
    const config = buildModelSettingsConfig(
      [provider, { id: "brand-new", label: "新服务", baseUrl: "https://new.example/v1", apiKeyEnv: "", apiKeyStatus: "missing" as const }],
      tasks,
      { previousRawText: previous },
    );
    const providers = config.providers as Record<string, Record<string, unknown>>;
    expect(Object.keys(providers).sort()).toEqual(["brand-new", "deepseek"]);
    expect(providers.deepseek?.customHeaders).toEqual({ "x-a": MASKED });
    expect("customHeaders" in (providers["brand-new"] ?? {})).toBe(false);
  });

  it("previousRawText 非法 JSON：退化为从零重建，不炸表单保存", () => {
    const config = buildModelSettingsConfig([provider], tasks, { previousRawText: "{not json" });
    const baseline = buildModelSettingsConfig([provider], tasks);
    expect(config).toEqual(baseline);
  });
});
