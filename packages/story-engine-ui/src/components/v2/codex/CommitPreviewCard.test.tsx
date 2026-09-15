// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommitPreviewCard } from "./CommitPreviewCard.js";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";

describe("CommitPreviewCard 定稿预览卡（R3）", () => {
  it("有阻断项 → attention 徽章「暂不可定稿」、阻断原因照实列出（不靠模型转述）", () => {
    const preview: CommitPreviewCardData = {
      chapter: 7,
      canCommit: false,
      blockingReasons: ["第 7 章还没有工作稿。"],
      summary: "暂不可定稿。",
    };
    const { container, getByText } = render(<CommitPreviewCard preview={preview} />);
    expect(container.querySelector(".step-card.sc-attention")).toBeTruthy();
    expect(getByText("暂不可定稿")).toBeTruthy();
    expect(container.textContent ?? "").toContain("第 7 章还没有工作稿。");
    expect(container.textContent ?? "").toContain("第 7 章目前不满足定稿条件");
  });

  it("canCommit:true 且无阻断 → done 徽章「可以定稿」、不说「暂不可定稿」", () => {
    const preview: CommitPreviewCardData = { chapter: 7, canCommit: true, summary: "可以定稿。" };
    const { container, getByText } = render(<CommitPreviewCard preview={preview} />);
    expect(container.querySelector(".step-card.sc-done")).toBeTruthy();
    expect(getByText("可以定稿")).toBeTruthy();
    expect(container.textContent ?? "").toContain("已满足定稿条件");
  });

  it("残缺不一致输出：canCommit:true 却带阻断项 → 按阻断项显示「暂不可定稿」（绝不显示可以定稿）", () => {
    const preview: CommitPreviewCardData = {
      chapter: 7,
      canCommit: true,
      blockingReasons: ["质检有 1 处硬伤。"],
    };
    const { container } = render(<CommitPreviewCard preview={preview} />);
    expect(container.querySelector(".step-card.sc-attention")).toBeTruthy();
    expect(container.textContent ?? "").toContain("不满足定稿条件");
  });

  it("质量问题计数行只在有计数时渲染（明细见质检卡，不重复展开）", () => {
    const { container, rerender } = render(
      <CommitPreviewCard preview={{ chapter: 1, canCommit: false, blockingReasons: ["缺稿。"], draftIssueCount: 3, semanticIssueCount: 2 }} />,
    );
    expect(container.textContent ?? "").toContain("文稿问题 3 项");
    expect(container.textContent ?? "").toContain("语义/连续性问题 2 项");

    rerender(<CommitPreviewCard preview={{ chapter: 1, canCommit: true }} />);
    expect(container.textContent ?? "").not.toContain("文稿问题");
    expect(container.textContent ?? "").not.toContain("语义/连续性问题");
  });

  it("空阻断项被过滤（残缺输出里塞空串不渲染空行）", () => {
    const { container } = render(
      <CommitPreviewCard preview={{ chapter: 1, canCommit: false, blockingReasons: ["", "  ", "真阻断。"] }} />,
    );
    const items = container.querySelectorAll(".cpc-item");
    expect(items).toHaveLength(1);
    expect(container.textContent ?? "").toContain("真阻断。");
  });
});
