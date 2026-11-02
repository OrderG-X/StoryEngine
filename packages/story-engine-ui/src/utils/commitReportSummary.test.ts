import { describe, expect, it } from "vitest";
import { summarizeCommitReport } from "./commitReportSummary.js";

describe("summarizeCommitReport", () => {
  it("认章号、账记没记上、是不是补账", () => {
    expect(summarizeCommitReport({ chapter: 3, status: "ready" })).toEqual({ chapter: 3 });
    expect(summarizeCommitReport({ chapter: 3, status: "pending" })).toEqual({ chapter: 3, ledgerStatus: "pending" });
    expect(summarizeCommitReport({ chapter: 3, fill: true, status: "partial" })).toEqual({ chapter: 3, ledgerStatus: "partial", fill: true });
  });

  it("之前存下的回执（带条数）照样认出章号和状态", () => {
    expect(summarizeCommitReport({ chapter: 4, ledger: { facts: 2, status: "pending" } })).toEqual({ chapter: 4, ledgerStatus: "pending" });
  });

  it("脏输入不崩", () => {
    expect(summarizeCommitReport(null)).toEqual({});
    expect(summarizeCommitReport({ chapter: -1, status: "pending" })).toEqual({ ledgerStatus: "pending" });
  });
});
