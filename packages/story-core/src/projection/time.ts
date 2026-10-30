/**
 * 故事时间的投影（写作版本 P3a 设计 2.3）。纯函数，只读账单、作者裁定和换天规矩；不读正文、不判断意思。
 *
 *  - 当下线、段、未识别：P3 起新记的账（timeModel 2）按正面声明认；旧账只「推定」（有相对天数的章 + 全书第一章），推定的天数照推、标 presumed。
 *  - 两个世界：过了半夜算第二天（midnight）、天亮才算第二天（dawn）各推一遍；作者定了换天规矩就只推那一个。
 *    每章结果取两个世界的并：两个世界都是同一个单点才是确定的一天。分歧不逐处相加。
 *  - 链：当下线上的章按顺序接，绝对天数只沿没断的链从锚算（第一个当下章的开头 = 第 1 天，或作者定的天数）。
 *    未识别的章断开前后（后面的章找不到「前一个当下章」）；不知道、月 / 年的相对断开绝对天数（相对天数照接）。不知道不给下界。
 *  - 星期：全书一处算，只从明写的星期出发、沿两个世界都确定的相对天数推。
 *  - 结构冲突：作者定的开头 / 结尾和记账员记的对不上，各记一条（只说哪几条不能同时成立，不判谁对、不改任何一边）。
 */
import type { AuthorDecision } from "../schema/decisions.js";
import {
  TIME_MODEL,
  missingKindsOf,
  timeRoleOf,
  type BoundaryOffsets,
  type ChapterLedger,
  type DayBoundary,
  type LegacyTime,
  type SceneFrame,
  type TimeEntry,
  type TimeOffset,
  type UnitRange,
} from "../schema/ledger.js";

/** 一段天数（含两头）。缺一头 = 那头不知道 / 没界；整个没有（undefined）= 不知道。 */
export interface DayRange {
  readonly lo?: number;
  readonly hi?: number;
}

export type TimeWorld = DayBoundary;
export const TIME_WORLDS: readonly TimeWorld[] = ["midnight", "dawn"];

/** 一次换天：新的一天从第几句起（定位不了就没有），各世界隔了几天。 */
export interface DayChangeView {
  readonly unit?: number;
  readonly byWorld: Readonly<Partial<Record<TimeWorld, DayRange>>>;
}

/** 一个段：frame、句子范围、段的时间（原样：相对本章开头 / 前一个当下章结尾；unknown = 说不出；没有 = 没记）。 */
export interface SegmentView {
  readonly id: string;
  readonly frame: SceneFrame;
  readonly units: UnitRange;
  /** 改文后对不回了：这段在哪不知道，本章的条目按「段未知」处理。 */
  readonly stale: boolean;
  readonly when?: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets } | "unknown";
  /** 段的时间相对谁。 */
  readonly anchor?: "chapterStart" | "previousChapterEnd";
}

/** 一章在某个世界里的天数。 */
export interface WorldDays {
  readonly start?: DayRange;
  readonly end?: DayRange;
}

export interface ChapterTime {
  /** 在不在当下线上：true / false（整章是一段）/ unknown（没识别：账待记、没记全时间、旧账说不出）。 */
  readonly presentLine: true | false | "unknown";
  /** 这章自己的时间是旧账推定的（不算已识别；核账不凭它报「确定」）。 */
  readonly presumed: boolean;
  /** 本章开头、结尾是第几天（两个世界的并）。没有 = 不知道。 */
  readonly start?: DayRange;
  readonly end?: DayRange;
  /** 绝对天数是沿着推定的章推出来的（核账不凭它报「确定」）。 */
  readonly absolutePresumed: boolean;
  /** 前一个当下章（链没断时才有）。 */
  readonly previousPresent?: number;
  /** 离前一个当下章结尾多少天（两个世界的并）；链断了、不知道、按月 / 年说的就没有。 */
  readonly sincePrevious?: DayRange;
  /** 本章开头相对前一个当下章按月 / 年说的（原样，不折天）。 */
  readonly relativeText?: TimeOffset;
  /** 本章内跨了几天（两个世界的并）；不知道就没有。 */
  readonly span?: DayRange;
  /** 天数从哪来：作者定的、记账员记的、旧账推定的、不知道。 */
  readonly basis: "author" | "ledger" | "presumed" | "unknown";
  /** 老书里的天数判成不可信、记成了不知道：原来的值（给作者看「约第 N 天」）。 */
  readonly legacyDay?: { readonly day: number; readonly reason: LegacyTime["reason"] };
  /** 旧账里记账员按「天亮换日」判的相对天数，作者把换天规矩定成了半夜，这章的天数现在不知道（设计 2.4，要作者改天数）。 */
  readonly boundaryInvalidated: boolean;
  readonly dayChanges: readonly DayChangeView[];
  readonly segments: readonly SegmentView[];
  /** 各世界的开头、结尾（算某一句的时刻用）。 */
  readonly byWorld: Readonly<Partial<Record<TimeWorld, WorldDays>>>;
  /** 0 = 周一 … 6 = 周日。 */
  readonly weekday?: number;
  readonly weekdayDerived: boolean;
  readonly timeOfDay?: string;
}

/** 作者定的天数和记账员记的对不上（设计 2.5）。 */
export interface TimeConflictView {
  /** 确定性的问题键，作者点「以我定的为准」时记进裁定（issue.dismiss）。 */
  readonly key: string;
  readonly kind: "time-start" | "time-end";
  readonly chapter: number;
  /** 作者定的那天。 */
  readonly authorDay: number;
  /** 按记账员记的推出来的（两个世界的并）。 */
  readonly expected: DayRange;
}

// —— 区间算术 ——

const isEmpty = (range: DayRange): boolean => range.lo === undefined && range.hi === undefined;
const norm = (range: DayRange | undefined): DayRange | undefined => (range === undefined || isEmpty(range) ? undefined : range);
const point = (value: number): DayRange => ({ lo: value, hi: value });
export const isExact = (range: DayRange | undefined): range is { readonly lo: number; readonly hi: number } =>
  range !== undefined && range.lo !== undefined && range.lo === range.hi;

export function addRange(a: DayRange | undefined, b: DayRange | undefined): DayRange | undefined {
  if (a === undefined || b === undefined) return undefined;
  return norm({
    ...(a.lo !== undefined && b.lo !== undefined ? { lo: a.lo + b.lo } : {}),
    ...(a.hi !== undefined && b.hi !== undefined ? { hi: a.hi + b.hi } : {}),
  });
}

function subRange(a: DayRange | undefined, b: DayRange | undefined): DayRange | undefined {
  if (a === undefined || b === undefined) return undefined;
  return norm({
    ...(a.lo !== undefined && b.hi !== undefined ? { lo: a.lo - b.hi } : {}),
    ...(a.hi !== undefined && b.lo !== undefined ? { hi: a.hi - b.lo } : {}),
  });
}

/** 两个世界的并：有一边不知道就不知道；两头取最宽。 */
export function unionRange(ranges: readonly (DayRange | undefined)[]): DayRange | undefined {
  if (ranges.length === 0 || ranges.some((range) => range === undefined)) return undefined;
  const all = ranges as readonly DayRange[];
  const los = all.map((range) => range.lo);
  const his = all.map((range) => range.hi);
  return norm({
    ...(los.every((value) => value !== undefined) ? { lo: Math.min(...(los as number[])) } : {}),
    ...(his.every((value) => value !== undefined) ? { hi: Math.max(...(his as number[])) } : {}),
  });
}

export const inRange = (value: number, range: DayRange): boolean =>
  (range.lo === undefined || value >= range.lo) && (range.hi === undefined || value <= range.hi);

const dayRangeOf = (offset: TimeOffset | undefined): DayRange | undefined =>
  offset?.unit === "day" ? norm({ ...(offset.min !== undefined ? { lo: offset.min } : {}), ...(offset.max !== undefined ? { hi: offset.max } : {}) }) : undefined;

/** 一处相对在某个世界里是多少天：月 / 年、不知道 = undefined。 */
function worldRange(entry: Pick<TimeEntry, "offset" | "byBoundary"> | undefined, world: TimeWorld): DayRange | undefined {
  if (!entry) return undefined;
  if (entry.byBoundary) return dayRangeOf(entry.byBoundary[world]);
  return dayRangeOf(entry.offset);
}

// —— 一章的时间声明（和世界无关的部分） ——

interface ChapterDecl {
  readonly chapter: number;
  readonly presentLine: true | false | "unknown";
  readonly presumed: boolean;
  /** 首个推定章（旧账第一章）也当原点。 */
  readonly authorStart?: number;
  /** 作者给了结尾（裁定的 dayEnd、清单上的结尾）。 */
  readonly authorEnd?: number;
  /** 记账员记的开头（相对前一个当下章结尾）；没有 = 不知道。 */
  readonly start?: TimeEntry;
  /** 开头这条的相对能不能用（旧账判断的、换天规矩改成半夜的不能用；估的不能用）。 */
  readonly startUsable: boolean;
  /** 章内跨度：同一天、旧账本章内过了几天、或各次换天。 */
  readonly sameDay: boolean;
  readonly legacySpan?: number;
  readonly dayChanges: readonly TimeEntry[];
  /** 章末知不知道（P3 起：有同一天或换天才知道；旧账：照 P2b 当年的意思算同一天）。 */
  readonly endKnown: boolean;
  readonly weekday?: number;
  readonly timeOfDay?: string;
  readonly legacyDay?: ChapterTime["legacyDay"];
  readonly boundaryInvalidated: boolean;
  readonly segments: readonly SegmentView[];
}

function declOf(
  ledger: ChapterLedger,
  ruling: { readonly day: number; readonly dayEnd?: number } | undefined,
  first: boolean,
  policy: DayBoundary | undefined,
): ChapterDecl {
  const native = ledger.timeModel === TIME_MODEL;
  const times = ledger.entries.filter((entry): entry is TimeEntry => entry.kind === "time");
  const role = (name: ReturnType<typeof timeRoleOf>): TimeEntry | undefined => times.find((entry) => timeRoleOf(entry) === name);
  const start = role("start");
  const end = role("end");
  const authorStartEntry = role("authorStart");
  const authorEndEntry = role("authorEnd");
  const missing = missingKindsOf(ledger).includes("time");
  const segments: SegmentView[] = [...ledger.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => {
      const when = times.find((entry) => entry.id === scene.timeRefs[0]);
      return {
        id: scene.id,
        frame: scene.frame,
        units: scene.units,
        stale: scene.stale === true,
        ...(when
          ? {
            when: when.relation === "offset" ? { ...(when.offset ? { offset: when.offset } : {}), ...(when.byBoundary ? { byBoundary: when.byBoundary } : {}) } : ("unknown" as const),
            ...(when.anchor === "chapterStart" || when.anchor === "previousChapterEnd" ? { anchor: when.anchor } : {}),
          }
          : {}),
      };
    });
  const legacyEntry = times.find((entry) => entry.legacy);
  const legacyDay = legacyEntry?.legacy?.day !== undefined ? { day: legacyEntry.legacy.day, reason: legacyEntry.legacy.reason } : undefined;

  // 作者定的：定稿后改的（裁定，最后一次）盖过清单上的；旧账里作者定的开头没写结尾，当年的意思是同一天。
  const authorStart = ruling?.day ?? authorStartEntry?.day;
  const legacyAuthorEnd = !native && authorStartEntry?.day !== undefined && !ruling ? authorStartEntry.day + (end?.offset?.min ?? 0) : undefined;
  const authorEnd = ruling ? ruling.dayEnd : (authorEndEntry?.day ?? legacyAuthorEnd);

  const usable = (entry: TimeEntry | undefined): boolean => {
    if (!entry || entry.relation !== "offset" || entry.legacy || entry.basis === "estimated") return false;
    // 旧账是照「天亮换日」记的：作者定了半夜换天，记账员判断的相对天数就不能用了（正文明写的照用）。
    return native || policy !== "midnight" || entry.basis !== "judged";
  };
  const base = {
    chapter: ledger.chapter,
    boundaryInvalidated: !native && policy === "midnight" && start?.relation === "offset" && start.basis === "judged" && !start.legacy,
    ...(authorStart !== undefined ? { authorStart } : {}),
    ...(authorEnd !== undefined ? { authorEnd } : {}),
    ...(start ? { start } : {}),
    startUsable: usable(start),
    ...(start?.weekday !== undefined ? { weekday: start.weekday } : authorStartEntry?.weekday !== undefined ? { weekday: authorStartEntry.weekday } : {}),
    ...(start?.timeOfDay ? { timeOfDay: start.timeOfDay } : authorStartEntry?.timeOfDay ? { timeOfDay: authorStartEntry.timeOfDay } : {}),
    ...(legacyDay ? { legacyDay } : {}),
    segments,
  };
  if (native) {
    const dayChanges = times.filter((entry) => timeRoleOf(entry) === "dayChange");
    const declared = !missing && (start !== undefined || authorStart !== undefined);
    const wholeSegment = !missing && !declared && segments.length > 0;
    return {
      ...base,
      presentLine: authorStart !== undefined ? true : declared ? true : wholeSegment ? false : "unknown",
      presumed: false,
      sameDay: end !== undefined,
      dayChanges,
      endKnown: end !== undefined || dayChanges.length > 0,
    };
  }
  // 旧账：只推定。有相对天数（含估的）的章、全书第一章推定在当下线上；旧的不知道、没时间条目、账待记都算没识别。
  const presumedPresent = !missing && ((start?.relation === "offset") || (first && ledger.status !== "pending"));
  // 本章内过了几天照 P2b 当年的意思：记了就是那么多，没记 = 同一天；盘点判成不可信的（结尾那条已去掉）不知道。
  const legacySpan = presumedPresent && !start?.legacy ? (end?.offset?.min ?? 0) : undefined;
  return {
    ...base,
    presentLine: authorStart !== undefined ? true : presumedPresent ? true : "unknown",
    presumed: authorStart === undefined && presumedPresent,
    sameDay: false,
    ...(legacySpan !== undefined ? { legacySpan } : {}),
    dayChanges: [],
    endKnown: legacySpan !== undefined,
  };
}

/** 本章内跨了几天（某个世界）。 */
function spanIn(decl: ChapterDecl, world: TimeWorld): DayRange | undefined {
  if (!decl.endKnown) return undefined;
  if (decl.sameDay) return point(0);
  if (decl.legacySpan !== undefined) return point(decl.legacySpan);
  let total: DayRange | undefined = point(0);
  for (const change of decl.dayChanges) total = addRange(total, worldRange(change, world));
  return total;
}

interface WorldChapter {
  readonly start?: DayRange;
  readonly end?: DayRange;
  readonly sincePrevious?: DayRange;
  readonly previousPresent?: number;
  readonly span?: DayRange;
  readonly absolutePresumed: boolean;
  /** 按记账员记的推出来的开头（作者定了开头时核冲突用）。 */
  readonly expectedStart?: DayRange;
  /** 按开头 + 章内跨度推出来的结尾（作者定了结尾时核冲突用）。 */
  readonly expectedEnd?: DayRange;
}

/** 一个世界里沿链推一遍。 */
function walkWorld(decls: readonly ChapterDecl[], world: TimeWorld): Map<number, WorldChapter> {
  const out = new Map<number, WorldChapter>();
  let started = false;
  // 第一个当下章前面有没识别的章：它可能就在当下线上、跨了几天，第一个当下章不能当第 1 天（T14：不知道不给下界）。
  let lost = false;
  let previous: { readonly chapter: number; readonly end?: DayRange; readonly presumed: boolean } | undefined;
  for (const decl of decls) {
    if (decl.presentLine === "unknown") {
      // 没识别：后面的章找不到「前一个当下章」。
      out.set(decl.chapter, { absolutePresumed: false });
      if (started) previous = undefined;
      else lost = true;
      continue;
    }
    if (decl.presentLine === false) {
      out.set(decl.chapter, { absolutePresumed: false });
      continue;
    }
    const relative = decl.startUsable ? worldRange(decl.start, world) : undefined;
    const expectedStart = previous ? addRange(previous.end, relative) : undefined;
    let start: DayRange | undefined;
    let presumed: boolean;
    if (decl.authorStart !== undefined) {
      start = point(decl.authorStart);
      presumed = false;
    } else if (!started) {
      // 第一个当下章的开头 = 第 1 天（它那条相对天数不用：T5）。
      start = lost ? undefined : point(1);
      presumed = decl.presumed;
    } else {
      start = expectedStart;
      presumed = (previous?.presumed ?? false) || decl.presumed;
    }
    const span = spanIn(decl, world);
    const expectedEnd = addRange(start, span);
    const end = decl.authorEnd !== undefined ? point(decl.authorEnd) : expectedEnd;
    const sincePrevious = !previous
      ? undefined
      : decl.authorStart !== undefined
        ? subRange(start, previous.end)
        : relative;
    out.set(decl.chapter, {
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(sincePrevious ? { sincePrevious } : {}),
      ...(previous ? { previousPresent: previous.chapter } : {}),
      ...(span ? { span } : {}),
      absolutePresumed: presumed,
      ...(expectedStart ? { expectedStart } : {}),
      ...(expectedEnd ? { expectedEnd } : {}),
    });
    previous = { chapter: decl.chapter, ...(end ? { end } : {}), presumed: decl.authorEnd !== undefined ? false : presumed };
    started = true;
  }
  return out;
}

export interface TimeProjection {
  readonly chapters: ReadonlyMap<number, ChapterTime>;
  readonly conflicts: readonly TimeConflictView[];
  /** 这次推了哪几个世界（作者定了换天规矩就只有那一个）。 */
  readonly worlds: readonly TimeWorld[];
}

const mod7 = (value: number): number => ((value % 7) + 7) % 7;

/** ledgers 已按章排好。dismissed：作者点过「以我定的为准」的问题键。 */
export function projectTime(
  ledgers: readonly ChapterLedger[],
  decisions: readonly AuthorDecision[],
  policy: DayBoundary | undefined,
  dismissed: ReadonlySet<string>,
): TimeProjection {
  const rulings = new Map<number, { readonly day: number; readonly dayEnd?: number }>();
  for (const decision of decisions) if (decision.type === "chapter.day") rulings.set(decision.chapter, decision);
  const decls = ledgers.map((ledger, index) => declOf(ledger, rulings.get(ledger.chapter), index === 0, policy));
  const worlds: readonly TimeWorld[] = policy ? [policy] : TIME_WORLDS;
  const walked = worlds.map((world) => ({ world, chapters: walkWorld(decls, world) }));

  const chapters = new Map<number, ChapterTime>();
  const conflicts: TimeConflictView[] = [];
  for (const decl of decls) {
    const rows = walked.map(({ world, chapters: map }) => ({ world, row: map.get(decl.chapter) ?? { absolutePresumed: false } }));
    const union = (pick: (row: WorldChapter) => DayRange | undefined): DayRange | undefined => unionRange(rows.map(({ row }) => pick(row)));
    const start = union((row) => row.start);
    const end = union((row) => row.end);
    const previousPresent = rows[0]?.row.previousPresent;
    const sincePrevious = union((row) => row.sincePrevious);
    const span = union((row) => row.span);
    const relativeText = decl.startUsable && decl.start?.offset && decl.start.offset.unit !== "day" ? decl.start.offset : undefined;
    if (decl.authorStart !== undefined) {
      const expected = union((row) => row.expectedStart);
      const key = `time-start:${decl.chapter}:${decl.authorStart}`;
      if (expected && !inRange(decl.authorStart, expected) && !dismissed.has(key)) conflicts.push({ key, kind: "time-start", chapter: decl.chapter, authorDay: decl.authorStart, expected });
    }
    if (decl.authorEnd !== undefined) {
      const expected = union((row) => row.expectedEnd);
      const key = `time-end:${decl.chapter}:${decl.authorEnd}`;
      if (expected && !inRange(decl.authorEnd, expected) && !dismissed.has(key)) conflicts.push({ key, kind: "time-end", chapter: decl.chapter, authorDay: decl.authorEnd, expected });
    }
    const byWorld: Partial<Record<TimeWorld, WorldDays>> = {};
    for (const { world, row } of rows) byWorld[world] = { ...(row.start ? { start: row.start } : {}), ...(row.end ? { end: row.end } : {}) };
    const dayChanges: DayChangeView[] = decl.dayChanges.map((change) => {
      const range: Partial<Record<TimeWorld, DayRange>> = {};
      for (const world of worlds) {
        const value = worldRange(change, world);
        if (value) range[world] = value;
      }
      const unit = change.evidenceStatus === "located" ? change.evidence[0]?.units?.from : undefined;
      return { ...(unit !== undefined ? { unit } : {}), byWorld: range };
    });
    chapters.set(decl.chapter, {
      presentLine: decl.presentLine,
      presumed: decl.presumed,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      absolutePresumed: rows.some(({ row }) => row.absolutePresumed),
      ...(previousPresent !== undefined ? { previousPresent } : {}),
      ...(sincePrevious ? { sincePrevious } : {}),
      ...(relativeText ? { relativeText } : {}),
      ...(span ? { span } : {}),
      basis: decl.presentLine !== true
        ? "unknown"
        : decl.authorStart !== undefined
          ? "author"
          : start === undefined
            ? "unknown"
            : decl.presumed || rows.some(({ row }) => row.absolutePresumed)
              ? "presumed"
              : "ledger",
      ...(decl.legacyDay ? { legacyDay: decl.legacyDay } : {}),
      boundaryInvalidated: decl.boundaryInvalidated,
      dayChanges,
      segments: decl.segments,
      byWorld,
      ...(decl.weekday !== undefined ? { weekday: decl.weekday } : {}),
      weekdayDerived: false,
      ...(decl.timeOfDay ? { timeOfDay: decl.timeOfDay } : {}),
    });
  }
  return { chapters: withWeekdays(ledgers.map((ledger) => ledger.chapter), chapters), conflicts, worlds };
}

/**
 * 星期（设计 2.3，全书一处算）：章的开头按「两个世界都确定」的相对天数连成几串（绝对天数确定的章另连成一串），
 * 串里有明写星期的就推给同一串里没写的（取天数最近的那个）。连不上的不推。
 */
function withWeekdays(order: readonly number[], chapters: Map<number, ChapterTime>): Map<number, ChapterTime> {
  const parent = new Map<string, string>();
  const offset = new Map<string, number>(); // 相对父节点差几天
  const find = (node: string): { root: string; diff: number } => {
    let diff = 0;
    let current = node;
    while (parent.has(current)) {
      diff += offset.get(current) ?? 0;
      current = parent.get(current) as string;
    }
    return { root: current, diff };
  };
  /** b 比 a 晚 days 天。 */
  const tie = (a: string, b: string, days: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra.root === rb.root) return;
    parent.set(rb.root, ra.root);
    offset.set(rb.root, ra.diff + days - rb.diff);
  };
  const ABS = "absolute";
  let previous: { readonly chapter: number; readonly time: ChapterTime } | undefined;
  for (const chapter of order) {
    const time = chapters.get(chapter);
    if (!time || time.presentLine !== true) {
      if (time?.presentLine === "unknown") previous = undefined;
      continue;
    }
    const node = `c${chapter}`;
    if (isExact(time.start)) tie(ABS, node, time.start.lo);
    if (previous && time.previousPresent === previous.chapter && isExact(previous.time.span) && isExact(time.sincePrevious)) {
      tie(`c${previous.chapter}`, node, previous.time.span.lo + time.sincePrevious.lo);
    }
    previous = { chapter, time };
  }
  const anchors = order.flatMap((chapter) => {
    const time = chapters.get(chapter);
    return time?.presentLine === true && time.weekday !== undefined ? [{ chapter, weekday: time.weekday, ...find(`c${chapter}`) }] : [];
  });
  if (anchors.length === 0) return chapters;
  const out = new Map(chapters);
  for (const chapter of order) {
    const time = chapters.get(chapter);
    if (!time || time.presentLine !== true || time.weekday !== undefined) continue;
    const here = find(`c${chapter}`);
    let best: (typeof anchors)[number] | undefined;
    for (const anchor of anchors) {
      if (anchor.root !== here.root) continue;
      if (!best || Math.abs(anchor.diff - here.diff) < Math.abs(best.diff - here.diff)) best = anchor;
    }
    if (best) out.set(chapter, { ...time, weekday: mod7(best.weekday + here.diff - best.diff), weekdayDerived: true });
  }
  return out;
}

/**
 * 本章第几句那一刻离本章开头多少天（设计 2.2：开头 + 这句之前各次换天；没定位到句子的换天，它前后的句子取区间）。
 * 两个世界的并。
 */
export function momentOf(time: ChapterTime, unit: number): DayRange | undefined {
  const worlds = Object.keys(time.byWorld) as TimeWorld[];
  const perWorld = (worlds.length > 0 ? worlds : TIME_WORLDS).map((world) => {
    let total: DayRange | undefined = point(0);
    for (const change of time.dayChanges) {
      const range = change.byWorld[world];
      if (!range) return undefined;
      if (change.unit !== undefined) {
        if (change.unit <= unit) total = addRange(total, range);
      } else {
        // 不知道在哪句换的：可能已经换了，也可能还没。
        total = addRange(total, { lo: 0, ...(range.hi !== undefined ? { hi: range.hi } : {}) });
      }
    }
    return total;
  });
  return unionRange(perWorld);
}

/** 某一句那一刻是第几天（各世界开头 + 这句之前的换天，取并）。 */
export function dayAt(time: ChapterTime, unit: number): DayRange | undefined {
  const worlds = Object.keys(time.byWorld) as TimeWorld[];
  return unionRange(worlds.map((world) => {
    let total: DayRange | undefined = time.byWorld[world]?.start;
    for (const change of time.dayChanges) {
      const range = change.byWorld[world];
      if (!range) return undefined;
      total = addRange(total, change.unit === undefined ? { lo: 0, ...(range.hi !== undefined ? { hi: range.hi } : {}) } : change.unit <= unit ? range : point(0));
    }
    return total;
  }));
}
