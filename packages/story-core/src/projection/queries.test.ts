import { describe, expect, it } from "vitest";
import type { AuthorDecision } from "../schema/decisions.js";
import { CHAPTER_LEDGER_SCHEMA, type ChapterLedger, type LedgerEntry } from "../schema/ledger.js";
import { project } from "./project.js";
import { chapterBrief, currentFactsAbout, threadsForPrompt, timelineTable, timelineText } from "./queries.js";

type Draft = LedgerEntry extends infer E ? (E extends LedgerEntry ? Omit<E, "id" | "review"> & { id?: string } : never) : never;

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return {
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter,
    textSha256: "0".repeat(64),
    committedAt: "2026-10-17T00:00:00.000Z",
    origin: "commit",
    entries: drafts.map((draft, index) => ({ review: "auto", ...draft, id: draft.id ?? `c${chapter}-${index + 1}` }) as LedgerEntry),
  };
}

const q = "原句原句";
const presence = (name: string, nameUsed = name, viewpoint?: boolean): Draft => ({ kind: "presence", name, nameUsed, quote: q, ...(viewpoint ? { viewpoint } : {}) });
const fact = (nature: "hard" | "state", subject: string, attribute: string, value: string): Draft => ({
  kind: "fact", nature, subject, attribute, value, text: `${subject}${attribute}${value}`, quote: q,
});
const event = (subject: string, text: string): Draft => ({ kind: "fact", nature: "event", subject, text, quote: q });
const open = (thread: string, title: string): Draft => ({ kind: "thread", op: "open", thread, type: "question", title, note: `开：${title}`, quote: q });
const touch = (thread: string, op: "advance" | "close", note: string = op): Draft => ({ kind: "thread", op, thread, note, quote: q });
const time = (extra: Partial<Extract<Draft, { kind: "time" }>>): Draft => ({ kind: "time", basis: "text", quote: q, ...extra });
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

  it("时间表：每章第几天、星期（明写 / 推算）、依据；文字版给提示词用", () => {
    const view = project({
      ledgers: [
        ledger(1, [time({ weekday: 1, timeOfDay: "傍晚" })]),
        ledger(2, [time({ basis: "judged", daysSincePrevious: 2, daysInChapter: 1 })]),
        ledger(3, []),
      ],
      decisions: [],
    });
    const rows = timelineTable(view);
    expect(rows.map((row) => [row.chapter, row.day, row.dayEnd, row.weekday, row.weekdayDerived, row.basis])).toEqual([
      [1, 1, 1, 1, false, "text"],
      [2, 3, 4, 3, true, "judged"],
      [3, 5, 5, 5, true, "missing"],
    ]);
    expect(timelineTable(view, 2)).toHaveLength(2);
    const text = timelineText(rows);
    expect(text).toContain("| 第 1 章 | 1 | 周二 | 傍晚 | 正文明写 |");
    expect(text).toContain("| 第 2 章 | 3～4 | 周四（推算） | — | 按正文推断 |");
    expect(text).toContain("没记，按上一章 +1");
  });

  it("一章的简介：梗概、出场、视角、时间、动过的线索；没定稿的章 undefined", () => {
    const view = project({
      ledgers: [
        ledger(1, [{ kind: "summary", text: "青禾到了雾港", quote: q }, presence("沈青禾", "沈青禾", true), presence("老周"), open("t-a", "钥匙开什么"), time({ timeOfDay: "清晨" })]),
        ledger(2, [touch("t-a", "advance")]),
      ],
      decisions: [],
    });
    expect(chapterBrief(view, 1)).toMatchObject({
      chapter: 1,
      summary: "青禾到了雾港",
      present: ["沈青禾", "老周"],
      viewpoint: "沈青禾",
      time: { day: 1, timeOfDay: "清晨", basis: "text" },
      threads: [{ title: "钥匙开什么", op: "open" }],
    });
    expect(chapterBrief(view, 2)?.threads).toEqual([{ id: "t-a", title: "钥匙开什么", op: "advance" }]);
    expect(chapterBrief(view, 9)).toBeUndefined();
  });
});
