import { describe, expect, it } from "vitest";
import { summarizeCommitReport } from "./commitReportSummary.js";

describe("summarizeCommitReport", () => {
  it("summarizes formal state sync counts from commit report", () => {
    const summary = summarizeCommitReport({
      chapterPath: "/tmp/story/chapters/chapter-0001.md",
      updatedCharacters: ["guo-xu"],
      timelineEventIds: ["evt-1", "evt-2"],
      updatedHooks: ["hook-1"],
      updatedWorld: true,
      updatedCalendar: false,
      threadTracking: {
        touchedThreads: ["thread-1", "thread-2"],
        staleThreadWarnings: [{}],
      },
      arcGoalTracking: {
        touchedGoals: ["goal-1"],
        completedGoals: ["goal-1"],
        staleGoalWarnings: [],
      },
    });

    expect(summary.chapter).toBeUndefined();
    expect(summary.detailLines).toEqual([
      "角色状态：1 项",
      "时间线事件：2 条",
      "伏笔更新：1 项",
      "线索线程：2 项",
      "主线目标：1 项，完成 1 项",
      "世界状态：已更新",
      "故事日历：无变更",
      "过期提醒：伏笔 0 条，线索 1 条，主线目标 0 条",
    ]);
  });

  it("handles missing or malformed reports without throwing", () => {
    const summary = summarizeCommitReport(null);

    expect(summary.detailLines).toContain("角色状态：0 项");
    expect(summary.detailLines).toContain("世界状态：无变更");
  });

  it("新定稿回执（report.ledger）：报这一章记了多少条账", () => {
    const summary = summarizeCommitReport({
      chapter: 2,
      chapterPath: "chapters/0002.md",
      ledger: { facts: 4, threadsOpened: 1, threadsAdvanced: 2, threadsClosed: 1, present: 3, day: 2, dayEnd: 3, notRecorded: 1 },
    });
    expect(summary.chapter).toBe(2);
    expect(summary.detailLines).toEqual([
      "故事时间：第 2～3 天",
      "事实：4 条",
      "线索：新开 1，推进 2，收口 1",
      "出场人物：3 人",
      "没记上：1 条",
    ]);
  });

  it("账待记：不列一排零，只说还没记上；没记全的照列条数再标一行；补账的回执带着标记", () => {
    const pending = summarizeCommitReport({ chapter: 3, ledger: { facts: 0, threadsOpened: 0, threadsAdvanced: 0, threadsClosed: 0, present: 0, notRecorded: 0, status: "pending" } });
    expect(pending).toEqual({ chapter: 3, detailLines: ["账：还没记上"], ledgerStatus: "pending" });
    const partial = summarizeCommitReport({ chapter: 3, fill: true, ledger: { facts: 2, threadsOpened: 0, threadsAdvanced: 0, threadsClosed: 0, present: 1, day: 4, dayEnd: 4, notRecorded: 0, status: "partial" } });
    expect(partial).toMatchObject({ chapter: 3, ledgerStatus: "partial", fill: true });
    expect(partial.detailLines.at(-1)).toBe("账：没记全");
    expect(summarizeCommitReport({ chapter: 3, ledger: { facts: 1, status: "ready" } }).ledgerStatus).toBeUndefined();
  });
});
