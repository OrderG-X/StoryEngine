import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DraftCandidatesPanel from "./DraftCandidatesPanel.js";
import type { DraftCandidate } from "../../stores/uiStore.js";

afterEach(() => cleanup());

const candidates: readonly DraftCandidate[] = [
  { content: "# 第一章 · 甲版\n\n甲版正文。", title: "第一章 · 甲版", originTarget: { projectPath: "/book", chapter: 1, sessionId: "session", operationId: "op" } },
  { content: "# 第一章 · 乙版\n\n乙版正文，长一些。", title: "第一章 · 乙版", originTarget: { projectPath: "/book", chapter: 1, sessionId: "session", operationId: "op" } },
];

describe("DraftCandidatesPanel", () => {
  it("renders each candidate side-by-side with its body (title stripped) and a 用这版 button", () => {
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("甲版正文。")).toBeDefined();
    expect(screen.getByText("乙版正文，长一些。")).toBeDefined();
    // 标题行不在正文展示里
    expect(screen.queryByText("# 第一章 · 甲版")).toBeNull();
    expect(screen.getAllByRole("button", { name: "用这版" }).length).toBe(2);
  });

  it("picks the chosen candidate's full content (with title) on click", () => {
    const onPick = vi.fn();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "用这版" })[1]!);
    expect(onPick).toHaveBeenCalledWith("# 第一章 · 乙版\n\n乙版正文，长一些。");
  });

  it("disables 用这版 while a pick is being applied", () => {
    render(<DraftCandidatesPanel candidates={candidates} busy onPick={vi.fn()} onClose={vi.fn()} />);
    for (const button of screen.getAllByRole("button", { name: "用这版" })) {
      expect(button).toBeDisabled();
    }
  });

  it("closes the panel (discarding candidates) on 关闭", () => {
    const onClose = vi.fn();
    render(<DraftCandidatesPanel candidates={candidates} busy={false} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
  });
});
