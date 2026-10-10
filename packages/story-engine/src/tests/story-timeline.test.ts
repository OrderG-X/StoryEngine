import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  absoluteDayForRelative,
  chapterEndDay,
  deriveTimelineFromLegacy,
  describeTimelineForChapter,
  emptyStoryTimeline,
  parseWeekday,
  placeChapter,
  readStoryTimeline,
  removeChapter,
  StoryModelFileError,
  timelineEntryFor,
  validateStoryTimeline,
  weekdayOfDay,
  type StoryTimeline,
} from "../story-timeline.js";

/** 《半页书店》：周三起，一天一章，第 5 章「三天后，周二」。 */
function banye(): StoryTimeline {
  let t = emptyStoryTimeline();
  t = placeChapter(t, { chapter: 1, declared: { weekday: parseWeekday("周三"), quote: "周三，下午四点十分。" } }).timeline;
  t = placeChapter(t, { chapter: 2, declared: { daysSincePrevious: 1, quote: "第二天雨停了" } }).timeline;
  t = placeChapter(t, { chapter: 3, declared: { weekday: parseWeekday("周五"), quote: "周五下午" } }).timeline;
  t = placeChapter(t, { chapter: 4, declared: { weekday: parseWeekday("周六"), quote: "周六早上" } }).timeline;
  t = placeChapter(t, { chapter: 5, declared: { daysSincePrevious: 3, weekday: parseWeekday("周二"), quote: "三天后，周二下午" } }).timeline;
  return t;
}

describe("故事时间线", () => {
  it("按正文说法排日子：周三第 1 天 → 第二天 → 周五 → 周六 → 三天后（周二）= 第 7 天", () => {
    const t = banye();
    expect(t.entries.map((e) => e.day)).toEqual([1, 2, 3, 4, 7]);
    expect(t.entries.every((e) => e.source === "declared")).toBe(true);
    expect(weekdayOfDay(t, 7)).toBe(parseWeekday("周二"));
    expect(weekdayOfDay(t, 2)).toBe(parseWeekday("周四"));
  });

  it("没有任何说法 → 上一章 +1，标 fallback（调用方要提醒作者确认）；第一章是第 1 天", () => {
    let t = emptyStoryTimeline();
    t = placeChapter(t, { chapter: 1 }).timeline;
    t = placeChapter(t, { chapter: 2, plan: { day: 10 } }).timeline;
    t = placeChapter(t, { chapter: 3 }).timeline;
    expect(t.entries.map((e) => [e.day, e.source])).toEqual([[1, "fallback"], [10, "plan"], [11, "fallback"]]);
  });

  it("作者改了第 2 章的天数，后面靠相对关系推出来的章跟着顺延；作者 / 章纲定死的不动", () => {
    let t = banye();
    t = placeChapter(t, { chapter: 2, author: { day: 3 } }).timeline;
    // 第 3、4 章只说了周五、周六：第 3 天是周五 → 第 3 章仍第 3 天（同一天算 0）
    expect(timelineEntryFor(t, 2)).toMatchObject({ day: 3, source: "author" });
    expect(t.entries.map((e) => e.day)).toEqual([1, 3, 3, 4, 7]);
    let fixed = placeChapter(emptyStoryTimeline(), { chapter: 1 }).timeline;
    fixed = placeChapter(fixed, { chapter: 2, plan: { day: 5 } }).timeline;
    fixed = placeChapter(fixed, { chapter: 3 }).timeline;
    fixed = placeChapter(fixed, { chapter: 1, author: { day: 2 } }).timeline;
    expect(fixed.entries.map((e) => e.day)).toEqual([2, 5, 6]);
  });

  it("删掉一章（撤销定稿）后面的相对章顺延回来", () => {
    let t = emptyStoryTimeline();
    t = placeChapter(t, { chapter: 1 }).timeline;
    t = placeChapter(t, { chapter: 2, declared: { daysSincePrevious: 5, quote: "五天后" } }).timeline;
    t = placeChapter(t, { chapter: 3 }).timeline;
    expect(t.entries.map((e) => e.day)).toEqual([1, 6, 7]);
    expect(removeChapter(t, 2).entries.map((e) => e.day)).toEqual([1, 2]);
  });

  it("给模型的对照表：本章哪天、前面各章是昨天 / 前天 / 几天前，带星期；不让模型自己算", () => {
    const text = describeTimelineForChapter(banye(), 5)!;
    expect(text).toContain("本章（第 5 章）：故事第 7 天（周二）");
    expect(text).toContain("第 4 章：故事第 4 天（周六），3 天前");
    expect(text).toContain("第 3 章：故事第 3 天（周五），4 天前");
    expect(text).toContain("不要自己推算");
    expect(describeTimelineForChapter(emptyStoryTimeline(), 1)).toBeUndefined();
    const draftView = describeTimelineForChapter(banye(), 6)!;
    expect(draftView).toContain("本章（第 6 章）：还没定稿");
    expect(draftView).toContain("第 5 章：故事第 7 天（周二）");
    expect(describeTimelineForChapter(banye(), 6, { currentDay: 8 })).toContain("第 5 章：故事第 7 天（周二），昨天");
  });

  it("章内换了天：下一章从章末那天往后算（第 6 章周二写到第二天，第 7 章「第二天上午」是周四）", () => {
    let t = banye();
    t = placeChapter(t, { chapter: 6, daysInChapter: 1, declared: { daysSincePrevious: 0, timeOfDay: "傍晚", quote: "周二傍晚" } }).timeline;
    t = placeChapter(t, { chapter: 7, declared: { daysSincePrevious: 1, quote: "第二天上午" } }).timeline;
    expect(timelineEntryFor(t, 6)).toMatchObject({ day: 7, daysInChapter: 1 });
    expect(chapterEndDay(timelineEntryFor(t, 6)!)).toBe(8);
    expect(timelineEntryFor(t, 7)!.day).toBe(9);
    expect(weekdayOfDay(t, 9)).toBe(parseWeekday("周四"));
    // 没说法的 fallback 也从章末 +1；作者改了第 5 章，跨天的第 6 章顺延时跨度保留
    expect(placeChapter(t, { chapter: 8 }).entry.day).toBe(10);
    const moved = placeChapter(t, { chapter: 5, author: { day: 8 } }).timeline;
    expect(timelineEntryFor(moved, 6)).toMatchObject({ day: 8, daysInChapter: 1 });
    expect(timelineEntryFor(moved, 7)!.day).toBe(10);
    // 撤销第 6 章：第 7 章回到第 5 章的第二天
    expect(timelineEntryFor(removeChapter(t, 6), 7)!.day).toBe(8);
    // 对照表标出两天、两个相对说法；读写往返不丢跨度
    const text = describeTimelineForChapter(t, 7)!;
    expect(text).toContain("第 6 章：故事第 7 天（周二）～第 8 天（周三），前天～昨天");
    expect(validateStoryTimeline(JSON.parse(JSON.stringify(t))).timeline).toEqual(t);
  });

  it("相对说法换算；星期写法宽进", () => {
    expect(absoluteDayForRelative("前天", 4)).toBe(2);
    expect(absoluteDayForRelative("大前天", 2)).toBeUndefined();
    expect(absoluteDayForRelative("下周", 4)).toBeUndefined();
    expect(parseWeekday("星期天")).toBe(6);
    expect(parseWeekday("礼拜一")).toBe(0);
    expect(parseWeekday(3)).toBe(3);
    expect(parseWeekday("周八")).toBeUndefined();
  });

  it("校验宽进：坏条目丢掉不连坐；根不是对象 → 说清哪个文件坏了", () => {
    const { timeline, dropped } = validateStoryTimeline({ entries: [{ chapter: 1, day: 1, source: "plan" }, { chapter: "x" }, { chapter: 2, day: 0, source: "plan" }] });
    expect(timeline.entries).toHaveLength(1);
    expect(dropped).toBe(2);
    expect(() => validateStoryTimeline([])).toThrow(StoryModelFileError);
  });

  it("老书没有时间线文件：由章纲和已定稿章节现推（中间章纲记了第 10 天，后面从 11 往后数，不回落到章号）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "timeline-legacy-"));
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "drafts", "plans"), { recursive: true });
    for (const n of [1, 2, 3, 4]) await writeFile(join(dir, "chapters", `000${n}.md`), "正文", "utf-8");
    await writeFile(join(dir, "drafts", "plans", "chapter-0002.json"), JSON.stringify({ storyDay: 10, scene: { time: "周一上午" } }), "utf-8");
    const derived = await deriveTimelineFromLegacy(dir);
    expect(derived.entries.map((e) => [e.chapter, e.day, e.source])).toEqual([[1, 1, "fallback"], [2, 10, "plan"], [3, 11, "fallback"], [4, 12, "fallback"]]);
    expect(weekdayOfDay(derived, 12)).toBe(parseWeekday("周三"));
    const read = await readStoryTimeline(dir);
    expect(read.derived).toBe(true);
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "timeline.json"), "{坏的", "utf-8");
    await expect(readStoryTimeline(dir)).rejects.toThrow("story/timeline.json");
  });
});

describe("记账换算日子（引擎按时间线算）", () => {
  it("昨天 / 后天 / 本章说的后天 → 故事第 N 天（周X）；模型编的第几天只留星期；「目前天气」不动", async () => {
    const { absolutizeRelativeDaysInText } = await import("../story-timeline.js");
    const t = banye();
    expect(absolutizeRelativeDaysInText("周屿说本章说的后天上午来取书", 4, t)).toBe("周屿说故事第 6 天（周一）上午来取书");
    expect(absolutizeRelativeDaysInText("昨晚有人敲门，目前天气转凉", 3, t)).toBe("故事第 2 天（周四）晚上有人敲门，目前天气转凉");
    expect(absolutizeRelativeDaysInText("周屿故事第3天（周六）一早会来", 2, t)).toBe("周屿周六一早会来");
  });
});
