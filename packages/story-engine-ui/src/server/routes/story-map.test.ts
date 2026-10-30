import { describe, expect, it } from "vitest";
import { ledgerOf, project, type BookProjection, type TimeInput } from "@actalk/story-core";
import { toStoryMap } from "./story-map.js";

type Member = BookProjection["cast"][number];

const STAMP = "2026-10-18T00:00:00.000Z";
const days = (min: number, max = min) => ({ unit: "day" as const, min, max });
/** 一章：第一句当开头原句；后面两句可以拿来当段。 */
function chapter(n: number, time: Omit<TimeInput, "kind" | "review">) {
  return ledgerOf({ chapter: n, text: `# 第${n}章\n\n第${n}章开头这一句。他想起三年前。那年很冷。`, committedAt: STAMP, entries: [{ kind: "time", review: "auto", ...time }] });
}
const at = (offset: ReturnType<typeof days>, n: number) => ({ start: { offset, basis: "text" as const, quote: `第${n}章开头这一句` }, sameDay: true });
const flashback = { frame: "past" as const, firstQuote: "他想起三年前", lastQuote: "那年很冷", when: { offset: { unit: "year" as const, min: -3, max: -3 } } };

const member = (over: Partial<Member> & Pick<Member, "key" | "name" | "chapters">): Member => ({
  aliases: [],
  viewpointChapters: [],
  appearances: over.chapters.map((n) => ({ chapter: n, quote: `${over.name}第${n}章` })),
  ...over,
});

describe("故事地图数据（重构 P6）", () => {
  it("章：故事哪几天、星期、时段、不在当下的段、梗概、出场、视角；隔了几天、往回接标出来；定稿时间、正文改没改不外传", () => {
    const projection = project({
      decisions: [],
      ledgers: [
        chapter(1, { ...at(days(0), 1), weekday: 0, timeOfDay: "傍晚" }),
        chapter(2, { ...at(days(1), 2), segments: [flashback] }),
        chapter(3, at(days(4), 3)),
        // 整章回忆：不占故事的日子。
        chapter(4, { segments: [{ ...flashback, firstQuote: "第4章开头这一句" }] }),
        // 多线往回接：比第 3 章早两天。
        chapter(5, at(days(-2), 5)),
        chapter(6, at(days(1, 3), 6)),
      ],
    });
    const [first, ...rest] = projection.chapters;
    const map = toStoryMap({ ...projection, chapters: [{ ...first!, summary: "周守义来了", present: ["周守义"], viewpoint: "周守义", editedSinceCommit: true }, ...rest] });
    expect(map.chapters[0]).toEqual({
      chapter: 1, presentLine: true, days: "第 1 天", weekday: 0, weekdayDerived: false, timeOfDay: "傍晚",
      segments: [], summary: "周守义来了", present: ["周守义"], viewpoint: "周守义",
    });
    expect(map.chapters[1]).toMatchObject({ days: "第 2 天", weekday: 1, weekdayDerived: true, segments: ["回忆（3 年前）"] });
    expect(map.chapters[1]).not.toHaveProperty("gap");
    expect(map.chapters[2]).toMatchObject({ days: "第 6 天", gap: "过了 4 天" });
    expect(map.chapters[3]).toMatchObject({ presentLine: false, segments: ["回忆（3 年前）"] });
    expect(map.chapters[3]).not.toHaveProperty("days");
    expect(map.chapters[4]).toMatchObject({ days: "第 4 天", gap: "往回 2 天" });
    expect(map.chapters[5]).toMatchObject({ days: "第 5～7 天" });
    expect(map.chapters[5]).not.toHaveProperty("gap");
    // 故事走到第几天：结尾确定的当下章里最晚的那天（往回接的章不往回拉）。
    expect(map.lastDay).toBe(6);
    expect(JSON.stringify(map)).not.toContain("committedAt");
    expect(JSON.stringify(map)).not.toContain("editedSinceCommit");
  });

  it("人物：出场章多的在前，一样多的先出场的在前；带每章出场原句，不带内部 key", () => {
    const map = toStoryMap({
      upTo: 3,
      chapters: [],
      cast: [
        member({ key: "k-late", name: "沈同志", chapters: [3] }),
        member({ key: "k-early", name: "老板娘", chapters: [1] }),
        member({ key: "k-main", name: "周守义", aliases: ["老周"], chapters: [1, 2, 3], viewpointChapters: [1] }),
      ],
    });
    expect(map.cast.map((item) => item.name)).toEqual(["周守义", "老板娘", "沈同志"]);
    expect(map.cast[0]).toEqual({
      name: "周守义",
      aliases: ["老周"],
      viewpointChapters: [1],
      appearances: [{ chapter: 1, quote: "周守义第1章" }, { chapter: 2, quote: "周守义第2章" }, { chapter: 3, quote: "周守义第3章" }],
    });
    expect(JSON.stringify(map)).not.toContain("k-main");
  });

  it("出场一样多：当过视角的在前（主角不被配角挤到后面）", () => {
    const map = toStoryMap({
      upTo: 2,
      chapters: [],
      cast: [
        member({ key: "a-side", name: "周婶", chapters: [1, 2] }),
        member({ key: "b-main", name: "林舟", chapters: [1, 2], viewpointChapters: [2] }),
      ],
    });
    expect(map.cast.map((item) => item.name)).toEqual(["林舟", "周婶"]);
  });
});
