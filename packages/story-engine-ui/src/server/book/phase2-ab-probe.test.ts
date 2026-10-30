// @vitest-environment node
/**
 * Phase 2 A/B acceptance probe for "longform memory hub" — engine package.
 *
 * Covers attributes 1 & 2 with deterministic OLD vs NEW comparisons.
 *
 * Attribute 1 · 早期大事件可查（Task 6 timeline 分层）
 *   - OLD: timeline.recentEvents = sort.slice(-5) → 只有近章，ch1-5 查不到
 *   - NEW: timeline.macroSummary (L3) 含早期 ch1-5 mainEvent；
 *          read_timeline(chapter=2) 精确返回第2章事件
 *
 * （Attribute 2 · 伏笔池收口：伏笔池随 P2b 删镜像一起删了，伏笔就是悬念类线索，收口看 threads。）
 *
 * 均为确定性、无网络、纯内存函数级别验证（不调 LLM，不读真实磁盘临时文件除外）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { seedChapters } from "./ledger-test-helpers.js";
import { createStoryProject } from "./project-store.js";
import { buildStateOverview } from "./state-overview.js";
import { buildTimelineLayers } from "./timeline-layers.js";
import type { TimelineEvent } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTimelineEvent(
  chapter: number,
  mainEvent: string,
): TimelineEvent {
  return {
    id: `ch${String(chapter).padStart(4, "0")}-001`,
    chapter,
    summary: `第${chapter}章摘要`,
    participants: [`char-${chapter}`],
    effects: {
      semanticSummary: {
        mainEvent,
        timelineSummary: `第${chapter}章时间线`,
      },
    },
  };
}

/** 构造 30 章事件：ch1-5 是宏事件(标记 MACRO-)，ch6-30 是普通事件 */
function make30ChapterEvents(): readonly TimelineEvent[] {
  return Array.from({ length: 30 }, (_, i) => {
    const ch = i + 1;
    const isEarly = ch <= 5;
    return makeTimelineEvent(
      ch,
      isEarly
        ? `MACRO-ch${ch}：早期关键大事件（伏笔/核心转折）`
        : `普通-ch${ch}：推进事件`,
    );
  });
}

// ── 属性 1 A/B 对比 ──────────────────────────────────────────────────────────

describe("Phase 2 A/B probe — 属性 1：早期大事件可查（Task 6 timeline 分层）", () => {
  /**
   * 构造 30 章 fixture：ch1-5 带 MACRO- 前缀的宏事件（重要早期事件）。
   * currentChapter = 30（已写到第 30 章）。
   *
   * 默认窗口：l1Window=3（近章 28-30）, l2Window=15（中段 16-27）, l3Window=<= 15（远期 ch1-15，含 ch1-5）
   *
   * OLD 内联复刻：recentEvents = 全量 events.sort.slice(-5) = ch26-30（只有近 5 章）
   * NEW：buildTimelineLayers → macroSummary(L3) 包含 ch1-5 宏块，早期可查率 100% vs OLD 0%
   */

  const CURRENT_CHAPTER = 30;
  const EARLY_CHAPTERS = [1, 2, 3, 4, 5];

  /**
   * OLD 内联复刻：state-overview 旧逻辑
   * `recentEvents = timelineEvents.sort((a,b)=>a.chapter-b.chapter).slice(-maxTimeline)`
   * 默认 maxTimeline = 5
   */
  function oldGetVisibleChapters(events: readonly TimelineEvent[], maxRecent = 5): number[] {
    return events
      .slice()
      .sort((a, b) => a.chapter - b.chapter)
      .slice(-maxRecent)
      .map((e) => e.chapter);
  }

  /** 早期宏事件在给定章号列表中的出现率 */
  function earlyChapterRecall(earlyChapters: number[], visibleChapters: number[]): number {
    const visSet = new Set(visibleChapters);
    const hit = earlyChapters.filter((ch) => visSet.has(ch)).length;
    return hit / earlyChapters.length;
  }

  /** 从 macroSummary(L3) 提取覆盖早期章号的 blocks */
  function earlyChaptersInMacroSummary(
    macroBlocks: readonly { fromChapter: number; toChapter: number; summary: string }[],
    earlyChapters: number[],
  ): number {
    let count = 0;
    for (const ch of earlyChapters) {
      if (macroBlocks.some((b) => b.fromChapter <= ch && b.toChapter >= ch)) count++;
    }
    return count;
  }

  it("OLD：recentEvents 只有近 5 章（ch26-30），早期 ch1-5 可查率 = 0%", () => {
    const events = make30ChapterEvents();
    const oldVisible = oldGetVisibleChapters(events, 5);

    // OLD: 近 5 章 = ch26-30
    expect(oldVisible).toEqual([26, 27, 28, 29, 30]);

    const oldRecall = earlyChapterRecall(EARLY_CHAPTERS, oldVisible);
    expect(oldRecall).toBe(0);
    console.log(`[属性1 OLD] recentEvents chapters: ${oldVisible.join(",")}, 早期可查率: ${(oldRecall * 100).toFixed(0)}%`);
  });

  it("NEW：buildTimelineLayers macroSummary(L3) 覆盖所有早期 ch1-5，可查率 = 100%", () => {
    const events = make30ChapterEvents();
    const layers = buildTimelineLayers(events, CURRENT_CHAPTER);

    // L3 远期：ch <= currentChapter - l2Window = 30 - 15 = 15 → ch1-15 都在 L3
    // ch1-5 全在 L3，每块 summary 含对应 MACRO-ch? mainEvent
    const macroBlocks = layers.l3;
    expect(macroBlocks.length).toBeGreaterThan(0);

    const earlyInL3 = earlyChaptersInMacroSummary(macroBlocks, EARLY_CHAPTERS);
    const newRecall = earlyInL3 / EARLY_CHAPTERS.length;
    expect(newRecall).toBe(1); // 100%

    // 每个早期章号的 mainEvent 都应出现在对应 L3 块的 summary 里
    for (const ch of EARLY_CHAPTERS) {
      const block = macroBlocks.find((b) => b.fromChapter <= ch && b.toChapter >= ch);
      expect(block, `ch${ch} 应该有对应的 L3 宏块`).toBeTruthy();
      expect(block!.summary).toContain(`MACRO-ch${ch}`);
    }

    console.log(`[属性1 NEW] L3 blocks: ${macroBlocks.length} 个，早期 ch1-5 覆盖率: ${(newRecall * 100).toFixed(0)}%`);
    console.log(`[属性1 NEW] L3 blocks: ${macroBlocks.map((b) => `[ch${b.fromChapter}-${b.toChapter}]`).join(", ")}`);
  });

  it("NEW：buildStateOverview(chapter=30) 的 timeline.macroSummary 含早期 ch1-5 宏块", { timeout: 60_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "phase2-attr1-overview-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "Phase2 属性1 早期可查测试",
      genre: "都市",
      logline: "主角进入权力中心，早期伏笔埋下。",
      protagonistName: "林远",
    });
    // 每章梗概就是事件（从账算）：早期 5 章带 MACRO- 标记。
    await seedChapters(projectDir, make30ChapterEvents().map((event) => ({
      chapter: event.chapter,
      entries: [{ kind: "summary" as const, text: String((event.effects?.semanticSummary as { mainEvent?: string } | undefined)?.mainEvent) }],
    })));

    const overview = await buildStateOverview({ projectDir, chapter: CURRENT_CHAPTER });

    // recentEvents: 只有近几章（OLD 窗口，ch28-30）
    const recentChapters = overview.timeline.recentEvents.map((e) => e.chapter);
    expect(recentChapters.every((ch) => ch > 25), "recentEvents 应只包含近章（>25）").toBe(true);

    // macroSummary (L3): 必须覆盖 ch1-5
    const macroBlocks = overview.timeline.macroSummary;
    expect(macroBlocks.length).toBeGreaterThan(0);
    for (const ch of EARLY_CHAPTERS) {
      const block = macroBlocks.find((b) => b.fromChapter <= ch && b.toChapter >= ch);
      expect(block, `macroSummary 应覆盖 ch${ch}`).toBeTruthy();
      expect(block!.summary).toContain(`MACRO-ch${ch}`);
    }

    console.log(`[属性1 NEW via buildStateOverview] recentEvents chapters: ${recentChapters.join(",")}`);
    console.log(`[属性1 NEW via buildStateOverview] macroSummary blocks: ${macroBlocks.length} 个，覆盖 ch${macroBlocks[0]?.fromChapter}-${macroBlocks.at(-1)?.toChapter}`);
  });

  it("量化对比：OLD 早期可查率 0% vs NEW(L3) 早期可查率 100%", () => {
    const events = make30ChapterEvents();

    // OLD
    const oldVisible = oldGetVisibleChapters(events, 5);
    const oldRecall = earlyChapterRecall(EARLY_CHAPTERS, oldVisible);

    // NEW (pure function level)
    const layers = buildTimelineLayers(events, CURRENT_CHAPTER);
    const earlyInL3 = earlyChaptersInMacroSummary(layers.l3, EARLY_CHAPTERS);
    const newRecall = earlyInL3 / EARLY_CHAPTERS.length;

    console.log("\n=== 属性 1 量化对比 ===");
    console.log(`OLD recentEvents 早期可查率: ${(oldRecall * 100).toFixed(0)}%`);
    console.log(`NEW macroSummary 早期可查率: ${(newRecall * 100).toFixed(0)}%`);

    // 硬门
    expect(oldRecall).toBe(0); // OLD 完全不可查
    expect(newRecall).toBe(1); // NEW 100% 可查
    expect(newRecall).toBeGreaterThan(oldRecall); // NEW 明显优于 OLD
  });
});
