import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchProviderIdView, SearchSettingsView } from "../../../api/searchSettingsClient.js";
import { SearchSettingsSection } from "./SearchSettingsSection.js";

afterEach(cleanup);

const PROVIDERS: SearchSettingsView["providers"] = [
  { id: "bocha", label: "博查", site: "https://open.bochaai.com" },
  { id: "tavily", label: "Tavily", site: "https://app.tavily.com" },
];

function api(view: SearchSettingsView = { provider: null, hasKey: false, providers: PROVIDERS }) {
  return {
    fetchSearchSettings: vi.fn(async () => view),
    saveSearchSettings: vi.fn(async (input: { provider: SearchProviderIdView | null; apiKey?: string }) => ({
      provider: input.provider,
      hasKey: input.provider !== null,
      providers: PROVIDERS,
    })),
    testSearchSettings: vi.fn(async () => ({ works: true, summary: "能用：真搜到了结果。" })),
  };
}

describe("设置 · 联网搜索", () => {
  it("没开：选一家、填密钥才能存；存完能试一下", async () => {
    const calls = api();
    render(<SearchSettingsSection api={calls} />);
    expect(await screen.findByText("没开")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "博查" }));
    expect(screen.getByRole("button", { name: "存" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "open.bochaai.com" })).toHaveAttribute("href", "https://open.bochaai.com");
    fireEvent.change(screen.getByLabelText("博查的密钥"), { target: { value: " sk-1 " } });
    fireEvent.click(screen.getByRole("button", { name: "存" }));
    expect(calls.saveSearchSettings).toHaveBeenCalledWith({ provider: "bocha", apiKey: "sk-1" });
    expect(await screen.findByText("在用：博查")).toBeInTheDocument();
    expect((screen.getByLabelText("博查的密钥") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "试一下" }));
    expect((await screen.findByRole("status")).textContent).toContain("能用");
  });

  it("已开：密钥框留空表示沿用；换一家得重填；关掉会删", async () => {
    const calls = api({ provider: "tavily", hasKey: true, providers: PROVIDERS });
    render(<SearchSettingsSection api={calls} />);
    expect(await screen.findByText("在用：Tavily")).toBeInTheDocument();
    expect(screen.getByLabelText("Tavily的密钥")).toHaveAttribute("placeholder", "已填过（不换就留空）");
    fireEvent.click(screen.getByRole("button", { name: "博查" }));
    expect(screen.getByRole("button", { name: "存" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关掉" }));
    expect(calls.saveSearchSettings).toHaveBeenCalledWith({ provider: null });
    expect(await screen.findByText("没开")).toBeInTheDocument();
  });

  it("试一下没成：如实显示原因", async () => {
    const calls = api({ provider: "bocha", hasKey: true, providers: PROVIDERS });
    calls.testSearchSettings.mockResolvedValueOnce({ works: false, summary: "没成功：博查说密钥不对。" });
    render(<SearchSettingsSection api={calls} />);
    fireEvent.click(await screen.findByRole("button", { name: "试一下" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("密钥不对");
    expect(status.className).toContain("is-bad");
  });
});
