// @vitest-environment jsdom
/**
 * 设置只留一套（重构 P6 第 6 步）：书架和写作台开同一个设置弹窗；「高级」能直接改设置文件原文。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchModelSettings = vi.fn();
const saveModelSettings = vi.fn();
vi.mock("../../../api/client.js", () => ({
  fetchModelSettings: (...args: unknown[]) => fetchModelSettings(...args),
  saveModelSettings: (...args: unknown[]) => saveModelSettings(...args),
}));
vi.mock("./AiSettingsPage.js", () => ({ AiSettingsPage: () => <p>模型页</p> }));

import { SettingsModal } from "./SettingsModal.js";
import { RawSettingsSection } from "./RawSettingsSection.js";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("设置弹窗（P6 第 6 步）", () => {
  it("模型 / 显示 / 高级三栏；点栏切换；Esc 和关闭键都关", () => {
    const onTab = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal tab="model" onTab={onTab} onClose={onClose} />);
    expect(screen.getByText("模型页")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    expect(onTab).toHaveBeenCalledWith("raw");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("高级：读出原文，改了才能存；存不上照实说", async () => {
    fetchModelSettings.mockResolvedValue({ rawText: "{\"a\":1}" });
    saveModelSettings.mockRejectedValueOnce(new Error("JSON 格式错误"));
    render(<RawSettingsSection />);
    const box = await screen.findByLabelText("model-settings.json 原文") as HTMLTextAreaElement;
    expect(box.value).toBe("{\"a\":1}");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "{\"a\":" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("没存上：JSON 格式错误")).toBeTruthy();
    expect(saveModelSettings).toHaveBeenCalledWith("{\"a\":");
    saveModelSettings.mockResolvedValueOnce({ rawText: "{\"a\":2}" });
    fireEvent.change(box, { target: { value: "{\"a\":2}" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText("已保存并校验通过。")).toBeTruthy());
  });
});
