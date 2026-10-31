// 写作版本 P3a 设计第 3 节：谁说的、在哪说的，能改多少现状。权限 = 来源那行和段那行取交集。
import { describe, expect, it } from "vitest";
import type { ChapterLedger, EntryInput } from "../schema/ledger.js";
import { ledgerOf, relocateScenes, chapterSource } from "../ledger/entries.js";
import { project } from "./project.js";
import { frameOf, rightsOf } from "./scope.js";

const STAMP = "2026-10-31T00:00:00.000Z";
type Draft = EntryInput extends infer E ? (E extends EntryInput ? Omit<E, "review"> : never) : never;
const auto = (drafts: Draft[]) => drafts.map((draft) => ({ review: "auto", ...draft }) as EntryInput);

const CH1 = "# 第1章\n\n周守义今年六十了。钟楼里的钟停了。周守义住在钟楼。";
const ch1 = (): ChapterLedger => ledgerOf({
  chapter: 1,
  text: CH1,
  committedAt: STAMP,
  entries: auto([
    { kind: "time", start: { offset: { unit: "day", min: 0, max: 0 }, basis: "text", quote: "周守义今年六十了" }, sameDay: true },
    { kind: "fact", nature: "hard", subject: "周守义", attribute: "年纪", value: "六十", text: "周守义六十", quote: "周守义今年六十了" },
    { kind: "fact", nature: "state", subject: "周守义", attribute: "住在", value: "钟楼", text: "住钟楼", quote: "周守义住在钟楼" },
    { kind: "thread", op: "open", thread: "t1-1", type: "question", title: "钟为什么停", note: "停了", quote: "钟楼里的钟停了" },
  ]),
});

// 第 2 章：第 2～3 句是个梦；第 4 句是回忆；第 5 句是周守义自己说的。
const CH2 = "# 第2章\n\n第二天阿笙睡着了。梦里周守义才五十岁，搬去了渡口。梦里钟又走了。他想起小时候周守义住在城南。周守义说：「我今年八十了。」";
function ch2(): ChapterLedger {
  return ledgerOf({
    chapter: 2,
    text: CH2,
    committedAt: STAMP,
    entries: auto([
      {
        kind: "time",
        start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "第二天阿笙睡着了" },
        sameDay: true,
        segments: [
          { frame: "other", firstQuote: "梦里周守义才五十岁", lastQuote: "梦里钟又走了" },
          { frame: "past", firstQuote: "他想起小时候周守义住在城南", lastQuote: "他想起小时候周守义住在城南", when: "unknown" },
        ],
      },
      { kind: "fact", nature: "hard", subject: "周守义", attribute: "年纪", value: "五十", text: "梦里五十", quote: "梦里周守义才五十岁" },
      { kind: "fact", nature: "state", subject: "周守义", attribute: "住在", value: "渡口", text: "梦里搬去渡口", quote: "搬去了渡口" },
      { kind: "thread", op: "close", thread: "t1-1", note: "梦里钟走了", quote: "梦里钟又走了" },
      { kind: "fact", nature: "state", subject: "周守义", attribute: "住在", value: "城南", text: "小时候住城南", quote: "他想起小时候周守义住在城南" },
      { kind: "fact", nature: "hard", subject: "周守义", attribute: "年纪", value: "八十", text: "他说八十", quote: "我今年八十了", source: { kind: "character_claim", speaker: "周守义" } },
    ]),
  });
}

describe("投影按权限算现状", () => {
  it("梦里的、回忆里的、人物说的：记着（aside），不顶替现状、不收线索；和不会变的事实对不上时梦里的不报、人物说的报「可能」", () => {
    const view = project({ ledgers: [ch1(), ch2()], decisions: [] });
    const facts = new Map(view.facts.map((fact) => [fact.value, fact]));
    expect(facts.get("五十")).toMatchObject({ status: "aside", scope: { frame: "other", source: "unknown" } });
    expect(facts.get("渡口")).toMatchObject({ status: "aside", scope: { frame: "other" } });
    expect(facts.get("城南")).toMatchObject({ status: "aside", scope: { frame: "past" } });
    expect(facts.get("八十")).toMatchObject({ status: "aside", scope: { frame: "present", source: "character_claim", speaker: "周守义" } });
    expect(facts.get("钟楼")).toMatchObject({ status: "current" });
    expect(facts.get("六十")).toMatchObject({ status: "current" });
    const home = view.subjects.find((subject) => subject.name === "周守义")?.attributes.find((attr) => attr.attribute === "住在");
    expect(home?.current.map((id) => view.facts.find((fact) => fact.id === id)?.value)).toEqual(["钟楼"]);
    expect(view.conflicts.map((conflict) => [conflict.confidence, conflict.facts.map((id) => view.facts.find((fact) => fact.id === id)?.value)])).toEqual([
      ["maybe", ["六十", "八十"]],
    ]);
    const thread = view.threads.find((item) => item.id === "t1-1");
    expect(thread?.status).not.toBe("closed");
    expect(thread?.touches.at(-1)).toMatchObject({ op: "advance", closeDenied: { frame: "other" } });
  });

  it("叙述当下说的：照常更新现状；不会变的事实对不上报「确定」，来源没标的报「可能」", () => {
    const CH3 = "# 第3章\n\n周守义其实已经七十了。周守义的左眼是瞎的。周守义的左眼好好的。";
    const ch3 = ledgerOf({
      chapter: 3,
      text: CH3,
      committedAt: STAMP,
      entries: auto([
        { kind: "time", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "judged", quote: "周守义其实已经七十了" }, sameDay: true },
        { kind: "fact", nature: "hard", subject: "周守义", attribute: "年纪", value: "七十", text: "七十", quote: "周守义其实已经七十了", source: { kind: "narration" } },
        { kind: "fact", nature: "hard", subject: "周守义", attribute: "左眼", value: "瞎", text: "瞎", quote: "周守义的左眼是瞎的", source: { kind: "narration" } },
        { kind: "fact", nature: "hard", subject: "周守义", attribute: "左眼", value: "好", text: "好", quote: "周守义的左眼好好的" },
      ]),
    });
    const view = project({ ledgers: [ch1(), ch2(), ch3], decisions: [] });
    const value = (id: string) => view.facts.find((fact) => fact.id === id)?.value;
    expect(view.conflicts.map((conflict) => [conflict.confidence, conflict.facts.map(value)])).toEqual([
      ["maybe", ["六十", "八十"]],
      // 第 1 章那条没标来源（旧的、没标的一律「不知道」）：和叙述的对不上也只「可能」。
      ["maybe", ["六十", "七十"]],
      ["maybe", ["瞎", "好"]],
    ]);
  });

  it("段改文后对不回了（stale）：这章的事实一律段未知——不更新现状，不会变的对不上报「可能」", () => {
    const ledger = ch2();
    const changed = "# 第2章\n\n第二天阿笙睡着了。他梦见周守义才五十岁，搬去了渡口。钟又走了。他想起小时候周守义住在城南。周守义说：「我今年八十了。」";
    const scenes = relocateScenes(ledger.scenes, chapterSource(2, changed));
    expect(scenes.map((scene) => scene.stale ?? false)).toEqual([true, false]);
    const staleLedger = { ...ledger, scenes };
    expect(frameOf([{ units: { from: 1, to: 1 } }], true, scenes)).toBe("unknown");
    const view = project({ ledgers: [ch1(), staleLedger], decisions: [] });
    expect(view.facts.find((fact) => fact.value === "五十")).toMatchObject({ status: "aside", scope: { frame: "unknown" } });
    expect(view.conflicts.map((conflict) => conflict.confidence)).toEqual(["maybe", "maybe"]);
  });
});

describe("权限表（来源 × 段，取交集）", () => {
  it("每一格", () => {
    expect(rightsOf("narration", "present")).toEqual({ state: true, replaces: true, conflict: "sure", close: true });
    expect(rightsOf("unknown", "present")).toEqual({ state: true, replaces: true, conflict: "maybe", close: true });
    expect(rightsOf("character_claim", "present")).toEqual({ state: false, replaces: false, conflict: "maybe", close: false });
    expect(rightsOf("narration", "other")).toEqual({ state: false, replaces: false, conflict: "none", close: false });
    expect(rightsOf("narration", "past")).toEqual({ state: false, replaces: false, conflict: "none", close: false });
    expect(rightsOf("narration", "unknown")).toEqual({ state: false, replaces: false, conflict: "maybe", close: false });
    expect(rightsOf("character_claim", "other")).toEqual({ state: false, replaces: false, conflict: "none", close: false });
    expect(rightsOf("author_ruling", "present")).toEqual({ state: true, replaces: true, conflict: "sure", close: true });
  });

  it("原句在哪段：没段 = 当下；全在一段 = 那段；混着、跨段边、定位不了 = 段未知", () => {
    const scenes = [{ units: { from: 2, to: 3 }, frame: "other" as const }, { units: { from: 5, to: 5 }, frame: "past" as const }];
    expect(frameOf([], false, [])).toBe("present");
    expect(frameOf([{ units: { from: 2, to: 2 } }], true, scenes)).toBe("other");
    expect(frameOf([{ units: { from: 1, to: 1 } }], true, scenes)).toBe("present");
    expect(frameOf([{ units: { from: 3, to: 4 } }], true, scenes)).toBe("unknown");
    expect(frameOf([{ units: { from: 1, to: 1 } }, { units: { from: 2, to: 2 } }], true, scenes)).toBe("unknown");
    expect(frameOf([{ units: { from: 2, to: 2 } }, { units: { from: 5, to: 5 } }], true, scenes)).toBe("other");
    expect(frameOf([{}], false, scenes)).toBe("unknown");
  });
});
