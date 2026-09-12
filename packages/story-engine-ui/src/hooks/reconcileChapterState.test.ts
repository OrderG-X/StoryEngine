import { describe, expect, it } from "vitest";

import { flowStatusAfterGenerateFailure, shouldAdoptDiskDraftAfterStop, shouldReconcileToCommitted } from "./reconcileChapterState.js";

describe("flowStatusAfterGenerateFailure 出稿失败时复位卡死的「正在生成草稿」", () => {
  it("卡在 draft_generating + 已有草稿内容（流式落了一截/原有草稿）→ draft_ready，别再谎称正在生成", () => {
    expect(flowStatusAfterGenerateFailure("draft_generating", true)).toBe("draft_ready");
  });

  it("卡在 draft_generating + 一字未出 → idle，回到起点（不谎称有草稿）", () => {
    expect(flowStatusAfterGenerateFailure("draft_generating", false)).toBe("idle");
  });

  it("不在 draft_generating（失败发生在别的流程态）→ 返回 null、绝不乱改", () => {
    expect(flowStatusAfterGenerateFailure("draft_ready", true)).toBeNull();
    expect(flowStatusAfterGenerateFailure("committed", false)).toBeNull();
    expect(flowStatusAfterGenerateFailure("idle", false)).toBeNull();
    expect(flowStatusAfterGenerateFailure("quality_checked", true)).toBeNull();
  });
});

describe("shouldReconcileToCommitted R2 磁盘对账判定", () => {
  it("磁盘已入库 + UI 还在草稿态（断流显失败）→ 该更正为已入库", () => {
    expect(shouldReconcileToCommitted({ hasCommittedChapter: true }, "draft_ready")).toBe(true);
    expect(shouldReconcileToCommitted({ hasCommittedChapter: true }, "idle")).toBe(true);
    expect(shouldReconcileToCommitted({ hasCommittedChapter: true }, "commit_preview_ready")).toBe(true);
  });

  it("磁盘已入库 + UI 已是入库态 → 无需更正（不重复打扰）", () => {
    expect(shouldReconcileToCommitted({ hasCommittedChapter: true }, "committed")).toBe(false);
    expect(shouldReconcileToCommitted({ hasCommittedChapter: true }, "ready_for_next")).toBe(false);
  });

  it("磁盘未入库 → 不更正（真失败就如实显失败，不乱改）", () => {
    expect(shouldReconcileToCommitted({ hasCommittedChapter: false }, "draft_ready")).toBe(false);
    expect(shouldReconcileToCommitted({}, "draft_ready")).toBe(false);
  });
});

describe("shouldAdoptDiskDraftAfterStop 停止后磁盘对账判定（A-5）", () => {
  it("盘上草稿比停止时编辑器里的长（服务端在停止前已写完整稿）→ 采用盘稿", () => {
    expect(shouldAdoptDiskDraftAfterStop({ draftContent: "完整的一章正文，停止前服务端已写完全部内容。" }, "半截流")).toBe(true);
  });

  it("编辑器是空的、盘上有旧稿 → 采用盘稿（按盘上草稿复位，别谎称一字没有）", () => {
    expect(shouldAdoptDiskDraftAfterStop({ draftContent: "上一版工作稿正文。" }, "")).toBe(true);
    expect(shouldAdoptDiskDraftAfterStop({ draftContent: "上一版工作稿正文。" }, "   ")).toBe(true);
  });

  it("盘上更短或与编辑器等长 → 保留编辑器里已流出的内容（已写出的内容保留）", () => {
    expect(shouldAdoptDiskDraftAfterStop({ draftContent: "短" }, "编辑器里已经流出了更长的一截正文")).toBe(false);
    const same = "一模一样的内容";
    expect(shouldAdoptDiskDraftAfterStop({ draftContent: same }, same)).toBe(false);
  });

  it("盘上没有草稿内容 → 不采用（别用空盘盖掉编辑器）", () => {
    expect(shouldAdoptDiskDraftAfterStop({}, "已流出的半截正文")).toBe(false);
    expect(shouldAdoptDiskDraftAfterStop({ draftContent: "   " }, "已流出的半截正文")).toBe(false);
  });
});
