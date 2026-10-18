import { describe, expect, it } from "vitest";
import { findRecurringPhrases } from "./recurring-phrases.js";

const ENDING = "他把台灯拧暗了一格。一屋子的钟在黑暗里响着，七只，各走各的。";

describe("findRecurringPhrases", () => {
  it("跨章复用的收尾意象被找出来（拼回整句），专有名词不算", () => {
    const chapters = [1, 2, 3, 4].map((chapter) => ({
      chapter,
      body: `第${chapter}章里林舟去了回记铜作，查了登记表上第${chapter}行。中间写些各不相同的事情编号${chapter}。\n\n${chapter % 2 === 0 ? ENDING : "他睡下了，窗外下起小雨。"}`,
    }));
    const phrases = findRecurringPhrases({ chapters, knownNames: ["林舟", "回记铜作", "登记表"], minChapters: 3 });
    const texts = phrases.map((item) => item.phrase);
    expect(texts.some((text) => text.includes("一屋子的钟在黑暗里响"))).toBe(true);
    // 跨在专有名词上的片段一个都不产生（连「舟去了回记铜」这种半截都没有）。
    expect(texts.every((text) => !/[舟回记铜登表]/u.test(text))).toBe(true);
  });

  it("只出现在一章的不算", () => {
    const phrases = findRecurringPhrases({
      chapters: [
        { chapter: 1, body: "一屋子的钟在黑暗里响着。" },
        { chapter: 2, body: "窗外下起了小雨，街上没人。" },
        { chapter: 3, body: "早上起来，豆浆摊已经出摊。" },
      ],
    });
    expect(phrases).toEqual([]);
  });
});
