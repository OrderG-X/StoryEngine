// 写作版本 P3a：时间投影（设计第 2 节）。每条反例对着设计里的编号或 Astra 复核轮次。
import { describe, expect, it } from "vitest";
import type { AuthorDecision } from "../schema/decisions.js";
import type { SettingCardsFile } from "../schema/cards.js";
import { emptySettingCards } from "../schema/cards.js";
import type { ChapterLedger, DayBoundary, TimeInput } from "../schema/ledger.js";
import { ledgerOf, newLedger, storeLegacyTime, type LegacyTimeDraft } from "../ledger/entries.js";
import { project } from "./project.js";
import { timelineTable, timelineText } from "./queries.js";
import { dayAt, elapsedDays, momentOf } from "./time.js";
import { daysText, relativeDaysText } from "./time-text.js";

const STAMP = "2026-10-31T00:00:00.000Z";
const days = (min: number, max = min, unit: "day" | "month" | "year" = "day") => ({ unit, min, max });
const body = (chapter: number, ...sentences: string[]): string => `# 第${chapter}章\n\n${sentences.join("")}`;

type TimeDraft = Omit<TimeInput, "kind" | "review">;

/** 一章：正文几句，时间按记账员的说法记（不给 = 这章没记时间）。 */
function chapter(n: number, time: TimeDraft | undefined, sentences: string[] = [`第${n}章开头这一句。`, `第${n}章后面那一句。`]): ChapterLedger {
  return ledgerOf({
    chapter: n,
    text: body(n, ...sentences),
    committedAt: STAMP,
    entries: time ? [{ kind: "time", review: "auto", ...time }] : [],
  });
}

type Offset = ReturnType<typeof days> | { readonly unit: "day"; readonly min: number };
/** 开头离前一个当下章结尾多久（引的是本章第一句），整章同一天；extra 里的 start 盖过这个。 */
const after = (n: number, offset: Offset | undefined, extra: Partial<TimeDraft> = {}): ChapterLedger =>
  chapter(n, { start: { ...(offset ? { offset } : {}), basis: "text", quote: `第${n}章开头这一句` }, sameDay: true, ...extra });

function view(ledgers: ChapterLedger[], options: { decisions?: AuthorDecision[]; boundary?: DayBoundary } = {}) {
  const cards: SettingCardsFile | undefined = options.boundary ? { ...emptySettingCards(), calendar: { dayBoundary: options.boundary, at: STAMP } } : undefined;
  return project({ ledgers, decisions: options.decisions ?? [], ...(cards ? { cards } : {}) });
}
const timeOf = (projection: ReturnType<typeof view>, n: number) => projection.chapters.find((item) => item.chapter === n)!.time;
const decision = (input: Record<string, unknown>, index = 1): AuthorDecision => ({ id: `d-${index}`, at: STAMP, ...input }) as AuthorDecision;

describe("锚和链", () => {
  it("第一个当下章的开头 = 第 1 天，它那条「隔 3 天」不用（T5）", () => {
    const v = view([after(1, days(3)), after(2, days(1))]);
    expect(timeOf(v, 1)).toMatchObject({ presentLine: true, start: { lo: 1, hi: 1 }, end: { lo: 1, hi: 1 }, basis: "ledger" });
    expect(timeOf(v, 1).previousPresent).toBeUndefined();
    expect(timeOf(v, 2)).toMatchObject({ start: { lo: 2, hi: 2 }, sincePrevious: { lo: 1, hi: 1 }, previousPresent: 1 });
  });

  it("多线往回接：相对天数是负的，第 1 天以前照样说得出", () => {
    const v = view([after(1, days(0)), after(2, days(-2))]);
    expect(timeOf(v, 2).start).toEqual({ lo: -1, hi: -1 });
    expect(daysText(timeOf(v, 2).start)).toBe("第 1 天之前 2 天");
    expect(relativeDaysText(timeOf(v, 2).sincePrevious)).toBe("往回 2 天");
  });

  it("「隔一到三天」是区间，不是确定的天数：往后一路是区间", () => {
    const v = view([after(1, days(0)), after(2, days(1, 3)), after(3, days(1))]);
    expect(timeOf(v, 2).start).toEqual({ lo: 2, hi: 4 });
    expect(timeOf(v, 3).start).toEqual({ lo: 3, hi: 5 });
    expect(daysText(timeOf(v, 3).start)).toBe("第 3～5 天");
  });

  it("「几天后」只有下界：往后只知道至少第几天", () => {
    const v = view([after(1, days(0)), after(2, { unit: "day", min: 1 })]);
    expect(timeOf(v, 2).start).toEqual({ lo: 2 });
    expect(daysText(timeOf(v, 2).start)).toBe("第 2 天以后");
  });

  it("说不出隔多久（unknown）：在当下线上，但这章和后面的绝对天数两头都不知道，不给下界（T14）", () => {
    const v = view([after(1, days(0)), chapter(2, { start: "unknown", sameDay: true }), after(3, days(1))]);
    expect(timeOf(v, 2)).toMatchObject({ presentLine: true, basis: "unknown" });
    expect(timeOf(v, 2).start).toBeUndefined();
    // 第 3 章和第 2 章之间的相对天数还在，绝对天数不知道。
    expect(timeOf(v, 3)).toMatchObject({ previousPresent: 2, sincePrevious: { lo: 1, hi: 1 } });
    expect(timeOf(v, 3).start).toBeUndefined();
  });

  it("没认出在不在当下线上（账待记、没记时间）：后面的章找不到前一个当下章；作者定了天数再接上", () => {
    const pending = ledgerOf({ chapter: 2, text: body(2, "第2章开头这一句。"), committedAt: STAMP, entries: [], status: "pending", coverage: { reasonCodes: ["keeper_failed"] } });
    const v = view([after(1, days(0)), pending, chapter(3, undefined), after(4, days(1)), after(5, days(1))], {
      decisions: [decision({ type: "chapter.day", chapter: 5, day: 9 })],
    });
    expect(timeOf(v, 2).presentLine).toBe("unknown");
    expect(timeOf(v, 3).presentLine).toBe("unknown");
    expect(timeOf(v, 4)).toMatchObject({ presentLine: true, basis: "unknown" });
    expect(timeOf(v, 4).previousPresent).toBeUndefined();
    expect(timeOf(v, 4).start).toBeUndefined();
    expect(timeOf(v, 5)).toMatchObject({ start: { lo: 9, hi: 9 }, end: { lo: 9, hi: 9 }, basis: "author" });
  });

  it("第一个当下章前面有没认出来的章：不当第 1 天", () => {
    const v = view([chapter(1, undefined), after(2, days(1))]);
    expect(timeOf(v, 2).start).toBeUndefined();
  });

  it("整章是回忆：不在当下线上，下一章接着再前面那个当下章", () => {
    const flashback = chapter(2, {
      segments: [{ frame: "past", firstQuote: "第2章开头这一句", lastQuote: "第2章后面那一句", when: { offset: days(-3, -3, "year") } }],
    });
    const v = view([after(1, days(0)), flashback, after(3, days(1))]);
    expect(timeOf(v, 2)).toMatchObject({ presentLine: false, basis: "unknown", segments: [{ frame: "past", units: { from: 1, to: 2 }, anchor: "previousChapterEnd" }] });
    expect(timeOf(v, 3)).toMatchObject({ previousPresent: 1, start: { lo: 2, hi: 2 } });
    expect(timelineText(timelineTable(v))).toContain("| 第 2 章 | — | — | — | — | — | 整章不在当下线上 | 回忆（3 年前） |");
  });

  it("按月、年说的相对：原样留着、不折天，这之后的绝对天数断开", () => {
    const v = view([after(1, days(0)), after(2, days(6, 6, "month")), after(3, days(1))]);
    expect(timeOf(v, 2)).toMatchObject({ presentLine: true, relativeText: { unit: "month", min: 6, max: 6 } });
    expect(timeOf(v, 2).start).toBeUndefined();
    expect(timeOf(v, 2).sincePrevious).toBeUndefined();
    expect(timeOf(v, 3).start).toBeUndefined();
    expect(timelineText(timelineTable(v))).toContain("| 第 2 章 | 不知道 | 不知道 | 6 个月后 |");
  });

  it("章末不知道：没说整章同一天、也没列换天的，不当同一天", () => {
    const v = view([chapter(1, { start: { offset: days(0), basis: "text", quote: "第1章开头这一句" } }), after(2, days(1))]);
    expect(timeOf(v, 1)).toMatchObject({ start: { lo: 1, hi: 1 } });
    expect(timeOf(v, 1).end).toBeUndefined();
    expect(timeOf(v, 1).span).toBeUndefined();
    expect(timeOf(v, 2).start).toBeUndefined();
  });
});

describe("换天规矩：两个世界", () => {
  // 第 1 章夜里 23 点；第 2 章凌晨 1 点（过了半夜算第二天的话隔一天，天亮才算的话还是同一天）；第 3 章天亮（反过来）。
  const ledgers = () => [
    after(1, days(0)),
    after(2, undefined, { start: { byBoundary: { midnight: days(1), dawn: days(0) }, basis: "judged", quote: "第2章开头这一句" } }),
    after(3, undefined, { start: { byBoundary: { midnight: days(0), dawn: days(1) }, basis: "judged", quote: "第3章开头这一句" } }),
  ];

  it("没定：两种都推，两边得出同一个单点才确定；分歧不逐处相加（23 点 → 1 点 → 天亮 = 第 2 天）", () => {
    const v = view(ledgers());
    expect(v.timeWorlds).toEqual(["midnight", "dawn"]);
    expect(timeOf(v, 2).start).toEqual({ lo: 1, hi: 2 });
    expect(timeOf(v, 2).byWorld).toEqual({
      midnight: { start: { lo: 2, hi: 2 }, end: { lo: 2, hi: 2 }, sincePrevious: { lo: 1, hi: 1 }, span: { lo: 0, hi: 0 } },
      dawn: { start: { lo: 1, hi: 1 }, end: { lo: 1, hi: 1 }, sincePrevious: { lo: 0, hi: 0 }, span: { lo: 0, hi: 0 } },
    });
    expect(timeOf(v, 3).start).toEqual({ lo: 2, hi: 2 });
  });

  it("作者定了半夜换天：只推那一个世界", () => {
    const v = view(ledgers(), { boundary: "midnight" });
    expect(v.timeWorlds).toEqual(["midnight"]);
    expect(timeOf(v, 2).start).toEqual({ lo: 2, hi: 2 });
    expect(timeOf(v, 3).start).toEqual({ lo: 2, hi: 2 });
  });
});

describe("章里换天：任一句那一刻", () => {
  const sentences = ["傍晚他到了渡口。", "夜里下起了雨。", "第二天一早雨停了。", "他又上了船。"];

  it("换天定位到句子：那句之前是开头那天，从那句起是下一天", () => {
    const ledger = chapter(1, { start: { offset: days(0), basis: "text", quote: "傍晚他到了渡口" }, dayChanges: [{ offset: days(1), quote: "第二天一早雨停了" }] }, sentences);
    const time = timeOf(view([ledger]), 1);
    expect(time).toMatchObject({ start: { lo: 1, hi: 1 }, end: { lo: 2, hi: 2 }, span: { lo: 1, hi: 1 }, dayChanges: [{ unit: 3 }] });
    expect(momentOf(time, 2)).toEqual({ lo: 0, hi: 0 });
    expect(momentOf(time, 3)).toEqual({ lo: 1, hi: 1 });
    expect(dayAt(time, 4)).toEqual({ lo: 2, hi: 2 });
  });

  it("换天没附那句：章末照算，但哪句换的不知道，每一句都取区间", () => {
    const ledger = chapter(1, { start: { offset: days(0), basis: "text", quote: "傍晚他到了渡口" }, dayChanges: [{ offset: days(1) }] }, sentences);
    const time = timeOf(view([ledger]), 1);
    expect(time.end).toEqual({ lo: 2, hi: 2 });
    expect(momentOf(time, 1)).toEqual({ lo: 0, hi: 1 });
    expect(dayAt(time, 4)).toEqual({ lo: 1, hi: 2 });
  });
});

describe("两处之间隔几天", () => {
  const map = (projection: ReturnType<typeof view>) => new Map(projection.chapters.map((item) => [item.chapter, item.time]));
  const between = (projection: ReturnType<typeof view>, from: [number, "start" | "end" | number], to: [number, "start" | "end" | number]) =>
    elapsedDays(map(projection), { chapter: from[0], at: from[1] }, { chapter: to[0], at: to[1] });

  it("沿链逐章加：中间有一章「隔一到三天」，后面两章的绝对天数是区间，它们之间隔几天照样确定", () => {
    const v = view([after(1, days(0)), after(2, days(1, 3)), after(3, days(1)), after(4, days(2))]);
    expect(timeOf(v, 3).start).toEqual({ lo: 3, hi: 5 });
    expect(between(v, [3, "start"], [4, "start"])).toEqual({ days: { lo: 2, hi: 2 }, presumed: false });
    expect(between(v, [1, "end"], [3, "start"])?.days).toEqual({ lo: 2, hi: 4 });
    // 倒过来问是负的。
    expect(between(v, [4, "start"], [3, "start"])?.days).toEqual({ lo: -2, hi: -2 });
  });

  it("两个世界各加各的：每章两边说法不一样，加起来一样就是确定的", () => {
    const v = view([
      after(1, days(0)),
      after(2, undefined, { start: { byBoundary: { midnight: days(1), dawn: days(0) }, basis: "judged", quote: "第2章开头这一句" } }),
      after(3, undefined, { start: { byBoundary: { midnight: days(0), dawn: days(1) }, basis: "judged", quote: "第3章开头这一句" } }),
    ]);
    expect(between(v, [2, "end"], [3, "start"])?.days).toEqual({ lo: 0, hi: 1 });
    expect(between(v, [1, "end"], [3, "start"])?.days).toEqual({ lo: 1, hi: 1 });
  });

  it("章里：换天定位到句子就按句算；没定位到的那次换天，句子之间可能换了也可能没换", () => {
    const sentences = ["傍晚他到了渡口。", "夜里下起了雨。", "第二天一早雨停了。", "他又上了船。"];
    const located = view([chapter(1, { start: { offset: days(0), basis: "text", quote: "傍晚他到了渡口" }, dayChanges: [{ offset: days(1), quote: "第二天一早雨停了" }] }, sentences)]);
    expect(between(located, [1, 2], [1, 3])?.days).toEqual({ lo: 1, hi: 1 });
    expect(between(located, [1, 3], [1, 4])?.days).toEqual({ lo: 0, hi: 0 });
    expect(between(located, [1, "start"], [1, "end"])?.days).toEqual({ lo: 1, hi: 1 });
    const loose = view([chapter(1, { start: { offset: days(0), basis: "text", quote: "傍晚他到了渡口" }, dayChanges: [{ offset: days(1) }] }, sentences)]);
    expect(between(loose, [1, 2], [1, 3])?.days).toEqual({ lo: 0, hi: 1 });
    expect(between(loose, [1, "start"], [1, "end"])?.days).toEqual({ lo: 1, hi: 1 });
  });

  it("链上有作者定的天数：从那天重新算，这时才拿两处的绝对天数相减", () => {
    const v = view([after(1, days(0)), after(2, days(1, 3)), after(3, days(1)), after(4, days(1))], {
      decisions: [decision({ type: "chapter.day", chapter: 3, day: 10, dayEnd: 10 })],
    });
    expect(between(v, [2, "start"], [4, "start"])?.days).toEqual({ lo: 7, hi: 9 });
    expect(between(v, [3, "start"], [4, "start"])?.days).toEqual({ lo: 1, hi: 1 });
  });

  it("整章回忆跳过、链照接；中间有没认出的章、按月说的：断开或不知道", () => {
    const flashback = chapter(2, { segments: [{ frame: "past", firstQuote: "第2章开头这一句", lastQuote: "第2章后面那一句" }] });
    const v = view([after(1, days(0)), flashback, after(3, days(1))]);
    expect(between(v, [1, "end"], [3, "start"])?.days).toEqual({ lo: 1, hi: 1 });
    expect(between(v, [2, "start"], [3, "start"])).toBeUndefined();
    const broken = view([after(1, days(0)), chapter(2, undefined), after(3, days(1))]);
    expect(between(broken, [1, "end"], [3, "start"])).toBeUndefined();
    const months = view([after(1, days(0)), after(2, days(6, 6, "month")), after(3, days(1))]);
    expect(between(months, [1, "end"], [3, "start"])?.days).toBeUndefined();
    expect(between(months, [2, "end"], [3, "start"])?.days).toEqual({ lo: 1, hi: 1 });
  });
});

describe("作者定的天数", () => {
  it("和记账员记的并存：作者定的开头当锚；结尾没给按章内跨度推", () => {
    const ch2 = ledgerOf({
      chapter: 2,
      text: body(2, "第2章开头这一句。"),
      committedAt: STAMP,
      entries: [
        { kind: "time", review: "auto", start: { offset: days(1), basis: "text", quote: "第2章开头这一句" }, dayChanges: [{ offset: days(2) }] },
        { kind: "day", review: "auto", day: 2 },
      ],
    });
    const v = view([after(1, days(0)), ch2]);
    expect(timeOf(v, 2)).toMatchObject({ start: { lo: 2, hi: 2 }, end: { lo: 4, hi: 4 }, basis: "author" });
    expect(v.timeConflicts).toEqual([]);
  });

  it("对不上的各记一条结构冲突（不判谁对、不改任何一边）；作者点「以我定的为准」以后不再提", () => {
    const ch2 = ledgerOf({
      chapter: 2,
      text: body(2, "第2章开头这一句。"),
      committedAt: STAMP,
      entries: [
        { kind: "time", review: "auto", start: { offset: days(1), basis: "text", quote: "第2章开头这一句" }, sameDay: true },
        { kind: "day", review: "auto", day: 5, dayEnd: 7 },
      ],
    });
    const v = view([after(1, days(0)), ch2]);
    expect(v.timeConflicts).toEqual([
      { key: "time-start:2:5", kind: "time-start", chapter: 2, authorDay: 5, expected: { lo: 2, hi: 2 } },
      { key: "time-end:2:7", kind: "time-end", chapter: 2, authorDay: 7, expected: { lo: 5, hi: 5 } },
    ]);
    expect(timeOf(v, 2)).toMatchObject({ start: { lo: 5, hi: 5 }, end: { lo: 7, hi: 7 } });
    const settled = view([after(1, days(0)), ch2], { decisions: [decision({ type: "issue.dismiss", issue: "time-start:2:5" })] });
    expect(settled.timeConflicts.map((conflict) => conflict.key)).toEqual(["time-end:2:7"]);
  });

  it("定稿后改天数（裁定）：最后一次盖过清单上的；没给结尾 = 结尾按跨度推，给了 = 明确那天（T4）", () => {
    const ch2 = ledgerOf({ chapter: 2, text: body(2, "第2章开头这一句。"), committedAt: STAMP, entries: [{ kind: "day", review: "auto", day: 3 }] });
    const open = view([after(1, days(0)), ch2], { decisions: [decision({ type: "chapter.day", chapter: 2, day: 4 })] });
    expect(timeOf(open, 2).start).toEqual({ lo: 4, hi: 4 });
    // 本章记账员没记时间，作者也没给结尾：结尾不知道。
    expect(timeOf(open, 2).end).toBeUndefined();
    const closed = view([after(1, days(0)), ch2], {
      decisions: [decision({ type: "chapter.day", chapter: 2, day: 4 }), decision({ type: "chapter.day", chapter: 2, day: 6, dayEnd: 6 }, 2)],
    });
    expect(timeOf(closed, 2)).toMatchObject({ start: { lo: 6, hi: 6 }, end: { lo: 6, hi: 6 } });
  });
});

describe("星期", () => {
  it("只沿两个世界都确定的相对天数推；隔着区间的不推；作者定的天数把两段接上", () => {
    const v = view([
      after(1, days(0), { weekday: 0 }),
      after(2, days(2)),
      after(3, days(1, 2)),
      after(4, days(1)),
    ], { decisions: [decision({ type: "chapter.day", chapter: 4, day: 10, dayEnd: 10 })] });
    expect([1, 2, 3, 4].map((n) => [timeOf(v, n).weekday, timeOf(v, n).weekdayDerived])).toEqual([
      [0, false],
      [2, true],
      [undefined, false],
      // 第 4 章作者定了第 10 天：和第 1 章（第 1 天、周一）差 9 天。
      [2, true],
    ]);
  });
});

describe("旧账（P2b 及更早）只是推定", () => {
  function legacy(chapter: number, draft: Partial<LegacyTimeDraft>): ChapterLedger {
    const parsed = newLedger({
      chapter,
      textSha256: "0".repeat(64),
      committedAt: STAMP,
      origin: "commit",
      legacyTime: true,
      entries: storeLegacyTime({ review: "auto", basis: "text", ...draft }, `c${chapter}-1`, { evidence: [], evidenceStatus: "none" }, "migrated"),
    });
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  }

  it("有相对天数的章、全书第一章推定在当下线上，天数照推、标推定；旧的不知道算没认出", () => {
    const v = view([legacy(1, { basis: "estimated" }), legacy(2, { daysSincePrevious: 1, daysInChapter: 1 }), legacy(3, { basis: "estimated" }), legacy(4, { daysSincePrevious: 1 })]);
    expect(timeOf(v, 1)).toMatchObject({ presentLine: true, presumed: true, start: { lo: 1, hi: 1 }, end: { lo: 1, hi: 1 }, basis: "presumed" });
    expect(timeOf(v, 2)).toMatchObject({ presentLine: true, presumed: true, start: { lo: 2, hi: 2 }, end: { lo: 3, hi: 3 }, basis: "presumed" });
    expect(timeOf(v, 3).presentLine).toBe("unknown");
    expect(timeOf(v, 4).start).toBeUndefined();
    // 隔几天照算，但标着是推定的（核账不凭它报「确定」）。
    const times = new Map(v.chapters.map((item) => [item.chapter, item.time]));
    expect(elapsedDays(times, { chapter: 1, at: "end" }, { chapter: 2, at: "end" })).toEqual({ days: { lo: 2, hi: 2 }, presumed: true });
  });

  it("作者把换天定成半夜：旧账里记账员判断的相对天数失效（是按天亮换日判的），正文明写的照用", () => {
    const ledgers = [legacy(1, { daysSincePrevious: 0 }), legacy(2, { basis: "judged", daysSincePrevious: 1 }), legacy(3, { daysSincePrevious: 1 })];
    const dawn = view(ledgers);
    expect(timeOf(dawn, 2)).toMatchObject({ start: { lo: 2, hi: 2 }, boundaryInvalidated: false });
    const midnight = view(ledgers, { boundary: "midnight" });
    expect(timeOf(midnight, 2)).toMatchObject({ boundaryInvalidated: true, presentLine: true });
    expect(timeOf(midnight, 2).start).toBeUndefined();
    expect(timeOf(midnight, 3)).toMatchObject({ boundaryInvalidated: false, sincePrevious: { lo: 1, hi: 1 } });
    expect(timeOf(midnight, 3).start).toBeUndefined();
  });

  it("作者把换天定成半夜：旧账里记账员判断的章内天数也失效（出口复核 R5），作者定的那头照用", () => {
    const ledgers = [legacy(1, { basis: "judged", daysSincePrevious: 0, daysInChapter: 1 }), legacy(2, { basis: "text", daysSincePrevious: 1, daysInChapter: 1 })];
    expect(timeOf(view(ledgers), 1)).toMatchObject({ end: { lo: 2, hi: 2 }, boundaryInvalidated: false });
    const midnight = view(ledgers, { boundary: "midnight" });
    expect(timeOf(midnight, 1)).toMatchObject({ boundaryInvalidated: true });
    expect(timeOf(midnight, 1).end).toBeUndefined();
    // 正文明写的章内天数照用。
    expect(timeOf(midnight, 2)).toMatchObject({ boundaryInvalidated: false });
    expect(timeOf(midnight, 2).span).toEqual({ lo: 1, hi: 1 });
    // 作者定的天数（连它带的章内天数）照用。
    const authored = view([legacy(1, { basis: "judged", daysSincePrevious: 0, daysInChapter: 1 }), legacy(2, { basis: "author", day: 5, daysInChapter: 1 })], { boundary: "midnight" });
    expect(timeOf(authored, 2)).toMatchObject({ start: { lo: 5, hi: 5 }, end: { lo: 6, hi: 6 }, boundaryInvalidated: false });
  });

  it("盘点判成不可信的：不知道，原值留着", () => {
    const v = view([legacy(1, { daysSincePrevious: 0 }), legacy(2, { basis: "estimated", legacy: { relation: "at", day: 5, basis: "estimated", reason: "estimated" } })]);
    expect(timeOf(v, 2)).toMatchObject({ basis: "unknown", legacyDay: { day: 5, reason: "estimated" } });
    expect(timelineText(timelineTable(v))).toContain("不知道（老书里记的约第 5 天，不可信）");
  });
});
