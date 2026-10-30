import { describe, expect, it } from "vitest";
import { ledgerOf, project, type BookProjection } from "@actalk/story-core";
import { toChapterChanges } from "./chapter-changes.js";

type Fact = BookProjection["facts"][number];
type Thread = BookProjection["threads"][number];
type Member = BookProjection["cast"][number];

// 第 12 章：作者定的第 13 天，里面有一段回忆；第 11 章没记时间。
const STAMP = "2026-10-18T00:00:00.000Z";
const [eleven, twelve] = project({
  decisions: [],
  ledgers: [
    ledgerOf({ chapter: 11, text: "# 第11章\n\n林舟到了。", committedAt: STAMP, entries: [] }),
    ledgerOf({
      chapter: 12,
      text: "# 第12章\n\n林溪退了票。她想起那年。那年很冷。",
      committedAt: STAMP,
      entries: [
        { kind: "day", review: "auto", day: 13 },
        { kind: "time", review: "auto", start: { basis: "text", quote: "林溪退了票" }, sameDay: true, segments: [{ frame: "past", firstQuote: "她想起那年", lastQuote: "那年很冷" }] },
      ],
    }),
  ],
}).chapters;
const NARRATION = { frame: "present", source: "narration" } as const;
const fact = (id: string, n: number, over: Partial<Fact> = {}): Fact => ({
  id, chapter: n, nature: "state", text: `事实${id}`, review: "auto", status: "current", scope: NARRATION, ...over,
});
const thread = (id: string, title: string, touches: Thread["touches"]): Thread => ({
  id, type: "question", title, openedAt: touches[0]!.chapter, lastTouchedAt: touches.at(-1)!.chapter, idleChapters: 0,
  status: "active", weight: "normal", touches, mergedFrom: [],
});
const member = (name: string, chapters: number[]): Member => ({
  key: name, name, aliases: [], chapters, viewpointChapters: [],
  appearances: chapters.map((n) => ({ chapter: n, quote: `${name}在第${n}章` })),
});

const projection = {
  chapters: [{ ...eleven!, present: ["林舟", "林溪"] }, { ...twelve!, summary: "翻出汇款存根", present: ["林舟", "林溪", "沈家侄女"] }],
  facts: [
    fact("f1", 11, { subject: "林溪", text: "林溪订了周日的返程票", status: "superseded", supersededAt: 12, supersededBy: "f2" }),
    fact("f2", 12, { subject: "林溪", text: "林溪退了返程票、续了两天假", quote: "退票的确认弹出来", review: "author" }),
    fact("f3", 12, { text: "汇款从一九六四年起每季一张", quote: "第一张的日期是一九六四年四月", status: "retracted" }),
    fact("f4", 12, { text: "母亲那年在上海", quote: "那年很冷", scope: { frame: "past", source: "narration" } }),
    fact("f5", 12, { text: "汇款是父亲寄的", quote: "是你爸寄的", scope: { frame: "present", source: "character_claim", speaker: "沈家侄女" } }),
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
  it("事实带上顶掉的旧说法、自动记的标出来、后来被改掉 / 撤了的照实标；回忆里、人物说的标出来；线索按 开 → 推进 → 收口 排；只列第一次出场的人", () => {
    const changes = toChapterChanges(projection, 12)!;
    expect(changes).toMatchObject({ chapter: 12, chapters: [11, 12], summary: "翻出汇款存根", days: "故事第 13 天 · 含回忆" });
    expect(changes.facts).toEqual([
      { subject: "林溪", text: "林溪退了返程票、续了两天假", quote: "退票的确认弹出来", replaces: "林溪订了周日的返程票", auto: false },
      { text: "汇款从一九六四年起每季一张", quote: "第一张的日期是一九六四年四月", auto: true, later: "retracted" },
      { text: "母亲那年在上海", quote: "那年很冷", auto: true, scope: "回忆里" },
      { text: "汇款是父亲寄的", quote: "是你爸寄的", auto: true, scope: "沈家侄女说的" },
    ]);
    // 第 11 章没记时间：不给天数（界面说哪天不知道）。
    expect(toChapterChanges(projection, 11)).not.toHaveProperty("days");
    expect(changes.threads.map((item) => [item.op, item.title])).toEqual([["open", "半夜的来电"], ["advance", "那笔上海的债"], ["close", "沈允贞是谁"]]);
    expect(changes.newCast).toEqual([{ name: "沈家侄女", quote: "沈家侄女在第12章" }]);
  });

  it("不给章号＝最近定稿那章；没定稿的章返回空", () => {
    expect(toChapterChanges(projection)!.chapter).toBe(12);
    expect(toChapterChanges(projection, 13)).toBeUndefined();
    expect(toChapterChanges({ chapters: [], facts: [], threads: [], cast: [] })).toBeUndefined();
  });
});
