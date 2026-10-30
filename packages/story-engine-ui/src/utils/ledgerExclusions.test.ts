import { describe, expect, it } from "vitest";
import { clearLedgerExclusions, ledgerDayOverrideFor, ledgerExclusionsFor, rememberLedgerDayOverride, rememberLedgerExclusions } from "./ledgerExclusions.js";

describe("定稿清单上作者动过的（按出清单的那次定稿记）", () => {
  it("同一次定稿：弹窗重挂载能取回勾选和天数；别的一次不认；点了确认清掉", () => {
    const op = "op-0123456789abcdef0123";
    rememberLedgerExclusions(op, new Set(["fact:x", "thread:lead-1"]));
    rememberLedgerDayOverride(op, { day: 3, dayEnd: 4 });
    expect([...ledgerExclusionsFor(op)]).toEqual(["fact:x", "thread:lead-1"]);
    expect(ledgerDayOverrideFor(op)).toEqual({ day: 3, dayEnd: 4 });
    expect([...ledgerExclusionsFor("op-0123456789abcdef0124")]).toEqual([]);
    rememberLedgerExclusions(op, new Set(["fact:x"]));
    expect(ledgerDayOverrideFor(op)).toEqual({ day: 3, dayEnd: 4 });
    rememberLedgerDayOverride(op, undefined);
    expect([...ledgerExclusionsFor(op)]).toEqual(["fact:x"]);
    expect(ledgerDayOverrideFor(op)).toBeUndefined();
    clearLedgerExclusions(op);
    expect([...ledgerExclusionsFor(op)]).toEqual([]);
  });
});
