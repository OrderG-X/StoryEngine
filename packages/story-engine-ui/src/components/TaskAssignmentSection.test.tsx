// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskAssignmentSection } from "./TaskAssignmentSection.js";
import { TASK_LABELS } from "./ModelSettingsDialogTypes.js";

describe("TaskAssignmentSection 6 行两旋钮", () => {
  afterEach(cleanup); // 每个用例后卸载，避免多次 render 在 document.body 里堆叠出陈旧节点
  it("TASK_LABELS 含 triage、不含 futureReview 和已删的 enrichment，共 6 个", () => {
    const keys = Object.keys(TASK_LABELS);
    expect(keys).toContain("triage");
    expect(keys).not.toContain("enrichment");
    expect(keys).not.toContain("futureReview");
    expect(keys).toHaveLength(6);
  });

  it("内容审阅任务说明", () => {
    render(
      <TaskAssignmentSection
        tasks={{}}
        thinking={{}}
        savedProviders={[]}
        onEditTask={() => {}}
        onToggleThinking={() => {}}
      />,
    );
    expect(screen.getByText("内容审阅")).toBeTruthy();
    expect(screen.getByText(/通读整章/u)).toBeTruthy();
  });

  it("每个任务渲染一个思考开关（checkbox），共 6 个", () => {
    render(
      <TaskAssignmentSection
        tasks={{}}
        thinking={{}}
        savedProviders={[]}
        onEditTask={() => {}}
        onToggleThinking={() => {}}
      />,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
  });

  it("点击思考开关回调 onToggleThinking", () => {
    const onToggle = vi.fn();
    render(
      <TaskAssignmentSection
        tasks={{}}
        thinking={{ fastDraft: false }}
        savedProviders={[]}
        onEditTask={() => {}}
        onToggleThinking={onToggle}
      />,
    );
    const first = screen.getAllByRole("checkbox")[0];
    if (first) fireEvent.click(first); // React 把 checkbox 的 onChange 映射到 click 事件
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("没单独选模型的任务如实说用默认模型", () => {
    render(
      <TaskAssignmentSection
        tasks={{ fastDraft: "deepseek|deepseek-v4-flash" }}
        thinking={{}}
        savedProviders={[{ id: "deepseek", label: "DeepSeek", baseUrl: "https://example.test", apiKeyEnv: "DEEPSEEK_API_KEY", apiKeyStatus: "present" }]}
        onEditTask={() => {}}
        onToggleThinking={() => {}}
      />,
    );

    expect(screen.getByText("deepseek-v4-flash")).toBeTruthy();
    expect(screen.getAllByText("没单独选，用默认模型").length).toBe(5);
  });
});
