import { describe, expect, it } from "vitest";
import {
  buildDraftAIReviewPrompt,
  fallbackDraftAIReviewReport,
  parseDraftAIReviewReport,
} from "../draft-ai-review.js";
import type { StateOverview } from "../state-overview.js";
import type { WritingContextPack } from "../writing-context-pack.js";

describe("Draft AI Review V0", () => {
  it("builds a prompt with draft content, writing rules, boundaries, and no-rewrite constraints", () => {
    const prompt = buildDraftAIReviewPrompt({
      chapter: 1,
      draftContent: "# 第1章 · 半张申请表\n\n林序站在海天市旧城区创业孵化楼二楼申请窗口前。",
      chapterGoal: "毕业失败当天，林序第一次接触魂钢异常反应。",
      writingContextPack: contextPackFixture(),
      deterministicQuality: {
        passed: true,
        issues: [{ severity: "warning", type: "writing_context_setup_asset_missing", message: "Draft does not mention setup asset." }],
      },
    });

    expect(prompt).toContain("你是 StoryEngine-NG 的“审稿老师”");
    expect(prompt).toContain("不改正文，不输出重写全文");
    expect(prompt).toContain("不泄露 protectedSecrets / forbiddenReveals / hiddenTruths");
    expect(prompt).toContain("不建议主角知道 unknownTruths");
    expect(prompt).toContain("克制、紧张、少解释");
    expect(prompt).toContain("海天市旧城区创业孵化楼");
    expect(prompt).toContain("欠费手机");
    expect(prompt).toContain("魂钢真实来源");
    expect(prompt).toContain("林序站在海天市旧城区创业孵化楼二楼申请窗口前");
  });

  // E3（B）：把全角色（含非主角）的 appearanceAnchors 透进审稿上下文 + 加「同属性互斥」审查指令，
  // 让 LLM 审稿层能 catch 角色卡内部语义矛盾（如陈雨薇「二十六七岁」vs「三十出头」——fuzzy/确定性都够不着）。
  it("feeds all characters' appearance anchors (incl. non-protagonist) so the reviewer can flag same-attribute contradictions", () => {
    const prompt = buildDraftAIReviewPrompt({
      chapter: 2,
      draftContent: "# 第2章\n\n顾长风在雾港码头见到了那个女人。",
      writingContextPack: contextPackFixture(), // pack 在场（草稿审稿常态）——主角分支用 pack
      stateOverview: overviewWithCharacterConflict(),
    });
    // 非主角陈雨薇的两条互斥年龄锚点都进了喂模型的上下文（pack 在场也不丢）
    expect(prompt).toContain("二十六七岁");
    expect(prompt).toContain("三十出头");
    // 通用「同属性互斥」审查指令
    expect(prompt).toContain("同一属性");
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

// 最小 StateOverview：只填本测试要读的 characterMatrix.characters（name + appearanceAnchors）。
// 含一个非主角（陈雨薇）带互斥年龄锚点，验证非主角也被透传。
function overviewWithCharacterConflict(): StateOverview {
  return {
    project: { title: "测试悬疑书", genre: "悬疑", currentChapter: 2 },
    characterMatrix: {
      available: true,
      characters: [
        { id: "char-gcf", name: "顾长风", role: "主角", appearanceAnchors: ["身形挺拔"] },
        { id: "char-cyw", name: "陈雨薇", role: "配角", appearanceAnchors: ["二十六七岁", "三十出头", "穿着米色风衣"] },
      ],
      relationships: [],
      riskReminders: [],
    },
  } as unknown as StateOverview;
}

function contextPackFixture(): WritingContextPack {
  return {
    chapterTask: {
      chapterNumber: 1,
      userDirection: "毕业失败当天，林序第一次接触魂钢异常反应。",
      currentChapterGoal: "让林序接触异常申请表，但不揭开魂钢来源。",
      firstChapterGoal: "第一次接触魂钢异常反应。",
      openingScene: "海天市旧城区创业孵化楼二楼申请窗口",
      firstHook: "半张魂钢申请表发热",
      firstConflict: "普通毕业生难以获得魂钢资格",
    },
    protagonistContext: {
      name: "林序",
      identity: "普通毕业生",
      currentGoal: "确认申请记录",
      weakness: "资源不足",
      behaviorBoundaries: ["普通人起步，不开挂"],
      knownFacts: ["魂钢申请表异常发热"],
      unknownTruths: ["魂钢真实来源"],
      forbiddenReveals: ["财团幕后操盘者"],
      physicalState: "疲惫",
      mentalState: "警惕",
      resourcesLimit: ["无大额现金"],
      age: "22岁",
      speechStyle: "克制，先观察再反问",
      speechSamples: ["所以，我的申请记录到底在哪里？"],
      cannotDo: ["不能突然知道财团幕后操盘者"],
      extraFields: [],
    },
    supportingCast: [],
    locationContext: {
      requiredCurrentLocation: "海天市旧城区创业孵化楼",
      openingLocation: "二楼申请窗口",
      spatialStructure: {
        floors: ["1楼大厅", "2楼申请窗口", "3楼办公区"],
        rooms: ["申请窗口"],
        entrances: ["正门"],
        exits: ["楼梯"],
      },
      travelRules: [{ targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1 }],
      fixedFacts: ["只有三层楼"],
      locationRisks: ["不能出现四楼"],
      locationResources: ["查询终端"],
      nearbyLocations: ["旧城区公交站"],
      extraFields: [],
      locationDoNotInventRule: "不要编造新城市名。",
    },
    worldRulesContext: {
      coreRules: ["创业魂钢决定城市阶层和英灵能力"],
      resourceRules: ["普通毕业生很难获得魂钢"],
      socialOrder: ["财团垄断觉醒机会"],
      factions: [{ name: "财团", goal: "垄断魂钢", resources: ["检测系统"] }],
      conflictSources: ["阶层门槛"],
      hiddenTruths: ["魂钢真实来源"],
      protectedSecrets: ["主角潜力真实等级"],
    },
    assetContext: {
      initialAssets: ["欠费手机", "公交卡"],
      keyItems: ["半张魂钢申请表"],
      resourceLimits: ["无车辆", "无大额现金"],
      importantCarriedItems: ["半张魂钢申请表"],
      carriedAssets: ["欠费手机", "公交卡", "半张魂钢申请表"],
      ownedAssets: [],
      usableAssets: ["公交卡"],
      unavailableAssets: ["欠费手机"],
      plotCriticalAssets: ["半张魂钢申请表"],
      assetHardRules: ["欠费手机不能正常联网"],
      extraFields: [],
      assetDoNotInventRule: "不要凭空创建车辆或大额现金。",
    },
    continuityFocus: {
      recentTimelineEvents: ["林序毕业失败"],
      mustCarryHooks: ["申请表发热"],
      mustCarryThreads: ["申请记录异常"],
      arcGoalFocus: ["突破魂钢阶层门槛"],
      establishedFacts: [],
    },
    writingRulesContext: {
      narrativePerspective: "第三人称限知",
      proseStyle: ["克制、紧张、少解释"],
      pacing: "中等",
      revealPolicy: "慢揭示",
      targetChapterWords: 1800,
      forbiddenContent: ["不要提前解释魂钢来源"],
      doNotDo: ["不要写成设定说明书"],
      readerExperienceRules: ["保持压迫感"],
      styleExemplars: [],
    },
    hardConstraints: ["不要提前揭开隐藏真相"],
    sourceTrace: [],
  };
}
