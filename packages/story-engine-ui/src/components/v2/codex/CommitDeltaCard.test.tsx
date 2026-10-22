// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitDeltaCard } from "./CommitDeltaCard.js";

const report = {
  updatedCharacters: ["c1", "c2"],
  timelineEventIds: ["e1", "e2", "e3"],
  updatedHooks: ["h1"],
  updatedWorld: true,
  updatedCalendar: false,
  threadTracking: { touchedThreads: ["t1", "t2"] },
  arcGoalTracking: { touchedGoals: ["g1"], completedGoals: [] },
};

describe("CommitDeltaCard 入库 delta 卡", () => {
  it("用 StepCard 外壳、标题「第 N 章记下的账」（老回执没章号就「记下的账」）、徽章「已定稿」", () => {
    const { container, getByText } = render(<CommitDeltaCard report={report} />);
    expect(container.querySelector(".step-card.sc-done")).toBeTruthy();
    expect(getByText("记下的账")).toBeTruthy();
    expect(getByText("已定稿")).toBeTruthy();
    cleanup();
    render(<CommitDeltaCard report={{ chapter: 4, ledger: { facts: 2 } }} />);
    expect(getByText("第 4 章记下的账")).toBeTruthy();
  });

  it("渲染状态行 + 分项（角色/时间线/主线目标）", () => {
    const { container } = render(<CommitDeltaCard report={report} />);
    const text = container.textContent ?? "";
    expect(text).toContain("角色");
    expect(text).toContain("2");
    expect(text).toContain("时间线");
    expect(text).toContain("3");
    expect(text).toContain("主线目标");
  });

  it("脏/空 report 不崩（summarizeCommitReport 全程防御）", () => {
    const { container } = render(<CommitDeltaCard report={undefined} />);
    expect(container.querySelector(".step-card")).toBeTruthy();
  });
});

describe("displayDeltaLines：定稿明细说人话", () => {
  it("去掉没变化的行与 0 条的提醒分项", async () => {
    const { displayDeltaLines } = await import("./CommitDeltaCard.js");
    expect(displayDeltaLines([
      "角色状态：1 项",
      "时间线事件：1 条",
      "伏笔更新：0 项",
      "线索线程：15 项",
      "主线目标：0 项，完成 0 项",
      "世界状态：已更新",
      "故事日历：无变更",
      "过期提醒：伏笔 0 条，线索 7 条，主线目标 1 条",
    ])).toEqual([
      "角色状态：1 项",
      "时间线事件：1 条",
      "线索线程：15 项",
      "世界状态：已更新",
      "过期提醒：线索 7 条，主线目标 1 条",
    ]);
  });
});

describe("CommitDeltaCard 撤销这次定稿", () => {
  afterEach(() => cleanup());

  it("先确认再撤；点「算了」不撤；没有撤销能力就不出按钮", () => {
    const onUndo = vi.fn();
    const { getByText, queryByText } = render(<CommitDeltaCard report={report} onUndo={onUndo} />);
    fireEvent.click(getByText("撤销这次定稿"));
    expect(onUndo).not.toHaveBeenCalled();
    fireEvent.click(getByText("算了"));
    expect(queryByText("撤销定稿")).toBeNull();
    fireEvent.click(getByText("撤销这次定稿"));
    fireEvent.click(getByText("撤销定稿"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("不传 onUndo 时不渲染撤销按钮", () => {
    const { queryByText } = render(<CommitDeltaCard report={report} />);
    expect(queryByText("撤销这次定稿")).toBeNull();
  });
});
