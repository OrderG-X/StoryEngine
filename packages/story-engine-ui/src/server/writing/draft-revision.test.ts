// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyDraftRevisionToContent, buildDraftRevisionPrompt, createRevisionTaskFromIssue, createRevisionTaskFromSuggestion, fallbackDraftRevisionPreview, normalizeDraftRevisionPreview, parseDraftRevisionPreview } from "./draft-revision.js";
import type { DraftAIReviewIssue, DraftAIRevisionSuggestion } from "./draft-ai-review.js";
import { applyCardOps, bibleView, emptySettingCards, project } from "@actalk/story-core";
import { buildSettingPack } from "./setting-pack.js";
import type { WritingContextPack } from "./writing-context-pack.js";

const draft = [
  "# 第1章 · 半张申请表",
  "",
  "林序站在2楼申请窗口前，右手捏着半张魂钢申请表。",
  "",
  "窗口里的工作人员抬起头，语气很硬：“你站这儿干什么？”",
  "",
  "纸张开始发热，但他没有声张。",
].join("\n");

const issue: DraftAIReviewIssue = {
  id: "issue-ending",
  severity: "warning",
  category: "reader_hook",
  title: "结尾追读点不足",
  description: "结尾缺少钩子。",
  evidence: "纸张开始发热，但他没有声张。",
  suggestedFix: "补强主角反应和下一步悬念。",
  affectedParagraphHint: "结尾段",
};

const suggestion: DraftAIRevisionSuggestion = {
  id: "suggestion-opening",
  target: "开头",
  suggestion: "减少设定解释，先写窗口现场和申请表发热。",
  reason: "开头解释偏多，场景抓力不足。",
  priority: "high",
};

describe("draft revision", () => {
  it("builds a scoped revision prompt with safety boundaries and the setting pack rendered as text", () => {
    const task = createRevisionTaskFromIssue({
      chapter: 1,
      issue,
      draftContent: draft,
      constraints: ["不要提前揭开魂钢真实来源"],
    });
    const prompt = buildDraftRevisionPrompt({ task, draftContent: draft, writingContextPack: packFixture() });

    expect(prompt).toContain("只修指定片段，不重写全文");
    expect(prompt).toContain("不提前揭开设定里写着还没揭开、不能说破的内容");
    expect(prompt).toContain("不要以信息不足为理由保持原样");
    expect(prompt).toContain("afterText 是小说正文，不许写章号");
    expect(prompt).toContain("设定（设定卡 + 账里记的现状）：");
    expect(prompt).toContain("【海天市旧城区创业孵化楼】");
    expect(prompt).toContain("- 规矩：不能凭空变成完整申请表");
    expect(prompt).toContain("- 还没揭开：魂钢真实来源");
    expect(prompt).toContain("- 一定不要写：不要设定说明书");
    expect(prompt).toContain("不要提前揭开隐藏真相"); // 硬约束进上下文摘要
    expect(prompt).toContain("不要提前揭开魂钢真实来源"); // 任务约束
    expect(prompt).toContain(issue.evidence);
  });

  it("没有上下文包：不出设定段，其余照常", () => {
    const task = createRevisionTaskFromIssue({ chapter: 1, issue, draftContent: draft });
    const prompt = buildDraftRevisionPrompt({ task, draftContent: draft });
    expect(prompt).not.toContain("设定（设定卡 + 账里记的现状）：");
    expect(prompt).toContain("只修指定片段，不重写全文");
    expect(prompt).toContain(issue.evidence);
  });

  it("applies a single exact replacement only", () => {
    const updated = applyDraftRevisionToContent({
      draftContent: draft,
      beforeText: "纸张开始发热，但他没有声张。",
      afterText: "纸张开始发热。林序没有声张，只把编号默默记进心里。",
    });
    expect(updated).toContain("编号默默记进心里");
    expect(updated).not.toContain("纸张开始发热，但他没有声张。");
  });

  it("creates revision tasks from review suggestions without applying changes", () => {
    const task = createRevisionTaskFromSuggestion({
      chapter: 1,
      suggestion,
      draftContent: draft,
      constraints: ["只修开头"],
    });
    expect(task.sourceSuggestionId).toBe(suggestion.id);
    expect(task.targetType).toBe("paragraph"); // 不从意见字面猜「开头 / 结尾」（重构 P7）
    expect(task.revisionGoal).toContain("减少设定解释");
    expect(task.status).toBe("pending");
    expect(draft).toContain("林序站在2楼申请窗口前");
  });

  it("refuses missing or ambiguous targets", () => {
    expect(() => applyDraftRevisionToContent({
      draftContent: draft,
      beforeText: "不存在的段落",
      afterText: "新段落",
    })).toThrow(/未在当前草稿中找到/u);

    expect(() => applyDraftRevisionToContent({
      draftContent: "重复段落\n\n重复段落",
      beforeText: "重复段落",
      afterText: "新段落",
    })).toThrow(/出现多次/u);
  });

  it("normalizes previews and falls back without changing text", () => {
    const task = createRevisionTaskFromIssue({ chapter: 1, issue, draftContent: draft });
    const preview = normalizeDraftRevisionPreview({
      taskId: task.id,
      afterText: "纸张开始发热。林序没有声张。",
      changeSummary: "增强结尾",
    }, task);
    expect(preview.beforeText).toBe(task.targetText);
    expect(preview.afterText).toContain("没有声张");

    const fallback = fallbackDraftRevisionPreview(task, "bad json");
    expect(fallback.beforeText).toBe(fallback.afterText);
    expect(fallback.warnings).toContain("未应用任何修改。");
  });

  it("rejects invalid model JSON without producing an applied preview", () => {
    const task = createRevisionTaskFromIssue({ chapter: 1, issue, draftContent: draft });
    expect(() => parseDraftRevisionPreview("not json", task)).toThrow(/JSON object/u);
    expect(() => parseDraftRevisionPreview(JSON.stringify({ taskId: task.id }), task)).toThrow(/afterText/u);
  });
});

function packFixture(): WritingContextPack {
  const applied = applyCardOps(emptySettingCards(), [
    { op: "story.set", label: "还没揭开", value: "魂钢真实来源" },
    { op: "card.create", kind: "character", name: "林序", protagonist: true, fields: [{ label: "身份", value: "普通毕业生" }] },
    { op: "card.create", kind: "place", name: "海天市旧城区创业孵化楼", fields: [{ label: "格局", value: "只有三层" }] },
    { op: "card.create", kind: "item", name: "半张魂钢申请表", fields: [{ label: "规矩", value: "不能凭空变成完整申请表" }] },
    { op: "rules.add", list: "style", text: "克制" },
    { op: "rules.add", list: "bans", text: "不要设定说明书" },
  ], { by: "author", at: "2026-10-19T00:00:00.000Z" });
  if (!applied.ok) throw new Error(applied.message);
  return {
    chapterTask: { chapterNumber: 1, userDirection: "申请窗口异常", currentChapterGoal: "制造悬念" },
    setting: buildSettingPack(bibleView(project({ ledgers: [], decisions: [] }), applied.file)),
    continuityFocus: { recentTimelineEvents: [], mustCarryHooks: [], mustCarryThreads: [], arcGoalFocus: [], establishedFacts: [] },
    hardConstraints: ["不要提前揭开隐藏真相"],
    readFailures: [],
  };
}
