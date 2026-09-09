import { describe, expect, it } from "vitest";
import {
  applyDraftRevisionToContent,
  buildDraftRevisionPrompt,
  buildDeterministicRevisionPreview,
  createRevisionTaskFromIssue,
  createRevisionTaskFromSuggestion,
  fallbackDraftRevisionPreview,
  normalizeDraftRevisionPreview,
  parseDraftRevisionPreview,
} from "../draft-revision.js";
import type { DraftAIReviewIssue, DraftAIRevisionSuggestion } from "../draft-ai-review.js";

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
  it("builds a scoped revision prompt with safety boundaries", () => {
    const task = createRevisionTaskFromIssue({
      chapter: 1,
      issue,
      draftContent: draft,
      constraints: ["不要提前揭开魂钢真实来源"],
    });
    const prompt = buildDraftRevisionPrompt({
      task,
      draftContent: draft,
      writingContextPack: {
        chapterTask: { chapterNumber: 1, userDirection: "申请窗口异常", currentChapterGoal: "制造悬念" },
        protagonistContext: {
          name: "林序",
          identity: "普通毕业生",
          currentGoal: "查清申请表异常",
          weakness: "资源不足",
          behaviorBoundaries: ["普通人起步"],
          knownFacts: ["申请表发热"],
          unknownTruths: ["魂钢真实来源"],
          forbiddenReveals: ["财团幕后操盘者"],
          physicalState: "疲惫",
          mentalState: "警惕",
          resourcesLimit: ["无大额现金"],
          age: "22",
          speechStyle: "克制",
          speechSamples: ["先观察，再反问。"],
          cannotDo: ["不能突然开挂"],
          extraFields: [],
        },
        supportingCast: [],
        locationContext: {
          requiredCurrentLocation: "海天市旧城区创业孵化楼2楼申请窗口",
          openingLocation: "2楼申请窗口",
          locationRisks: ["检测终端会记录异常"],
          locationResources: ["申请窗口"],
          nearbyLocations: ["1楼大厅"],
          extraFields: [],
          locationDoNotInventRule: "不要新增地点",
          spatialStructure: { floors: ["1楼", "2楼"], rooms: ["申请窗口"], entrances: ["大厅入口"], exits: ["楼梯"] },
          travelRules: [{ targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1 }],
          fixedFacts: ["只有三层"],
        },
        worldRulesContext: {
          coreRules: ["魂钢决定阶层"],
          resourceRules: ["申请表是关键凭证"],
          socialOrder: ["财团垄断机会"],
          factions: [],
          conflictSources: ["资源垄断"],
          hiddenTruths: ["魂钢真实来源"],
          protectedSecrets: ["主角潜力真实等级"],
        },
        assetContext: {
          initialAssets: ["半张魂钢申请表"],
          keyItems: ["半张魂钢申请表"],
          resourceLimits: ["欠费手机不能联网"],
          importantCarriedItems: ["半张魂钢申请表"],
          extraFields: [],
          assetDoNotInventRule: "不要新增关键资产",
          carriedAssets: ["半张魂钢申请表"],
          ownedAssets: [],
          usableAssets: ["公交卡"],
          unavailableAssets: ["欠费手机"],
          plotCriticalAssets: ["半张魂钢申请表"],
          assetHardRules: ["半张申请表不能变完整"],
        },
        continuityFocus: { recentTimelineEvents: [], mustCarryHooks: [], mustCarryThreads: [], arcGoalFocus: [], establishedFacts: [] },
        writingRulesContext: {
          narrativePerspective: "第三人称限知",
          proseStyle: ["克制", "紧张"],
          pacing: "中等",
          revealPolicy: "慢揭示",
          targetChapterWords: 1200,
          forbiddenContent: ["不要设定说明书"],
          doNotDo: ["不要突然开挂"],
          readerExperienceRules: ["保留追读点"],
          styleExemplars: [],
        },
        hardConstraints: ["不要提前揭开隐藏真相"],
        sourceTrace: [],
      },
    });

    expect(prompt).toContain("只修指定片段，不重写全文");
    expect(prompt).toContain("不提前揭开 forbiddenReveals / protectedSecrets");
    expect(prompt).toContain("writingRules");
    expect(prompt).toContain("海天市旧城区创业孵化楼2楼申请窗口");
    expect(prompt).toContain("半张申请表不能变完整");
    expect(prompt).toContain("魂钢真实来源");
    expect(prompt).toContain("不要以信息不足为理由保持原样");
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
    expect(task.targetType).toBe("opening");
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

  it("can deterministically repair explicit pronoun drift tasks", () => {
    const preview = buildDeterministicRevisionPreview({
      id: "revision-pronoun",
      chapter: 2,
      targetType: "paragraph",
      targetText: "沈砚从檐影里走出来，他拍了拍林远的肩膀",
      problemSummary: "沈砚人称代词漂移：她→他",
      revisionGoal: "确认沈砚性别设定后统一全章代词；若为女性则改为'她拍了拍林远的肩膀'",
      constraints: ["只修改选中的原文片段"],
      status: "pending",
    });

    expect(preview?.afterText).toBe("沈砚从檐影里走出来，她拍了拍林远的肩膀");
    expect(preview?.changeSummary).toContain("女性/她");
  });

  it("rejects invalid model JSON without producing an applied preview", () => {
    const task = createRevisionTaskFromIssue({ chapter: 1, issue, draftContent: draft });
    expect(() => parseDraftRevisionPreview("not json", task)).toThrow(/JSON object/u);
    expect(() => parseDraftRevisionPreview(JSON.stringify({ taskId: task.id }), task)).toThrow(/afterText/u);
  });
});
