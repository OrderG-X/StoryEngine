import { describe, expect, it } from "vitest";

import {
  COMMIT_PREVIEW_BUTTON_INTENT,
  DIRECT_WRITE_FALLBACK_GOAL,
  DRAFT_BUTTON_INTENT,
  LEGACY_COMMIT_PREVIEW_BUTTON_INTENT,
  LEGACY_QUALITY_BUTTON_INTENT,
  LEGACY_REVIEW_BUTTON_INTENT,
  QUALITY_BUTTON_INTENT,
  REVIEW_BUTTON_INTENT,
  matchDeterministicChapterAction,
  resolveDirectWriteChapterGoal,
  userActionChoiceText,
} from "./chapterActionIntents.js";

describe("核账 / 再细核一遍走确定性动作", () => {
  it("按钮意图和两个字的短说法都认", () => {
    expect(matchDeterministicChapterAction("核账")).toBe("check_continuity");
    expect(matchDeterministicChapterAction("再细核一遍：这一章重新对一遍前文")).toBe("check_continuity_fresh");
    expect(matchDeterministicChapterAction(" 再细核一遍 ")).toBe("check_continuity_fresh");
    expect(matchDeterministicChapterAction("再细核一遍第三章吧")).toBeNull();
  });
});

describe("matchDeterministicChapterAction（固定动作按钮确定性）", () => {
  it("审稿/质检/写这一章 按钮精确意图 → 对应确定性动作", () => {
    expect(matchDeterministicChapterAction(REVIEW_BUTTON_INTENT)).toBe("ai_review");
    expect(matchDeterministicChapterAction(QUALITY_BUTTON_INTENT)).toBe("quality_check");
    expect(matchDeterministicChapterAction(DRAFT_BUTTON_INTENT)).toBe("generate_draft");
  });

  it("定稿预览按钮走结构化动作直达（2026-10-10 起；服务端跑同一个 commit_preview 工具，票据照登记）", () => {
    expect(matchDeterministicChapterAction(COMMIT_PREVIEW_BUTTON_INTENT)).toBe("commit_preview");
    expect(matchDeterministicChapterAction("生成定稿预览")).toBe("commit_preview");
    expect(matchDeterministicChapterAction("预览第 8 章的定稿改动")).toBe("commit_preview");
    expect(matchDeterministicChapterAction("生成第 3 章定稿预览")).toBe("commit_preview");
    expect(matchDeterministicChapterAction("先别定稿，我再看看")).toBeNull();
  });

  it("迁移期仍识别旧审稿/质检/入库预览按钮", () => {
    expect(matchDeterministicChapterAction(LEGACY_REVIEW_BUTTON_INTENT)).toBe("ai_review");
    expect(matchDeterministicChapterAction(LEGACY_QUALITY_BUTTON_INTENT)).toBe("quality_check");
    expect(matchDeterministicChapterAction(LEGACY_COMMIT_PREVIEW_BUTTON_INTENT)).toBe("commit_preview");
  });

  it("前后空白容错（按钮发文仍命中）", () => {
    expect(matchDeterministicChapterAction(`  ${REVIEW_BUTTON_INTENT}  `)).toBe("ai_review");
  });

  it("用户自由打字/其它意图 → null（仍走 agent 对话链路）", () => {
    expect(matchDeterministicChapterAction("审一下这章，但先别给评分")).toBeNull();
    expect(matchDeterministicChapterAction("写第二章")).toBeNull();
    expect(matchDeterministicChapterAction("")).toBeNull();
  });
});

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
  it("各动作给作者看得懂的一句话；定稿预览那句是确定性意图认识的形状", () => {
    expect(userActionChoiceText({ toolName: "commit_preview", chapter: 5 })).toBe("预览第 5 章的定稿改动");
    expect(matchDeterministicChapterAction(userActionChoiceText({ toolName: "commit_preview", chapter: 5 }))).toBe("commit_preview");
    expect(userActionChoiceText({ toolName: "check_continuity", chapter: 5 })).toBe("重新核第 5 章的账");
    expect(userActionChoiceText({ toolName: "check_continuity", chapter: 5, fresh: true })).toBe("再细核一遍：重新核第 5 章的账");
    expect(userActionChoiceText({ toolName: "generate_draft", chapter: 6 })).toBe("写第 6 章的正文");
    expect(userActionChoiceText({ toolName: "commit_apply", chapter: 5 })).toBe("确认定稿第 5 章");
    expect(userActionChoiceText({ toolName: "prune_snapshots" })).toBe("确认裁剪操作历史");
    expect(userActionChoiceText({ toolName: "prune_snapshots", keep: 50 })).toBe("确认裁剪操作历史（保留最近 50 条）");
  });
});
