// @vitest-environment node
// R7.3 相对日子换算（确定性、不调模型）：两句里都有「今天 / 明天 / 后天 / 大后天 / 昨天 / 前天」时，
// 按时间线里两章各自的故事日换算成绝对第几天再比——同一天不报；换算不了（缺可靠故事日）最多「可能」。
import { describe, expect, it } from "vitest";
import type { StoryTimeline } from "../../book/story-timeline.js";
import { applyRelativeDayAlignment, relativeDayMentions, type ContinuityIssueV2 } from "./check-chapter.js";

const entry = (chapter: number, day: number, source: StoryTimeline["entries"][number]["source"]) => ({ chapter, day, source });
const timeline = (...entries: readonly ReturnType<typeof entry>[]): StoryTimeline => ({ schemaVersion: 1, entries });

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

describe("applyRelativeDayAlignment：换算成绝对第几天再比", () => {
  it("报告 3.3 的案子：第 1 章（第 1 天）「后天」对第 2 章（第 2 天）「明天」是同一天 → 不报", () => {
    const tl = timeline(entry(1, 1, "fallback"), entry(2, 2, "plan"));
    const out = applyRelativeDayAlignment([issue("“明天上午陆川来。”老周说", "后天上午，陆川会来。", 1)], 2, tl);
    expect(out).toEqual([]);
  });

  it("换算出来真是不同的日子（约的日子顺延了）→ 照报", () => {
    const tl = timeline(entry(6, 6, "declared"), entry(7, 7, "declared"));
    const out = applyRelativeDayAlignment([issue("你约的按手印，是不是后天上午", "定在后天上午", 6)], 7, tl);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe("sure");
  });

  it("缺可靠故事日（没有条目 / fallback 估的）→ 最多「可能」，不进「确定」", () => {
    // 第 2 章没有条目（还没定稿的稿子）；第 3 章是 fallback 估的——都换算不了。
    const tl = timeline(entry(1, 1, "declared"), entry(3, 3, "fallback"));
    const out = applyRelativeDayAlignment(
      [issue("他想起前天送表那个男人", "怀表是前天送来的", 1), issue("明天再说", "明天开工", 3)],
      2,
      tl,
    );
    expect(out).toHaveLength(2);
    expect(out.every((item) => item.confidence === "maybe")).toBe(true);
  });

  it("第 1 章的 fallback 是 day＝1（前面没有章，不是估的）→ 算可靠", () => {
    const tl = timeline(entry(1, 1, "fallback"), entry(2, 2, "declared"));
    const out = applyRelativeDayAlignment([issue("明天上午到", "后天上午到", 1)], 2, tl);
    expect(out).toEqual([]);
  });

  it("换算出来在故事开始之前（第 1 天说「前天」）→ 算换算不了，降「可能」", () => {
    const tl = timeline(entry(1, 1, "declared"), entry(2, 2, "declared"));
    const out = applyRelativeDayAlignment([issue("前天送来的", "前天就到了", 1)], 2, tl);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe("maybe");
  });

  it("两边各有好几处说法（日子对调那类）→ 代码分不出，不删也不降", () => {
    const tl = timeline(entry(1, 1, "declared"), entry(2, 2, "declared"));
    const out = applyRelativeDayAlignment([issue("茶馆后天，林记大后天", "你们林记后天，茶馆大后天", 1)], 2, tl);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe("sure");
  });

  it("只有一边有固定说法、或两边都没有 → 不动；对设定本的条目不适用", () => {
    const tl = timeline(entry(1, 1, "declared"));
    const plain = issue("他说明天就走", "他答应再住几天", 1);
    const none = issue("钟停在三点一刻", "钟停在三点十五分", 1);
    const setting: ContinuityIssueV2 = { ...issue("走了五年", "三年前过世", 3), againstSetting: { label: "人物卡" }, fixChapter: 3 };
    const out = applyRelativeDayAlignment([plain, none, setting], 6, tl);
    expect(out.map((item) => item.confidence)).toEqual(["sure", "sure", "sure"]);
    expect(out[2]).toMatchObject({ againstSetting: { label: "人物卡" }, fixChapter: 3 });
  });

  it("同章内两句（earlierChapter＝本章）也按同一天换算：同一天不报", () => {
    const tl = timeline(entry(4, 4, "author"));
    const out = applyRelativeDayAlignment([issue("说明天一早动身", "明天一早就动身吧", 4)], 4, tl);
    expect(out).toEqual([]);
  });

  it("时间线整个没有（读不了）→ 相对日子的条目全降「可能」，其余不动", () => {
    const out = applyRelativeDayAlignment([issue("明天再说", "后天再说", 2)], 3, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe("maybe");
  });
});
