import { describe, expect, it } from "vitest";
import type { BookProjection } from "@actalk/story-core";
import { toStoryMap } from "./story-map.js";

type Chapter = BookProjection["chapters"][number];
type Member = BookProjection["cast"][number];

const chapter = (over: Partial<Chapter> & Pick<Chapter, "chapter" | "day">): Chapter => ({
  origin: "commit",
  committedAt: "2026-10-18T00:00:00.000Z",
  dayEnd: over.day,
  dayBasis: "text",
  weekdayDerived: false,
  present: [],
  textMissing: false,
  ...over,
});

const member = (over: Partial<Member> & Pick<Member, "key" | "name" | "chapters">): Member => ({
  aliases: [],
  viewpointChapters: [],
  appearances: over.chapters.map((n) => ({ chapter: n, quote: `${over.name}第${n}章` })),
  ...over,
});

describe("故事地图数据（重构 P6）", () => {
  it("章：故事日、星期、时段、依据、梗概、出场、视角原样给；没有的字段不带；定稿时间、正文改没改不外传", () => {
    const map = toStoryMap({
      upTo: 2,
      chapters: [
        chapter({ chapter: 1, day: 1, weekday: 0, timeOfDay: "傍晚", summary: "周守义来了", present: ["周守义"], viewpoint: "周守义" }),
        chapter({ chapter: 2, day: 4, dayEnd: 5, dayBasis: "missing", weekday: 3, weekdayDerived: true, editedSinceCommit: true }),
      ],
      cast: [],
    });
    expect(map.chapters[0]).toEqual({
      chapter: 1, day: 1, dayEnd: 1, weekday: 0, weekdayDerived: false, timeOfDay: "傍晚",
      basis: "text", summary: "周守义来了", present: ["周守义"], viewpoint: "周守义",
    });
    expect(map.chapters[1]).toEqual({ chapter: 2, day: 4, dayEnd: 5, weekday: 3, weekdayDerived: true, basis: "missing", present: [] });
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
