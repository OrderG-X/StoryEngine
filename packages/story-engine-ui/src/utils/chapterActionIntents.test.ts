import { describe, expect, it } from "vitest";

import {
  DIRECT_WRITE_FALLBACK_GOAL,
  resolveDirectWriteChapterGoal,
  userActionChoiceText,
} from "./chapterActionIntents.js";

describe("resolveDirectWriteChapterGoal（写这一章按钮：没方向也直接写，不落方案整理失败）", () => {
  it("有显式方向 → 用方向（trim）", () => {
    expect(resolveDirectWriteChapterGoal("林澈夜探旧泵站")).toBe("林澈夜探旧泵站");
    expect(resolveDirectWriteChapterGoal("  林澈夜探  ")).toBe("林澈夜探");
  });

  it("方向为空/纯空白 → 用题材中立默认目标（按现有资料自然推进），绝不返回空", () => {
    expect(resolveDirectWriteChapterGoal("")).toBe(DIRECT_WRITE_FALLBACK_GOAL);
    expect(resolveDirectWriteChapterGoal("   ")).toBe(DIRECT_WRITE_FALLBACK_GOAL);
    expect(resolveDirectWriteChapterGoal(DIRECT_WRITE_FALLBACK_GOAL).length).toBeGreaterThan(0);
  });

  it("默认目标题材中立（不预设题材/世界观）", () => {
    expect(DIRECT_WRITE_FALLBACK_GOAL).not.toMatch(/悬疑|武侠|玄幻|科幻|爱情/u);
    expect(DIRECT_WRITE_FALLBACK_GOAL.trim().length).toBeGreaterThan(0);
  });
});

describe("userActionChoiceText（R4.7：结构化动作选项点击后的「你：…」回显文案）", () => {
  it("各动作给作者看得懂的一句话", () => {
    expect(userActionChoiceText({ toolName: "commit_preview", chapter: 5 })).toBe("预览第 5 章的定稿改动");
    expect(userActionChoiceText({ toolName: "generate_draft", chapter: 12, chapterGoal: "寄往上海的存根：1. …" }, "寄往上海的存根")).toBe("照「寄往上海的存根」写第 12 章的正文");
    expect(userActionChoiceText({ toolName: "generate_draft", chapter: 12 })).toBe("写第 12 章的正文");
    expect(userActionChoiceText({ toolName: "generate_draft", chapter: 12, continueDraft: true })).toBe("第 12 章接着往下写");
    // 定论（P12）：回显说清以哪边为准，原句照抄。
    expect(userActionChoiceText({ toolName: "settle_preview", chapter: 4, truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" } })).toBe("以第 1 章为准：「杜叔走了整整十年」");
    expect(userActionChoiceText({ toolName: "settle_preview", chapter: 4, truth: { where: "setting", quote: "三年前过世", label: "人物卡" } })).toBe("以设定为准：人物卡「三年前过世」");
    expect(userActionChoiceText({ toolName: "settle_preview", statement: "杜长顺十年前去世" })).toBe("按定论查前文：「杜长顺十年前去世」");
    expect(userActionChoiceText({ toolName: "settle_apply", token: "0123456789abcdef", excluded: [] })).toBe("确认定论，改齐前文");
    expect(userActionChoiceText({ toolName: "ai_review", chapter: 5 })).toBe("审阅第 5 章的内容");
    expect(userActionChoiceText({ toolName: "quality_check", chapter: 5 })).toBe("对第 5 章做硬伤检查");
    expect(userActionChoiceText({ toolName: "undo" })).toBe("撤销上一步");
    expect(userActionChoiceText({ toolName: "check_continuity", chapter: 5 })).toBe("核第 5 章的账");
    expect(userActionChoiceText({ toolName: "check_continuity", chapter: 5, fresh: true })).toBe("再核一遍第 5 章的账");
    expect(userActionChoiceText({ toolName: "generate_draft", chapter: 6 })).toBe("写第 6 章的正文");
    expect(userActionChoiceText({ toolName: "commit_apply", chapter: 5 })).toBe("确认定稿第 5 章");
    expect(userActionChoiceText({ toolName: "prune_snapshots" })).toBe("确认裁剪操作历史");
    expect(userActionChoiceText({ toolName: "prune_snapshots", keep: 50 })).toBe("确认裁剪操作历史（保留最近 50 条）");
  });
});
