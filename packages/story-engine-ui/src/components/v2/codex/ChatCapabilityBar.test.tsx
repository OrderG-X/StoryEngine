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

  it("点高频按钮 → 发对应用户面意图（补全人物）", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} />);
    fireEvent.click(btnByText(container, "补全人物")!);
    expect(onSend).toHaveBeenCalledWith("帮我把人物卡补全一点：只补空着的，按正文里写过的来");
  });

  it("点「更多」展开，显示 写作/补全/整理 分组与全部能力", () => {
    const { container } = render(<ChatCapabilityBar onSendMessage={() => {}} />);
    fireEvent.click(btnByText(container, "更多")!);
    const panel = container.querySelector(".cap-panel");
    expect(panel).toBeTruthy();
    const text = panel?.textContent ?? "";
    expect(text).toContain("内容审阅");     // 写作组
    expect(text).toContain("检查机器腔");   // 写作组
    expect(text).toContain("定稿");         // 写作组
    expect(text).toContain("补全故事设定");
    expect(text).toContain("给没建卡的建卡");
    expect(text).toContain("归并线索");
    // 分组标题
    expect([...panel!.querySelectorAll(".cap-group-title")].map((e) => e.textContent)).toEqual(["写作", "补全", "整理"]);
  });

  it("固定动作按钮（内容审阅）走 onChapterButton 发结构化动作，不给 AI 发话（重构 P4）", () => {
    const onSend = vi.fn();
    const onChapterButton = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} onChapterButton={onChapterButton} />);
    fireEvent.click(btnByText(container, "更多")!);
    fireEvent.click(btnByText(container, "内容审阅")!);
    expect(onChapterButton).toHaveBeenCalledWith("ai_review");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("不带 button 的（检查机器腔）照常给 AI 发一句话", () => {
    const onSend = vi.fn();
    const onChapterButton = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} onChapterButton={onChapterButton} />);
    fireEvent.click(btnByText(container, "更多")!);
    fireEvent.click(btnByText(container, "检查机器腔")!);
    expect(onSend).toHaveBeenCalledWith("检查这一章的机器腔，把有机器腔的句子列出来");
    expect(onChapterButton).not.toHaveBeenCalled();
  });

  it("用户面绝不出现「做厚」二字（纪律 2.6）", () => {
    const { container } = render(<ChatCapabilityBar onSendMessage={() => {}} />);
    fireEvent.click(btnByText(container, "更多")!);
    expect(container.textContent ?? "").not.toContain("做厚");
  });

  it("disabled 时点了不发", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatCapabilityBar onSendMessage={onSend} disabled />);
    fireEvent.click(btnByText(container, "补全人物")!);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ChatCapabilityBar · 本章进度工具并入同一排", () => {
  it("leading 排最前、第一个高亮；常驻快捷里同 key 的去重", () => {
    const { container } = render(
      <ChatCapabilityBar
        onSendMessage={vi.fn()}
        leading={[{ key: "quality", label: "硬伤检查", intent: "q" }, { key: "commit", label: "定稿", intent: "c" }]}
      />,
    );
    const labels = [...container.querySelectorAll(".cap-quick button")].map((b) => b.textContent);
    expect(labels[0]).toBe("硬伤检查");
    expect(labels[1]).toBe("定稿");
    expect(labels.filter((t) => t === "硬伤检查")).toHaveLength(1);
    // 一排最多 3 个常用 + 「更多」
    expect(labels).toHaveLength(4);
    expect(labels[3]).toBe("更多");
    expect(container.querySelector(".cap-btn.is-lead")?.textContent).toBe("硬伤检查");
  });
});

describe("contextActionsForView 快捷条随页面", () => {
  it("写作台不给（照旧按进度）；设定本按分类；历史给撤销上一步；时间线不给", async () => {
    const { contextActionsForView } = await import("./ChatCapabilityBar.js");
    expect(contextActionsForView("desk", "story")).toBeNull();
    expect(contextActionsForView("library", "chars")?.map((a) => a.label)).toEqual(["补全人物", "整理人物关系"]);
    expect(contextActionsForView("library", "uncarded")?.map((a) => a.label)).toEqual(["给没建卡的建卡"]);
    expect(contextActionsForView("library", "hooks")?.map((a) => a.label)).toEqual(["理一遍线索", "归并线索"]);
    expect(contextActionsForView("library", "timeline")).toBeNull();
    expect(contextActionsForView("history", "story")?.map((a) => a.label)).toEqual(["撤销上一步"]);
  });
});
