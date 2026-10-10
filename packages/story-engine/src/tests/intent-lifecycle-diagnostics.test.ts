import { describe, expect, it } from "vitest";
import { analyzeIntentLifecycle } from "../intent-lifecycle-diagnostics.js";
import type { NarrativeThread, ThreadPool } from "../types.js";

describe("Intent Lifecycle Diagnostics V1", () => {
  it("classifies low-value generic actions as non-executing cleanup-visible candidates", () => {
    const report = analyzeIntentLifecycle({
      threads: [
        intentThread("intent-decision", "决定先回去", {
          evidence: ["林澈想了想，决定先回去。"],
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
        }),
        intentThread("intent-glance", "看了一眼", {
          evidence: ["他看了一眼门外，没有继续。"],
          firstSeenChapter: 3,
          lastTouchedChapter: 3,
        }),
      ],
    }, { currentChapter: 12 });

    expect(report.valueClassCounts.low_value_generic).toBe(2);
    expect(report.cleanupCandidateCounts.none).toBe(0);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: "intent-decision",
        intentValueClass: "low_value_generic",
        intentTypeCategory: expect.stringMatching(/generic_|stale_or_obsolete/),
        lifecycleSuggestion: "do_not_pool_or_low_priority",
        cleanupCandidateClass: expect.stringMatching(/cleanup_candidate|manual_review_drop_candidate|stale_low_value_candidate/),
      }),
    ]));
  });

  it("does not let nextActionHint alone protect weak generic stale intents", () => {
    const report = analyzeIntentLifecycle({
      threads: [
        intentThread("intent-hinted-generic", "林澈想了想，决定先不管这个", {
          evidence: ["林澈想了想，决定先不管这个。"],
          nextActionHint: "之后再说",
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
        }),
        intentThread("intent-stale-generic", "正准备迈步走出去", {
          evidence: ["林澈正准备迈步走出去，突然停住了。"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
        }),
      ],
    }, { currentChapter: 14 });

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: "intent-hinted-generic",
        lifecycleSuggestion: "do_not_pool_or_low_priority",
        cleanupCandidateClass: "stale_low_value_candidate",
      }),
      expect.objectContaining({
        threadId: "intent-stale-generic",
        cleanupCandidateClass: "stale_low_value_candidate",
      }),
    ]));
    expect(report.keepCandidates.some((item) => item.threadId === "intent-hinted-generic")).toBe(false);
  });

  it("exposes stale generic medium-value actions without direct drop or auto-expire actions", () => {
    const report = analyzeIntentLifecycle({
      threads: [
        intentThread("intent-concrete-generic", "这个决定做得很艰难", {
          evidence: ["这个决定做得很艰难。"],
          nextActionHint: "原始文件拿到了。",
          firstSeenChapter: 4,
          lastTouchedChapter: 4,
        }),
      ],
    }, { currentChapter: 20 });

    expect(report.diagnostics[0]).toMatchObject({
      intentValueClass: "medium_value_action",
      cleanupCandidateClass: "stale_generic_candidate",
      lifecycleSuggestion: "low_priority_keep",
    });
    expect(report.lifecycleSuggestionCounts.drop_candidate).toBe(0);
    expect(report.lifecycleSuggestionCounts.auto_expire_candidate).toBe(0);
  });

  it("keeps concrete resource, location, clue, risk, and character intents valuable", () => {
    const report = analyzeIntentLifecycle({
      threads: [
        intentThread("intent-signal", "确认消息来源", {
          evidence: ["她要追踪那条匿名消息的来源。"],
        }),
        intentThread("intent-garage", "进入档案室调查", {
          evidence: ["档案室可能存着关键材料。", "她决定进入档案室调查。"],
        }),
        intentThread("intent-medicine", "获取原始合同副本", {
          evidence: ["前台说原始合同副本还在保险柜里。"],
        }),
        intentThread("intent-risk", "避开追兵守住出口", {
          evidence: ["他要避开追兵，守住安全路线。"],
        }),
        intentThread("intent-character", "确认目击者证词", {
          evidence: ["她要确认那个目击者的证词是否可靠。"],
        }),
      ],
    }, { currentChapter: 6 });

    expect(report.valueClassCounts.high_value_narrative + report.valueClassCounts.medium_value_action).toBeGreaterThanOrEqual(5);
    expect(report.lifecycleSuggestionCounts.keep_open_or_touched + report.lifecycleSuggestionCounts.low_priority_keep).toBeGreaterThanOrEqual(5);
    expect(report.cleanupCandidateCounts.none).toBeGreaterThanOrEqual(4);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "intent-signal", intentTypeCategory: "signal_or_clue_goal", cleanupCandidateClass: "none" }),
      expect.objectContaining({ threadId: "intent-garage", intentTypeCategory: "location_goal", cleanupCandidateClass: "none" }),
      expect.objectContaining({ threadId: "intent-medicine", intentTypeCategory: "resource_goal", cleanupCandidateClass: "none" }),
      expect.objectContaining({ threadId: "intent-risk", intentTypeCategory: "risk_or_survival_goal", cleanupCandidateClass: "none" }),
      expect.objectContaining({ threadId: "intent-character", intentTypeCategory: "character_interaction", cleanupCandidateClass: "none" }),
    ]));
  });

  it("does not modify ThreadPool state", () => {
    const threadPool: ThreadPool = {
      threads: [
        intentThread("intent-signal", "确认无线电信号来源", {
          evidence: ["林澈要追踪信号源。"],
          nextActionHint: "去天台接收信号",
        }),
      ],
    };
    const before = JSON.stringify(threadPool);

    const report = analyzeIntentLifecycle(threadPool, { currentChapter: 8 });

    expect(report.totalIntents).toBe(1);
    expect(JSON.stringify(threadPool)).toBe(before);
    expect(threadPool.threads[0]).toMatchObject({
      status: "open",
      nextActionHint: "去天台接收信号",
    });
  });

});

function intentThread(
  id: string,
  title: string,
  overrides: Partial<NarrativeThread> = {},
): NarrativeThread {
  return {
    id,
    type: "intent",
    title,
    status: "open",
    firstSeenChapter: 1,
    lastTouchedChapter: 1,
    evidence: [],
    ...overrides,
  };
}

function emptyContinuity() {
  return {
    recentEvents: [],
    openLeads: [],
    activeConflicts: [],
    discoveries: [],
    recentLocations: [],
    recentCharacters: [],
    carryForwardInstruction: "暂无前情承接要求。",
  };
}
