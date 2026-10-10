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

  // 本文件不做自动 cleanup，多次 render 会叠在 document 上——按钮一律在各自 container 内查。
  it("可定稿 + 传了 onConfirm → 渲染「确认定稿」按钮，点击回调", () => {
    const onConfirm = vi.fn();
    const { container } = render(<CommitPreviewCard preview={{ chapter: 4, canCommit: true }} onConfirm={onConfirm} />);
    const button = container.querySelector<HTMLButtonElement>("button.cpc-confirm");
    expect(button?.textContent).toBe("确认定稿");
    fireEvent.click(button!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("不可定稿 / 没传 onConfirm（旧卡）→ 不渲染按钮", () => {
    const { container, rerender } = render(
      <CommitPreviewCard preview={{ chapter: 4, canCommit: false, blockingReasons: ["字数不足。"] }} onConfirm={() => undefined} />,
    );
    expect(container.querySelector("button.cpc-confirm")).toBeNull();
    rerender(<CommitPreviewCard preview={{ chapter: 4, canCommit: true }} />);
    expect(container.querySelector("button.cpc-confirm")).toBeNull();
  });

  it("回合进行中 confirmDisabled → 按钮禁用", () => {
    const { container } = render(
      <CommitPreviewCard preview={{ chapter: 4, canCommit: true }} onConfirm={() => undefined} confirmDisabled />,
    );
    expect(container.querySelector<HTMLButtonElement>("button.cpc-confirm")?.disabled).toBe(true);
  });

  it("「先不定」只在挂了确认按钮时出现，点了调 onDecline、不触发定稿", () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    const { container } = render(
      <CommitPreviewCard preview={{ chapter: 4, canCommit: true }} onConfirm={onConfirm} onDecline={onDecline} />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>("button.cpc-decline")!);
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    const { container: blocked } = render(
      <CommitPreviewCard preview={{ chapter: 4, canCommit: false, blockingReasons: ["字数不足。"] }} onConfirm={onConfirm} onDecline={onDecline} />,
    );
    expect(blocked.querySelector("button.cpc-decline")).toBeNull();
  });

  it("账本清单：列出会记的条目，勾掉的随「确认定稿」带上；只提示的条目没有勾选框", () => {
    const preview: CommitPreviewCardData = {
      chapter: 7,
      canCommit: true,
      ledgerChecklist: [
        { id: "day", kind: "day", label: "这一章记为故事第 3 天", removable: false },
        { id: "fact:0", kind: "fact", label: "记下：铜钥匙在林溪手里", detail: "她摸出一把铜钥匙。", removable: true },
        { id: "thread:lead-1", kind: "thread", label: "新线索：去码头", removable: true },
      ],
    };
    const onConfirm = vi.fn();
    const { container, getByRole, getAllByRole } = render(<CommitPreviewCard preview={preview} onConfirm={onConfirm} />);
    expect(container.textContent ?? "").toContain("这次入账会记下 2 条");
    expect(getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(getAllByRole("checkbox")[0]);
    expect(container.textContent ?? "").toContain("这次入账会记下 1 条");
    fireEvent.click(getByRole("button", { name: "确认定稿（去掉 1 条）" }));
    expect(onConfirm).toHaveBeenCalledWith(["fact:0"]);
  });

  it("卡片重新挂载（回合收尾重建消息）后勾选还在", () => {
    const preview: CommitPreviewCardData = {
      chapter: 9,
      canCommit: true,
      previewToken: "tok-remount",
      ledgerChecklist: [{ id: "fact:0", kind: "fact", label: "记下：x", removable: true }],
    };
    const first = render(<CommitPreviewCard preview={preview} onConfirm={vi.fn()} />);
    fireEvent.click(first.container.querySelector("input[type=checkbox]")!);
    first.unmount();
    const onConfirm = vi.fn();
    const second = render(<CommitPreviewCard preview={preview} onConfirm={onConfirm} />);
    const confirm = [...second.container.querySelectorAll("button")].find((button) => button.textContent === "确认定稿（去掉 1 条）");
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);
    expect(onConfirm).toHaveBeenCalledWith(["fact:0"]);
  });
});
