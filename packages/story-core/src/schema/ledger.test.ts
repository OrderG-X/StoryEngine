import { describe, expect, it } from "vitest";
import { CHAPTER_LEDGER_SCHEMA, ChapterLedger, UNITS_VERSION } from "./ledger.js";

const base = {
  schema: CHAPTER_LEDGER_SCHEMA,
  chapter: 3,
  textSha256: "a".repeat(64),
  committedAt: "2026-10-17T00:00:00.000Z",
  status: "ready",
  coverage: { missingKinds: [], rejectedCount: 0, reasonCodes: [], omittedUnits: [] },
  unitsVersion: UNITS_VERSION,
  scenes: [],
};
const common = { review: "auto", source: { kind: "unknown" }, transition: "unknown", provenance: "native" };
const proof = (quote: string, units?: { from: number; to: number }) => ({
  evidence: [{ resource: { kind: "chapter", chapter: 3 }, revision: "a".repeat(64), quote, ...(units ? { units } : {}) }],
  evidenceStatus: units ? "located" : "quoted",
});
const none = { evidence: [], evidenceStatus: "none" };
const fact = { id: "fact-3-0", kind: "fact", ...common, nature: "event", subjectRef: { mention: "老周" }, text: "老周卖了机芯" };
const time = (extra: Record<string, unknown>) => ({ id: "t", kind: "time", ...common, ...none, basis: "estimated", relation: "unknown", appliesTo: "chapterStart", ...extra });
const ok = (entries: unknown[], extra: Record<string, unknown> = {}) => ChapterLedger.safeParse({ ...base, origin: "commit", entries, ...extra }).success;

describe("章节账单格式（v2）", () => {
  it("定稿写的每条都要原句（核得上：唯一定位给句号、不止一处不给）；老书导入的可以没有", () => {
    expect(ok([{ ...fact, ...none }])).toBe(false);
    expect(ok([{ ...fact, ...none }], { origin: "import" })).toBe(true);
    expect(ok([{ ...fact, ...proof("老周把机芯卖了", { from: 2, to: 2 }) }])).toBe(true);
    expect(ok([{ ...fact, ...proof("老周把机芯卖了") }])).toBe(true);
    expect(ok([{ ...fact, ...proof("老周把机芯卖了"), evidenceStatus: "located" }])).toBe(false);
  });

  it("找不到原句、过时了只有迁移来的能是", () => {
    const lost = { ...fact, ...proof("老周把机芯卖了"), evidenceStatus: "unlocated_legacy" };
    expect(ok([lost])).toBe(false);
    expect(ok([{ ...lost, provenance: "migrated" }])).toBe(true);
    expect(ok([{ ...lost, provenance: "migrated", evidenceStatus: "stale" }])).toBe(true);
  });

  it("结构问题挡在门外：状态缺值、开线索缺标题、编号重复、两条开头时间、非作者定天数、P2b 不用的格子", () => {
    const q = proof("原句原句");
    const bad = [
      [{ ...fact, ...q, nature: "state", predicate: "在哪" }],
      [{ id: "a", kind: "thread", ...common, ...q, op: "open", threadRef: { id: "t3-1" }, note: "x" }],
      [{ ...fact, ...q }, { ...fact, ...q }],
      [time({}), time({ id: "u" })],
      [time({ relation: "at", day: 4 })],
      [time({ relation: "offset", anchor: "previousChapterEnd", offset: { unit: "day", min: 1, max: 2 } })],
      [time({ relation: "offset", anchor: "previousChapterEnd", offset: { unit: "day", min: -1, max: -1 } })],
      [time({ id: "e", appliesTo: "chapterEnd", relation: "offset", anchor: "chapterStart", offset: { unit: "day", min: 1, max: 1 } })],
      [{ ...fact, ...q, source: { kind: "narration" } }],
      [{ ...fact, ...q, transition: "change" }],
    ];
    for (const entries of bad) expect(ok(entries)).toBe(false);
    expect(ok([time({}), time({ id: "e", appliesTo: "chapterEnd", relation: "offset", anchor: "chapterStart", offset: { unit: "day", min: 1, max: 1 } })])).toBe(true);
    expect(ok([time({ basis: "author", relation: "at", day: 4 })])).toBe(true);
  });

  it("账待记的章没有条目；场景 P2b 一律空", () => {
    expect(ok([], { status: "pending" })).toBe(true);
    expect(ok([{ ...fact, ...proof("老周把机芯卖了") }], { status: "pending" })).toBe(false);
    expect(ok([], { scenes: [{ id: "s1", units: { from: 1, to: 2 }, order: 0, timeRefs: [] }] })).toBe(false);
  });
});
