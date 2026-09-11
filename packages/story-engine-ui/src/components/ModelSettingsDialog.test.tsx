// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ModelSettingsDialog from "./ModelSettingsDialog.js";

const fetchModelSettings = vi.fn();
const saveModelSettings = vi.fn();
const testModelConnection = vi.fn();

vi.mock("../api/client.js", () => ({
  fetchModelSettings: (...args: unknown[]) => fetchModelSettings(...args),
  saveModelSettings: (...args: unknown[]) => saveModelSettings(...args),
  testModelConnection: (...args: unknown[]) => testModelConnection(...args),
}));

vi.mock("./DisplaySettingsSection.js", () => ({
  DisplaySettingsSection: () => <div data-testid="display-settings" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  fetchModelSettings.mockReset();
  saveModelSettings.mockReset();
  testModelConnection.mockReset();
});

describe("ModelSettingsDialog 表面切换", () => {
  it("无任何已配置 AI 服务时默认向导态", async () => {
    fetchModelSettings.mockResolvedValue({
      result: {
        passed: false,
        available: false,
        status: "missing",
        configPath: "/tmp/x",
        summary: {
          available: false,
          status: "missing",
          configPath: "/tmp/x",
          providers: [],
          profiles: [],
          taskProfiles: {},
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: "{}",
      taskAssignments: {},
    });

    render(<ModelSettingsDialog open onCancel={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByLabelText("AI 设置向导")).toBeTruthy();
    });
    expect(screen.getByText("开始使用 AI")).toBeTruthy();
    expect(screen.queryByText("当前 AI 服务")).toBeNull();
  });

  it("已配置服务时进入简单视图", async () => {
    fetchModelSettings.mockResolvedValue({
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/tmp/x",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/tmp/x",
          providers: [{
            id: "deepseek",
            label: "DeepSeek",
            type: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            apiKeyStatus: "present",
          }],
          profiles: [{ id: "deepseek_deepseek-chat", provider: "deepseek", model: "deepseek-chat" }],
          taskProfiles: { fastDraft: "deepseek_deepseek-chat" },
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: '{"chatHistoryBudgetTokens":96000}',
      taskAssignments: {
        fastDraft: { profileId: "deepseek_deepseek-chat", thinking: false },
      },
    });
    testModelConnection.mockResolvedValue({ providerId: "deepseek", models: [{ id: "deepseek-chat" }], elapsedMs: 10 });

    render(<ModelSettingsDialog open onCancel={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByLabelText("当前 AI 服务")).toBeTruthy();
    });
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.queryByLabelText("AI 设置向导")).toBeNull();
  });
});

describe("ModelSettingsDialog 保存 warnings 展示", () => {
  /** 已配置一家服务商的载荷；保存响应复用同形态，按需附加 warnings。 */
  function configuredPayload(warnings?: readonly string[]) {
    return {
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/tmp/x",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/tmp/x",
          providers: [{
            id: "deepseek",
            label: "DeepSeek",
            type: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            apiKeyStatus: "present",
          }],
          profiles: [{ id: "deepseek_deepseek-chat", provider: "deepseek", model: "deepseek-chat" }],
          taskProfiles: { fastDraft: "deepseek_deepseek-chat" },
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: '{"chatHistoryBudgetTokens":96000}',
      taskAssignments: {
        fastDraft: { profileId: "deepseek_deepseek-chat", thinking: false },
      },
      ...(warnings ? { warnings } : {}),
    };
  }

  it("保存响应带 warnings 时面板如实展示（不静默吞掉丢头事实）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：deepseek 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    fetchModelSettings.mockResolvedValue(configuredPayload());
    saveModelSettings.mockResolvedValue(configuredPayload(warnings));
    // 挂载后后台同步模型列表；返回空列表即可，与警告断言无关。
    testModelConnection.mockResolvedValue({ providerId: "deepseek", models: [], elapsedMs: 1 });

    const { container } = render(<ModelSettingsDialog open onCancel={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByLabelText("当前 AI 服务")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /^高级设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    });
    // 成功提示照常显示，警告与之并存（警告不是错误，保存本身已成功）
    expect(screen.getByText("已保存并校验通过。")).toBeTruthy();
    expect(container.querySelector(".ms-warn-notice")).not.toBeNull();
  });

  it("保存响应不带 warnings 时不出现警告条（无丢弃不刷警告）", async () => {
    fetchModelSettings.mockResolvedValue(configuredPayload());
    saveModelSettings.mockResolvedValue(configuredPayload());
    testModelConnection.mockResolvedValue({ providerId: "deepseek", models: [], elapsedMs: 1 });

    const { container } = render(<ModelSettingsDialog open onCancel={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByLabelText("当前 AI 服务")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /^高级设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(screen.getByText("已保存并校验通过。")).toBeTruthy();
    });
    expect(container.querySelector(".ms-warn-notice")).toBeNull();
  });

  it("保存失败不清旧警告（两面板统一为「成功才换、失败保留」）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：deepseek 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    fetchModelSettings.mockResolvedValue(configuredPayload());
    saveModelSettings.mockResolvedValueOnce(configuredPayload(warnings));
    testModelConnection.mockResolvedValue({ providerId: "deepseek", models: [], elapsedMs: 1 });

    const { container } = render(<ModelSettingsDialog open onCancel={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByLabelText("当前 AI 服务")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /^高级设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => {
      expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    });

    // 第二次保存失败：错误如实展示，且旧警告不被抹掉（用户还没补回丢的头）
    saveModelSettings.mockRejectedValueOnce(new Error("network down"));
    fireEvent.click(screen.getByRole("button", { name: /^高级设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => {
      expect(screen.getByText(/保存失败/)).toBeTruthy();
    });
    expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    expect(container.querySelector(".ms-warn-notice")).not.toBeNull();
  });
});

describe("ModelSettingsDialog 表单路径保存保留 customHeaders（P2-3 残留洞）", () => {
  // 与服务端 MASKED_CUSTOM_HEADER_VALUE（server/routes/model-settings.ts）同字面量，内联守 components/server 边界：
  // GET 回显里 customHeaders 的值一律是此哨兵，服务端 PUT 时 restoreMaskedCustomHeaders 还原磁盘真值。
  const MASKED = "__STORY_ENGINE_MASKED__";

  /** 已配置一家 deepseek 的载荷；rawText 由用例自定（带/不带 customHeaders 两种场景）。 */
  function configuredPayloadWithRawText(rawText: string) {
    return {
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/tmp/x",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/tmp/x",
          providers: [{
            id: "deepseek",
            label: "DeepSeek",
            type: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            apiKeyStatus: "present",
          }],
          profiles: [{ id: "deepseek_deepseek-chat", provider: "deepseek", model: "deepseek-chat" }],
          taskProfiles: { fastDraft: "deepseek_deepseek-chat" },
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText,
      taskAssignments: {
        fastDraft: { profileId: "deepseek_deepseek-chat", thinking: false },
      },
    };
  }

  function rawTextWithDeepSeek(extraProviderFields?: Record<string, unknown>) {
    return JSON.stringify({
      version: 1,
      providers: {
        deepseek: {
          id: "deepseek",
          label: "DeepSeek",
          type: "openai-compatible",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          ...extraProviderFields,
        },
      },
    });
  }

  async function saveViaFormPath() {
    render(<ModelSettingsDialog open onCancel={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByLabelText("当前 AI 服务")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /^高级设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    return JSON.parse(saveModelSettings.mock.calls[0][0] as string) as {
      providers: Record<string, Record<string, unknown>>;
    };
  }

  it("有 customHeaders：表单保存（非 raw JSON 路径）提交载荷里打码哨兵原样保留，不再静默丢头", async () => {
    const rawText = rawTextWithDeepSeek({ customHeaders: { "x-opencode-session": MASKED } });
    fetchModelSettings.mockResolvedValue(configuredPayloadWithRawText(rawText));
    saveModelSettings.mockResolvedValue(configuredPayloadWithRawText(rawText));
    testModelConnection.mockResolvedValue({ providerId: "deepseek", models: [], elapsedMs: 1 });

    const config = await saveViaFormPath();

    expect(config.providers.deepseek?.customHeaders).toEqual({ "x-opencode-session": MASKED });
    // 表单管理字段照常
    expect(config.providers.deepseek?.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("无 customHeaders：提交载荷不凭空带出该字段（合并零副作用）", async () => {
    const rawText = rawTextWithDeepSeek();
    fetchModelSettings.mockResolvedValue(configuredPayloadWithRawText(rawText));
    saveModelSettings.mockResolvedValue(configuredPayloadWithRawText(rawText));
    testModelConnection.mockResolvedValue({ providerId: "deepseek", models: [], elapsedMs: 1 });

    const config = await saveViaFormPath();

    expect(config.providers.deepseek && "customHeaders" in config.providers.deepseek).toBe(false);
  });
});
