import { describe, expect, it } from "vitest";
import { CHAPTER_LEDGER_SCHEMA, type ChapterLedger, type LedgerEntry } from "../schema/ledger.js";
import { paceReport } from "./pace.js";
import { project } from "./project.js";

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
const open = (thread: string): Draft => ({ kind: "thread", op: "open", thread, type: "question", title: `线索${thread}`, note: "开", quote: q });
const touch = (thread: string, op: "advance" | "close"): Draft => ({ kind: "thread", op, thread, note: op, quote: q });
const days = (daysSincePrevious: number, daysInChapter = 0, basis: "text" | "estimated" = "text"): Draft =>
  ({ kind: "time", basis, quote: q, daysSincePrevious, ...(daysInChapter ? { daysInChapter } : {}) });

/** 十章：平常每两千字推进两条；5～6 章不动、7 章一千字推五条（收一条算两条）、8 章一千字跨六天、9 章不动但过了十天、10 章两百字。 */
function book(overrides: { readonly ch8Basis?: "text" | "estimated" } = {}) {
  const view = project({
    ledgers: [
      ledger(1, [open("a"), open("b"), open("c")]),
      ledger(2, [days(1), touch("a", "advance"), touch("b", "advance"), open("d")]),
      ledger(3, [days(1), touch("a", "advance"), touch("c", "advance")]),
      ledger(4, [days(1), touch("b", "advance"), touch("c", "advance")]),
      ledger(5, [days(1)]),
      ledger(6, [days(0)]),
      ledger(7, [days(1), touch("a", "advance"), touch("b", "advance"), touch("c", "advance"), touch("d", "close")]),
      ledger(8, [days(1, 6, overrides.ch8Basis), touch("a", "advance"), touch("b", "advance")]),
      ledger(9, [days(10)]),
      ledger(10, [days(1), touch("a", "advance")]),
    ],
    decisions: [],
  });
  const words = new Map([[1, 2000], [2, 2000], [3, 2000], [4, 2000], [5, 2000], [6, 2000], [7, 1000], [8, 1000], [9, 2000], [10, 200]]);
  return paceReport(view, words);
}

describe("节奏诊断", () => {
  it("拿全书自己的平常当尺子：推进稀又没过几天的连成一段算拖；推进密、一章跨好多天字又少的算赶", () => {
    const report = book();
    expect(report.typical).toEqual({ density: 1, words: 2000 });
    expect(report.flags).toEqual([
      { kind: "drag", reason: "slow", from: 5, to: 6, words: 4000, advanced: 0, closed: 0 },
      { kind: "rush", reason: "dense", from: 7, to: 7, words: 1000, advanced: 3, closed: 1 },
      { kind: "rush", reason: "span", from: 8, to: 8, words: 1000, advanced: 2, closed: 0, span: 6 },
    ]);
    const byChapter = new Map(report.chapters.map((item) => [item.chapter, item]));
    expect(byChapter.get(7)).toMatchObject({ opened: 0, advanced: 3, closed: 1, density: 5, pace: "fast", storyDays: 1 });
    expect(byChapter.get(8)).toMatchObject({ span: 6, storyDays: 7, timeSure: true, pace: "fast" });
    // 第 1 章前面没有开着的线索、第 10 章字太少：不算密度，也不下结论。
    expect(byChapter.get(1)?.density).toBeUndefined();
    expect(byChapter.get(10)?.density).toBeUndefined();
    expect(byChapter.get(10)?.pace).toBeUndefined();
    // 第 9 章没推进，但故事一下过了十天：是跳时间，不算拖。
    expect(byChapter.get(9)).toMatchObject({ density: 0, storyDays: 10 });
    expect(byChapter.get(9)?.pace).toBeUndefined();
  });

  it("天数是估的：不拿它说「一章跨好多天」", () => {
    const report = book({ ch8Basis: "estimated" });
    expect(report.flags.map((flag) => flag.reason)).toEqual(["slow", "dense"]);
    expect(report.chapters.find((item) => item.chapter === 8)?.pace).toBeUndefined();
  });

  it("能算的章不到 6 章、或全书几乎没记推进：只给每章数字，不下结论", () => {
    const short = project({
      ledgers: [ledger(1, [open("a")]), ledger(2, [touch("a", "advance")]), ledger(3, []), ledger(4, [touch("a", "advance")])],
      decisions: [],
    });
    const few = paceReport(short, new Map([[1, 2000], [2, 2000], [3, 2000], [4, 2000]]));
    expect(few.typical).toBeUndefined();
    expect(few.flags).toEqual([]);
    expect(few.chapters.map((item) => [item.chapter, item.advanced, item.words])).toEqual([[1, 0, 2000], [2, 1, 2000], [3, 0, 2000], [4, 1, 2000]]);

    const still = project({
      ledgers: [ledger(1, [open("a")]), ...[2, 3, 4, 5, 6, 7, 8].map((chapter) => ledger(chapter, []))],
      decisions: [],
    });
    const none = paceReport(still, new Map([2, 3, 4, 5, 6, 7, 8].map((chapter) => [chapter, 2000])));
    expect(none.typical).toBeUndefined();
    expect(none.flags).toEqual([]);
  });
});
