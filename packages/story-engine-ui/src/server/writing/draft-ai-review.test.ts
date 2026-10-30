// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDraftAIReviewPrompt,
  fallbackDraftAIReviewReport,
  parseDraftAIReviewReport,
} from "./draft-ai-review.js";
import { applyCardOps, bibleView, emptySettingCards, project } from "@actalk/story-core";
import type { StateOverview } from "../book/state-overview.js";
import { buildSettingPack } from "./setting-pack.js";
import type { WritingContextPack } from "./writing-context-pack.js";

describe("Draft AI Review V0", () => {
  it("builds a prompt with draft content, writing rules, boundaries, and no-rewrite constraints", () => {
    const prompt = buildDraftAIReviewPrompt({
      chapter: 1,
      draftContent: "# 第1章 · 半张申请表\n\n林序站在海天市旧城区创业孵化楼二楼申请窗口前。",
      chapterGoal: "毕业失败当天，林序第一次接触魂钢异常反应。",
      writingContextPack: contextPackFixture(),
      stateOverview: { project: { title: "海天魂钢", genre: "都市英灵", logline: "", currentChapter: 1 }, storyStatus: {} } as unknown as StateOverview,
      deterministicQuality: {
        passed: true,
        issues: [{ severity: "warning", type: "missing_chapter_title", message: "Draft does not contain an obvious chapter title." }],
      },
    });

    expect(prompt).toContain("你是 StoryEngine-NG 的“审稿老师”");
    expect(prompt).toContain("不改正文，不输出重写全文");
    expect(prompt).toContain("不泄露设定里写着还没揭开、不能说破的内容");
    expect(prompt).toContain("不建议让人物知道他此刻不该知道的事");
    expect(prompt).toContain("设定（设定卡 + 账里记的现状）：");
    expect(prompt).toContain("- 文风：克制、紧张、少解释");
    expect(prompt).toContain("【海天市旧城区创业孵化楼】");
    expect(prompt).toContain("【欠费手机】\n- 现状：欠费三天，不能正常联网");
    expect(prompt).toContain("- 还没揭开：魂钢真实来源");
    expect(prompt).toContain("不要提前揭开隐藏真相"); // 硬约束进上下文摘要
    expect(prompt).toContain("申请记录异常"); // 接着写要扛住的线进上下文摘要
    expect(prompt).toContain("\"title\": \"海天魂钢\"");
    expect(prompt).toContain("missing_chapter_title"); // 自动检查结果交给审稿老师（给作者看的字由第 8 条规矩管）
    expect(prompt).toContain("林序站在海天市旧城区创业孵化楼二楼申请窗口前");
  });

  // E3（B）：审稿要能看出人物卡内部同属性互斥（如「二十六七岁」vs「三十出头」）——本章相关人物的卡整张进审稿上下文，
  // 再配一条「同一属性互斥」审查指令。重构 P9 起人物来自设定包（主角 + 本章相关人物），不再读状态总览里的人物矩阵。
  it("feeds the cast's setting cards (incl. non-protagonist) so the reviewer can flag same-attribute contradictions", () => {
    const prompt = buildDraftAIReviewPrompt({
      chapter: 2,
      draftContent: "# 第2章\n\n林序在雾港码头见到了陈雨薇。",
      writingContextPack: contextPackFixture(["陈雨薇"]),
    });
    expect(prompt).toContain("【陈雨薇】");
    expect(prompt).toContain("- 年龄：二十六七岁");
    expect(prompt).toContain("- 外貌：三十出头，穿着米色风衣");
    expect(prompt).toContain("同一属性");
  });

  it("没有上下文包：不出设定段", () => {
    const prompt = buildDraftAIReviewPrompt({ chapter: 1, draftContent: "# 第1章\n\n正文。" });
    expect(prompt).not.toContain("设定（设定卡 + 账里记的现状）：");
    expect(prompt).toContain("当前草稿正文：");
  });

  it("parses valid JSON reports", () => {
    const report = parseDraftAIReviewReport(JSON.stringify({
      passed: true,
      score: 82,
      verdict: "needs_minor_revision",
      summary: "整体可用，但结尾追读点偏弱。",
      strengths: ["开场地点明确"],
      issues: [{
        id: "issue-1",
        severity: "warning",
        category: "reader_hook",
        title: "结尾追读点偏弱",
        description: "最后一段没有形成新的疑问。",
        evidence: "他离开了窗口。",
        suggestedFix: "结尾让申请表再次发热。",
      }],
      suggestedRevisions: [{
        id: "rev-1",
        target: "结尾",
        suggestion: "增加申请表发热的细节。",
        reason: "形成下一章牵引。",
        priority: "medium",
      }],
      continuityNotes: [],
      styleNotes: [],
      characterNotes: [],
      pacingNotes: [],
      readerHookNotes: ["追读点可加强"],
      shouldCommit: true,
      blockingReasons: [],
    }));

    expect(report.verdict).toBe("needs_minor_revision");
    expect(report.score).toBe(82);
    expect(report.issues[0]).toMatchObject({ category: "reader_hook", severity: "warning" });
  });

  it("throws on invalid JSON so callers can fallback safely", () => {
    expect(() => parseDraftAIReviewReport("这章还行，但我不输出 JSON。")).toThrow(/JSON/u);
    const fallback = fallbackDraftAIReviewReport("bad output");
    expect(fallback).toMatchObject({
      passed: false,
      verdict: "blocked",
      shouldCommit: false,
    });
    expect(fallback.issues[0]?.id).toBe("ai-review-format-error");
  });
});

function contextPackFixture(cast: readonly string[] = []): WritingContextPack {
  const applied = applyCardOps(emptySettingCards(), [
    { op: "story.set", label: "还没揭开", value: "魂钢真实来源" },
    { op: "card.create", kind: "character", name: "林序", protagonist: true, fields: [{ label: "身份", value: "普通毕业生" }] },
    {
      op: "card.create",
      kind: "character",
      name: "陈雨薇",
      fields: [{ label: "年龄", value: "二十六七岁" }, { label: "外貌", value: "三十出头，穿着米色风衣" }],
    },
    { op: "card.create", kind: "place", name: "海天市旧城区创业孵化楼", fields: [{ label: "格局", value: "只有三层楼" }] },
    { op: "card.create", kind: "item", name: "欠费手机", fields: [{ label: "现状", value: "欠费三天，不能正常联网" }] },
    { op: "rules.add", list: "style", text: "克制、紧张、少解释" },
    { op: "rules.add", list: "bans", text: "不要提前解释魂钢来源" },
  ], { by: "author", at: "2026-10-19T00:00:00.000Z" });
  if (!applied.ok) throw new Error(applied.message);
  return {
    chapterTask: {
      chapterNumber: 1,
      userDirection: "毕业失败当天，林序第一次接触魂钢异常反应。",
      currentChapterGoal: "让林序接触异常申请表，但不揭开魂钢来源。",
    },
    setting: buildSettingPack(bibleView(project({ ledgers: [], decisions: [] }), applied.file), { characters: cast }),
    continuityFocus: {
      recentTimelineEvents: ["林序毕业失败"],
      mustCarryThreads: ["申请记录异常"],
      arcGoalFocus: ["突破魂钢阶层门槛"],
      establishedFacts: [],
    },
    hardConstraints: ["不要提前揭开隐藏真相"],
    readFailures: [],
  };
}
