// @vitest-environment node
// R7.3 相对日子换算（确定性、不调模型）：两句里都有「今天 / 明天 / 后天 / 大后天 / 昨天 / 前天」时，
// 按两句各在哪一刻、沿当下链算隔几天再比——同一天不报；算不了最多「可能」（写作版本 P3a T10：看开头和结尾、按句定位）。
import { chapterSource, ledgerOf, locateQuote, newLedger, project, storeLegacyTime, type ChapterLedger, type TimeInput } from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import { applyRelativeDayAlignment, relativeDayMentions, type ContinuityIssueV2, type RelativeDayContext } from "./check-chapter.js";

const STAMP = "2026-10-31T00:00:00.000Z";
const days = (min: number, max = min) => ({ unit: "day" as const, min, max });
const text = (chapter: number, sentences: readonly string[]) => `# 第${chapter}章\n\n${sentences.join("")}`;

/** 一章：正文几句，开头离上一个当下章结尾 offset 天（第一句引作原句），没写换天就是整章同一天。 */
function chapter(n: number, sentences: readonly string[], time: Partial<Omit<TimeInput, "kind" | "review">> & { readonly offset?: ReturnType<typeof days> } = {}): ChapterLedger {
  const { offset = days(1), ...rest } = time;
  return ledgerOf({
    chapter: n,
    text: text(n, sentences),
    committedAt: STAMP,
    entries: [{ kind: "time", review: "auto", start: { offset, basis: "text", quote: sentences[0]!.slice(0, -1) }, ...(rest.dayChanges ? {} : { sameDay: true }), ...rest }],
  });
}

/** 按这几章算的时间；texts 里的章能按句定位（定稿后没改过）。 */
function context(ledgers: readonly ChapterLedger[], texts: ReadonlyMap<number, readonly string[]> = new Map()): RelativeDayContext {
  const view = project({ ledgers: [...ledgers], decisions: [] });
  return {
    times: new Map(view.chapters.map((item) => [item.chapter, item.time])),
    unitsOf: (n, quote) => {
      const sentences = texts.get(n);
      return sentences ? locateQuote(quote, chapterSource(n, text(n, sentences)))?.units : undefined;
    },
  };
}

const issue = (quote: string, earlierQuote: string, earlierChapter: number): ContinuityIssueV2 => ({
  quote,
  earlierQuote,
  earlierChapter,
  reason: "日子对不上",
  kind: "time",
  confidence: "sure",
});

describe("relativeDayMentions：只认这六个固定说法", () => {
  it("六个都认得到，带偏移", () => {
    expect(relativeDayMentions("今天他说后天走，明天再说，昨天和前天的话大后天兑现")).toEqual([
      { word: "今天", delta: 0 },
      { word: "后天", delta: 2 },
      { word: "明天", delta: 1 },
      { word: "昨天", delta: -1 },
      { word: "前天", delta: -2 },
      { word: "大后天", delta: 3 },
    ]);
  });
  it("「大后天」不拆成「后天」；守卫字（目前天气 / 眼前天色 / 然后天亮）和「大前天」都不算", () => {
    expect(relativeDayMentions("大后天出发")).toEqual([{ word: "大后天", delta: 3 }]);
    expect(relativeDayMentions("目前天气不好")).toEqual([]);
    expect(relativeDayMentions("眼前天色暗了")).toEqual([]);
    expect(relativeDayMentions("然后天亮再走")).toEqual([]);
    expect(relativeDayMentions("大前天的事")).toEqual([]);
  });
  it("别的说法（次日、一周后、周三）不认——不扩词表", () => {
    expect(relativeDayMentions("次日一早他就走了，过了一周才回来，周三见面")).toEqual([]);
  });
});

describe("applyRelativeDayAlignment：按两句各在哪一刻算隔几天再比", () => {
  it("报告 3.3 的案子：第 1 章「后天」对第二天那章的「明天」是同一天 → 不报", () => {
    const ctx = context([chapter(1, ["后天上午，陆川会来。"], { offset: days(0) }), chapter(2, ["“明天上午陆川来。”老周说。"])]);
    expect(applyRelativeDayAlignment([issue("“明天上午陆川来。”老周说", "后天上午，陆川会来。", 1)], 2, ctx)).toEqual([]);
  });

  it("算出来真是不同的日子（约的日子顺延了）→ 照报", () => {
    const ctx = context([chapter(1, ["开头。"], { offset: days(0) }), chapter(2, ["定在后天上午。"]), chapter(3, ["你约的按手印，是不是后天上午。"])]);
    const out = applyRelativeDayAlignment([issue("你约的按手印，是不是后天上午", "定在后天上午", 2)], 3, ctx);
    expect(out.map((item) => item.confidence)).toEqual(["sure"]);
  });

  it("前一章跨了天：按那句在章里哪一刻算，不只看开头那天（T10）", () => {
    const sentences = ["傍晚他到了渡口。", "夜里下起了雨。", "第二天一早雨停了。", "船家说明天上午到。"];
    const located = chapter(1, sentences, { offset: days(0), dayChanges: [{ offset: days(1), quote: "第二天一早雨停了" }] });
    const next = chapter(2, ["今天上午船到了。"]);
    // 第 1 章第 4 句已经是第 2 天，「明天」= 第 3 天 = 第 2 章「今天」。
    const ctx = context([located, next], new Map([[1, sentences], [2, ["今天上午船到了。"]]]));
    expect(applyRelativeDayAlignment([issue("今天上午船到了", "船家说明天上午到", 1)], 2, ctx)).toEqual([]);
    // 那句定位不了（正文定稿后改过）：可能在第 1 天也可能在第 2 天，说不准 → 「可能」。
    const loose = context([located, next]);
    expect(applyRelativeDayAlignment([issue("今天上午船到了", "船家说明天上午到", 1)], 2, loose).map((item) => item.confidence)).toEqual(["maybe"]);
  });

  it("中间隔着「一到三天后」：绝对天数是区间，两章之间隔几天照样确定 → 照算", () => {
    const ctx = context([chapter(1, ["开头。"], { offset: days(0) }), chapter(2, ["明天就见分晓。"], { offset: days(1, 3) }), chapter(3, ["今天见分晓。"])]);
    expect(applyRelativeDayAlignment([issue("今天见分晓", "明天就见分晓", 2)], 3, ctx)).toEqual([]);
  });

  it("说不准隔几天，但怎么算都不可能是同一天 → 照报；可能是同一天 → 「可能」", () => {
    const far = context([chapter(1, ["明天就见分晓。"], { offset: days(0) }), chapter(2, ["今天见分晓。"], { offset: days(3, 5) })]);
    expect(applyRelativeDayAlignment([issue("今天见分晓", "明天就见分晓", 1)], 2, far).map((item) => item.confidence)).toEqual(["sure"]);
    const near = context([chapter(1, ["明天就见分晓。"], { offset: days(0) }), chapter(2, ["今天见分晓。"], { offset: days(1, 2) })]);
    expect(applyRelativeDayAlignment([issue("今天见分晓", "明天就见分晓", 1)], 2, near).map((item) => item.confidence)).toEqual(["maybe"]);
  });

  it("算不了 → 最多「可能」：本章还没定稿、在回忆段里、沿着旧账推定的章、时间整个读不了", () => {
    const base = [chapter(1, ["明天开工。"], { offset: days(0) })];
    expect(applyRelativeDayAlignment([issue("明天再说", "明天开工", 1)], 2, context(base)).map((item) => item.confidence)).toEqual(["maybe"]);
    const memory = ["他想起那年说过明天开工。", "如今人都散了。"];
    const flashback = chapter(2, memory, { segments: [{ frame: "past", firstQuote: "他想起那年说过明天开工", lastQuote: "他想起那年说过明天开工" }] });
    const segmented = context([...base, flashback], new Map([[2, memory]]));
    expect(applyRelativeDayAlignment([issue("他想起那年说过明天开工", "明天开工", 1)], 2, segmented).map((item) => item.confidence)).toEqual(["maybe"]);
    const legacy = (n: number, daysSincePrevious: number): ChapterLedger => {
      const parsed = newLedger({
        chapter: n,
        textSha256: "0".repeat(64),
        committedAt: STAMP,
        origin: "commit",
        legacyTime: true,
        entries: storeLegacyTime({ review: "auto", basis: "judged", daysSincePrevious }, `c${n}-1`, { evidence: [], evidenceStatus: "none" }, "migrated"),
      });
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    };
    expect(applyRelativeDayAlignment([issue("今天再说", "明天再说", 1)], 2, context([legacy(1, 0), legacy(2, 1)])).map((item) => item.confidence)).toEqual(["maybe"]);
    expect(applyRelativeDayAlignment([issue("明天再说", "后天再说", 2)], 3, undefined).map((item) => item.confidence)).toEqual(["maybe"]);
  });

  it("两边各有好几处说法（日子对调那类）→ 隔几天确定就不删也不降", () => {
    const ctx = context([chapter(1, ["你们林记后天，茶馆大后天。"], { offset: days(0) }), chapter(2, ["茶馆后天，林记大后天。"])]);
    expect(applyRelativeDayAlignment([issue("茶馆后天，林记大后天", "你们林记后天，茶馆大后天", 1)], 2, ctx).map((item) => item.confidence)).toEqual(["sure"]);
  });

  it("只有一边有固定说法、或两边都没有 → 不动；对设定本的条目不适用", () => {
    const ctx = context([chapter(1, ["开头。"], { offset: days(0) })]);
    const plain = issue("他说明天就走", "他答应再住几天", 1);
    const none = issue("钟停在三点一刻", "钟停在三点十五分", 1);
    const setting: ContinuityIssueV2 = { ...issue("走了五年", "三年前过世", 3), againstSetting: { label: "人物卡" }, fixChapter: 3 };
    const out = applyRelativeDayAlignment([plain, none, setting], 6, ctx);
    expect(out.map((item) => item.confidence)).toEqual(["sure", "sure", "sure"]);
    expect(out[2]).toMatchObject({ againstSetting: { label: "人物卡" }, fixChapter: 3 });
  });

  it("同章内两句（earlierChapter＝本章）：整章同一天就是同一天，不报", () => {
    const ctx = context([chapter(1, ["开头。"], { offset: days(0) }), chapter(4, ["说明天一早动身。", "明天一早就动身吧。"], { offset: days(2) })]);
    expect(applyRelativeDayAlignment([issue("说明天一早动身", "明天一早就动身吧", 4)], 4, ctx)).toEqual([]);
  });
});
