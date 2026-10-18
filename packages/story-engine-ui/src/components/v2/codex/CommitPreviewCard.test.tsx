// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    expect(container.textContent ?? "").toContain("第 7 章可以定稿。");
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

  it("质量问题计数行只在有计数时渲染（R7.7：明细直接进卡默认折叠，不再指向「质检卡」）", () => {
    const { container, rerender } = render(
      <CommitPreviewCard preview={{ chapter: 1, canCommit: false, blockingReasons: ["缺稿。"], draftIssueCount: 3, semanticIssueCount: 2 }} />,
    );
    expect(container.textContent ?? "").toContain("文稿问题 3 项");
    expect(container.textContent ?? "").toContain("和前文对不上的问题 2 项");
    expect(container.textContent ?? "").not.toContain("质检卡");

    rerender(<CommitPreviewCard preview={{ chapter: 1, canCommit: true }} />);
    expect(container.textContent ?? "").not.toContain("文稿问题");
    expect(container.textContent ?? "").not.toContain("和前文对不上的问题");
  });

  // R7.7·报告 4.3：明细文案直接列在卡里——默认折叠（一屏读得完），点开才列出。
  it("带明细文案 → 默认折叠不露明细，点 chip 展开；不出现「质检卡」字样", () => {
    const { container } = render(
      <CommitPreviewCard
        preview={{
          chapter: 1,
          canCommit: false,
          blockingReasons: ["缺稿。"],
          draftIssueCount: 2,
          draftIssues: ["正文过短，疑似只返回标题。", "段落不足。"],
        }}
      />,
    );
    expect(container.textContent ?? "").toContain("文稿问题 2 项（点开看）");
    expect(container.textContent ?? "").not.toContain("正文过短");
    fireEvent.click(container.querySelector("button.chip")!);
    expect(container.textContent ?? "").toContain("正文过短，疑似只返回标题。");
    expect(container.textContent ?? "").toContain("段落不足。");
    expect(container.textContent ?? "").toContain("文稿问题 2 项（收起）");
    expect(container.textContent ?? "").not.toContain("质检卡");
  });

  it("旧数据只有计数（无明细文案）→ 只报数字，不指任何卡、不出折叠按钮", () => {
    const { container } = render(
      <CommitPreviewCard preview={{ chapter: 1, canCommit: false, blockingReasons: ["缺稿。"], draftIssueCount: 3 }} />,
    );
    expect(container.textContent ?? "").toContain("文稿问题 3 项。");
    expect(container.querySelector("button.chip")).toBeNull();
    expect(container.textContent ?? "").not.toContain("质检卡");
  });

  it("空阻断项被过滤（残缺输出里塞空串不渲染空行）", () => {
    const { container } = render(
      <CommitPreviewCard preview={{ chapter: 1, canCommit: false, blockingReasons: ["", "  ", "真阻断。"] }} />,
    );
    const items = container.querySelectorAll(".cpc-item");
    expect(items).toHaveLength(1);
    expect(container.textContent ?? "").toContain("真阻断。");
  });

  // 本文件不做自动 cleanup，多次 render 会叠在 document 上——按钮一律在各自 container 内查。
  it("可定稿：卡上只说要看几条、自动记几条，加【打开定稿清单】（清单在弹窗里，重构 P6）", () => {
    const onOpen = vi.fn();
    const preview: CommitPreviewCardData = {
      chapter: 7,
      canCommit: true,
      ledgerChecklist: [
        { id: "day", kind: "time", label: "这一章记为故事第 3 天", removable: false, editableDay: 3 },
        { id: "0", kind: "fact", label: "钥匙在林溪手里（核账员标了）", removable: true, needsConfirm: true },
        { id: "1", kind: "thread", label: "新线索：去码头", removable: true },
        { id: "2", kind: "fact", label: "铜盒回到桌上", removable: true },
      ],
    };
    const { container } = render(<CommitPreviewCard preview={preview} confirmable onOpen={onOpen} />);
    expect(container.textContent ?? "").toContain("第 7 章可以定稿：要你看 1 条，自动记下 2 条。");
    expect(container.querySelector("input[type=checkbox]")).toBeNull();
    const open = container.querySelector<HTMLButtonElement>("button.cpc-confirm");
    expect(open?.textContent).toBe("打开定稿清单");
    fireEvent.click(open!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("旧预览（已用掉）→ 只能「看这份清单」；定不了 → 没有打开按钮、照实列原因", () => {
    const { container } = render(<CommitPreviewCard preview={{ chapter: 4, canCommit: true }} onOpen={() => undefined} />);
    expect(container.querySelector("button.cpc-confirm")).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "看这份清单")).toBe(true);
    const { container: blocked } = render(
      <CommitPreviewCard preview={{ chapter: 4, canCommit: false, blockingReasons: ["字数不足。"] }} confirmable onOpen={() => undefined} />,
    );
    expect([...blocked.querySelectorAll("button")].some((b) => b.textContent?.includes("清单"))).toBe(false);
    expect(blocked.textContent ?? "").toContain("字数不足。");
  });
});
