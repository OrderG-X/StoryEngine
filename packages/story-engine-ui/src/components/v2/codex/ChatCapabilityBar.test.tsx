// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatCapabilityBar } from "./ChatCapabilityBar.js";

/** container 作用域里按文字找按钮（避开跨用例 DOM 累积导致的全局 getByText 撞多个）。 */
function btnByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
}

describe("ChatCapabilityBar · 聊天区能力快捷条", () => {
  it("无 onSendMessage → 不渲染（不绕过唯一控制面）", () => {
    const { container } = render(<ChatCapabilityBar />);
    expect(container.querySelector(".cap-bar")).toBeNull();
  });

  it("常驻露脸高频几个；默认收起、不显展开面板", () => {
    const { container } = render(<ChatCapabilityBar onSendMessage={() => {}} />);
    expect(container.querySelector(".cap-bar")).toBeTruthy();
    expect(container.querySelectorAll(".cap-quick .cap-btn").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector(".cap-panel")).toBeNull();
  });

  it("点高频按钮 → 发对应用户面意图（补全角色）", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} />);
    fireEvent.click(btnByText(container, "✦ 补全角色")!);
    expect(onSend).toHaveBeenCalledWith("帮我把现有角色补全一点");
  });

  it("点「更多」展开，显示 写作/补全/整理 分组与全部能力", () => {
    const { container } = render(<ChatCapabilityBar onSendMessage={() => {}} />);
    fireEvent.click(btnByText(container, "⋯ 更多")!);
    const panel = container.querySelector(".cap-panel");
    expect(panel).toBeTruthy();
    const text = panel?.textContent ?? "";
    expect(text).toContain("内容审阅");     // 写作组
    expect(text).toContain("检查机器腔");   // 写作组
    expect(text).toContain("定稿");         // 写作组
    expect(text).toContain("补全世界观");
    expect(text).toContain("合并重复伏笔");
    // 分组标题
    expect([...panel!.querySelectorAll(".cap-group-title")].map((e) => e.textContent)).toEqual(["写作", "补全", "整理"]);
  });

  it("写作辅助意图与 ChapterToolRail 一致（审稿）", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} />);
    fireEvent.click(btnByText(container, "⋯ 更多")!);
    fireEvent.click(btnByText(container, "◈ 内容审阅")!);
    expect(onSend).toHaveBeenCalledWith("审阅这一章的内容，给我评分和改进建议");
  });

  it("用户面绝不出现「做厚」二字（纪律 2.6）", () => {
    const { container } = render(<ChatCapabilityBar onSendMessage={() => {}} />);
    fireEvent.click(btnByText(container, "⋯ 更多")!);
    expect(container.textContent ?? "").not.toContain("做厚");
  });

  it("disabled 时点了不发", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} disabled />);
    fireEvent.click(btnByText(container, "✦ 补全角色")!);
    expect(onSend).not.toHaveBeenCalled();
  });
});
