import { describe, expect, it } from "vitest";
import { isChapterAgentCancel, isChapterAgentConfirm, isClearDraftRequest } from "./chatTextHelpers.js";

describe("isClearDraftRequest", () => {
  it("treats draft deletion phrasings as clear-draft requests", () => {
    for (const message of ["把当前文章删除", "这一章删掉吧", "本章清空", "给我删掉"]) {
      expect(isClearDraftRequest(message)).toBe(true);
    }
  });

  it("does not treat book/project deletion as a clear-draft request", () => {
    for (const message of ["删除这本书", "删除这个项目", "删除书籍"]) {
      expect(isClearDraftRequest(message)).toBe(false);
    }
  });

  it("does not treat foundation deletion as a clear-draft request", () => {
    for (const message of ["删除那个占位人物资料", "清空角色矩阵", "删掉这个设定"]) {
      expect(isClearDraftRequest(message)).toBe(false);
    }
  });

  it("ignores empty input", () => {
    expect(isClearDraftRequest("")).toBe(false);
    expect(isClearDraftRequest("   ")).toBe(false);
  });
});

describe("isChapterAgentConfirm", () => {
  it("accepts plain confirmation words", () => {
    for (const message of ["确认", "好的", "可以", "就这样", "开始吧"]) {
      expect(isChapterAgentConfirm(message)).toBe(true);
    }
  });

  it("accepts explicit workflow confirmation commands", () => {
    for (const message of ["生成本章方案", "开始写", "确认入库", "确认定稿", "生成工作稿", "质检工作稿", "生成定稿预览", "继续下一章"]) {
      expect(isChapterAgentConfirm(message)).toBe(true);
    }
  });

  it("rejects cancellation and unrelated chatter", () => {
    for (const message of ["取消", "再想想这一章怎么写", "", "  "]) {
      expect(isChapterAgentConfirm(message)).toBe(false);
    }
  });
});

describe("isChapterAgentCancel", () => {
  it("accepts cancellation words", () => {
    for (const message of ["取消", "算了", "先不要", "不要了", "先停", "重新说"]) {
      expect(isChapterAgentCancel(message)).toBe(true);
    }
  });

  it("rejects confirmation and unrelated input", () => {
    for (const message of ["确认", "好的", "开始写", "", "  "]) {
      expect(isChapterAgentCancel(message)).toBe(false);
    }
  });
});
