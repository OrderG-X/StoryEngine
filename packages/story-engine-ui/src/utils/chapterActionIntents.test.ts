import { describe, expect, it } from "vitest";
import { newCanonPick, newCanonStatement, newCommitAction, newDraftAction, newEditAction, newInspectAction, newUndoAction } from "../api/agentChatClient.js";

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
    expect(userActionChoiceText(newCommitAction(5))).toBe("定稿第 5 章");
    expect(userActionChoiceText(newCommitAction(5, { allowShort: true }))).toBe("第 5 章就这么短，照样定稿");
    expect(userActionChoiceText({ kind: "new", type: "settings.change", params: { accept: "op-0123456789abcdef0123" }, requestKey: "k", issuedAt: "2026-10-30T00:00:00.000Z" })).toBe("认下 AI 刚写的设定");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm-settings", decision: "apply" } })).toBe("确认改设定");
    expect(userActionChoiceText(newDraftAction("write", { chapter: 12, direction: "寄往上海的存根：1. …" }), "寄往上海的存根")).toBe("照「寄往上海的存根」写第 12 章的正文");
    expect(userActionChoiceText(newDraftAction("write", { chapter: 12 }))).toBe("写第 12 章的正文");
    expect(userActionChoiceText(newDraftAction("continue", { chapter: 12 }))).toBe("第 12 章接着往下写");
    expect(userActionChoiceText(newDraftAction("write", { chapter: 12, rewrite: true }))).toBe("重写第 12 章");
    // 定论（P12）：回显说清以哪边为准，原句照抄。
    expect(userActionChoiceText(newCanonPick({ chapter: 4, truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" } }))).toBe("以第 1 章为准：「杜叔走了整整十年」");
    expect(userActionChoiceText(newCanonPick({ chapter: 4, truth: { where: "setting", quote: "三年前过世", label: "人物卡" } }))).toBe("以设定为准：人物卡「三年前过世」");
    expect(userActionChoiceText(newCanonStatement({ statement: "杜长顺十年前去世" }))).toBe("按定论查前文：「杜长顺十年前去世」");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm-canon", decision: "apply", excluded: ["e1"] } })).toBe("确认定论，改齐前文");
    // 检查交给执行器（写作版本 P2a）：新的一次按种类说，停着的「接着做 / 不要了」。
    expect(userActionChoiceText(newInspectAction("review", 5))).toBe("审阅第 5 章的内容");
    expect(userActionChoiceText(newInspectAction("quality", 5))).toBe("对第 5 章做硬伤检查");
    expect(userActionChoiceText(newInspectAction("flavor", 5))).toBe("查第 5 章的 AI 味");
    expect(userActionChoiceText(newUndoAction())).toBe("撤销上一步");
    expect(userActionChoiceText(newUndoAction("op-0123456789abcdef0123"))).toBe("撤回来");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm-undo-2", decision: "apply" } })).toBe("全撤");
    expect(userActionChoiceText(newInspectAction("continuity", 5))).toBe("核第 5 章的账");
    expect(userActionChoiceText(newInspectAction("continuity", 5, { fresh: true }))).toBe("再核一遍第 5 章的账");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123" })).toBe("接着做");
    expect(userActionChoiceText({ kind: "cancel", opId: "op-0123456789abcdef0123" })).toBe("不要了");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm-commit", decision: "commit", values: { day: 3 } } })).toBe("确认定稿");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm-prune", decision: "apply" } })).toBe("确认裁剪");
    // 改稿（片 2C）：按核账改、去 AI 味、改写；引的原文太长截短。改写停着等作者点的说点的哪个。
    expect(userActionChoiceText(newEditAction({ mode: "fix", chapter: 5, fixes: [{ targetText: "他把钥匙放回柜台。", revisionGoal: "对上前文" }] }))).toBe("改第 5 章这一处：「他把钥匙放回柜台。」");
    expect(userActionChoiceText(newEditAction({ mode: "fix", chapter: 5, fixes: [{ targetText: "a", revisionGoal: "b" }, { targetText: "c", revisionGoal: "d" }] }))).toBe("改掉第 5 章这 2 处");
    expect(userActionChoiceText(newEditAction({ mode: "deai", chapter: 5, violations: [{ id: "v1", text: "那一刻，他\n明白了。" }] }))).toBe("改掉第 5 章这句的机器腔：「那一刻，他 明白了。」");
    expect(userActionChoiceText(newEditAction({ mode: "deai", chapter: 5, violations: [{ id: "v1", text: "a" }, { id: "v2", text: "b" }, { id: "v3", text: "c" }] }))).toBe("改掉第 5 章这 3 句的机器腔");
    expect(userActionChoiceText(newEditAction({ mode: "revise", chapter: 5, edits: [{ targetText: "长".repeat(50), revisionGoal: "润色" }], preview: true }))).toBe(`改写第 5 章这段：「${"长".repeat(40)}…」`);
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm:1", decision: "apply" } })).toBe("换上");
    expect(userActionChoiceText({ kind: "resume", opId: "op-0123456789abcdef0123", answer: { actionId: "confirm:1", decision: "again" } })).toBe("再改一版");
  });
});
