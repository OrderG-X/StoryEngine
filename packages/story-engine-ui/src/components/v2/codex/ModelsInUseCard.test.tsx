import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_PRESETS } from "../../../constants/providerPresets.js";
import type { SavedProvider } from "../../ModelSettingsDialogTypes.js";
import { AiServiceManager } from "./AiServiceManager.js";
import { ModelsInUseCard, rowsFromAssignments } from "./ModelsInUseCard.js";

afterEach(cleanup);

const PROVIDERS: SavedProvider[] = [{ id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "", apiKeyStatus: "present" }];

describe("在用的模型 + 体检（P10）", () => {
  it("按模型把功能并到一起；没分配的说用默认", () => {
    const tasks = { triage: "deepseek|chat-a", fastDraft: "deepseek|chat-a", draftReview: "deepseek|reason-b" };
    expect(rowsFromAssignments(tasks, PROVIDERS)).toEqual([
      { key: "deepseek|chat-a", providerLabel: "DeepSeek", model: "chat-a", tasks: ["fastDraft", "triage"] },
      { key: "deepseek|reason-b", providerLabel: "DeepSeek", model: "reason-b", tasks: ["draftReview"] },
    ]);
    render(<ModelsInUseCard savedProviders={PROVIDERS} tasks={tasks} />);
    expect(screen.getByText("正文生成、主对话")).toBeInTheDocument();
    expect(screen.getByText(/局部改稿、章纲、硬伤检查没单独选/u)).toBeInTheDocument();
  });

  it("体检：通的显示耗时，不通的如实显示原因", async () => {
    const runModelCheckup = vi.fn(async () => ({
      models: [
        { key: "deepseek|chat-a", providerLabel: "DeepSeek", model: "chat-a", tasks: ["triage"], ok: true, ms: 820 },
        { key: "deepseek|reason-b", providerLabel: "DeepSeek", model: "reason-b", tasks: ["draftReview"], ok: false, ms: 300, error: "上游返回 401：密钥不对" },
      ],
      unresolved: [],
    }));
    render(<ModelsInUseCard api={{ runModelCheckup }} savedProviders={PROVIDERS} tasks={{ triage: "deepseek|chat-a" }} />);
    fireEvent.click(screen.getByRole("button", { name: "体检" }));
    expect(await screen.findByText("820 毫秒")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toContain("密钥不对");
    expect(screen.getByText("有没通的，看下面的原因。")).toBeInTheDocument();
  });
});

describe("服务商重排（P10）", () => {
  it("已接好的在上；没接的收进「添加服务商」，展开后不再重复列已接的", () => {
    const onSelect = vi.fn();
    render(<AiServiceManager onSelect={onSelect} savedProviders={PROVIDERS} />);
    expect(screen.getByRole("button", { name: /^DeepSeek已配置/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^OpenAI没接/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加服务商" }));
    expect(screen.getByRole("button", { name: /^OpenAI没接/u })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^DeepSeek/u })).toHaveLength(1);
  });

  it("一个都没接时直接展开", () => {
    render(<AiServiceManager onSelect={() => {}} savedProviders={[]} />);
    expect(screen.getByRole("button", { name: /^DeepSeek没接/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "＋ 添加服务商" })).toBeNull();
  });

  it("预设不列模型版本号，接不上的原生接口不放", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(ids).not.toContain("anthropic");
    expect(ids).not.toContain("baidu");
    for (const preset of PROVIDER_PRESETS) expect(preset.note ?? "").not.toMatch(/\d+\.\d|gpt-|glm-|qwen|llama|deepseek-/iu);
  });
});
