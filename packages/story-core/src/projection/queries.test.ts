import { describe, expect, it } from "vitest";
import type { AuthorDecision } from "../schema/decisions.js";
import type { ChapterLedger, ReviewMark } from "../schema/ledger.js";
import { ledgerOf, type EntryDraft } from "../ledger/entries.js";
import { project } from "./project.js";
import { chapterBrief, currentFactsAbout, preWriteMemo, threadsForPrompt, timelineTable, timelineText } from "./queries.js";

type Draft = EntryDraft extends infer E ? (E extends EntryDraft ? Omit<E, "review"> & { readonly id?: string; readonly review?: ReviewMark } : never) : never;

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return ledgerOf({ chapter, committedAt: "2026-10-17T00:00:00.000Z", entries: drafts.map((draft) => ({ review: "auto", ...draft }) as EntryDraft & { id?: string }) });
}

const q = "原句原句";
const presence = (name: string, nameUsed = name, viewpoint?: boolean): Draft => ({ kind: "presence", name, nameUsed, quote: q, ...(viewpoint ? { viewpoint } : {}) });
const fact = (nature: "hard" | "state", subject: string, attribute: string, value: string): Draft => ({
  kind: "fact", nature, subject, attribute, value, text: `${subject}${attribute}${value}`, quote: q,
});
const event = (subject: string, text: string): Draft => ({ kind: "fact", nature: "event", subject, text, quote: q });
const open = (thread: string, title: string): Draft => ({ kind: "thread", op: "open", thread, type: "question", title, note: `开：${title}`, quote: q });
const touch = (thread: string, op: "advance" | "close", note: string = op): Draft => ({ kind: "thread", op, thread, note, quote: q });
const exactly = (value: number) => ({ unit: "day" as const, min: value, max: value });
/** 离上一章几天、章内过了几天（0 = 同一天）。 */
const time = (
  since: number,
  inChapter = 0,
  extra: Partial<Extract<Draft, { kind: "time" }>> & { readonly basis?: "text" | "judged" } = {},
): Draft => {
  const { basis = "text", ...rest } = extra;
  return {
    kind: "time",
    start: { offset: exactly(since), basis, quote: q },
    ...(inChapter === 0 ? { sameDay: true } : { dayChanges: [{ offset: exactly(inChapter) }] }),
    ...rest,
  };
};
const decision = (input: Record<string, unknown>, index = 1): AuthorDecision => ({ id: `d-${index}`, at: "2026-10-17T00:00:00.000Z", ...input }) as AuthorDecision;

describe("投影查询", () => {
  it("某人现在有效的事实：名字、别名都能查；作废的不算；查不到就是 undefined", () => {
    const view = project({
      ledgers: [
        ledger(1, [presence("沈青禾"), fact("hard", "沈青禾", "年纪", "二十七"), fact("state", "沈青禾", "住在", "旅馆")]),
        ledger(2, [presence("沈青禾", "青禾"), fact("state", "青禾", "住在", "钟楼"), event("青禾", "青禾烧了信")]),
        ledger(3, [fact("state", "铜盒", "在哪", "井里")]),
      ],
      decisions: [],
    });
    const byAlias = currentFactsAbout(view, " 青禾 ");
    expect(byAlias).toMatchObject({ name: "沈青禾", aliases: ["青禾"] });
    expect(byAlias?.facts.map((item) => item.text)).toEqual(["沈青禾年纪二十七", "青禾住在钟楼", "青禾烧了信"]);
    expect(currentFactsAbout(view, "沈青禾")?.facts).toHaveLength(3);
    expect(currentFactsAbout(view, "铜盒")?.facts.map((item) => item.value)).toEqual(["井里"]);
    expect(currentFactsAbout(view, "老周")).toBeUndefined();
    expect(currentFactsAbout(view, "  ")).toBeUndefined();
  });

  it("给模型的线索：分量重的先、同分量停太久的先、再按最近推进；收了的不给；limit 乱给按缺省", () => {
    const view = project({
      ledgers: [
        ledger(1, [open("t-a", "钥匙开什么"), open("t-b", "门外是谁"), open("t-c", "账本下落"), open("t-d", "信是谁写的")]),
        ledger(2, [touch("t-d", "close")]),
        ledger(5, [touch("t-b", "advance", "门外有脚印")]),
        ledger(8, [touch("t-c", "advance")]),
      ],
      decisions: [decision({ type: "thread.weight", thread: "t-c", weight: "minor" }), decision({ type: "thread.weight", thread: "t-a", weight: "major" }, 2)],
    });
    const { threads, omitted } = threadsForPrompt(view, { limit: 2 });
    expect(threads.map((thread) => thread.title)).toEqual(["钥匙开什么", "门外是谁"]);
    expect(omitted).toBe(1);
    // 大伏笔停 7 章不算停太久（要 20 章），状态还是刚埋下。
    expect(threads[0]).toMatchObject({ weight: "major", status: "open", idleChapters: 7, lastNote: "开：钥匙开什么" });
    expect(threads[1]).toMatchObject({ lastNote: "门外有脚印", idleChapters: 3 });
    for (const limit of [0, -3, Number.NaN, 2.5, undefined]) {
      expect(threadsForPrompt(view, { limit }).threads.map((thread) => thread.title)).toEqual(["钥匙开什么", "门外是谁", "账本下落"]);
    }
  });

  it("时间表：每章开头结尾第几天、离上一个当下章、星期（明写 / 推算）、依据；文字版给提示词用", () => {
    const view = project({
      ledgers: [
        ledger(1, [time(0, 0, { weekday: 1, timeOfDay: "傍晚" })]),
        ledger(2, [time(2, 1, { basis: "judged" })]),
        ledger(3, []),
        ledger(4, [time(1)]),
      ],
      decisions: [],
    });
    const rows = timelineTable(view);
    expect(rows.map((row) => [row.chapter, row.presentLine, row.start, row.end, row.weekday, row.weekdayDerived, row.basis])).toEqual([
      [1, true, { lo: 1, hi: 1 }, { lo: 1, hi: 1 }, 1, false, "ledger"],
      [2, true, { lo: 3, hi: 3 }, { lo: 4, hi: 4 }, 3, true, "ledger"],
      [3, "unknown", undefined, undefined, undefined, false, "unknown"],
      // 第 3 章没认出在不在当下线上：第 4 章找不到前一个当下章，天数不知道，也不推星期。
      [4, true, undefined, undefined, undefined, false, "unknown"],
    ]);
    expect(timelineTable(view, 2)).toHaveLength(2);
    const text = timelineText(rows);
    expect(text).toContain("| 第 1 章 | 第 1 天 | 第 1 天 | 不知道 | 周二 | 傍晚 | 按账推的 | — |");
    expect(text).toContain("| 第 2 章 | 第 3 天 | 第 4 天 | 过了 2 天 | 周四（推算） | — | 按账推的 | — |");
    expect(text).toContain("| 第 3 章 | — | — | — | — | — | 没认出在不在当下线上 | — |");
    expect(text).toContain("| 第 4 章 | 不知道 | 不知道 | 不知道 | — | — | 不知道 | — |");
  });

  it("一章的简介：梗概、出场、视角、时间、动过的线索；没定稿的章 undefined", () => {
    const view = project({
      ledgers: [
        ledger(1, [{ kind: "summary", text: "青禾到了雾港", quote: q }, presence("沈青禾", "沈青禾", true), presence("老周"), open("t-a", "钥匙开什么"), time(0, 0, { timeOfDay: "清晨" })]),
        ledger(2, [touch("t-a", "advance")]),
      ],
      decisions: [],
    });
    expect(chapterBrief(view, 1)).toMatchObject({
      chapter: 1,
      summary: "青禾到了雾港",
      present: ["沈青禾", "老周"],
      viewpoint: "沈青禾",
      time: { start: { lo: 1, hi: 1 }, timeOfDay: "清晨", basis: "ledger" },
      threads: [{ title: "钥匙开什么", op: "open" }],
    });
    expect(chapterBrief(view, 2)?.threads).toEqual([{ id: "t-a", title: "钥匙开什么", op: "advance" }]);
    expect(chapterBrief(view, 9)).toBeUndefined();
  });
});

describe("写前备忘", () => {
  const summary = (text: string): Draft => ({ kind: "summary", text, quote: q });

  it("前面一章都没定稿：空的，什么都不列", () => {
    const view = project({ ledgers: [], decisions: [] });
    expect(preWriteMemo(view, 1)).toEqual({ chapter: 1, threads: [], moreThreads: 0, changes: [] });
  });

  it("上一章停在哪：第几天、时段、梗概、在场、视角；跳过没定稿的章，接最近定稿的那章", () => {
    const view = project({
      ledgers: [
        ledger(1, [time(0), presence("许微", "许微", true)]),
        ledger(3, [time(1, 2, { timeOfDay: "傍晚" }), summary("许微去码头"), presence("许微", "许微", true), presence("孟叔")]),
      ],
      decisions: [],
    });
    const memo = preWriteMemo(view, 5);
    expect(memo.previous).toMatchObject({
      chapter: 3,
      summary: "许微去码头",
      present: ["许微", "孟叔"],
      viewpoint: "许微",
      time: { chapter: 3, start: { lo: 2, hi: 2 }, end: { lo: 4, hi: 4 }, sincePrevious: { lo: 1, hi: 1 }, timeOfDay: "傍晚", basis: "ledger" },
    });
  });

  it("该接的线索：上一章动过的先，再停太久的（分量重、停得久的先），再大伏笔；收了的、刚埋没停多久的普通线索不列，只计数", () => {
    const view = project({
      ledgers: [
        ledger(1, [open("t-old", "信是谁写的"), open("t-major", "父亲怎么失踪的"), open("t-closed", "钥匙开什么")]),
        ledger(2, [open("t-older", "门外是谁")]),
        ledger(5, [touch("t-closed", "close")]),
        ledger(8, [open("t-fresh", "账本下落")]),
        ledger(9, [touch("t-older", "advance", "门外有脚印"), open("t-new", "零三号仓是谁")]),
      ],
      decisions: [decision({ type: "thread.weight", thread: "t-major", weight: "major" })],
    });
    const memo = preWriteMemo(view, 10);
    expect(memo.threads.map((item) => [item.title, item.reason])).toEqual([
      ["门外是谁", "previous"],
      ["零三号仓是谁", "previous"],
      ["信是谁写的", "stale"],
      ["父亲怎么失踪的", "major"],
    ]);
    expect(memo.threads[0]).toMatchObject({ previousOp: "advance", idle: 0, last: { chapter: 9, note: "门外有脚印", quote: q } });
    expect(memo.threads[1]).toMatchObject({ previousOp: "open" });
    expect(memo.threads[2]).toMatchObject({ idle: 8, last: { chapter: 1, note: "开：信是谁写的" } });
    // 「账本下落」第 8 章埋、才停 1 章，不列；收了的「钥匙开什么」不算开着。
    expect(memo.moreThreads).toBe(1);
  });

  it("最多列 5 条：上一章动过的先占 3 条，停太久的接着，还有空才补上一章动过的其余几条", () => {
    const view = project({
      ledgers: [
        ledger(1, [open("s1", "停一"), open("s2", "停二"), open("s3", "停三")]),
        ledger(10, ["p1", "p2", "p3", "p4"].map((id) => open(id, `新${id}`))),
      ],
      decisions: [],
    });
    const memo = preWriteMemo(view, 11);
    expect(memo.threads.map((item) => item.title)).toEqual(["新p1", "新p2", "新p3", "停一", "停二"]);
    expect(memo.moreThreads).toBe(2);
  });

  it("回头改前面的章：投影算到上一章，后文的账不露进来；作者在更后面收掉的线索这里仍当开着", () => {
    const ledgers = [
      ledger(1, [open("t-a", "钥匙开什么"), fact("state", "铜盒", "在哪", "井里")]),
      ledger(2, [touch("t-a", "advance", "找到锁孔")]),
      ledger(3, [fact("state", "铜盒", "在哪", "许微手里")]),
    ];
    const view = project({ ledgers, decisions: [decision({ type: "thread.close", thread: "t-a", chapter: 3 })] }, { upTo: 1 });
    const memo = preWriteMemo(view, 2);
    expect(memo.previous?.chapter).toBe(1);
    expect(memo.threads).toEqual([expect.objectContaining({ title: "钥匙开什么", reason: "previous", previousOp: "open" })]);
    expect(memo.changes).toEqual([{ subject: "铜盒", attribute: "在哪", value: "井里", chapter: 1, quote: q }]);
  });

  it("最近变了：只看最近 3 章里记的、现在还算数的状态；新的先，最多 6 条；不会变的事实不算", () => {
    const view = project({
      ledgers: [
        ledger(1, [fact("state", "铜盒", "在哪", "井里")]),
        ledger(5, [fact("state", "石头", "胳膊", "缠着绷带"), fact("hard", "石头", "年纪", "十六")]),
        ledger(6, [fact("state", "镖旗", "在哪", "车上")]),
        ledger(7, [
          fact("state", "镖旗", "在哪", "埋进坟里"),
          fact("state", "石头", "胳膊", "拆了线"),
          ...["甲", "乙", "丙", "丁", "戊"].map((name) => fact("state", name, "在哪", "渡口")),
        ]),
      ],
      decisions: [],
    });
    const memo = preWriteMemo(view, 8);
    expect(memo.changes).toHaveLength(6);
    expect(memo.changes.map((item) => `${item.subject}${item.attribute}${item.value}`)).toEqual([
      "镖旗在哪埋进坟里", "石头胳膊拆了线", "甲在哪渡口", "乙在哪渡口", "丙在哪渡口", "丁在哪渡口",
    ]);
    // 第 1 章的「铜盒在井里」太早；第 6 章「镖旗在车上」被第 7 章推翻；不会变的「年纪」不列。
    expect(JSON.stringify(memo.changes)).not.toContain("井里");
    expect(JSON.stringify(memo.changes)).not.toContain("车上");
    expect(JSON.stringify(memo.changes)).not.toContain("十六");
  });
});
