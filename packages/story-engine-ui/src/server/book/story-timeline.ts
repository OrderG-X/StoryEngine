/**
 * 故事时间线的读者形状（2026-10-10 引擎升级·第 1 期起；写作版本 P2b 起从投影现算，见 story-views.ts）：
 * 每章是故事第几天、星期几、章内过了几天，给模型的是算好的对照表（describeTimelineForChapter），模型不做日期算术。
 *
 * 来源：作者（author）> 正文里的时间说法（declared，引原句）> 判的（plan）> 估的（fallback，绝不静默：表上注明「估的」）。
 * 星期几只给正文 / 作者明写的；其它日子由最近的锚点推算（weekdayOfDay）。
 */
import { daysText, type DayRange } from "@actalk/story-core";

export type TimelineSource = "author" | "declared" | "plan" | "fallback";

const sameRange = (a: DayRange | undefined, b: DayRange | undefined): boolean => a?.lo === b?.lo && a?.hi === b?.hi;

/**
 * 一章是故事哪几天，全书一个口径（写作版本 P3 设计第 6 节）：「第 5 天」「第 5 天到第 6 天」「第 5～7 天到哪天说不准」；
 * 开头不知道就 undefined（调用方说「不知道」时说清为什么）。
 */
export function storySpanText(range: { readonly start?: DayRange; readonly end?: DayRange }): string | undefined {
  if (!range.start) return undefined;
  if (sameRange(range.start, range.end)) return daysText(range.start);
  return `${daysText(range.start)}到${range.end ? daysText(range.end) : "哪天说不准"}`;
}

export interface TimelineEntry {
  readonly chapter: number;
  /** 故事第几天（从 1 起）。 */
  readonly day: number;
  /** 正文或作者明写的星期：0 = 周一 … 6 = 周日。推算出来的不存。 */
  readonly weekday?: number;
  /** 正文里的时段说法（「下午」「傍晚」），原样。 */
  readonly timeOfDay?: string;
  /** 正文说和上一章隔了几天（0 = 同一天）。只有 declared 才有。 */
  readonly daysSincePrevious?: number;
  /**
   * 本章内过了几天（章末 = day + daysInChapter；缺省 = 整章同一天）。下一章的「隔几天」「上一章 +1」都从章末那天算
   * （2026-10-11 真机验收：第 6 章写到「第二天上午」，只记开场那天，第 7 章少算一天）。
   */
  readonly daysInChapter?: number;
  readonly source: TimelineSource;
  /** 依据的原句（declared 必有）。 */
  readonly quote?: string;
}

/** 天数不知道的章（写作版本 P2b 设计 3.3）：这章的时间没记上（账待记、没记全），或接着一章天数不知道的章算的（直到下一个作者定的天数）。 */
export interface UnknownDay {
  readonly chapter: number;
  /** 这章自己的时间没记上：pending = 账还没记上；partial = 账没记全。没有 = 前面有章不知道。 */
  readonly own?: "pending" | "partial";
}

export interface StoryTimeline {
  readonly schemaVersion: 1;
  /** 天数知道的章。 */
  readonly entries: readonly TimelineEntry[];
  /** 定稿了、天数不知道的章（不在 entries 里；没给 = 没有）。 */
  readonly unknownDays?: readonly UnknownDay[];
}

/** 这一章的天数是不是不知道。 */
export function unknownDayOf(timeline: StoryTimeline, chapter: number): UnknownDay | undefined {
  return timeline.unknownDays?.find((item) => item.chapter === chapter);
}

const unknownDayText = (item: UnknownDay): string =>
  item.own === "pending" ? "这章的账还没记上，是哪天不知道" : item.own === "partial" ? "这章的账没记全、时间没记上，是哪天不知道" : "前面有章的时间没记上，是哪天不知道";

/** 一章结束时是故事第几天。 */
export function chapterEndDay(entry: TimelineEntry): number {
  return entry.day + (entry.daysInChapter ?? 0);
}
export const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

/** 推算某一天是星期几：取离它最近的、明写了星期的锚点。没有锚点 → undefined。 */
export function weekdayOfDay(timeline: StoryTimeline, day: number): number | undefined {
  const anchors = timeline.entries.filter((entry) => entry.weekday !== undefined);
  if (anchors.length === 0) return undefined;
  const anchor = anchors.reduce((best, entry) => (Math.abs(entry.day - day) < Math.abs(best.day - day) ? entry : best));
  return (((anchor.weekday! + day - anchor.day) % 7) + 7) % 7;
}

export function timelineEntryFor(timeline: StoryTimeline, chapter: number): TimelineEntry | undefined {
  return timeline.entries.find((entry) => entry.chapter === chapter);
}

/** 「故事第 7 天（周二）」。 */
export function formatStoryDay(timeline: StoryTimeline, day: number): string {
  const weekday = weekdayOfDay(timeline, day);
  return `故事第 ${day} 天${weekday !== undefined ? `（${WEEKDAY_NAMES[weekday]}）` : ""}`;
}

/** 一章占的日子：「故事第 7 天（周二）」，跨了天就是「故事第 7 天（周二）～第 8 天（周三）」。 */
function formatChapterDays(timeline: StoryTimeline, entry: TimelineEntry): string {
  const end = chapterEndDay(entry);
  if (end === entry.day) return formatStoryDay(timeline, entry.day);
  // 不猜白名单：日期归一
  return `${formatStoryDay(timeline, entry.day)}～${formatStoryDay(timeline, end).replace(/^故事/u, "")}`;
}

function relativeSpanLabel(current: number, entry: TimelineEntry): string {
  const end = chapterEndDay(entry);
  return end === entry.day ? relativeLabel(current - entry.day) : `${relativeLabel(current - entry.day)}～${relativeLabel(current - end)}`;
}

function relativeLabel(delta: number): string {
  if (delta === 0) return "同一天";
  if (delta === 1) return "昨天";
  if (delta === 2) return "前天";
  if (delta > 0) return `${delta} 天前`;
  return `${-delta} 天后`;
}

/**
 * 给模型看的时间对照表（拟章纲、写正文、记账、核账共用）：本章是哪天，前面各章分别是「昨天 / 前天 / 几天前」、星期几。
 * 模型照表说日子、照表判日子，不自己推算。currentDay 缺省 = 时间线里本章那条（还没定稿时传入预估）。
 */
export function describeTimelineForChapter(
  timeline: StoryTimeline,
  chapter: number,
  options: { readonly currentDay?: number; readonly limit?: number } = {},
): string | undefined {
  const ownUnknown = options.currentDay === undefined ? unknownDayOf(timeline, chapter) : undefined;
  const current = options.currentDay ?? timelineEntryFor(timeline, chapter)?.day;
  const limit = options.limit ?? 12;
  // 前面各章按章号排，天数不知道的章照样列一行、如实说不知道（不跳过，免得模型把再前一章当成上一章）。
  const earlier = [
    ...timeline.entries.filter((entry) => entry.chapter < chapter).map((entry) => ({ chapter: entry.chapter, entry })),
    ...(timeline.unknownDays ?? []).filter((item) => item.chapter < chapter).map((item) => ({ chapter: item.chapter, unknown: item })),
  ].sort((a, b) => a.chapter - b.chapter).slice(-limit);
  const unsure = timeline.entries.some((entry) => entry.chapter <= chapter && entry.source === "fallback");
  const unknownNote = earlier.some((row) => "unknown" in row) || ownUnknown ? ["（有的章时间没记上，那几章是哪天不知道，别替它们定日子。）"] : [];
  if (current === undefined) {
    // 本章还没定是哪天（还没定稿的稿子、天数不知道的章）：只列前面各章是哪天、周几，本章按正文里的说法对照这张表。
    if (earlier.length === 0) return undefined;
    return [
      ownUnknown ? `本章（第 ${chapter} 章）：${unknownDayText(ownUnknown)}，以正文里的说法为准，对照下表` : `本章（第 ${chapter} 章）：还没定稿，是哪天以正文里的说法为准，对照下表`,
      ...earlier.reverse().map((row) => ("unknown" in row
        ? `第 ${row.chapter} 章：${unknownDayText(row.unknown)}`
        : `第 ${row.chapter} 章：${formatChapterDays(timeline, row.entry)}${row.entry.timeOfDay ? `，${row.entry.timeOfDay}` : ""}`)),
      "前面各章是哪天以这张表为准，不要自己推算。",
      ...(unsure ? ["（表里有的章天数是按「上一章 +1」估的，作者还没确认。）"] : []),
      ...unknownNote,
    ].join("\n");
  }
  const own = options.currentDay === undefined ? timelineEntryFor(timeline, chapter) : undefined;
  return [
    `本章（第 ${chapter} 章）：${own ? formatChapterDays(timeline, own) : formatStoryDay(timeline, current)}`,
    ...earlier.reverse().map((row) => ("unknown" in row
      ? `第 ${row.chapter} 章：${unknownDayText(row.unknown)}`
      : `第 ${row.chapter} 章：${formatChapterDays(timeline, row.entry)}，${relativeSpanLabel(current, row.entry)}${row.entry.timeOfDay ? `，${row.entry.timeOfDay}` : ""}`)),
    "日子以这张表为准，说「昨天、前天、几天前、周几」照表来，不要自己推算；正文和台词里不写「故事第几天」。",
    ...(unsure ? ["（表里有的章天数是按「上一章 +1」估的，作者还没确认。）"] : []),
    ...unknownNote,
  ].join("\n");
}
