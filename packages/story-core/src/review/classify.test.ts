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
  { kind: "time", review: "auto", basis: "estimated" },
  { kind: "summary", review: "auto", text: "阿笙回来", quote: "你回来了" },
];

describe("定稿清单：哪几条要作者看", () => {
  it("改旧账、丢线索、新面孔、估的天数要看；其余自动记", () => {
    const checked = checkEntries(entries, TEXT, before);
    expect(checked.rejected).toEqual([]);
    const plan = classifyForReview(checked.accepted, before, { chapter: 2 });
    expect(plan.review.map((item) => [item.index, item.reasons])).toEqual([
      [0, ["hard-conflict"]],
      [1, ["new-character"]],
      [3, ["closes-thread"]],
      [4, ["time-estimated"]],
    ]);
    expect(plan.auto.map((item) => item.index)).toEqual([2, 5]);
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
});
