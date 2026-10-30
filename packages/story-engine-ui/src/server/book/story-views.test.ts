// @vitest-environment node
import {
  CHAPTER_LEDGER_SCHEMA,
  project,
  type AuthorDecision,
  type ChapterLedger,
  type LedgerEntry,
} from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import { weekdayOfDay } from "./story-timeline.js";
import { storyViewsOf } from "./story-views.js";

type Draft = LedgerEntry extends infer E ? (E extends LedgerEntry ? Omit<E, "id" | "review"> & { id?: string; review?: "auto" | "author" } : never) : never;
const q = "原句原句";

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return {
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter,
    textSha256: "0".repeat(64),
    committedAt: "2026-10-18T00:00:00.000Z",
    origin: "commit",
    entries: drafts.map((draft, index) => ({ review: "auto", ...draft, id: draft.id ?? `c${chapter}-${index + 1}` }) as LedgerEntry),
  };
}

function sample() {
  const ledgers = [
    ledger(1, [
      { kind: "summary", text: "沈青禾进钟楼拿走钥匙", quote: q },
      { kind: "time", basis: "text", weekday: 1, timeOfDay: "傍晚", quote: "周二傍晚" },
      { kind: "presence", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: q },
      { kind: "presence", name: "周守义", nameUsed: "老周", quote: q },
      { id: "f-key", kind: "fact", nature: "state", subject: "钥匙", attribute: "在哪", value: "钟箱里", text: "钥匙在钟箱里", quote: q },
      { id: "f-clock", kind: "fact", nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: q, review: "author" },
      { id: "f-wrong", kind: "fact", nature: "event", text: "老周哭了", quote: q },
      { kind: "thread", thread: "t-clock", op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟停在三点十五分" },
      { kind: "thread", thread: "t-well", op: "open", type: "intent", title: "去井边", note: "她决定去井边", quote: "她决定去井边" },
      { kind: "thread", thread: "g-truth", op: "open", type: "goal", title: "查清爷爷的死", note: "她要查清", quote: "她要查清" },
    ]),
    ledger(2, [
      { kind: "summary", text: "钥匙到了沈青禾手里", quote: q },
      { kind: "time", basis: "text", daysSincePrevious: 1, daysInChapter: 1, quote: "第二天" },
      { kind: "presence", name: "周守义", nameUsed: "周守义", quote: q },
      { kind: "fact", nature: "state", subject: "钥匙", attribute: "在哪", value: "沈青禾手里", text: "钥匙在沈青禾手里", quote: q },
      { kind: "thread", op: "advance", thread: "t-clock", note: "钟是被拨停的", quote: "钟是被拨停的" },
      { kind: "thread", op: "close", thread: "t-well", note: "去过井边了", quote: "去过井边了" },
    ]),
  ];
  const decisions: AuthorDecision[] = [
    { id: "d-1", at: "2026-10-18T00:00:00.000Z", type: "fact.retract", fact: "f-wrong" },
    { id: "d-2", at: "2026-10-18T00:00:00.000Z", type: "thread.weight", thread: "g-truth", weight: "major" },
    { id: "d-3", at: "2026-10-18T00:00:00.000Z", type: "thread.weight", thread: "t-clock", weight: "major" },
  ];
  return { ledgers, projection: project({ ledgers, decisions, version: 7 }) };
}

describe("账的几种读法（从投影现算）", () => {
  it("时间线、事实、线索、目标、事件都照读者要的样子给", () => {
    const { ledgers, projection } = sample();
    const views = storyViewsOf(projection, ledgers, new Map([[1, "第1章 · 钟停"]]));

    expect(views.timeline.entries).toEqual([
      { chapter: 1, day: 1, weekday: 1, timeOfDay: "傍晚", source: "declared", quote: "周二傍晚" },
      { chapter: 2, day: 2, daysSincePrevious: 1, daysInChapter: 1, source: "declared", quote: "第二天" },
    ]);
    // 星期只给明写的，别的日子读者按锚点推：第 2 天推成周三。
    expect(weekdayOfDay(views.timeline, 2)).toBe(2);

    // 作者撤掉的那条不给；被取代的带上取代信息；作者亲手点过的记 manual。
    expect(views.facts.facts.map((fact) => fact.id)).toEqual(["f-key", "f-clock", "c2-4"]);
    expect(views.facts.facts[0]).toMatchObject({ kind: "state", supersededByChapter: 2, supersededByFactId: "c2-4", effectiveFromChapter: 1, source: "auto" });
    expect(views.facts.facts[1]).toMatchObject({ kind: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", source: "manual" });
    expect(views.facts.facts[1]).not.toHaveProperty("supersededByChapter");

    expect(views.threads.threads).toEqual([
      // 作者标的轻重带过去（大伏笔不当过期线索劝清理）；一般的不写。
      { id: "t-clock", type: "lead", title: "钟为什么停", status: "touched", firstSeenChapter: 1, lastTouchedChapter: 2, evidence: ["钟停在三点十五分", "钟是被拨停的"], weight: "major" },
      { id: "t-well", type: "intent", title: "去井边", status: "done", firstSeenChapter: 1, lastTouchedChapter: 2, evidence: ["她决定去井边", "去过井边了"] },
    ]);
    expect(views.goals.goals).toEqual([
      { id: "g-truth", title: "查清爷爷的死", status: "active", scope: "main_arc", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["她要查清"] },
    ]);

    const [first, second] = views.events;
    // 出场人物直接写已确立的名字（重构 P9：人物卡没有老格式编号了），别称不当成另一个人。
    expect(first).toMatchObject({ id: "ch0001-001", chapter: 1, summary: "沈青禾进钟楼拿走钥匙", participants: ["沈青禾", "周守义"] });
    expect(second).toMatchObject({ participants: ["周守义"] });
    expect(first?.effects?.semanticSummary).toMatchObject({
      chapterTitle: "第1章 · 钟停",
      mainEvent: "沈青禾进钟楼拿走钥匙",
      presentCharacterNames: ["沈青禾", "周守义"],
      characterAliases: [{ name: "周守义", alias: "老周" }],
      viewpointCharacter: "沈青禾",
      decision: "她决定去井边",
      mentionedHooks: [],
      locations: [],
    });
    // 撤掉的事件不进「本章要事」。
    expect(first?.effects?.semanticSummary).not.toHaveProperty("keyEvents");
    // 第 2 章收的是打算（不是悬念），不算「发现」。
    expect(second?.effects?.semanticSummary).toMatchObject({ chapterTitle: "第2章" });
    expect(second?.effects?.semanticSummary).not.toHaveProperty("discovery");
    expect(second?.effects?.semanticSummary).not.toHaveProperty("characterAliases");
  });

  it("泛称（generic）不进别名：「那人」只是那一章的叫法", () => {
    const ledgers = [
      ledger(1, [{ kind: "presence", name: "周守义", nameUsed: "周守义", quote: q }]),
      ledger(2, [{ kind: "presence", name: "周守义", nameUsed: "那人", generic: true, quote: q }]),
    ];
    const views = storyViewsOf(project({ ledgers, decisions: [] }), ledgers, new Map());
    expect(views.events[1]?.participants).toEqual(["周守义"]);
    expect(views.events[1]?.effects?.semanticSummary).not.toHaveProperty("characterAliases");
  });

  it("投影里「停了好几章」的线索照样开着（读者说的 stale 是不再追踪，会藏掉）", () => {
    const ledgers = [
      ledger(1, [{ kind: "thread", thread: "t-old", op: "open", type: "question", title: "井里有什么", note: "井里有声音", quote: q }]),
      ledger(9, [{ kind: "summary", text: "过了很久", quote: q }]),
    ];
    const projection = project({ ledgers, decisions: [] });
    expect(projection.threads[0]?.status).toBe("stale");
    const views = storyViewsOf(projection, ledgers, new Map());
    expect(views.threads.threads[0]).toMatchObject({ id: "t-old", status: "open" });
  });

  it("本章收掉的悬念记成「发现」（并掉的线索按并入的那条算）", () => {
    const ledgers = [
      ledger(1, [
        { kind: "thread", thread: "t-door", op: "open", type: "question", title: "门外是谁", note: "有人敲门", quote: q },
        { kind: "thread", thread: "t-door2", op: "open", type: "question", title: "谁在敲门", note: "又有人敲门", quote: q },
      ]),
      ledger(2, [{ kind: "thread", thread: "t-door2", op: "close", note: "门外是老周", quote: q }]),
    ];
    const decisions: AuthorDecision[] = [{ id: "d-1", at: "2026-10-18T00:00:00.000Z", type: "thread.merge", from: ["t-door2"], into: "t-door" }];
    const projection = project({ ledgers, decisions });
    const views = storyViewsOf(projection, ledgers, new Map());
    expect(views.events[1]?.effects?.semanticSummary).toMatchObject({ discovery: "门外是老周" });
    expect(views.threads.threads.map((thread) => thread.id)).toEqual(["t-door"]);
  });

  it("并进悬念的打算照样记成那一章的「决定」；每章的换称呼按那一章的账给", () => {
    const ledgers = [
      ledger(1, [
        { kind: "thread", thread: "t-door", op: "open", type: "question", title: "门外是谁", note: "有人敲门", quote: q },
        { kind: "thread", thread: "t-go", op: "open", type: "intent", title: "去开门", note: "她决定去开门", quote: q },
        { kind: "presence", name: "周守义", nameUsed: "老周", quote: q },
      ]),
      ledger(2, [{ kind: "presence", name: "周守义", nameUsed: "周伯", quote: q }]),
    ];
    const decisions: AuthorDecision[] = [{ id: "d-1", at: "2026-10-18T00:00:00.000Z", type: "thread.merge", from: ["t-go"], into: "t-door" }];
    const views = storyViewsOf(project({ ledgers, decisions }), ledgers, new Map());
    expect(views.events[0]?.effects?.semanticSummary).toMatchObject({ decision: "她决定去开门", characterAliases: [{ name: "周守义", alias: "老周" }] });
    expect(views.events[1]?.effects?.semanticSummary).toMatchObject({ characterAliases: [{ name: "周守义", alias: "周伯" }] });
  });

  it("空书：每样都是空的", () => {
    const views = storyViewsOf(project({ ledgers: [], decisions: [] }), [], new Map());
    expect({ timeline: views.timeline, facts: views.facts, threads: views.threads, goals: views.goals, events: views.events }).toEqual({
      timeline: { schemaVersion: 1, entries: [] },
      facts: { version: "v0", facts: [] },
      threads: { threads: [] },
      goals: { goals: [] },
      events: [],
    });
  });
});
