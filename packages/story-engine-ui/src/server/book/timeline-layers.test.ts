// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "./types.js";
import {
  buildTimelineLayers,
  type TimelineLayers,
  type TimelineLayerEvent,
  type TimelineMacroBlock,
} from "./timeline-layers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  chapter: number,
  summary: string,
  mainEvent?: string,
  participants?: string[],
): TimelineEvent {
  return {
    id: `ch${chapter}`,
    chapter,
    summary,
    participants: participants ?? [],
    effects: mainEvent
      ? {
          semanticSummary: {
            mainEvent,
            timelineSummary: `${summary} (timeline)`,
          },
        }
      : undefined,
  };
}

/** 构造 N 章的 events，每章都有 mainEvent */
function make50Events(): readonly TimelineEvent[] {
  return Array.from({ length: 50 }, (_, i) => {
    const ch = i + 1;
    return makeEvent(ch, `第${ch}章摘要`, `第${ch}章主事件`, [`角色${ch}`]);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTimelineLayers", () => {
  // 核心场景：50 章，currentChapter=50
  describe("50章/currentChapter=50 三层分区", () => {
    const events = make50Events();
    let layers: TimelineLayers;

    it("能调用且不抛出", () => {
      layers = buildTimelineLayers(events, 50);
    });

    it("L1 = 近 3 章（48、49、50）", () => {
      layers = buildTimelineLayers(events, 50);
      const chapters = layers.l1.map((e) => e.chapter).sort((a, b) => a - b);
      expect(chapters).toEqual([48, 49, 50]);
    });

    it("L1 每条都带 summary、mainEvent、participants", () => {
      layers = buildTimelineLayers(events, 50);
      for (const e of layers.l1) {
        expect(typeof e.summary).toBe("string");
        expect(e.summary.length).toBeGreaterThan(0);
        expect(typeof e.mainEvent).toBe("string");
        expect(Array.isArray(e.participants)).toBe(true);
      }
    });

    it("L2 = 中段每章 35..47（章号在 35 到 47 之间）", () => {
      layers = buildTimelineLayers(events, 50);
      const chapters = layers.l2.map((e) => e.chapter).sort((a, b) => a - b);
      // 默认 l2Window=15，l1Window=3 → 中段 = chapter in (50-15, 50-3] = (35, 47]
      const expected = Array.from({ length: 12 }, (_, i) => 36 + i); // 36..47
      expect(chapters).toEqual(expected);
    });

    it("L2 每条都带 chapter 和 summary（mainEvent 截断 ≤120 字）", () => {
      layers = buildTimelineLayers(events, 50);
      for (const e of layers.l2) {
        expect(typeof e.chapter).toBe("number");
        expect(typeof e.summary).toBe("string");
        if (e.mainEvent !== undefined) {
          expect(e.mainEvent.length).toBeLessThanOrEqual(120);
        }
      }
    });

    it("L3 = 远期 1-35 章，按 5 章分块", () => {
      layers = buildTimelineLayers(events, 50);
      // 远期 = chapter <= 50-15 = 35，分块 5 → [1-5, 6-10, 11-15, 16-20, 21-25, 26-30, 31-35]
      expect(layers.l3.length).toBe(7);
      const firstBlock = layers.l3[0];
      expect(firstBlock.fromChapter).toBe(1);
      expect(firstBlock.toChapter).toBe(5);
    });

    it("L3 每块都有 fromChapter、toChapter 和非空 summary", () => {
      layers = buildTimelineLayers(events, 50);
      for (const block of layers.l3) {
        expect(typeof block.fromChapter).toBe("number");
        expect(typeof block.toChapter).toBe("number");
        expect(block.fromChapter).toBeLessThanOrEqual(block.toChapter);
        expect(typeof block.summary).toBe("string");
        expect(block.summary.length).toBeGreaterThan(0);
      }
    });

    it("⭐ 核心：早期第 2 章的 mainEvent 仍出现在某个 L3 块 summary 里", () => {
      layers = buildTimelineLayers(events, 50);
      const ch2Event = events.find((e) => e.chapter === 2)!;
      // mainEvent 来自 effects.semanticSummary.mainEvent
      const ch2MainEvent = "第2章主事件";
      const found = layers.l3.some((block) =>
        block.summary.includes(ch2MainEvent),
      );
      expect(found).toBe(true);
    });
  });

  // 兜底场景：currentChapter 未知（0 / NaN / undefined）
  describe("currentChapter 未知兜底不崩", () => {
    const events = make50Events();

    it("currentChapter=0：L2/L3 空，L1 非空（取最近几章）", () => {
      const layers = buildTimelineLayers(events, 0);
      expect(layers.l2).toEqual([]);
      expect(layers.l3).toEqual([]);
      // L1 fallback：取最近若干章（非空）
      expect(layers.l1.length).toBeGreaterThan(0);
    });

    it("currentChapter=NaN：不抛，三层结构正常", () => {
      expect(() => buildTimelineLayers(events, NaN)).not.toThrow();
      const layers = buildTimelineLayers(events, NaN);
      expect(Array.isArray(layers.l1)).toBe(true);
      expect(Array.isArray(layers.l2)).toBe(true);
      expect(Array.isArray(layers.l3)).toBe(true);
    });
  });

  // 空 events
  describe("空 events 返回空三层", () => {
    it("返回 { l1: [], l2: [], l3: [] }", () => {
      const layers = buildTimelineLayers([], 10);
      expect(layers.l1).toEqual([]);
      expect(layers.l2).toEqual([]);
      expect(layers.l3).toEqual([]);
    });
  });

  // 乱序 events 应先按章号排序
  describe("events 乱序 → 排序后正确分层", () => {
    it("乱序 5 章 L1 仍是最近几章", () => {
      const shuffled = [
        makeEvent(5, "第5章摘要", "第5主"),
        makeEvent(1, "第1章摘要", "第1主"),
        makeEvent(3, "第3章摘要", "第3主"),
        makeEvent(2, "第2章摘要", "第2主"),
        makeEvent(4, "第4章摘要", "第4主"),
      ];
      const layers = buildTimelineLayers(shuffled, 5, { l1Window: 2 });
      const l1Chapters = layers.l1.map((e) => e.chapter).sort((a, b) => a - b);
      expect(l1Chapters).toEqual([4, 5]);
    });
  });

  // 同章多事件 → 合并为单条
  describe("同章多事件合并", () => {
    it("同章两条 event → L1 仍只产一条", () => {
      const events: readonly TimelineEvent[] = [
        { id: "a", chapter: 1, summary: "摘要A", participants: ["角A"] },
        { id: "b", chapter: 1, summary: "摘要B", participants: ["角B"] },
      ];
      const layers = buildTimelineLayers(events, 1, { l1Window: 3 });
      expect(layers.l1.length).toBe(1);
    });
  });

  // opts 覆盖测试
  describe("自定义 opts 生效", () => {
    it("l1Window=1 时 L1 只含 currentChapter 那章", () => {
      const events = make50Events();
      const layers = buildTimelineLayers(events, 50, { l1Window: 1 });
      const chapters = layers.l1.map((e) => e.chapter);
      expect(chapters).toEqual([50]);
    });

    it("l3BlockSize=10 时块大小变大", () => {
      const events = make50Events();
      const layers = buildTimelineLayers(events, 50, {
        l1Window: 3,
        l2Window: 15,
        l3BlockSize: 10,
      });
      // 远期 1-35 章，块大小 10 → [1-10, 11-20, 21-30, 31-35(不足整块)]
      expect(layers.l3.length).toBe(4);
      expect(layers.l3[0].fromChapter).toBe(1);
      expect(layers.l3[0].toChapter).toBe(10);
    });
  });

  // 无 effects.semanticSummary 时退回 summary
  describe("无 semanticSummary 的事件防御读取", () => {
    it("L1 event 无 effects → summary 字段不为空", () => {
      const events: readonly TimelineEvent[] = [
        { id: "x", chapter: 10, summary: "裸摘要", participants: [] },
      ];
      const layers = buildTimelineLayers(events, 10);
      expect(layers.l1[0].summary).toBe("裸摘要");
      expect(layers.l1[0].mainEvent).toBeUndefined();
    });

    it("L3 块无 mainEvent → summary 退回章节 summary 字符串", () => {
      const events: readonly TimelineEvent[] = [
        { id: "x1", chapter: 1, summary: "第1章摘要无主事件", participants: [] },
        { id: "x2", chapter: 2, summary: "第2章摘要无主事件", participants: [] },
        { id: "x3", chapter: 3, summary: "第3章摘要无主事件", participants: [] },
      ];
      const layers = buildTimelineLayers(events, 20, {
        l1Window: 1,
        l2Window: 5,
        l3BlockSize: 5,
      });
      // chapter 1-3 全在 L3（<=15）
      expect(layers.l3.length).toBeGreaterThan(0);
      const block = layers.l3[0];
      expect(block.summary.length).toBeGreaterThan(0);
    });
  });
});
