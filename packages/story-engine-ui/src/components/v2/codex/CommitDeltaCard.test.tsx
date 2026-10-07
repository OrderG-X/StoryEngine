// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("用 StepCard 外壳、标题「入库」、徽章「已入库」", () => {
    const { container, getByText } = render(<CommitDeltaCard report={report} />);
    expect(container.querySelector(".step-card.sc-done")).toBeTruthy();
    expect(getByText("定稿")).toBeTruthy();
    expect(getByText("已定稿")).toBeTruthy();
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
  it("文件路径换章号、去掉没变化的行与 0 条的提醒分项", async () => {
    const { displayDeltaLines } = await import("./CommitDeltaCard.js");
    expect(displayDeltaLines([
      "正式章节：已写入 chapters/0058.md",
      "角色状态：1 项",
      "时间线事件：1 条",
      "伏笔更新：0 项",
      "线索线程：15 项",
      "主线目标：0 项，完成 0 项",
      "世界状态：已更新",
      "故事日历：无变更",
      "过期提醒：伏笔 0 条，线索 7 条，主线目标 1 条",
    ])).toEqual([
      "正文：已写入第 58 章",
      "角色状态：1 项",
      "时间线事件：1 条",
      "线索线程：15 项",
      "世界状态：已更新",
      "过期提醒：线索 7 条，主线目标 1 条",
    ]);
    expect(displayDeltaLines(["正式章节：已写入 chapters"])).toEqual(["正文：已写入"]);
  });
});
