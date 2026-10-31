import { describe, expect, it } from "vitest";
import { project } from "../projection/project.js";
import type { EntryInput } from "../schema/ledger.js";
import { ledgerOf } from "../ledger/entries.js";
import { checkEntries } from "./check.js";
import { classifyForReview } from "./classify.js";

const before = project({
  ledgers: [
    ledgerOf({
      chapter: 1,
      committedAt: "2026-10-17T00:00:00.000Z",
      entries: [
        { id: "c1-1", kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周没拦" },
        { id: "c1-2", kind: "fact", review: "auto", nature: "hard", subject: "老周", attribute: "年纪", value: "六十", text: "老周六十", quote: "六十岁" },
        { id: "c1-3", kind: "thread", review: "auto", op: "open", thread: "t1-1", type: "question", title: "钟为什么停", note: "停了", quote: "钟停了" },
      ],
    }),
  ],
  decisions: [],
});

const TEXT = "周守义今年七十了。阿笙推门进来，钟又走了。周守义说：「你回来了。」";
const entries: EntryInput[] = [
  { kind: "fact", review: "auto", nature: "hard", subject: "周守义", attribute: "年纪", value: "七十", text: "老周七十", quote: "周守义今年七十了" },
  { kind: "presence", review: "auto", name: "阿笙", nameUsed: "阿笙", quote: "阿笙推门进来" },
  { kind: "presence", review: "auto", name: "周守义", nameUsed: "周守义", quote: "周守义今年七十了" },
  { kind: "thread", review: "auto", op: "close", thread: "t1-1", note: "钟又走了", quote: "钟又走了" },
  { kind: "time", review: "auto", start: "unknown", sameDay: true },
  { kind: "summary", review: "auto", text: "阿笙回来", quote: "你回来了" },
];

describe("定稿清单：哪几条要作者看", () => {
  it("改旧账、丢线索、新面孔要看；其余（含说不出隔几天的时间）自动记", () => {
    const checked = checkEntries(entries, TEXT, before);
    expect(checked.rejected).toEqual([]);
    const plan = classifyForReview(checked.accepted, before, { chapter: 2 });
    expect(plan.review.map((item) => [item.index, item.reasons])).toEqual([
      [0, ["hard-conflict"]],
      [1, ["new-character"]],
      [3, ["closes-thread"]],
    ]);
    expect(plan.auto.map((item) => item.index)).toEqual([2, 4, 5]);
    expect(plan.timeMissing).toBe(false);
  });

  it("设定卡上有的名字不算新面孔；明写推翻的不算矛盾、但要看；没有时间条目要标出来", () => {
    const plan = classifyForReview(
      [
        { index: 0, entry: { ...(entries[0] as EntryInput), replaces: ["c1-2"] } as EntryInput },
        { index: 1, entry: entries[1] as EntryInput },
      ],
      before,
      { chapter: 2, knownNames: ["阿笙"] },
    );
    expect(plan.review.map((item) => item.reasons)).toEqual([["replaces-fact"]]);
    expect(plan.timeMissing).toBe(true);
  });

  it("人物说的、梦里的、回忆里的不算改旧账：和前文对不上、收线索都不出卡；没给正文按当下算", () => {
    const text = "那天夜里阿笙做了个梦。梦里周守义才五十，钟又走了。阿笙醒了。周守义说：「我今年八十。」";
    const time: EntryInput = {
      kind: "time",
      review: "auto",
      start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "那天夜里阿笙做了个梦" },
      sameDay: true,
      segments: [{ frame: "other", firstQuote: "梦里周守义才五十", lastQuote: "钟又走了" }],
    };
    const dreamAge: EntryInput = { kind: "fact", review: "auto", nature: "hard", subject: "周守义", attribute: "年纪", value: "五十", text: "梦里五十", quote: "梦里周守义才五十" };
    const dreamClose: EntryInput = { kind: "thread", review: "auto", op: "close", thread: "t1-1", note: "梦里钟走了", quote: "钟又走了" };
    const claim: EntryInput = {
      kind: "fact", review: "auto", nature: "hard", subject: "周守义", attribute: "年纪", value: "八十", text: "他说八十", quote: "我今年八十",
      source: { kind: "character_claim", speaker: "周守义" },
    };
    const items = [time, dreamAge, dreamClose, claim].map((entry, index) => ({ index, entry }));
    const plan = classifyForReview(items, before, { chapter: 2, text });
    expect(plan.review).toEqual([]);
    expect(plan.timeMissing).toBe(false);
    // 不给正文：段对不回句子，梦里那两条按当下算（照旧出卡）；人物说的照样不出。
    const blind = classifyForReview(items, before, { chapter: 2 });
    expect(blind.review.map((item) => [item.index, item.reasons])).toEqual([[1, ["hard-conflict"]], [2, ["closes-thread"]]]);
  });
});
