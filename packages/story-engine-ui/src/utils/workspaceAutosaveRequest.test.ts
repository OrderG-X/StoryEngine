import { describe, expect, it } from "vitest";

import { buildWorkspaceAutosaveRequest } from "./workspaceAutosaveRequest.js";

const baseInput = {
  projectPath: "/books/demo",
  chapter: 3,
  selectedAdviceCardKeys: ["advice-1"],
  flowStatus: "draft_ready" as const,
  title: "第三章",
};

describe("buildWorkspaceAutosaveRequest", () => {
  it("omits every draft write field when the editor contains placeholder text", () => {
    const request = buildWorkspaceAutosaveRequest({
      ...baseInput,
      content: "还没有载入本章草稿正文……先完成章节规划。",
    });

    expect(request).toEqual({
      projectPath: "/books/demo",
      chapter: 3,
      selectedAdviceCardKeys: ["advice-1"],
      flowStatus: "draft_ready",
    });
    expect(request).not.toHaveProperty("draftContent");
    expect(request).not.toHaveProperty("draftTitle");
    expect(request).not.toHaveProperty("writeDraftFile");
  });

  it("keeps real draft content and enables the draft-file write", () => {
    const request = buildWorkspaceAutosaveRequest({
      ...baseInput,
      content: "雨水从屋檐垂落，林澈推开了仓库的门。",
    });

    expect(request).toMatchObject({
      draftContent: "雨水从屋檐垂落，林澈推开了仓库的门。",
      draftTitle: "第三章",
      writeDraftFile: true,
    });
  });

  it.each([
    { suppressed: true, committed: false, reason: "suppressed" },
    { suppressed: false, committed: true, reason: "committed" },
  ])("omits draft fields when a real draft is $reason", ({ suppressed, committed }) => {
    const request = buildWorkspaceAutosaveRequest({
      ...baseInput,
      content: "这是一段真实正文。",
      suppressed,
      committed,
    });

    expect(request).not.toHaveProperty("draftContent");
    expect(request).not.toHaveProperty("draftTitle");
    expect(request).not.toHaveProperty("writeDraftFile");
  });
});

describe("作者没改过就不写工作稿（2026-10-10 真机验收：自动保存把旧正文写回去，盖掉了对话 AI 刚改好的稿子）", () => {
  const base = { projectPath: "/book", chapter: 4, selectedAdviceCardKeys: [] as string[], flowStatus: "draft_ready" as const };
  it("正文和最近一次载入/写盘的一样 → 不带 writeDraftFile", () => {
    const request = buildWorkspaceAutosaveRequest({ ...base, content: "林秋，一九八七年春。", savedContent: "林秋，一九八七年春。" });
    expect(request.writeDraftFile).toBeUndefined();
    expect(request.draftContent).toBeUndefined();
  });
  it("作者改过 → 照写；没给 savedContent（老调用方）→ 照旧写", () => {
    expect(buildWorkspaceAutosaveRequest({ ...base, content: "林秋，一九八五年春。", savedContent: "林秋，一九八七年春。" }).writeDraftFile).toBe(true);
    expect(buildWorkspaceAutosaveRequest({ ...base, content: "林秋，一九八五年春。" }).writeDraftFile).toBe(true);
  });
});
