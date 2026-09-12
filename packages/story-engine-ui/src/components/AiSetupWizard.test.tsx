// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiSetupWizard } from "./AiSetupWizard.js";
import { AiSimpleView } from "./AiSimpleView.js";
import { ChatMemoryBudgetSection } from "./ChatMemoryBudgetSection.js";
import {
  buildWizardRecommendedState,
  parseChatHistoryBudgetTokens,
  pickRecommendedModelId,
} from "./ModelSettingsDialogLogic.js";
import { WIZARD_SERVICE_PRESETS } from "../constants/wizardPresets.js";
import { TASK_LABELS } from "./ModelSettingsDialogTypes.js";

afterEach(() => cleanup());

describe("AiSetupWizard 三步流转", () => {
  it("默认停在选择服务；选中后可进入填密钥与测试", () => {
    const onTestAndStart = vi.fn();
    render(<AiSetupWizard busy={false} error={null} onTestAndStart={onTestAndStart} />);

    expect(screen.getByText("选择 AI 服务")).toBeTruthy();
    expect(screen.queryByText("测试并开始使用")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByText(/填写 DeepSeek 的 API 密钥/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByRole("button", { name: "测试并开始使用" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试并开始使用" }));

    expect(onTestAndStart).toHaveBeenCalledWith({
      preset: expect.objectContaining({ id: "deepseek" }),
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
    });
  });

  it("自定义服务必须填写接口地址才能进入第 3 步", () => {
    render(<AiSetupWizard busy={false} error={null} onTestAndStart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "sk-x" } });
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://api.openai.com/v1" },
    });
    expect(screen.getByRole("button", { name: "下一步" })).not.toBeDisabled();
  });

  it("测试失败时显示人话错误与重试按钮文案", () => {
    render(
      <AiSetupWizard
        busy={false}
        error="密钥无效或已过期。请检查后重试，或到服务商控制台重新创建密钥。"
        onTestAndStart={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("alert")).toHaveTextContent("密钥无效");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});

describe("AiSimpleView 已配置态", () => {
  it("展示当前服务卡与高级设置入口", () => {
    const onOpenAdvanced = vi.fn();
    render(
      <AiSimpleView
        provider={{
          id: "deepseek",
          label: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          apiKeyStatus: "present",
        }}
        testing={false}
        testError={null}
        testNotice={null}
        onChangeKey={vi.fn()}
        onRetest={vi.fn()}
        onOpenAdvanced={onOpenAdvanced}
      />,
    );
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("密钥已配置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /高级设置/ }));
    expect(onOpenAdvanced).toHaveBeenCalled();
  });
});

describe("ChatMemoryBudgetSection 预设", () => {
  it("点击短/标准/长篇写入对应数字", () => {
    const onChange = vi.fn();
    render(<ChatMemoryBudgetSection value={96_000} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "短" }));
    expect(onChange).toHaveBeenCalledWith(48_000);
    fireEvent.click(screen.getByRole("button", { name: "长篇" }));
    expect(onChange).toHaveBeenCalledWith(300_000);
    fireEvent.click(screen.getByRole("button", { name: "标准" }));
    expect(onChange).toHaveBeenCalledWith(96_000);
  });
});

describe("wizard logic helpers", () => {
  it("pickRecommendedModelId 优先推荐、否则第一项", () => {
    expect(pickRecommendedModelId([{ id: "a" }, { id: "deepseek-chat" }], "deepseek-chat")).toBe("deepseek-chat");
    expect(pickRecommendedModelId([{ id: "a" }, { id: "b" }], "missing")).toBe("a");
    expect(pickRecommendedModelId([], "x")).toBeNull();
  });

  it("buildWizardRecommendedState 覆盖全部任务", () => {
    const preset = WIZARD_SERVICE_PRESETS[0]!;
    const state = buildWizardRecommendedState(preset, preset.baseUrl, "deepseek-chat");
    expect(state.providers).toHaveLength(1);
    expect(Object.keys(state.tasks)).toEqual(Object.keys(TASK_LABELS));
    expect(state.tasks.fastDraft).toBe("deepseek|deepseek-chat");
  });

  it("parseChatHistoryBudgetTokens 读 raw JSON", () => {
    expect(parseChatHistoryBudgetTokens('{"chatHistoryBudgetTokens":300000}')).toBe(300000);
    expect(parseChatHistoryBudgetTokens("{")).toBeNull();
  });

  it("预置 baseUrl 不含私人中转主机", () => {
    for (const preset of WIZARD_SERVICE_PRESETS) {
      if (!preset.baseUrl) continue;
      expect(preset.baseUrl).toMatch(/^https:\/\//);
      expect(preset.baseUrl).not.toMatch(/localhost|127\.0\.0\.1|192\.168\.|10\.\d/);
    }
  });
});
