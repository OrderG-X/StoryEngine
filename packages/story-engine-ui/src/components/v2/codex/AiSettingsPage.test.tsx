// @vitest-environment jsdom
/**
 * AiSettingsPage 回归测试 — 锁死 2026-08-11 重构翻车的四个致命点：
 *  1. providers 规范形态是「以 id 为键的对象」：读要走 result.summary（不是自己解析 rawText 当数组），
 *     否则已配置服务商全部显示「未配置」、已存自定义服务商永远不可见；
 *  2. 保存必须写回对象 map 且不丢已有服务商（翻车版写数组 → 服务端校验必拒 → 什么都存不了）；
 *  3. 打开已配置服务商必须回填已保存值（翻车版显示预设默认，保存会覆盖用户自定义地址）；
 *  4. 测通后点模型「保存并分配给所有任务」必须真干活（翻车版是空函数死按钮）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiSettingsPage } from "./AiSettingsPage.js";
import { TASK_LABELS } from "../../ModelSettingsDialogTypes.js";
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";

const fetchModelSettings = vi.fn();
const saveModelSettings = vi.fn();
const testModelConnection = vi.fn();

vi.mock("../../../api/client.js", () => ({
  fetchModelSettings: (...args: unknown[]) => fetchModelSettings(...args),
  saveModelSettings: (...args: unknown[]) => saveModelSettings(...args),
  testModelConnection: (...args: unknown[]) => testModelConnection(...args),
}));

/** 模拟用户真实配置：providers 为对象 map（规范形态），含一家预设（deepseek）+ 一家自定义中转。 */
function makeFetchFixture() {
  return {
    result: {
      passed: true,
      available: true,
      status: "loaded",
      configPath: "/tmp/model-settings.json",
      summary: {
        available: true,
        status: "loaded",
        configPath: "/tmp/model-settings.json",
        providers: [
          {
            id: "deepseek",
            label: "DeepSeek",
            type: "openai-compatible",
            baseUrl: "https://api.deepseek.com",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            apiKeyStatus: "present",
          },
          {
            id: "my-relay",
            label: "我的中转",
            type: "openai-compatible",
            baseUrl: "http://relay.example/v1",
            apiKeyEnv: "",
            apiKeyStatus: "missing",
          },
        ],
        profiles: [{ id: "deepseek_deepseek-chat", provider: "deepseek", model: "deepseek-chat" }],
        taskProfiles: { fastDraft: "deepseek_deepseek-chat" },
        issueCount: 0,
        highRiskIssueCount: 0,
      },
      issues: [],
    },
    rawText: JSON.stringify({
      version: 1,
      providers: {
        deepseek: {
          id: "deepseek",
          label: "DeepSeek",
          type: "openai-compatible",
          baseUrl: "https://api.deepseek.com",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
        "my-relay": {
          id: "my-relay",
          label: "我的中转",
          type: "openai-compatible",
          baseUrl: "http://relay.example/v1",
        },
      },
      profiles: {
        "deepseek_deepseek-chat": {
          id: "deepseek_deepseek-chat",
          provider: "deepseek",
          model: "deepseek-chat",
        },
      },
      taskProfiles: { fastDraft: "deepseek_deepseek-chat" },
      chatHistoryBudgetTokens: 300000,
    }),
    taskAssignments: {
      fastDraft: { profileId: "deepseek_deepseek-chat", thinking: false },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  fetchModelSettings.mockReset();
  saveModelSettings.mockReset();
  testModelConnection.mockReset();
  fetchModelSettings.mockResolvedValue(makeFetchFixture());
  saveModelSettings.mockResolvedValue(makeFetchFixture());
  // 挂载时后台逐家刷新模型列表；默认返回空（不覆盖 profile 反推的兜底列表）。
  testModelConnection.mockResolvedValue({ providerId: "x", models: [], elapsedMs: 1 });
});

async function renderAndWaitLoaded() {
  render(<AiSettingsPage onBack={() => undefined} />);
  await waitFor(() => {
    expect(screen.queryByText("正在加载配置...")).toBeNull();
  });
}

describe("AiSettingsPage 数据层（map 形态 providers）", () => {
  it("已配置的预设显示「已配置」，缺密钥的显示「缺密钥」，自定义服务商在列表可见", async () => {
    await renderAndWaitLoaded();

    const deepseekCard = screen.getByRole("button", { name: /^DeepSeek已配置/ });
    expect(deepseekCard).toBeTruthy();

    // 自定义中转（不属于任何预设）必须有自己的卡片，且如实标「缺密钥」
    const relayCard = screen.getByRole("button", { name: /^我的中转缺密钥/ });
    expect(relayCard).toBeTruthy();

    // 任务分配区随之出现（工作台内不再丢失该功能）
    expect(screen.getByText("各功能使用的 AI")).toBeTruthy();
    // 对话记忆上限回填真实值
    expect(screen.getByDisplayValue("300000")).toBeTruthy();
  });

  it("打开已配置服务商回填已保存值（而非预设默认）", async () => {
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^DeepSeek已配置/ }));

    // 用户保存的是 https://api.deepseek.com（无 /v1），预设默认是 https://api.deepseek.com/v1。
    // 必须显示已保存值，否则一保存就把用户自定义地址覆盖回预设。
    await waitFor(() => {
      expect(screen.getByDisplayValue("https://api.deepseek.com")).toBeTruthy();
    });
    expect(screen.queryByDisplayValue("https://api.deepseek.com/v1")).toBeNull();
    // 编辑态按钮文案是「保存修改」而非「添加」
    expect(screen.getByRole("button", { name: "保存修改" })).toBeTruthy();
  });

  it("保存新服务商：写回对象 map 形态、保留全部已有服务商、密钥随载荷提交", async () => {
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    const [rawText, apiKeys, taskAssignments] = saveModelSettings.mock.calls[0];
    const config = JSON.parse(rawText as string);

    // 规范形态：对象 map，绝不是数组（数组会被服务端校验拒收）
    expect(Array.isArray(config.providers)).toBe(false);
    expect(typeof config.providers).toBe("object");
    // 已有两家 + 新加一家，一家不丢
    expect(Object.keys(config.providers).sort()).toEqual(["deepseek", "my-relay", "openai"]);
    expect(config.providers["my-relay"].baseUrl).toBe("http://relay.example/v1");
    // 密钥走独立载荷（不进设置 JSON）
    expect(apiKeys).toEqual({ openai: "sk-new-key" });
    // 既有任务分配原样保留
    expect(taskAssignments.fastDraft.profileId).toBe("deepseek_deepseek-chat");
    expect(taskAssignments.fastDraft.thinking).toBe(false);
  });

  it("测通后点模型标签 = 保存服务商并把该模型分配给全部任务（不再是死按钮）", async () => {
    testModelConnection.mockImplementation((input: { providerId: string }) =>
      Promise.resolve(
        input.providerId === "openai"
          ? { providerId: "openai", models: [{ id: "gpt-test" }], elapsedMs: 5 }
          : { providerId: input.providerId, models: [], elapsedMs: 1 },
      ),
    );
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));

    const modelTag = await screen.findByRole("button", { name: "gpt-test" });
    fireEvent.click(modelTag);

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    const [rawText, apiKeys, taskAssignments] = saveModelSettings.mock.calls[0];
    const config = JSON.parse(rawText as string);

    expect(apiKeys).toEqual({ openai: "sk-new-key" });
    // 7 个任务全部指到该模型
    for (const task of Object.keys(TASK_LABELS)) {
      expect(config.taskProfiles[task]).toBe("openai_gpt-test");
      expect(taskAssignments[task].profileId).toBe("openai_gpt-test");
    }
    expect(config.profiles["openai_gpt-test"].model).toBe("gpt-test");
  });

  it("改对话记忆上限立刻同步 workspaceStore（聊天在用值），不用重开书", async () => {
    useWorkspaceStore.setState({ chatHistoryBudget: 96000 });
    await renderAndWaitLoaded();

    // 页面回填的是配置里的 300000；点「短」预设改成 48000
    fireEvent.click(screen.getByRole("button", { name: "短" }));

    // 本地表单值变了
    expect(screen.getByDisplayValue("48000")).toBeTruthy();
    // 关键断言：工作区在用值同步更新（useChat 裁剪与 ChatSessionBar 徽标都读它），
    // 否则改完要重开书才生效——静默退化。
    expect(useWorkspaceStore.getState().chatHistoryBudget).toBe(48000);
  });

  it("删除服务商：两击确认，配置中移除该家并剥离其任务分配", async () => {
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^DeepSeek已配置/ }));
    const deleteBtn = await screen.findByRole("button", { name: "删除此服务" });
    fireEvent.click(deleteBtn);
    // 第一击只是武装，不落盘
    expect(saveModelSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "再点一次确认删除" }));
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    const [rawText, , taskAssignments] = saveModelSettings.mock.calls[0];
    const config = JSON.parse(rawText as string);

    expect(Object.keys(config.providers)).toEqual(["my-relay"]);
    // fastDraft 原指 deepseek，删除后不得再引用
    expect(config.taskProfiles.fastDraft).toBeUndefined();
    expect(taskAssignments.fastDraft?.profileId).toBeUndefined();
  });

  it("保存响应带 warnings 时列表页如实展示（丢头警告不静默、不随 4 秒提示自动消失）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：deepseek 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    saveModelSettings.mockResolvedValue({ ...makeFetchFixture(), warnings });
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    });
    // 本页表单无 raw JSON 编辑器，警告必须指路到首页弹窗的补救路径（可行动性不断链）
    expect(screen.getByText(/原始 JSON 编辑/)).toBeTruthy();
  });

  it("保存响应不带 warnings 时不出现警告条（无丢弃不刷警告）", async () => {
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector(".ms-warn-notice")).toBeNull();
  });

  it("轻量旁路保存（切 thinking）不抹掉已有丢头警告——警告只归服务商保存刷新", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：deepseek 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    // 第一次：添加服务商（服务商保存），响应带回丢头警告
    saveModelSettings.mockResolvedValueOnce({ ...makeFetchFixture(), warnings });
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => {
      expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    });

    // 第二次：切 thinking 触发轻量旁路保存，响应无 warnings —— 旧警告必须保住
    saveModelSettings.mockResolvedValueOnce(makeFetchFixture());
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(warnings[0] as string)).toBeTruthy();
  });

  it("轻量旁路保存若真带回新警告也如实展示（新警告绝不静默吞）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：my-relay 的 x-lost。如需保留请重新填写明文值后保存。"];
    saveModelSettings.mockResolvedValueOnce({ ...makeFetchFixture(), warnings });
    await renderAndWaitLoaded();

    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    });
  });

  it("下一次服务商保存成功且无 warnings 时才清掉旧警告（成功才换）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：deepseek 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    saveModelSettings.mockResolvedValueOnce({ ...makeFetchFixture(), warnings });
    await renderAndWaitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => {
      expect(screen.getByText(warnings[0] as string)).toBeTruthy();
    });

    // 再保存一次服务商（编辑 deepseek 走「保存修改」），响应无 warnings → 旧警告清掉
    saveModelSettings.mockResolvedValueOnce(makeFetchFixture());
    fireEvent.click(screen.getByRole("button", { name: /^DeepSeek已配置/ }));
    fireEvent.click(await screen.findByRole("button", { name: "保存修改" }));
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(document.querySelector(".ms-warn-notice")).toBeNull();
    });
  });

  it("persist 写盘前重新拉取合并底（rawTextRef 陈旧修复）：同会话他面改盘后的新字段不被静默抹掉", async () => {
    const fixture = makeFetchFixture();
    fetchModelSettings.mockResolvedValue(fixture);
    await renderAndWaitLoaded();

    // 同会话内他面（App 级设置弹窗）改盘：磁盘文本多出 defaultProfile 与手写顶层键，
    // 本页 ref 仍停在挂载时的旧文本——persist 必须先 GET 刷新合并底再重建。
    const updatedRaw = JSON.stringify({
      ...JSON.parse(fixture.rawText),
      defaultProfile: "deepseek_deepseek-chat",
      someFutureTopLevel: { nested: [1, 2] },
    });
    fetchModelSettings.mockResolvedValue({ ...fixture, rawText: updatedRaw });
    saveModelSettings.mockResolvedValue({ ...fixture, rawText: updatedRaw });

    // 任意一次轻量旁路保存（切 thinking）即触发 persist
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    // 挂载 1 次 + persist 预读 1 次：预读真实发生
    expect(fetchModelSettings).toHaveBeenCalledTimes(2);
    const config = JSON.parse(saveModelSettings.mock.calls[0][0] as string) as Record<string, unknown>;
    // 合并底是新拉取的磁盘文本：他面新写的字段随合并保留，不被陈旧 ref 抹掉
    expect(config.defaultProfile).toBe("deepseek_deepseek-chat");
    expect(config.someFutureTopLevel).toEqual({ nested: [1, 2] });
  });

  it("磁盘手写明文 apiKey 经合并带回：保存时剔除、警告如实上屏且文案绝不含密钥值（P2-1 兜底清洗）", async () => {
    const fixture = makeFetchFixture();
    const raw = JSON.parse(fixture.rawText) as { providers: Record<string, Record<string, unknown>> };
    raw.providers["my-relay"] = { ...raw.providers["my-relay"], apiKey: "sk-handwritten" };
    const withKey = { ...fixture, rawText: JSON.stringify(raw) };
    fetchModelSettings.mockResolvedValue(withKey);
    saveModelSettings.mockResolvedValue(withKey);
    await renderAndWaitLoaded();

    // 切 thinking 触发轻量旁路保存：合并产物里的手写明文密钥必须被剔除
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    const sentText = saveModelSettings.mock.calls[0][0] as string;
    expect(sentText).not.toContain("sk-handwritten");
    const sent = JSON.parse(sentText) as { providers: Record<string, Record<string, unknown>> };
    expect("apiKey" in (sent.providers["my-relay"] ?? {})).toBe(false);
    // 清洗动作如实进警告区（与服务端 warnings 同栏）；文案只报字段路径、绝不含密钥明文
    await waitFor(() => {
      expect(screen.getByText(/明文密钥字段/)).toBeTruthy();
    });
    expect(document.querySelector(".ms-warn-notice")?.textContent ?? "").not.toContain("sk-handwritten");
  });

  it("整页表单路径持久化保留磁盘 provider 的 customHeaders（P2-3 残留洞），无头的 provider 不凭空带出", async () => {
    // 与服务端 MASKED_CUSTOM_HEADER_VALUE（server/routes/model-settings.ts）同字面量，内联守边界：
    // GET 回显里 customHeaders 值一律是此哨兵，服务端 PUT 时还原磁盘真值。
    const MASKED = "__STORY_ENGINE_MASKED__";
    const fixture = makeFetchFixture();
    const raw = JSON.parse(fixture.rawText) as { providers: Record<string, Record<string, unknown>> };
    raw.providers["my-relay"] = {
      ...raw.providers["my-relay"],
      customHeaders: { "x-relay-key": MASKED },
    };
    const withHeaders = { ...fixture, rawText: JSON.stringify(raw) };
    fetchModelSettings.mockResolvedValue(withHeaders);
    saveModelSettings.mockResolvedValue(withHeaders);
    await renderAndWaitLoaded();

    // 任意一次表单路径持久化（这里走「添加服务商」）：既有 provider 的自定义头必须随合并写回，不静默丢
    fireEvent.click(screen.getByRole("button", { name: /^OpenAI未配置/ }));
    const keyInput = await screen.findByPlaceholderText("sk-…");
    fireEvent.change(keyInput, { target: { value: "sk-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(saveModelSettings).toHaveBeenCalledTimes(1);
    });
    const config = JSON.parse(saveModelSettings.mock.calls[0][0] as string) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(config.providers["my-relay"]?.customHeaders).toEqual({ "x-relay-key": MASKED });
    expect(config.providers.deepseek && "customHeaders" in config.providers.deepseek).toBe(false);
  });
});
