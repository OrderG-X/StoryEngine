/**
 * 故事时间线给模型看的样子（2026-10-10 引擎升级·第 1 期起；写作版本 P3a 起读投影的时间表 `timelineTable`）：
 * 每章是故事哪几天、星期几、离本章「昨天 / 前天 / 几天前」、里面有没有不在当下的段，算好了给模型，模型不做日期算术。
 *
 * 全书一个口径（P3 设计第 6 节）：「第 5 天」「第 5～6 天」「第 5 天以后」「不知道」；段说「回忆（3 年前）」「梦、想象或传闻」。
 * 「昨天 / N 天前」只用两个世界都确定、沿当下链算出来的相对天数（核心 elapsedDays），说不准的只给第几天；
 * 不知道的章照实说为什么不知道，不替它们定日子。星期是核心投影算的（只沿确定的相对天数推），这里不再推。
 */
import { daysText, elapsedDays, isExact, offsetText, timelineTable, type BookProjection, type ChapterTime, type DayRange, type TimeConflictView, type TimelineRow, type TimePoint } from "@actalk/story-core";

export const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

const sameRange = (a: DayRange | undefined, b: DayRange | undefined): boolean => a?.lo === b?.lo && a?.hi === b?.hi;
const exactValue = (range: DayRange | undefined): number | undefined => (range?.lo !== undefined && range.lo === range.hi ? range.lo : undefined);

/**
 * 一章是故事哪几天：「第 5 天」「第 5 天到第 6 天」「第 5～7 天到哪天说不准」；
 * 开头不知道就 undefined（调用方说「不知道」时说清为什么）。
 */
export function storySpanText(range: { readonly start?: DayRange; readonly end?: DayRange }, weekday?: number): string | undefined {
  if (!range.start) return undefined;
  const start = `${daysText(range.start)}${weekday !== undefined ? `（${WEEKDAY_NAMES[weekday]}）` : ""}`;
  if (sameRange(range.start, range.end)) return start;
  return `${start}到${range.end ? daysText(range.end) : "哪天说不准"}`;
}

/** 这章是哪天不知道的原因（不带「是哪天不知道」；定稿清单、给模型的表同一套说法）。 */
export function unknownDayWhy(row: TimelineRow): string {
  if (row.ledgerShort === "pending") return "这章的账还没记上";
  if (row.ledgerShort === "partial") return "这章的账没记全、时间没记上";
  if (row.legacyDay !== undefined) return `老书里记的约第 ${row.legacyDay} 天不可信`;
  if (row.relativeText) return `这章离上一章${offsetText(row.relativeText)}，不折成天`;
  if (row.presentLine === "unknown") return "没认出这章在不在当下线上";
  if (row.afterUnknown) return "前面有章没认出在不在当下线上";
  if (row.sincePrevious) return "前面有章是哪天不知道";
  return "这章离上一章多久说不准";
}

/** 一章那几天的说法（不带相对）：「故事第 7 天（周二）到第 8 天，傍晚」；整章是段、不知道的照实说。 */
export function chapterDaysText(row: TimelineRow): string {
  if (row.presentLine === false) return `整章不在当下线上（${row.segments.join("；") || "回忆、梦这类"}），不占故事的日子`;
  const span = row.presentLine === true ? storySpanText(row, row.weekday) : undefined;
  if (!span) return `${unknownDayWhy(row)}，是哪天不知道`;
  return [
    `故事${span}`,
    row.timeOfDay,
    row.presumed ? "按旧账推的、不算准" : undefined,
    row.segments.length > 0 ? `里面有不在当下的段：${row.segments.join("；")}` : undefined,
  ].filter(Boolean).join("，");
}

/** 相对说法：0 = 同一天，1 = 昨天，2 = 前天，正数 = 几天前，负数 = 几天后。 */
export function relativeDayLabel(delta: number): string {
  if (delta === 0) return "同一天";
  if (delta === 1) return "昨天";
  if (delta === 2) return "前天";
  return delta > 0 ? `${delta} 天前` : `${-delta} 天后`;
}

const timesOf = (projection: BookProjection): ReadonlyMap<number, ChapterTime> => new Map(projection.chapters.map((view) => [view.chapter, view.time]));

/**
 * 一章离「今天」多久：「昨天」「前天到昨天」。today = 今天那一刻；extra = 今天离那一刻再过几天（章纲：上一个当下章结尾 + dayOffset）。
 * 开头、结尾到今天都确定才给；说不准就不给（只给第几天）。
 */
function relativeOf(times: ReadonlyMap<number, ChapterTime>, row: TimelineRow, today: TimePoint, extra = 0): string | undefined {
  if (row.presentLine !== true) return undefined;
  const fromStart = elapsedDays(times, { chapter: row.chapter, at: "start" }, today);
  const fromEnd = elapsedDays(times, { chapter: row.chapter, at: "end" }, today);
  const startDays = exactValue(fromStart?.days);
  const endDays = exactValue(fromEnd?.days);
  if (startDays === undefined || endDays === undefined) return undefined;
  return startDays === endDays ? relativeDayLabel(startDays + extra) : `${relativeDayLabel(startDays + extra)}到${relativeDayLabel(endDays + extra)}`;
}

/** 前面最近的当下章（整章是段的跳过）；中间有没认出在不在当下线上的章 → "unknown"；前面没有 → undefined。 */
export function previousPresentChapter(projection: BookProjection, chapter: number): TimelineRow | "unknown" | undefined {
  const rows = timelineTable(projection, chapter - 1);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.presentLine === "unknown") return "unknown";
    if (row.presentLine === true) return row;
  }
  return undefined;
}

/**
 * 给模型看的时间对照表（核账、写手、章纲共用）：本章是哪天，前面各章分别是哪天、离本章开头多久、星期几、里面的段。
 * 本章还没定稿（或不在投影里）：只列前面各章是哪天，本章按正文里的说法对照。
 */
export function describeTimelineForChapter(projection: BookProjection, chapter: number, options: { readonly limit?: number } = {}): string | undefined {
  const rows = timelineTable(projection, chapter);
  const own = rows.find((row) => row.chapter === chapter);
  const earlier = rows.filter((row) => row.chapter < chapter).slice(-(options.limit ?? 12)).reverse();
  if (!own && earlier.length === 0) return undefined;
  const times = timesOf(projection);
  const anchored = own?.presentLine === true && own.start !== undefined;
  const unknown = [...earlier, ...(own ? [own] : [])].some((row) => row.presentLine === "unknown" || (row.presentLine === true && !row.start));
  return [
    own ? `本章（第 ${chapter} 章）：${chapterDaysText(own)}${anchored ? "" : "，以正文里的说法为准，对照下表"}` : `本章（第 ${chapter} 章）：还没定稿，是哪天以正文里的说法为准，对照下表`,
    ...earlier.map((row) => {
      const relative = own?.presentLine === true ? relativeOf(times, row, { chapter, at: "start" }) : undefined;
      return `第 ${row.chapter} 章：${chapterDaysText(row)}${relative ? `；离本章开头：${relative}` : ""}`;
    }),
    own?.presentLine === true
      ? "日子以这张表为准，说「昨天、前天、几天前、周几」照表来，不要自己推算；表上没给「离本章开头」的，是隔了多久说不准，别替它定；正文和台词里不写「故事第几天」。"
      : "前面各章是哪天以这张表为准，不要自己推算。",
    ...(earlier.some((row) => row.segments.length > 0 || row.presentLine === false) ? ["（回忆、梦里的日子是那段自己的，不是当下的，别拿它和当下的「昨天、明天」对。）"] : []),
    ...(unknown ? ["（有的章是哪天不知道，别替它们定日子。）"] : []),
  ].join("\n");
}

/** 章纲给写手的故事日历（写作版本 P3a：今天 = 上一个当下章结尾 + 章纲的 dayOffset，可负；整章是回忆、梦的不给今天）。 */
export interface PlanClock {
  readonly today: string;
  readonly earlier: readonly string[];
}

/**
 * 写这章时「今天」是哪天、前面各章离今天多久。plan：本章开场离第 after 章（拟纲时的上一个当下章）结尾过了 dayOffset 天；
 * frame：整章不在当下线上。前面没有当下章 = 本章就是第 1 天。哪样说不准就只列第几天，不替模型定相对说法。
 */
export function planClock(
  projection: BookProjection,
  chapter: number,
  plan: { readonly dayOffset?: number; readonly after?: number; readonly frame?: "past" | "other"; readonly time?: string },
  limit = 12,
): PlanClock | undefined {
  const rows = timelineTable(projection, chapter - 1).slice(-limit).reverse();
  const times = timesOf(projection);
  const after = plan.after !== undefined ? rows.find((row) => row.chapter === plan.after && row.presentLine === true) : undefined;
  const flashback = plan.frame !== undefined;
  const offset = flashback ? undefined : plan.dayOffset;
  // 前面没有当下章（也没有认不出的章）：本章开头就是第 1 天。
  const firstDay = !flashback && plan.after === undefined && rows.every((row) => row.presentLine === false);
  const todayRange = firstDay ? { lo: 1, hi: 1 } : after && offset !== undefined && after.end ? shift(after.end, offset) : undefined;
  const weekday = after && offset !== undefined ? weekdayAfter(times.get(after.chapter), offset) : undefined;
  const scene = plan.time ? `（${plan.time}）` : "";
  const today = flashback
    ? `本章整章是${plan.frame === "past" ? "回忆" : "梦、想象或传闻"}${scene}，不在当下线上：里面的日子是那段自己的，下表的「昨天、前天」不适用`
    : todayRange
      ? `本章是故事${daysText(todayRange)}${weekday !== undefined ? `，${WEEKDAY_NAMES[weekday]}` : ""}${scene}`
      : `本章是哪天说不准${scene}：前面各章是哪天照下表，相对说法以正文为准`;
  const earlier = rows.map((row) => {
    const relative = !flashback && after && offset !== undefined ? relativeOf(times, row, { chapter: after.chapter, at: "end" }, offset) : undefined;
    return `第 ${row.chapter} 章：${chapterDaysText(row)}${relative ? `；离今天：${relative}` : ""}`;
  });
  if (!todayRange && !flashback && earlier.length === 0) return undefined;
  return { today, earlier };
}

function shift(range: DayRange, days: number): DayRange {
  return { ...(range.lo !== undefined ? { lo: range.lo + days } : {}), ...(range.hi !== undefined ? { hi: range.hi + days } : {}) };
}

/** 上一个当下章开头是周几、章内跨了确定的几天：往后 offset 天是周几。 */
function weekdayAfter(time: ChapterTime | undefined, offset: number): number | undefined {
  const span = exactValue(time?.span);
  if (time?.weekday === undefined || span === undefined) return undefined;
  return (((time.weekday + span + offset) % 7) + 7) % 7;
}

/** 写前备忘里一章那几天：「第 11 天傍晚」「第 5 天到第 6 天」「账待记」「不在当下（回忆（3 年前））」。 */
function memoDaysText(row: TimelineRow): string {
  if (row.ledgerShort === "pending") return "账待记";
  if (row.ledgerShort === "partial") return "账没记全";
  if (row.presentLine === false) return `不在当下（${row.segments.join("；") || "回忆、梦这类"}）`;
  const span = row.presentLine === true ? storySpanText(row) : undefined;
  if (!span) return "哪天不知道";
  const oneDay = isExact(row.start) && sameRange(row.start, row.end);
  return `${span}${oneDay && row.timeOfDay ? row.timeOfDay : ""}${row.presumed ? "（按旧账推的）" : ""}`;
}

/**
 * 写第 chapter 章前「接哪天」：上一章是哪几天；上一章整章是回忆、梦的，再说当下停在哪章哪天（写手接的是当下线）。
 * 前面一章都没有 → undefined。
 */
export function continueDayText(projection: BookProjection, chapter: number): string | undefined {
  const last = timelineTable(projection, chapter - 1).at(-1);
  if (!last) return undefined;
  const own = memoDaysText(last);
  if (last.presentLine !== false || last.ledgerShort) return own;
  const present = previousPresentChapter(projection, chapter);
  const tail = present === undefined ? "前面还没有当下线上的章" : present === "unknown" ? "当下停在哪天不知道" : `当下停在第 ${present.chapter} 章：${memoDaysText(present)}`;
  return `${own}；${tail}`;
}

/** 作者定的天数和按记下的推出来的对不上（只说哪两样不能同时成立，不判谁对）。 */
export function timeConflictText(conflict: Pick<TimeConflictView, "kind" | "authorDay" | "expected">): string {
  return `你定的第 ${conflict.authorDay} 天，和按${conflict.kind === "time-start" ? "上一章、这章开头" : "这章里换天"}推出来的${daysText(conflict.expected)}对不上`;
}

/** 天数要作者看一下的一章（写作版本 P3a 2.4～2.6）。 */
export interface TimeCheck {
  readonly chapter: number;
  /** unproven = 导入时记成作者定的、证明不了；boundary = 换天规矩改了、按天亮判的不算了；conflict = 作者定的和记下的对不上。 */
  readonly kind: "unproven" | "boundary" | "conflict";
  /** 给作者看的一句（不带章号）。 */
  readonly text: string;
  /** unproven：导入时记的那天（作者点「对，是这天」就记它）。 */
  readonly day?: number;
}

/** 全书天数要作者看的：概况和 AI 栏「不急的事」列，作者定了（记了天数、点了以我定的为准）就不再列。 */
export function timeChecksOf(projection: Pick<BookProjection, "chapters" | "timeConflicts">): TimeCheck[] {
  const checks: TimeCheck[] = [];
  for (const { chapter, time } of projection.chapters) {
    if (time.authorStart === undefined && time.legacyDay?.reason === "unproven") {
      checks.push({ chapter, kind: "unproven", day: time.legacyDay.day, text: `导入时记成你定的第 ${time.legacyDay.day} 天，证明不了是你定的，现在算不知道` });
    } else if (time.boundaryInvalidated) {
      checks.push({ chapter, kind: "boundary", text: "天数是按天亮换日判的，换天规矩改成过了半夜就算之后，是哪天不知道了" });
    }
  }
  for (const conflict of projection.timeConflicts) checks.push({ chapter: conflict.chapter, kind: "conflict", text: timeConflictText(conflict) });
  return checks.sort((a, b) => a.chapter - b.chapter);
}
