import { type ContextSection, type WriterContextEnvelope, estimateTokens } from "./context-gateway.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_BUDGET, makeWriterRankContext, rankWriterContext, resolveWriterTokenBudget } from "./rank-writer-context.js";

describe("rankWriterContext", () => {
  it("returns the original envelope and no drops when no token budget is provided", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 10),
      dynamic("writing_context_pack", 20),
      dynamic("timeline_events", 30),
    ]);

    const result = rankWriterContext(envelope);

    expect(result.envelope).toBe(envelope);
    expect(result.dropped).toEqual([]);
  });

  it("drops only dynamic sections by dropOrder while preserving stable and protected sections", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      stable("world_core", 50),
      dynamic("chapter_goal", 30),
      dynamic("writing_context_pack", 40),
      dynamic("story_calendar", 35),
      dynamic("timeline_events", 25),
      dynamic("character_state", 20),
    ]);

    const result = rankWriterContext(envelope, {
      tokenBudget: 95,
      dropOrder: ["timeline_events", "story_calendar", "character_state"],
    });

    expect(result.dropped.map((item) => item.name)).toEqual(["timeline_events", "story_calendar"]);
    expect(result.dropped.every((item) => item.reason === "budget")).toBe(true);
    expect(result.envelope.sections.map((section) => section.name)).toEqual([
      "story_core",
      "world_core",
      "chapter_goal",
      "writing_context_pack",
      "character_state",
    ]);
    expect(result.envelope.sections.filter((section) => section.cachePolicy === "stable")).toEqual([
      envelope.sections[0],
      envelope.sections[1],
    ]);
    expect(result.envelope.trace).toMatchObject({
      sectionNames: ["story_core", "world_core", "chapter_goal", "writing_context_pack", "character_state"],
      stableTokenEstimate: 100,
      dynamicTokenEstimate: 90,
      totalTokenEstimate: 190,
    });
  });

  it("keeps chapter_goal, writing_context_pack, and character_state even when the dynamic budget is smaller than protected sections", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 60),
      dynamic("writing_context_pack", 70),
      dynamic("character_state", 80),
      dynamic("timeline_events", 20),
    ]);

    const result = rankWriterContext(envelope, { tokenBudget: 10 });

    expect(result.envelope.sections.map((section) => section.name)).toEqual([
      "story_core",
      "chapter_goal",
      "writing_context_pack",
      "character_state",
    ]);
    expect(result.dropped.map((item) => item.name)).toEqual(["timeline_events"]);
  });

  it("reports core impact when protected dynamic sections exceed the budget by themselves", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 80),
      dynamic("writing_context_pack", 90),
      dynamic("character_state", 100),
      dynamic("timeline_events", 20),
    ]);

    const result = rankWriterContext(envelope, { tokenBudget: 120 });

    expect(result.envelope.sections.map((section) => section.name)).toEqual([
      "story_core",
      "chapter_goal",
      "writing_context_pack",
      "character_state",
    ]);
    expect(result.dropped.map((item) => item.name)).toEqual(["timeline_events"]);
    expect(result.coreImpact).toBe(true);
    expect(result.issues.join("\n")).toContain("核心 270 > 预算 120");
  });

  it("drops story_continuity last and marks it as core impact when it must be trimmed", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 10),
      dynamic("writing_context_pack", 10),
      dynamic("character_state", 10),
      dynamic("timeline_events", 40),
      dynamic("story_continuity", 30),
    ]);

    const result = rankWriterContext(envelope, { tokenBudget: 30 });

    expect(result.dropped.map((item) => item.name)).toEqual(["timeline_events", "story_continuity"]);
    expect(result.dropped.find((item) => item.name === "story_continuity")).toMatchObject({ coreImpact: true });
    expect(result.coreImpact).toBe(true);
  });
});

describe("rankWriterContext 段降级（R5 线索精筛）", () => {
  const bigThreads = {
    openLeads: [{ title: "主线索A" }, { title: "主线索B" }, { title: "线索C" }, { title: "线索D" }],
    openIntents: [{ title: "意图X" }, { title: "意图Y" }],
    recentlyTouchedThreads: [{ title: "冗余1" }, { title: "冗余2" }],
    staleThreadWarnings: Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`, type: "lead", title: `陈旧线索${i}`, lastTouchedChapter: 1, chaptersSinceTouched: i + 5,
      message: `Open lead "陈旧线索${i}" 已经 ${i + 5} 章没有推进了，提醒不要忘记这条线索的来龙去脉。`,
    })),
    threadCarryForwardInstruction: "下一章可优先自然推进：主线索A、主线索B。",
  };

  it("超预算时 story_threads 降级保留（砍 staleWarnings/冗余、留真线索+carryForward）而非整删", () => {
    const full = estimateTokens(bigThreads);
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 10),
      dynamic("writing_context_pack", 10),
      sectionWith("story_threads", bigThreads),
    ]);
    const result = rankWriterContext(envelope, { tokenBudget: 20 + Math.ceil(full / 2) });
    const threads = result.envelope.sections.find((s) => s.name === "story_threads");
    expect(threads).toBeDefined();
    const c = threads!.content as Record<string, unknown>;
    expect(c.staleThreadWarnings).toEqual([]);
    expect(c.recentlyTouchedThreads).toEqual([]);
    expect((c.openLeads as unknown[]).length).toBe(3);
    expect(c.threadCarryForwardInstruction).toContain("主线索");
    expect(threads!.tokenEstimate).toBeLessThan(full);
    expect(result.dropped.find((d) => d.name === "story_threads")?.reason).toBe("compacted");
  });

  it("预算极紧、降级后仍超 → story_threads 整删兜底（只一条 budget 记录）", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 10),
      dynamic("writing_context_pack", 10),
      sectionWith("story_threads", bigThreads),
    ]);
    const result = rankWriterContext(envelope, { tokenBudget: 5 });
    expect(result.envelope.sections.find((s) => s.name === "story_threads")).toBeUndefined();
    const recs = result.dropped.filter((d) => d.name === "story_threads");
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe("budget");
  });

  it("默认 tokenBudget undefined 仍 no-op（不降级、逐字节零改动）", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      sectionWith("story_threads", bigThreads),
    ]);
    const result = rankWriterContext(envelope);
    expect(result.envelope).toBe(envelope);
    expect(result.dropped).toEqual([]);
  });
});

describe("makeWriterRankContext", () => {
  it("defaults to identity even when dynamic context exceeds the Phase 1 default budget", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 10),
      dynamic("writing_context_pack", 10),
      dynamic("story_calendar", DEFAULT_TOKEN_BUDGET + 1),
      dynamic("timeline_events", DEFAULT_TOKEN_BUDGET + 2),
    ]);
    const ranked = makeWriterRankContext();

    const next = ranked.rankContext(envelope);

    expect(next).toBe(envelope);
    expect(next.sections).toEqual(envelope.sections);
    expect(ranked.droppedSections).toEqual([]);
  });

  it("captures dropped dynamic section names from rankContext calls", () => {
    const envelope = makeEnvelope([
      stable("story_core", 50),
      dynamic("chapter_goal", 10),
      dynamic("writing_context_pack", 10),
      dynamic("timeline_events", 40),
    ]);
    const ranked = makeWriterRankContext({ tokenBudget: 20 });

    const next = ranked.rankContext(envelope);

    expect(next.sections.map((section) => section.name)).toEqual(["story_core", "chapter_goal", "writing_context_pack"]);
    expect(ranked.droppedSections).toEqual(["timeline_events"]);
    expect(ranked.droppedDetails).toEqual([{ name: "timeline_events", reason: "budget", coreImpact: false }]);
  });
});

// 收口洞①：原始 makeWriterRankContext 默认 no-op（保 Phase 0 字节级零行为），
// 但生产出稿路径绝不能用 no-op——否则全部 dynamic 裁剪在真实写作里是死的。
// resolveWriterTokenBudget 是生产侧"显式取默认预算"的口子：缺省给 DEFAULT_TOKEN_BUDGET，
// 显式值（含 0）原样尊重。生产调用方用它把预算真正接上电。
describe("resolveWriterTokenBudget（生产侧默认预算兜底）", () => {
  it("未显式给预算 → 返回 DEFAULT_TOKEN_BUDGET（不再 no-op）", () => {
    expect(resolveWriterTokenBudget(undefined)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(resolveWriterTokenBudget()).toBe(DEFAULT_TOKEN_BUDGET);
  });

  it("显式给正整数预算 → 原样返回（用户/路由覆盖优先）", () => {
    expect(resolveWriterTokenBudget(3000)).toBe(3000);
  });

  it("显式给 0 → 尊重 0（不被 ?? 吞成默认），表示极限裁剪", () => {
    expect(resolveWriterTokenBudget(0)).toBe(0);
  });
});

function makeEnvelope(sections: readonly ContextSection[]): WriterContextEnvelope {
  const totalTokenEstimate = sections.reduce((sum, section) => sum + section.tokenEstimate, 0);
  const stableTokenEstimate = sections
    .filter((section) => section.cachePolicy === "stable")
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
  return {
    projectId: "test-project",
    chapter: 1,
    sections,
    trace: {
      sectionNames: sections.map((section) => section.name),
      totalTokenEstimate,
      stableTokenEstimate,
      dynamicTokenEstimate: totalTokenEstimate - stableTokenEstimate,
      selectedCharacters: [],
      selectedHooks: [],
      selectedTimelineEvents: [],
    },
  };
}

function stable(name: string, tokenEstimate: number): ContextSection {
  return section(name, tokenEstimate, "stable");
}

function dynamic(name: string, tokenEstimate: number): ContextSection {
  return section(name, tokenEstimate, "dynamic");
}

function section(name: string, tokenEstimate: number, cachePolicy: "stable" | "dynamic"): ContextSection {
  return { name, content: { name }, tokenEstimate, cachePolicy };
}

/** 真 content 的 dynamic section（token 用引擎同款 estimateTokens 算），供降级测试。 */
function sectionWith(name: string, content: unknown): ContextSection {
  return { name, content, tokenEstimate: estimateTokens(content), cachePolicy: "dynamic" };
}
