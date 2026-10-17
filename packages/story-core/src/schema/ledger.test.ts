import { describe, expect, it } from "vitest";
import { CHAPTER_LEDGER_SCHEMA, ChapterLedger } from "./ledger.js";

const base = { schema: CHAPTER_LEDGER_SCHEMA, chapter: 3, textSha256: "a".repeat(64), committedAt: "2026-10-17T00:00:00.000Z" };
const fact = { id: "fact-3-0", kind: "fact", review: "auto", nature: "event", subject: "老周", text: "老周卖了机芯" };

describe("章节账单格式", () => {
  it("定稿写的每条都要原句；老书导入的可以没有", () => {
    expect(ChapterLedger.safeParse({ ...base, origin: "commit", entries: [fact] }).success).toBe(false);
    expect(ChapterLedger.safeParse({ ...base, origin: "import", entries: [fact] }).success).toBe(true);
    expect(ChapterLedger.safeParse({ ...base, origin: "commit", entries: [{ ...fact, quote: "老周把机芯卖了" }] }).success).toBe(true);
  });

  it("结构问题挡在门外：状态缺值、开线索缺标题、编号重复、两条时间、非作者定天数", () => {
    const bad = [
      [{ ...fact, quote: "原句原句", nature: "state", attribute: "在哪" }],
      [{ id: "a", kind: "thread", review: "auto", op: "open", thread: "t3-1", note: "x", quote: "原句原句" }],
      [{ ...fact, quote: "原句原句" }, { ...fact, quote: "原句原句" }],
      [{ id: "a", kind: "time", review: "auto", basis: "estimated" }, { id: "b", kind: "time", review: "auto", basis: "estimated" }],
      [{ id: "a", kind: "time", review: "auto", basis: "estimated", day: 4 }],
    ];
    for (const entries of bad) expect(ChapterLedger.safeParse({ ...base, origin: "commit", entries }).success).toBe(false);
  });
});
