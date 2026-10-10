import { describe, expect, it } from "vitest";
import { clearLedgerExclusions, ledgerExclusionsForCard, ledgerExclusionsForConfirm, rememberLedgerExclusions } from "./ledgerExclusions.js";

describe("定稿预览卡的勾选（两个「确认定稿」入口共用）", () => {
  it("同一张预览：卡片重挂载能取回；建议条按钮不带令牌也带得上；换了预览就不认", () => {
    rememberLedgerExclusions(8, "tok-a", new Set(["fact:x", "thread:lead-1"]));
    expect([...ledgerExclusionsForCard(8, "tok-a")]).toEqual(["fact:x", "thread:lead-1"]);
    expect([...ledgerExclusionsForCard(8, "tok-b")]).toEqual([]);
    expect(ledgerExclusionsForConfirm(8, undefined)).toEqual(["fact:x", "thread:lead-1"]);
    expect(ledgerExclusionsForConfirm(8, "tok-a")).toEqual(["fact:x", "thread:lead-1"]);
    expect(ledgerExclusionsForConfirm(8, "tok-b")).toEqual([]);
    expect(ledgerExclusionsForConfirm(9, undefined)).toEqual([]);
    clearLedgerExclusions(8);
    expect(ledgerExclusionsForConfirm(8, undefined)).toEqual([]);
  });
});
