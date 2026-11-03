// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommitPreviewCard } from "./CommitPreviewCard.js";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";

// 本文件不做自动 cleanup，多次 render 会叠在 document 上——按钮一律在各自 container 内查。
describe("CommitPreviewCard 定不了的那张卡（安静账房：只剩这一种）", () => {
  it("attention 徽章「暂不可定稿」、阻断原因照实列出（不靠模型转述）；补账说「暂补不了」", () => {
    const preview: CommitPreviewCardData = { chapter: 7, blockingReasons: ["第 7 章还没有工作稿。"], summary: "暂不可定稿。" };
    const { container, getByText } = render(<CommitPreviewCard preview={preview} />);
    expect(container.querySelector(".step-card.sc-attention")).toBeTruthy();
    expect(getByText("暂不可定稿")).toBeTruthy();
    expect(container.textContent ?? "").toContain("第 7 章还没有工作稿。");
    const { container: fill } = render(<CommitPreviewCard preview={{ ...preview, fill: true }} />);
    expect(fill.textContent ?? "").toContain("暂补不了");
  });

  it("只差字数下限：卡上有「就这么短，照样定稿」；别的原因挡住的没有", () => {
    const preview: CommitPreviewCardData = { chapter: 7, shortOnly: true, blockingReasons: ["正文 900 字，低于写作规则要求的下限 2000 字"] };
    const onCommitShort = vi.fn();
    const { getByRole, rerender, queryByRole } = render(<CommitPreviewCard preview={preview} onCommitShort={onCommitShort} />);
    fireEvent.click(getByRole("button", { name: "就这么短，照样定稿" }));
    expect(onCommitShort).toHaveBeenCalledTimes(1);
    rerender(<CommitPreviewCard preview={{ ...preview, shortOnly: undefined }} onCommitShort={onCommitShort} />);
    expect(queryByRole("button", { name: "就这么短，照样定稿" })).toBeNull();
  });

  it("阻断项就是那条文稿问题（字数不够）→ 只列一次；别的文稿问题折叠着、点开才列", () => {
    const short = "正文 1006 字，低于写作规则要求的下限 2500 字。";
    const { container, rerender } = render(<CommitPreviewCard preview={{ chapter: 23, blockingReasons: [short], draftIssues: [short] }} />);
    expect((container.textContent ?? "").split(short)).toHaveLength(2);
    expect(container.textContent ?? "").not.toContain("文稿问题");

    rerender(<CommitPreviewCard preview={{ chapter: 23, blockingReasons: [short], draftIssues: [short, "第三段有乱码。"] }} />);
    expect(container.textContent ?? "").toContain("文稿问题 1 项（点开看）");
    expect(container.textContent ?? "").not.toContain("第三段有乱码。");
    fireEvent.click(container.querySelector("button.chip")!);
    expect(container.textContent ?? "").toContain("第三段有乱码。");
  });

  it("空阻断项被过滤（残缺输出里塞空串不渲染空行）", () => {
    const { container } = render(<CommitPreviewCard preview={{ chapter: 1, blockingReasons: ["", "  ", "真阻断。"] }} />);
    expect(container.querySelectorAll(".cpc-item")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("真阻断。");
  });
});
