/**
 * 故事时间线（2026-10-10 引擎升级·第 1 期）：每章是故事第几天、星期几，成为引擎自己的数据。
 *
 * 为什么：以前「第几天」只从章纲读，没有章纲就拿章号顶上（commit-plan-builder 的 storyDay 兜底），
 * 作者自己写的章一律猜错；拟章纲、写正文、记账、核账四处又各让模型自己推算日子——
 * 实测核账的误报大半是模型算错日子，记账也把「周六」记成「故事第 3 天」。
 *
 * 规则：
 *  - 每章一条，来源按优先级：作者（author）> 正文里的时间说法（declared，引原句）> 章纲（plan）> 上一章 +1（fallback）。
 *  - fallback 绝不静默：调用方（定稿清单）要把它标成「天数没把握，请确认」。
 *  - 作者改了某章，后面靠「隔几天」「上一章 +1」推出来的章跟着顺延；作者或章纲定死的天数不动。
 *  - 星期几只存正文 / 作者明写的；其它日子由最近的锚点推算（weekdayOfDay）。
 *  - 给模型的是算好的对照表（describeTimelineForChapter），模型不做日期算术。
 * 存 story/timeline.json；老书没有这个文件时由章纲和已定稿章节现推（deriveTimelineFromLegacy），不写盘。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type TimelineSource = "author" | "declared" | "plan" | "fallback";

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

export interface StoryTimeline {
  readonly schemaVersion: 1;
  readonly entries: readonly TimelineEntry[];
}

export const STORY_TIMELINE_SCHEMA_VERSION = 1;

/** 一章结束时是故事第几天。 */
export function chapterEndDay(entry: TimelineEntry): number {
  return entry.day + (entry.daysInChapter ?? 0);
}
export const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

const SOURCES: readonly TimelineSource[] = ["author", "declared", "plan", "fallback"];

/** 故事资料文件读坏了（不是不存在）：说清是哪个文件、坏在哪，绝不拿默认值顶上。 */
export class StoryModelFileError extends Error {
  readonly code = "STORY_MODEL_FILE_INVALID";
  constructor(readonly file: string, readonly reason: string) {
    super(`故事资料文件 ${file} 读不了：${reason}`);
    this.name = "StoryModelFileError";
  }
}

export function storyTimelinePath(projectDir: string): string {
  return join(projectDir, "story", "timeline.json");
}

export function emptyStoryTimeline(): StoryTimeline {
  return { schemaVersion: STORY_TIMELINE_SCHEMA_VERSION, entries: [] };
}

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;

/** 星期的各种写法 → 0..6（周一..周日）；认不出 → undefined。 */
export function parseWeekday(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) return value;
  if (typeof value !== "string") return undefined;
  const match = /(?:周|星期|礼拜)([一二三四五六日天])/u.exec(value);
  if (!match) return undefined;
  const index = "一二三四五六日".indexOf(match[1] === "天" ? "日" : match[1]);
  return index >= 0 ? index : undefined;
}

/** 宽进校验：根不是对象 → 抛 StoryModelFileError；单条坏了丢掉并计数（不连坐整个文件）。 */
export function validateStoryTimeline(raw: unknown, file = "story/timeline.json"): { readonly timeline: StoryTimeline; readonly dropped: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StoryModelFileError(file, "内容不是一个对象");
  const entriesRaw = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw)) throw new StoryModelFileError(file, "缺少 entries 列表");
  const entries: TimelineEntry[] = [];
  let dropped = 0;
  for (const item of entriesRaw) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const chapter = positiveInt(record?.chapter);
    const day = positiveInt(record?.day);
    const source = SOURCES.includes(record?.source as TimelineSource) ? (record!.source as TimelineSource) : undefined;
    if (!record || chapter === undefined || day === undefined || !source) {
      dropped += 1;
      continue;
    }
    const weekday = parseWeekday(record.weekday);
    const since = typeof record.daysSincePrevious === "number" && Number.isInteger(record.daysSincePrevious) && record.daysSincePrevious >= 0
      ? record.daysSincePrevious
      : undefined;
    const span = positiveInt(record.daysInChapter);
    entries.push({
      chapter,
      day,
      ...(weekday !== undefined ? { weekday } : {}),
      ...(typeof record.timeOfDay === "string" && record.timeOfDay.trim() ? { timeOfDay: record.timeOfDay.trim() } : {}),
      ...(since !== undefined ? { daysSincePrevious: since } : {}),
      ...(span !== undefined ? { daysInChapter: span } : {}),
      source,
      ...(typeof record.quote === "string" && record.quote.trim() ? { quote: record.quote.trim() } : {}),
    });
  }
  return { timeline: { schemaVersion: STORY_TIMELINE_SCHEMA_VERSION, entries: sortEntries(dedupeByChapter(entries)) }, dropped };
}

function dedupeByChapter(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const byChapter = new Map<number, TimelineEntry>();
  for (const entry of entries) byChapter.set(entry.chapter, entry);
  return [...byChapter.values()];
}

function sortEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => a.chapter - b.chapter);
}

/**
 * 读时间线：有文件就校验后返回（坏了如实抛）；没有文件（老书）由章纲和已定稿章节现推，derived=true，不写盘。
 */
export async function readStoryTimeline(projectDir: string): Promise<{ readonly timeline: StoryTimeline; readonly derived: boolean }> {
  let text: string;
  try {
    text = await readFile(storyTimelinePath(projectDir), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { timeline: await deriveTimelineFromLegacy(projectDir), derived: true };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoryModelFileError("story/timeline.json", "不是合法的 JSON");
  }
  return { timeline: validateStoryTimeline(parsed).timeline, derived: false };
}

/**
 * 老书的时间线：每个已定稿章节，有章纲天数用章纲（plan），没有就上一章 +1（fallback）。
 * 和旧逻辑「天数 = 章号」不同：中间有一章记了「第 10 天」，后面没章纲的章从第 11 天往后数，而不是回落到章号。
 */
export async function deriveTimelineFromLegacy(projectDir: string): Promise<StoryTimeline> {
  const chapterFiles = await readdir(join(projectDir, "chapters")).catch(() => [] as string[]);
  const planFiles = await readdir(join(projectDir, "drafts", "plans")).catch(() => [] as string[]);
  const committed = new Set(chapterFiles
    .map((file) => /^(\d{4})\.md$/u.exec(file))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1])));
  const planned = planFiles
    .map((file) => /^chapter-(\d{4})\.json$/u.exec(file))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]));
  let timeline = emptyStoryTimeline();
  // 已定稿的章都进；还没定稿、但章纲里写了天数的章也进（AI 起草的老书：章纲先于定稿）。
  for (const chapter of [...new Set([...committed, ...planned])].sort((a, b) => a - b)) {
    const plan = await readPlanDay(projectDir, chapter);
    if (!committed.has(chapter) && !plan) continue;
    timeline = placeChapter(timeline, { chapter, ...(plan ? { plan } : {}) }).timeline;
  }
  return timeline;
}

async function readPlanDay(projectDir: string, chapter: number): Promise<{ readonly day: number; readonly time?: string } | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(projectDir, "drafts", "plans", `chapter-${String(chapter).padStart(4, "0")}.json`), "utf-8")) as {
      storyDay?: unknown;
      scene?: { time?: unknown };
    };
    const day = positiveInt(raw.storyDay);
    if (day === undefined) return undefined;
    return { day, ...(typeof raw.scene?.time === "string" ? { time: raw.scene.time } : {}) };
  } catch {
    return undefined;
  }
}

export interface PlaceChapterInput {
  readonly chapter: number;
  /** 作者在定稿清单里定的天数（和可选星期）。 */
  readonly author?: { readonly day: number; readonly weekday?: number };
  /** 正文里的时间说法（模型声明、原句已由调用方校验在正文里）。 */
  readonly declared?: { readonly daysSincePrevious?: number; readonly weekday?: number; readonly timeOfDay?: string; readonly quote?: string };
  /** 章纲里的天数。 */
  readonly plan?: { readonly day: number; readonly time?: string };
  /** 本章内过了几天（正文里换天的说法已由调用方核过）；不论天数从哪来都带上。 */
  readonly daysInChapter?: number;
}

function previousEntry(entries: readonly TimelineEntry[], chapter: number): TimelineEntry | undefined {
  return [...entries].filter((entry) => entry.chapter < chapter).sort((a, b) => b.chapter - a.chapter)[0];
}

/** 推算某一天是星期几：取离它最近的、明写了星期的锚点。没有锚点 → undefined。 */
export function weekdayOfDay(timeline: StoryTimeline, day: number): number | undefined {
  const anchors = timeline.entries.filter((entry) => entry.weekday !== undefined);
  if (anchors.length === 0) return undefined;
  const anchor = anchors.reduce((best, entry) => (Math.abs(entry.day - day) < Math.abs(best.day - day) ? entry : best));
  return (((anchor.weekday! + day - anchor.day) % 7) + 7) % 7;
}

/** 按来源算一章的天数（不含顺延）。 */
function computeEntry(entries: readonly TimelineEntry[], input: PlaceChapterInput): TimelineEntry {
  const entry = computeStartEntry(entries, input);
  return input.daysInChapter && input.daysInChapter > 0 ? { ...entry, daysInChapter: input.daysInChapter } : entry;
}

function computeStartEntry(entries: readonly TimelineEntry[], input: PlaceChapterInput): TimelineEntry {
  const previous = previousEntry(entries, input.chapter);
  // 从上一章结束那天往后算（上一章写到第二天，这章的「第二天」是再往后一天）。
  const base = previous ? chapterEndDay(previous) : undefined;
  // 前面一章都没有（第 1 章，或老书缺章）：按「一章一天」从章号起算，和旧日历口径一致。
  const firstDay = Math.max(1, input.chapter);
  if (input.author) {
    return {
      chapter: input.chapter,
      day: input.author.day,
      ...(input.author.weekday !== undefined ? { weekday: input.author.weekday } : {}),
      ...(input.declared?.timeOfDay ? { timeOfDay: input.declared.timeOfDay } : {}),
      source: "author",
    };
  }
  const declared = input.declared;
  if (declared && (declared.daysSincePrevious !== undefined || declared.weekday !== undefined)) {
    let day: number;
    if (declared.daysSincePrevious !== undefined) {
      day = base === undefined ? firstDay : base + declared.daysSincePrevious;
    } else if (base === undefined) {
      day = firstDay;
    } else {
      // 只说了星期：从上一章往后找最近的这个星期（同一天算 0）；上一章星期不知道就当隔一天。
      const previousWeekday = weekdayOfDay({ schemaVersion: 1, entries }, base);
      day = previousWeekday === undefined ? base + 1 : base + ((((declared.weekday! - previousWeekday) % 7) + 7) % 7);
    }
    return {
      chapter: input.chapter,
      day,
      ...(declared.weekday !== undefined ? { weekday: declared.weekday } : {}),
      ...(declared.timeOfDay ? { timeOfDay: declared.timeOfDay } : {}),
      ...(declared.daysSincePrevious !== undefined ? { daysSincePrevious: declared.daysSincePrevious } : {}),
      source: "declared",
      ...(declared.quote ? { quote: declared.quote } : {}),
    };
  }
  if (input.plan) {
    const weekday = parseWeekday(input.plan.time);
    return { chapter: input.chapter, day: input.plan.day, ...(weekday !== undefined ? { weekday } : {}), source: "plan" };
  }
  return { chapter: input.chapter, day: base === undefined ? firstDay : base + 1, source: "fallback" };
}

/**
 * 放入（或替换）一章，然后顺延后面那些靠相对关系推出来的章（declared / fallback）；author、plan 定死的不动。
 */
export function placeChapter(timeline: StoryTimeline, input: PlaceChapterInput): { readonly timeline: StoryTimeline; readonly entry: TimelineEntry } {
  const others = timeline.entries.filter((entry) => entry.chapter !== input.chapter);
  const entry = computeEntry(others, input);
  const placed = sortEntries([...others, entry]);
  const reflowed: TimelineEntry[] = [];
  for (const item of placed) {
    if (item.chapter <= input.chapter || item.source === "author" || item.source === "plan") {
      reflowed.push(item);
      continue;
    }
    const recomputed = computeEntry(reflowed, {
      chapter: item.chapter,
      ...(item.daysInChapter ? { daysInChapter: item.daysInChapter } : {}),
      ...(item.source === "declared"
        ? { declared: { ...(item.daysSincePrevious !== undefined ? { daysSincePrevious: item.daysSincePrevious } : {}), ...(item.weekday !== undefined ? { weekday: item.weekday } : {}), ...(item.timeOfDay ? { timeOfDay: item.timeOfDay } : {}), ...(item.quote ? { quote: item.quote } : {}) } }
        : {}),
    });
    reflowed.push(recomputed);
  }
  return { timeline: { schemaVersion: STORY_TIMELINE_SCHEMA_VERSION, entries: reflowed }, entry };
}

/** 去掉一章（撤销定稿 / 重定稿前），后面的相对章跟着顺延。 */
export function removeChapter(timeline: StoryTimeline, chapter: number): StoryTimeline {
  const kept = timeline.entries.filter((entry) => entry.chapter !== chapter);
  const first = kept.find((entry) => entry.chapter > chapter);
  if (!first) return { schemaVersion: STORY_TIMELINE_SCHEMA_VERSION, entries: kept };
  let next: StoryTimeline = { schemaVersion: STORY_TIMELINE_SCHEMA_VERSION, entries: kept.filter((entry) => entry.chapter < first.chapter) };
  for (const entry of kept.filter((item) => item.chapter >= first.chapter)) {
    next = placeChapter(next, toPlaceInput(entry)).timeline;
  }
  return next;
}

function toPlaceInput(entry: TimelineEntry): PlaceChapterInput {
  const base = toPlaceSource(entry);
  return entry.daysInChapter ? { ...base, daysInChapter: entry.daysInChapter } : base;
}

function toPlaceSource(entry: TimelineEntry): PlaceChapterInput {
  switch (entry.source) {
    case "author":
      return { chapter: entry.chapter, author: { day: entry.day, ...(entry.weekday !== undefined ? { weekday: entry.weekday } : {}) } };
    case "declared":
      return {
        chapter: entry.chapter,
        declared: {
          ...(entry.daysSincePrevious !== undefined ? { daysSincePrevious: entry.daysSincePrevious } : {}),
          ...(entry.weekday !== undefined ? { weekday: entry.weekday } : {}),
          ...(entry.timeOfDay ? { timeOfDay: entry.timeOfDay } : {}),
          ...(entry.quote ? { quote: entry.quote } : {}),
        },
      };
    case "plan":
      return { chapter: entry.chapter, plan: { day: entry.day, ...(entry.weekday !== undefined ? { time: WEEKDAY_NAMES[entry.weekday] } : {}) } };
    default:
      return { chapter: entry.chapter };
  }
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
  const current = options.currentDay ?? timelineEntryFor(timeline, chapter)?.day;
  const earlier = timeline.entries.filter((entry) => entry.chapter < chapter).slice(-(options.limit ?? 12));
  const unsure = timeline.entries.some((entry) => entry.chapter <= chapter && entry.source === "fallback");
  if (current === undefined) {
    // 本章还没定是哪天（还没定稿的稿子）：只列前面各章是哪天、周几，本章按正文里的说法对照这张表。
    if (earlier.length === 0) return undefined;
    return [
      `本章（第 ${chapter} 章）：还没定稿，是哪天以正文里的说法为准，对照下表`,
      ...earlier.reverse().map((entry) => `第 ${entry.chapter} 章：${formatChapterDays(timeline, entry)}${entry.timeOfDay ? `，${entry.timeOfDay}` : ""}`),
      "前面各章是哪天以这张表为准，不要自己推算。",
      ...(unsure ? ["（表里有的章天数是按「上一章 +1」估的，作者还没确认。）"] : []),
    ].join("\n");
  }
  const own = options.currentDay === undefined ? timelineEntryFor(timeline, chapter) : undefined;
  return [
    `本章（第 ${chapter} 章）：${own ? formatChapterDays(timeline, own) : formatStoryDay(timeline, current)}`,
    ...earlier.reverse().map((entry) => `第 ${entry.chapter} 章：${formatChapterDays(timeline, entry)}，${relativeSpanLabel(current, entry)}${entry.timeOfDay ? `，${entry.timeOfDay}` : ""}`),
    "日子以这张表为准，说「昨天、前天、几天前、周几」照表来，不要自己推算；正文和台词里不写「故事第几天」。",
    ...(unsure ? ["（表里有的章天数是按「上一章 +1」估的，作者还没确认。）"] : []),
  ].join("\n");
}

/** 相对说法 → 绝对天数（今天 = today）。认不出 → undefined。 */
export function absoluteDayForRelative(word: string, today: number): number | undefined {
  const table: Record<string, number> = { 大前天: -3, 前天: -2, 昨天: -1, 昨日: -1, 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
  const delta = table[word];
  if (delta === undefined) return undefined;
  const day = today + delta;
  return day >= 1 ? day : undefined;
}

const RELATIVE_DAY_PATTERNS: readonly (readonly [RegExp, number, string])[] = [
  [/大前天/gu, -3, ""],
  // 「目前天气」「眼前天色」「然后天亮」里的前天 / 后天不是日子。
  [/(?<![目眼面跟门提当之以空从向往日])前天/gu, -2, ""],
  [/昨晚|昨夜/gu, -1, "晚上"],
  [/昨天|昨日/gu, -1, ""],
  [/今晚/gu, 0, "晚上"],
  [/今天|今日/gu, 0, ""],
  [/明早/gu, 1, "早上"],
  [/明晚/gu, 1, "晚上"],
  [/明天|明日/gu, 1, ""],
  [/大后天/gu, 3, ""],
  [/(?<![然最之以随此其落背身先午稍过])后天/gu, 2, ""],
];

/**
 * 记账用：事实里的「昨天 / 后天 / 本章说的后天」按时间线换成「故事第 N 天（周X）」——由引擎算，不让模型算。
 * 模型自己编的「故事第 N 天（周六）」只留星期（它不知道是第几天，编的数是错的）。
 */
export function absolutizeRelativeDaysInText(text: string, today: number, timeline: StoryTimeline): string {
  let out = text
    .replace(/故事第\s*\d+\s*天\s*[（(]\s*((?:周|星期|礼拜)[一二三四五六日天])\s*[）)]/gu, "$1")
    .replace(/本章(?:里)?说的/gu, "");
  for (const [pattern, delta, suffix] of RELATIVE_DAY_PATTERNS) {
    const day = today + delta;
    if (day < 1) continue;
    out = out.replace(pattern, `${formatStoryDay(timeline, day)}${suffix}`);
  }
  return out;
}
