// @vitest-environment node
// 长跑 2026-10-04 #4：写作规则显式 chapterLength.minWords（「至少 N 字」硬下限）的出稿执法语义。
// 「至少 3000」旧路一律摘成 targetWords → lowerBound=0.85×3000=2550（稀释）；显式 min 存在时下限本体取代推导。
import { describe, expect, it } from "vitest";
import { readWritingRulesLengthIntent, resolveDraftLengthTarget, requestedDraftLengthBounds, type DraftLengthTarget } from "./draft-length-control.js";

function boundsOf(target: DraftLengthTarget): { readonly lower: number; readonly upper: number } {
  return { lower: target.lowerBound, upper: target.upperBound };
}

describe("resolveDraftLengthTarget × 显式 minWords（长跑 #4）", () => {
  it("无显式 min：writing_rules 目标走既有 0.85 推导（缺省回落现有算法）", () => {
    const target = resolveDraftLengthTarget({ writingRules: { chapterLength: { targetWords: 3000 } } });
    expect(target.source).toBe("writing_rules");
    expect(target.requested).toBe(3000);
    const { lower, upper } = boundsOf(target);
    expect(lower).toBe(requestedDraftLengthBounds(3000).lowerBound); // 2550
    expect(upper).toBe(requestedDraftLengthBounds(3000).upperBound);
  });

  it("显式 min=目标（「至少 3000」→ target 3000 + min 3000）：下限本体取代 0.85 推导（3000，不是 2550）", () => {
    const target = resolveDraftLengthTarget({
      writingRules: { chapterLength: { targetWords: 3000, minWords: 3000 } },
    });
    expect(target.source).toBe("writing_rules");
    expect(target.requested).toBe(3000);
    expect(target.lowerBound).toBe(3000);
    expect(target.upperBound).toBe(requestedDraftLengthBounds(3000).upperBound); // 3450，区间不倒挂
  });

  it("用户点单目标 + 规则显式 min：用户目标优先、但下限仍是硬地板（跨章书级约束不被单章点单稀释）", () => {
    const target = resolveDraftLengthTarget({
      requestedDraftLength: 3200,
      writingRules: { chapterLength: { targetWords: 3000, minWords: 3000 } },
    });
    expect(target.source).toBe("user");
    expect(target.requested).toBe(3200);
    expect(target.lowerBound).toBe(3000);
  });

  it("用户点单目标低于显式 min：目标顶到下限（不能要求模型写「不到下限」的稿）", () => {
    const target = resolveDraftLengthTarget({
      requestedDraftLength: 2000,
      writingRules: { chapterLength: { minWords: 3000 } },
    });
    expect(target.requested).toBe(3000);
    expect(target.lowerBound).toBe(3000);
    expect(target.upperBound).toBeGreaterThan(3000);
  });

  it("只有显式 min、没有目标：目标也抬到下限（上限区间才有意义）", () => {
    const target = resolveDraftLengthTarget({ writingRules: { chapterLength: { minWords: 3000 } } });
    expect(target.source).toBe("writing_rules");
    expect(target.requested).toBe(3000);
    expect(target.lowerBound).toBe(3000);
  });

  it("min=0（用户清空下限）与 min<300（与地板重合）都视为缺省，回落推导算法", () => {
    for (const minWords of [0, 50, 299]) {
      const target = resolveDraftLengthTarget({ writingRules: { chapterLength: { targetWords: 2000, minWords } } });
      expect(target.lowerBound).toBe(requestedDraftLengthBounds(2000).lowerBound); // 1700
    }
  });

  it("数字字符串形式的 minWords（模型退化输入）也能归一", () => {
    const target = resolveDraftLengthTarget({ writingRules: { chapterLength: { targetWords: 3000, minWords: "3000" } } });
    expect(target.lowerBound).toBe(3000);
  });

  it("无写作规则：默认 1800 行为不变", () => {
    const target = resolveDraftLengthTarget({});
    expect(target.source).toBe("default");
    expect(target.requested).toBe(1800);
    expect(boundsOf(target)).toEqual(boundsOf(resolveDraftLengthTarget({})));
  });
});

describe("readWritingRulesLengthIntent（出稿/定稿共用的意图解析）", () => {
  it("下限写成 0 = 缺省，不产生 minWords 意图；目标照读", () => {
    const rules = { chapterLength: { targetWords: 3000, minWords: 0 } };
    expect(readWritingRulesLengthIntent(rules).minWords).toBeUndefined();
    expect(readWritingRulesLengthIntent(rules).targetWords).toBe(3000);
  });
});
