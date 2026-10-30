// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chapterEndDay, describeTimelineForChapter, timelineEntryFor, weekdayOfDay, type StoryTimeline, type TimelineEntry } from "./story-timeline.js";

// 天数怎么排是投影的事（核心 projection 的测试）；这里只测读者形状上的推星期和给模型的对照表。
const timeline = (entries: TimelineEntry[]): StoryTimeline => ({ schemaVersion: 1, entries });

/** 《半页书店》：周三起，一天一章，第 5 章「三天后，周二」。0 = 周一。 */
function banye(): StoryTimeline {
  return timeline([
    { chapter: 1, day: 1, weekday: 2, source: "declared", quote: "周三，下午四点十分。" },
    { chapter: 2, day: 2, daysSincePrevious: 1, source: "declared", quote: "第二天雨停了" },
    { chapter: 3, day: 3, weekday: 4, source: "declared", quote: "周五下午" },
    { chapter: 4, day: 4, weekday: 5, source: "declared", quote: "周六早上" },
    { chapter: 5, day: 7, daysSincePrevious: 3, weekday: 1, source: "declared", quote: "三天后，周二下午" },
  ]);
}

describe("故事时间线（读者形状）", () => {
  it("没明写星期的日子按最近的锚点推", () => {
    const t = banye();
    expect(weekdayOfDay(t, 7)).toBe(1);
    expect(weekdayOfDay(t, 2)).toBe(3);
    expect(weekdayOfDay(timeline([{ chapter: 1, day: 1, source: "fallback" }]), 1)).toBeUndefined();
  });

  it("给模型的对照表：本章哪天、前面各章是昨天 / 前天 / 几天前，带星期；不让模型自己算", () => {
    const text = describeTimelineForChapter(banye(), 5)!;
    expect(text).toContain("本章（第 5 章）：故事第 7 天（周二）");
    expect(text).toContain("第 4 章：故事第 4 天（周六），3 天前");
    expect(text).toContain("第 3 章：故事第 3 天（周五），4 天前");
    expect(text).toContain("不要自己推算");
    expect(describeTimelineForChapter(timeline([]), 1)).toBeUndefined();
    const draftView = describeTimelineForChapter(banye(), 6)!;
    expect(draftView).toContain("本章（第 6 章）：还没定稿");
    expect(draftView).toContain("第 5 章：故事第 7 天（周二）");
    expect(describeTimelineForChapter(banye(), 6, { currentDay: 8 })).toContain("第 5 章：故事第 7 天（周二），昨天");
  });

  it("章内换了天：表上标出两天、两个相对说法", () => {
    const t = timeline([
      ...banye().entries,
      { chapter: 6, day: 7, daysSincePrevious: 0, daysInChapter: 1, timeOfDay: "傍晚", source: "declared", quote: "周二傍晚" },
      { chapter: 7, day: 9, daysSincePrevious: 1, source: "declared", quote: "第二天上午" },
    ]);
    expect(chapterEndDay(timelineEntryFor(t, 6)!)).toBe(8);
    expect(describeTimelineForChapter(t, 7)).toContain("第 6 章：故事第 7 天（周二）～第 8 天（周三），前天～昨天，傍晚");
  });

  it("有章账待记：那几章和接着它算的章照实说哪天不知道、别替它们定日子；本章不知道也照实说（P2b）", () => {
    const t: StoryTimeline = {
      ...timeline([{ chapter: 1, day: 1, weekday: 2, source: "declared", quote: "周三" }]),
      unknownDays: [{ chapter: 2, own: "pending" }, { chapter: 3 }],
    };
    const text = describeTimelineForChapter(t, 4)!;
    expect(text).toContain("第 2 章：这章的账还没记上，是哪天不知道");
    expect(text).toContain("第 3 章：前面有章的时间没记上，是哪天不知道");
    expect(text).toContain("别替它们定日子");
    // 近的在前，和知道哪天的章排在一起。
    expect(text.indexOf("第 3 章")).toBeLessThan(text.indexOf("第 2 章"));
    expect(text.indexOf("第 2 章")).toBeLessThan(text.indexOf("第 1 章"));
    expect(describeTimelineForChapter(t, 3)).toContain("本章（第 3 章）：前面有章的时间没记上，是哪天不知道，以正文里的说法为准");
    // 没有账待记的章：和原来一字不差。
    expect(describeTimelineForChapter(banye(), 5)).not.toContain("不知道");
  });

  it("有估的天数：表上如实注明", () => {
    const t = timeline([
      { chapter: 1, day: 1, source: "declared", quote: "清晨" },
      { chapter: 2, day: 2, source: "fallback" },
    ]);
    expect(describeTimelineForChapter(t, 2)).toContain("按「上一章 +1」估的");
  });
});
