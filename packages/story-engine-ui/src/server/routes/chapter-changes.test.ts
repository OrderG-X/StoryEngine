import { describe, expect, it } from "vitest";
import type { BookProjection } from "@actalk/story-core";
import { toChapterChanges } from "./chapter-changes.js";

type Chapter = BookProjection["chapters"][number];
type Fact = BookProjection["facts"][number];
type Thread = BookProjection["threads"][number];
type Member = BookProjection["cast"][number];

const chapter = (n: number, over: Partial<Chapter> = {}): Chapter => ({
  chapter: n, origin: "commit", committedAt: "2026-10-18T00:00:00.000Z", day: n, dayEnd: n, dayBasis: "text",
  weekdayDerived: false, present: [], textMissing: false, ...over,
});
const fact = (id: string, n: number, over: Partial<Fact> = {}): Fact => ({
  id, chapter: n, nature: "state", text: `事实${id}`, review: "auto", status: "current", ...over,
});
const thread = (id: string, title: string, touches: Thread["touches"]): Thread => ({
  id, type: "question", title, openedAt: touches[0]!.chapter, lastTouchedAt: touches.at(-1)!.chapter,
  status: "active", weight: "normal", touches, mergedFrom: [],
});
const member = (name: string, chapters: number[]): Member => ({
  key: name, name, aliases: [], chapters, viewpointChapters: [],
  appearances: chapters.map((n) => ({ chapter: n, quote: `${name}在第${n}章` })),
});

const projection = {
  chapters: [chapter(11, { present: ["林舟", "林溪"] }), chapter(12, { summary: "翻出汇款存根", day: 13, dayEnd: 13, present: ["林舟", "林溪", "沈家侄女"] })],
  facts: [
    fact("f1", 11, { subject: "林溪", text: "林溪订了周日的返程票", status: "superseded", supersededAt: 12, supersededBy: "f2" }),
    fact("f2", 12, { subject: "林溪", text: "林溪退了返程票、续了两天假", quote: "退票的确认弹出来", review: "author" }),
    fact("f3", 12, { text: "汇款从一九六四年起每季一张", quote: "第一张的日期是一九六四年四月", status: "retracted" }),
  ],
  threads: [
    thread("t1", "那笔上海的债", [
      { chapter: 9, op: "open", note: "母亲提起", entry: "e1" },
      { chapter: 12, op: "advance", note: "存根坐实了汇款", quote: "收款地址一栏", entry: "e2" },
    ]),
    thread("t2", "沈允贞是谁", [{ chapter: 12, op: "close", note: "侄女说清了", entry: "e3" }]),
    thread("t3", "半夜的来电", [{ chapter: 12, op: "open", note: "号码又打来", entry: "e4" }]),
  ],
  cast: [member("林舟", [11, 12]), member("沈家侄女", [12])],
};

describe("这一章定稿记下了什么（重构 P6 第 6 步）", () => {
  it("事实带上顶掉的旧说法、自动记的标出来、后来被改掉 / 撤了的照实标；线索按 开 → 推进 → 收口 排；只列第一次出场的人", () => {
    const changes = toChapterChanges(projection, 12)!;
    expect(changes).toMatchObject({ chapter: 12, chapters: [11, 12], summary: "翻出汇款存根", day: 13, dayEnd: 13 });
    expect(changes.facts).toEqual([
      { subject: "林溪", text: "林溪退了返程票、续了两天假", quote: "退票的确认弹出来", replaces: "林溪订了周日的返程票", auto: false },
      { text: "汇款从一九六四年起每季一张", quote: "第一张的日期是一九六四年四月", auto: true, later: "retracted" },
    ]);
    expect(changes.threads.map((item) => [item.op, item.title])).toEqual([["open", "半夜的来电"], ["advance", "那笔上海的债"], ["close", "沈允贞是谁"]]);
    expect(changes.newCast).toEqual([{ name: "沈家侄女", quote: "沈家侄女在第12章" }]);
  });

  it("不给章号＝最近定稿那章；没定稿的章返回空", () => {
    expect(toChapterChanges(projection)!.chapter).toBe(12);
    expect(toChapterChanges(projection, 13)).toBeUndefined();
    expect(toChapterChanges({ chapters: [], facts: [], threads: [], cast: [] })).toBeUndefined();
  });
});
