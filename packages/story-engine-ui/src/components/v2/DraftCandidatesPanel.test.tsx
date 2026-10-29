import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DraftCandidatesPanel from "./DraftCandidatesPanel.js";
import type { DraftCandidate } from "../../stores/uiStore.js";

afterEach(() => cleanup());

const candidates: readonly DraftCandidate[] = [
  { body: "甲版正文。", title: "第一章 · 甲版", originTarget: { projectPath: "/book", chapter: 1, sessionId: "session", operationId: "op" } },
  { body: "# 一节\n\n乙版正文，长一些。", title: "第一章 · 乙版", originTarget: { projectPath: "/book", chapter: 1, sessionId: "session", operationId: "op" } },
];

describe("DraftCandidatesPanel", () => {
  it("并排摆每一版：章名在上头那一行，正文原样（开头的「# 某某」也是正文，写作版本 P1 第 15 轮 AC3）", () => {
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("甲版正文。")).toBeDefined();
    expect(screen.getByText(/^# 一节\s+乙版正文，长一些。$/u)).toBeDefined();
    expect(screen.getByText("候选 1 ·「第一章 · 甲版」")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "用这版" }).length).toBe(2);
  });

  it("点「用这版」交出那一份整稿（章名 + 正文）", () => {
    const onPick = vi.fn();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "用这版" })[1]!);
    expect(onPick).toHaveBeenCalledWith(candidates[1]);
  });

  it("disables 用这版 while a pick is being applied", () => {
    render(<DraftCandidatesPanel candidates={candidates} busy onPick={vi.fn()} onClose={vi.fn()} />);
    for (const button of screen.getAllByRole("button", { name: "用这版" })) {
      expect(button).toBeDisabled();
    }
  });

  it("对话「另外几版」卡打开的：标「第 N 版」，不说「关掉就没了」（卡还在对话里）", () => {
    const versions: readonly DraftCandidate[] = [
      { body: "第一版正文。", version: 1, originTarget: { projectPath: "/book", chapter: 1, sessionId: "session", operationId: "op" } },
    ];
    render(<DraftCandidatesPanel candidates={versions} busy={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "另外几版" })).toBeDefined();
    expect(screen.getByText("第 1 版")).toBeDefined();
    expect(screen.queryByText(/关掉就没了/u)).toBeNull();
    cleanup();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("候选 1 ·「第一章 · 甲版」")).toBeDefined();
    expect(screen.getByText(/关掉就没了/u)).toBeDefined();
  });

  it("closes the panel (discarding candidates) on 关闭", () => {
    const onClose = vi.fn();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
  });
});
