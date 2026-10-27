import { describe, expect, it } from "vitest";
import type { PaceFlag } from "@actalk/story-core";
import { paceNote, paceRange, paceReason } from "./pace-text.js";

const flag = (over: Partial<PaceFlag>): PaceFlag => ({ kind: "drag", reason: "slow", from: 46, to: 46, words: 2094, advanced: 1, closed: 0, ...over });

describe("节奏诊断的说法", () => {
  it("拖：只推进了几条 / 没推进；一段几章写起止", () => {
    expect(paceNote(flag({}))).toBe("第 46 章可能拖：2,094 字只推进了 1 条线索");
    expect(paceNote(flag({ from: 5, to: 6, words: 4000, advanced: 0 }))).toBe("第 5～6 章可能拖：4,000 字没推进线索");
    expect(paceReason(flag({ advanced: 1, closed: 1 }))).toBe("2,094 字只推进 1 条、收了 1 条线索");
  });

  it("赶：推进太密 / 一章跨好多天字少", () => {
    expect(paceNote(flag({ kind: "rush", reason: "dense", from: 9, to: 9, words: 861, advanced: 4, closed: 1 }))).toBe("第 9 章可能赶：861 字里推进 4 条、收了 1 条线索");
    expect(paceReason(flag({ kind: "rush", reason: "dense", words: 1137, advanced: 7 }))).toBe("1,137 字里推进了 7 条线索");
    expect(paceNote(flag({ kind: "rush", reason: "span", from: 27, to: 27, words: 1200, advanced: 2, span: 6 }))).toBe("第 27 章可能赶：一章跨了 6 天，只写了 1,200 字");
  });

  it("章号范围", () => {
    expect(paceRange({ from: 3, to: 3 })).toBe("第 3 章");
    expect(paceRange({ from: 12, to: 14 })).toBe("第 12～14 章");
  });
});
