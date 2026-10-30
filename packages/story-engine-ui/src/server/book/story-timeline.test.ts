// @vitest-environment node
import { emptySettingCards, ledgerOf, newLedger, project, storeLegacyTime, type AuthorDecision, type ChapterLedger, type LegacyTimeDraft, type TimeInput } from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import { continueDayText, describeTimelineForChapter, planClock, previousPresentChapter, timeChecksOf } from "./story-timeline.js";

// 天数怎么排是投影的事（核心 projection 的测试）；这里只测给模型、给界面的样子。
const STAMP = "2026-10-31T00:00:00.000Z";
const days = (min: number, max = min) => ({ unit: "day" as const, min, max });
type TimeDraft = Omit<TimeInput, "kind" | "review">;

/** 一章：第一句当开头原句；time 不给 start 就按 offset 记、整章同一天。 */
function chapter(n: number, offset: ReturnType<typeof days> | undefined, extra: Partial<TimeDraft> = {}, sentences = [`第${n}章开头这一句。`, `第${n}章后面那一句。`]): ChapterLedger {
  return ledgerOf({
    chapter: n,
    text: `# 第${n}章\n\n${sentences.join("")}`,
    committedAt: STAMP,
    entries: [{ kind: "time", review: "auto", start: { ...(offset ? { offset } : {}), basis: "text", quote: sentences[0]!.slice(0, -1) }, sameDay: true, ...extra }],
  });
}
const view = (ledgers: ChapterLedger[], decisions: AuthorDecision[] = []) => project({ ledgers, decisions });
/** 导入老书时记下的那种旧账（没有 P3 时间格式标记）。 */
function legacy(n: number, draft: Partial<LegacyTimeDraft>): ChapterLedger {
  const parsed = newLedger({ chapter: n, textSha256: "0".repeat(64), committedAt: STAMP, origin: "import", legacyTime: true, entries: storeLegacyTime({ review: "auto", basis: "text", ...draft }, `c${n}-1`, { evidence: [], evidenceStatus: "none" }, "migrated") });
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/** 《半页书店》：周三起；第 5 章「三天后，周二」。0 = 周一。 */
function banye() {
  return view([
    chapter(1, days(0), { weekday: 2 }),
    chapter(2, days(1)),
    chapter(3, days(1), { weekday: 4 }),
    chapter(4, days(1), { weekday: 5 }),
    chapter(5, days(3), { weekday: 1, timeOfDay: "下午" }),
  ]);
}

describe("给模型的时间对照表", () => {
  it("本章哪天、前面各章是哪天、离本章开头昨天 / 前天 / 几天前，带星期；不让模型自己算", () => {
    const text = describeTimelineForChapter(banye(), 5)!;
    expect(text).toContain("本章（第 5 章）：故事第 7 天（周二），下午");
    expect(text).toContain("第 4 章：故事第 4 天（周六）；离本章开头：3 天前");
    expect(text).toContain("第 2 章：故事第 2 天（周四）；离本章开头：5 天前");
    expect(text).toContain("不要自己推算");
    expect(text).not.toContain("不知道");
    // 近的在前。
    expect(text.indexOf("第 4 章")).toBeLessThan(text.indexOf("第 3 章"));
  });

  it("本章还没定稿：只列前面各章是哪天，本章按正文对照", () => {
    const text = describeTimelineForChapter(banye(), 6)!;
    expect(text).toContain("本章（第 6 章）：还没定稿");
    expect(text).toContain("第 5 章：故事第 7 天（周二），下午");
    expect(text).not.toContain("离本章开头");
    expect(describeTimelineForChapter(view([]), 1)).toBeUndefined();
  });

  it("章内换了天：表上标出两天、两个相对说法", () => {
    const v = view([chapter(1, days(0)), chapter(2, days(0), { sameDay: undefined, dayChanges: [{ offset: days(1) }], timeOfDay: "傍晚" }), chapter(3, days(1))]);
    expect(describeTimelineForChapter(v, 3)).toContain("第 2 章：故事第 1 天到第 2 天，傍晚；离本章开头：前天到昨天");
  });

  it("中间一章「一到三天后」：绝对天数是区间，照实写；它后面的章离本章多久照样确定", () => {
    const v = view([chapter(1, days(0)), chapter(2, days(1, 3)), chapter(3, days(1)), chapter(4, days(2))]);
    const text = describeTimelineForChapter(v, 4)!;
    expect(text).toContain("本章（第 4 章）：故事第 5～7 天");
    expect(text).toContain("第 3 章：故事第 3～5 天；离本章开头：前天");
    // 第 1 章到本章隔几天说不准：只给第几天，不给相对说法。
    expect(text).toContain("第 1 章：故事第 1 天\n");
  });

  it("多线往回接：前面那章在本章之后，说「几天后」；整章回忆的章照实说不在当下线上，并提醒别拿它的日子对", () => {
    const flashback = ledgerOf({
      chapter: 3,
      text: "# 第3章\n\n他想起三年前。那年冬天很冷。",
      committedAt: STAMP,
      entries: [{ kind: "time", review: "auto", segments: [{ frame: "past", firstQuote: "他想起三年前", lastQuote: "那年冬天很冷", when: { offset: { unit: "year", min: -3, max: -3 } } }] }],
    });
    const v = view([chapter(1, days(0)), chapter(2, days(3)), flashback, chapter(4, days(-2))]);
    const text = describeTimelineForChapter(v, 4)!;
    expect(text).toContain("本章（第 4 章）：故事第 2 天");
    expect(text).toContain("第 2 章：故事第 4 天；离本章开头：2 天后");
    expect(text).toContain("第 3 章：整章不在当下线上（回忆（3 年前）），不占故事的日子");
    expect(text).toContain("回忆、梦里的日子是那段自己的");
  });

  it("有章账待记、旧账推的：照实说不知道、推的不算准；别替它们定日子", () => {
    const pending = ledgerOf({ chapter: 2, text: "# 第2章\n\n正文。", committedAt: STAMP, entries: [], status: "pending", coverage: { reasonCodes: ["keeper_failed"] } });
    const text = describeTimelineForChapter(view([chapter(1, days(0)), pending, chapter(3, days(1))]), 4)!;
    expect(text).toContain("第 2 章：这章的账还没记上，是哪天不知道");
    expect(text).toContain("第 3 章：前面有章没认出在不在当下线上，是哪天不知道");
    expect(text).toContain("别替它们定日子");
    expect(describeTimelineForChapter(view([legacy(1, { daysSincePrevious: 0 }), legacy(2, { daysSincePrevious: 1 })]), 3)).toContain("第 2 章：故事第 2 天，按旧账推的、不算准");
  });
});

describe("章纲给写手的故事日历", () => {
  it("今天 = 上一个当下章结尾 + dayOffset，带星期；前面各章标好离今天多久", () => {
    const clock = planClock(banye(), 6, { dayOffset: 1, after: 5, time: "第二天上午" })!;
    expect(clock.today).toBe("本章是故事第 8 天，周三（第二天上午）");
    expect(clock.earlier[0]).toBe("第 5 章：故事第 7 天（周二），下午；离今天：昨天");
    expect(clock.earlier[1]).toBe("第 4 章：故事第 4 天（周六）；离今天：4 天前");
  });

  it("往回接（dayOffset 负）：前面那章在今天之后就说「几天后」，不滤掉", () => {
    const clock = planClock(banye(), 6, { dayOffset: -2, after: 5 })!;
    expect(clock.today).toBe("本章是故事第 5 天，周日");
    expect(clock.earlier[0]).toBe("第 5 章：故事第 7 天（周二），下午；离今天：2 天后");
  });

  it("整章回忆、说不准离上一章多久：不给今天、不给相对说法；前面没有当下章就是第 1 天", () => {
    expect(planClock(banye(), 6, { frame: "past", time: "三年前冬天" })!.today).toContain("本章整章是回忆（三年前冬天），不在当下线上");
    const loose = planClock(banye(), 6, {})!;
    expect(loose.today).toContain("本章是哪天说不准");
    expect(loose.earlier.some((line) => line.includes("离今天"))).toBe(false);
    expect(planClock(view([]), 1, { dayOffset: 0 })?.today).toBe("本章是故事第 1 天");
  });
});

describe("上一个当下章、接哪天", () => {
  it("跳过整章回忆的章；中间有没认出的章就说不知道", () => {
    const flashback = ledgerOf({ chapter: 2, text: "# 第2章\n\n他想起那年。那年很冷。", committedAt: STAMP, entries: [{ kind: "time", review: "auto", segments: [{ frame: "past", firstQuote: "他想起那年", lastQuote: "那年很冷" }] }] });
    const v = view([chapter(1, days(0), { timeOfDay: "傍晚" }), flashback]);
    expect(previousPresentChapter(v, 3)).toMatchObject({ chapter: 1 });
    expect(continueDayText(v, 3)).toBe("不在当下（回忆）；当下停在第 1 章：第 1 天傍晚");
    expect(continueDayText(v, 2)).toBe("第 1 天傍晚");
    const unknown = view([chapter(1, days(0)), ledgerOf({ chapter: 2, text: "# 第2章\n\n正文。", committedAt: STAMP, entries: [] })]);
    expect(previousPresentChapter(unknown, 3)).toBe("unknown");
    expect(previousPresentChapter(view([]), 1)).toBeUndefined();
  });
});

describe("天数要作者看的", () => {
  it("导入时记成作者定的、证明不了：列出来带原值；作者记了天数就不再列", () => {
    const books = [legacy(1, { daysSincePrevious: 0 }), legacy(2, { legacy: { relation: "at", day: 4, basis: "author", reason: "unproven" } })];
    expect(timeChecksOf(view(books))).toEqual([{ chapter: 2, kind: "unproven", day: 4, text: "导入时记成你定的第 4 天，证明不了是你定的，现在算不知道" }]);
    const confirmed: AuthorDecision = { id: "d-1", at: STAMP, type: "chapter.day", chapter: 2, day: 4 };
    expect(timeChecksOf(view(books, [confirmed]))).toEqual([]);
  });

  it("换天规矩改成过了半夜就算：旧账里记账员判断的那章列出来", () => {
    const ledgers = [legacy(1, { daysSincePrevious: 0 }), legacy(2, { basis: "judged", daysSincePrevious: 1 })];
    const midnight = project({ ledgers, decisions: [], cards: { ...emptySettingCards(), calendar: { dayBoundary: "midnight", at: STAMP } } });
    expect(timeChecksOf(midnight).map((check) => [check.chapter, check.kind])).toEqual([[2, "boundary"]]);
    expect(timeChecksOf(view(ledgers))).toEqual([]);
  });

  it("作者定的和按记下的推出来的对不上：开头、结尾各一条，只说哪两样对不上", () => {
    const two = ledgerOf({
      chapter: 2,
      text: "# 第2章\n\n第2章开头这一句。",
      committedAt: STAMP,
      entries: [{ kind: "time", review: "auto", start: { offset: days(1), basis: "text", quote: "第2章开头这一句" }, sameDay: true }, { kind: "day", review: "auto", day: 5, dayEnd: 7 }],
    });
    expect(timeChecksOf(view([chapter(1, days(0)), two]))).toEqual([
      { chapter: 2, kind: "conflict", text: "你定的第 5 天，和按上一章、这章开头推出来的第 2 天对不上" },
      { chapter: 2, kind: "conflict", text: "你定的第 7 天，和按这章里换天推出来的第 5 天对不上" },
    ]);
  });
});
