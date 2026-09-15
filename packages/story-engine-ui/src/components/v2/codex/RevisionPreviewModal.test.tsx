// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DraftRevisionTask } from "../../../api/types.js";
import { mockSidebarData, mockWorkspaceData } from "../../../mockData.js";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import RevisionPreviewModal from "./RevisionPreviewModal.js";

function makeTask(): DraftRevisionTask {
  return {
    id: "revision-task-1",
    chapter: 1,
    targetType: "paragraph",
    targetText: "林远站在落地窗前。",
    problemSummary: "语言略平",
    revisionGoal: "增强画面感。",
    constraints: [],
    status: "pending",
  };
}

function baseProps(overrides: Partial<WritingWorkspaceLayoutProps> = {}): WritingWorkspaceLayoutProps {
  return {
    workspace: mockWorkspaceData,
    sidebar: mockSidebarData,
    themeMode: "dark",
    steeringDirection: "",
    onSteeringDirectionChange: () => undefined,
    onGenerateSteering: () => undefined,
    activeRevisionTask: makeTask(),
    activeRevisionPreview: null,
    draftActionLoading: null,
    onGenerateRevisionPreview: vi.fn(),
    onDismissRevisionTask: vi.fn(),
    onApplyRevisionPreview: vi.fn(),
    ...overrides,
  } as WritingWorkspaceLayoutProps;
}

describe("RevisionPreviewModal 诚实第三态", () => {
  afterEach(() => {
    cleanup();
  });

  it("task 非空 + preview 空 + loading 空 → 显示「生成修订草案」而非假 loading", () => {
    render(<RevisionPreviewModal {...baseProps()} />);

    expect(screen.getByRole("button", { name: "生成修订草案" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放弃" })).toBeTruthy();
    expect(screen.queryByText("正在改写中…")).toBeNull();
    expect(screen.getByText(/修订草案尚未生成/)).toBeTruthy();
  });

  it("loading=revision-preview → 显示「正在改写中…」", () => {
    render(<RevisionPreviewModal {...baseProps({ draftActionLoading: "revision-preview" })} />);

    expect(screen.getByText("正在改写中…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "生成修订草案" })).toBeNull();
  });

  it("零差异：无「应用到工作稿」，主按钮是「保留原文并关闭」", () => {
    const text = "林远站在落地窗前。";
    render(
      <RevisionPreviewModal
        {...baseProps({
          activeRevisionPreview: {
            taskId: "revision-task-1",
            beforeText: text,
            afterText: text,
            changeSummary: "未作修改。该片段无需修订。",
            rationale: "",
            riskNotes: [],
            preservedFacts: [],
            warnings: [],
          },
        })}
      />,
    );
    expect(screen.getByText(/这段无需修改/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "保留原文并关闭" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换一种改法" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "应用到工作稿" })).toBeNull();
  });
});

  it("P1-1 回归：同一挂载实例上 task 从非空变空不崩（Rules of Hooks）", () => {
    // RevisionPreviewModal 由 WritingDeskCodex 无条件挂载，点「放弃/应用/切章」会让
    // activeRevisionTask 变空。Hook 若在条件 return 之后，这一变空会抛
    // "Rendered fewer hooks than expected" 把整个工作区崩到 ErrorBoundary 兜底页。
    const { rerender } = render(<RevisionPreviewModal {...baseProps()} />);
    expect(screen.getByRole("button", { name: "放弃" })).toBeTruthy();

    expect(() => {
      rerender(<RevisionPreviewModal {...baseProps({ activeRevisionTask: null })} />);
    }).not.toThrow();
    expect(screen.queryByRole("button", { name: "放弃" })).toBeNull();

    // 再变回非空也要正常（Hook 顺序在两次切换间必须稳定）
    expect(() => {
      rerender(<RevisionPreviewModal {...baseProps()} />);
    }).not.toThrow();
    expect(screen.getByRole("button", { name: "放弃" })).toBeTruthy();
  });
