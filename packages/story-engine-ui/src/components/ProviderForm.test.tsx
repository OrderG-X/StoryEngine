import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProviderForm } from "./ProviderForm.js";
import { PROVIDER_PRESETS } from "../constants/providerPresets.js";
import type { ProviderFormProps } from "./ModelSettingsDialogTypes.js";

afterEach(cleanup);

function props(presetId: string, over: Partial<ProviderFormProps> = {}): ProviderFormProps {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null;
  return {
    editingProviderId: null,
    hidePresetPicker: true,
    hideHeader: true,
    minimal: preset !== null,
    formPresetId: presetId,
    formName: preset?.label ?? "",
    formBaseUrl: preset?.baseUrl ?? "",
    formAuthEnv: preset?.apiKeyEnvSuggestion ?? "",
    formApiKey: "",
    showApiKey: false,
    selectedPreset: preset,
    testing: false,
    testModels: [],
    testError: null,
    testElapsed: null,
    setFormName: vi.fn(),
    setFormBaseUrl: vi.fn(),
    setFormAuthEnv: vi.fn(),
    setFormApiKey: vi.fn(),
    setShowApiKey: vi.fn(),
    onSelectPreset: vi.fn(),
    onTestConnection: vi.fn(),
    onCancel: vi.fn(),
    onSaveProvider: vi.fn(),
    onModelQuickAssign: vi.fn(),
    ...over,
  } as ProviderFormProps;
}

describe("ProviderForm：新作者第一眼只看到要填的那格（2026-10-22 好上手走查）", () => {
  it("官方预设：密钥框在「高级选项」前面", () => {
    const { container } = render(<ProviderForm {...props("zhipu")} />);
    const key = container.querySelector(".ms-input-key")!;
    const advanced = container.querySelector(".ms-advanced-details")!;
    expect(key.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("占位字跟着服务商走，不再一律是 DeepSeek", () => {
    const { container } = render(<ProviderForm {...props("zhipu")} />);
    const placeholders = [...container.querySelectorAll("input")].map((input) => input.getAttribute("placeholder") ?? "");
    expect(placeholders.join(" ")).not.toMatch(/deepseek/iu);
    expect(placeholders).toContain("https://open.bigmodel.cn/api/paas/v4");
  });

  it("本机服务（Ollama）不标必填，说一般不用填", () => {
    render(<ProviderForm {...props("ollama")} />);
    expect(screen.getByText(/本机服务一般不用填/u)).toBeTruthy();
  });
});
