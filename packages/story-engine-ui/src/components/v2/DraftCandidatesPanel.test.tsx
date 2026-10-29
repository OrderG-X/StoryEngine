import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DraftCandidatesPanel from "./DraftCandidatesPanel.js";
import type { DraftCandidate } from "../../stores/uiStore.js";

afterEach(() => cleanup());

const SHA = "b".repeat(64);
const candidates: readonly DraftCandidate[] = [
  { index: 1, candidateId: "0001-op-1", sha: SHA, body: "甲版正文。", title: "第1章 · 甲版", chapter: 1, projectPath: "/book" },
  { index: 2, candidateId: "0001-op-2", sha: SHA, body: "# 一节\n\n乙版正文，长一些。", chapter: 1, projectPath: "/book" },
];

describe("DraftCandidatesPanel", () => {
  it("并排摆每一版：第几版和章名在上头那一行，正文原样（开头的「# 某某」也是正文，写作版本 P1 第 15 轮 AC3）", () => {
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("甲版正文。")).toBeDefined();
    expect(screen.getByText(/^# 一节\s+乙版正文，长一些。$/u)).toBeDefined();
    expect(screen.getByText("第 1 版 ·「第1章 · 甲版」")).toBeDefined();
    expect(screen.getByText("第 2 版")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "用这版" }).length).toBe(2);
    // 关了几版还在：不说「关掉就没了」。
    expect(screen.queryByText(/关掉就没了/u)).toBeNull();
  });

  it("点「用这版」交出那一份（候选号 + 指纹）", () => {
    const onPick = vi.fn();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "用这版" })[1]!);
    expect(onPick).toHaveBeenCalledWith(candidates[1]);
  });

  it("有事在跑时「用这版」点不了", () => {
    render(<DraftCandidatesPanel candidates={candidates} busy onPick={vi.fn()} onClose={vi.fn()} />);
    for (const button of screen.getAllByRole("button", { name: "用这版" })) {
      expect(button).toBeDisabled();
    }
  });

  it("关闭", () => {
    const onClose = vi.fn();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
  });
});
