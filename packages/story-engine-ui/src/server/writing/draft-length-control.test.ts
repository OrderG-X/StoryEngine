// @vitest-environment node
// 长跑 2026-10-04 #4：写作规则显式「每章至少字数」（minWords，「至少 N 字」硬下限）的出稿执法语义。
// 「至少 3000」旧路一律摘成 targetWords → lowerBound=0.85×3000=2550（稀释）；显式 min 存在时下限本体取代推导。
// 重构 P9：字数来自设定卡写作规则（rules.targetWords / rules.minWords），经 lengthRulesOf 转成 lengthRules。
import { describe, expect, it } from "vitest";
import { emptyWritingRules, type WritingRules } from "@actalk/story-core";
import { applyDraftLengthConstraint, buildDraftLengthReport, draftLengthAim, draftLengthFloor, lengthRulesOf, readWritingRulesLengthIntent, resolveDraftLengthTarget, requestedDraftLengthBounds, type DraftLengthTarget } from "./draft-length-control.js";

function boundsOf(target: DraftLengthTarget): { readonly lower: number; readonly upper: number } {
  return { lower: target.lowerBound, upper: target.upperBound };
}

describe("resolveDraftLengthTarget × 显式 minWords（长跑 #4）", () => {
  it("无显式 min：writing_rules 目标走既有 0.85 推导（缺省回落现有算法）", () => {
    const target = resolveDraftLengthTarget({ lengthRules: { targetWords: 3000 } });
    expect(target.source).toBe("writing_rules");
    expect(target.requested).toBe(3000);
    const { lower, upper } = boundsOf(target);
    expect(lower).toBe(requestedDraftLengthBounds(3000).lowerBound); // 2550
    expect(upper).toBe(requestedDraftLengthBounds(3000).upperBound);
  });

  it("显式 min=目标（「至少 3000」→ target 3000 + min 3000）：下限本体取代 0.85 推导（3000，不是 2550）", () => {
    const target = resolveDraftLengthTarget({
      lengthRules: { targetWords: 3000, minWords: 3000 },
    });
    expect(target.source).toBe("writing_rules");
    expect(target.requested).toBe(3000);
    expect(target.lowerBound).toBe(3000);
    expect(target.upperBound).toBe(requestedDraftLengthBounds(3000).upperBound); // 3450，区间不倒挂
  });

  it("用户点单目标 + 规则显式 min：用户目标优先、但下限仍是硬地板（跨章书级约束不被单章点单稀释）", () => {
    const target = resolveDraftLengthTarget({
      requestedDraftLength: 3200,
      lengthRules: { targetWords: 3000, minWords: 3000 },
    });
    expect(target.source).toBe("user");
    expect(target.requested).toBe(3200);
    expect(target.lowerBound).toBe(3000);
  });

  it("用户点单目标低于显式 min：目标顶到下限（不能要求模型写「不到下限」的稿）", () => {
    const target = resolveDraftLengthTarget({
      requestedDraftLength: 2000,
      lengthRules: { minWords: 3000 },
    });
    expect(target.requested).toBe(3000);
    expect(target.lowerBound).toBe(3000);
    expect(target.upperBound).toBeGreaterThan(3000);
  });

  it("显式 min 比目标的正常区间还低（作者把地板调低、目标照旧）：出稿照旧瞄目标区间，地板不当出稿下限", () => {
    const target = resolveDraftLengthTarget({ lengthRules: { targetWords: 2500, minWords: 1000 } });
    expect(target.requested).toBe(2500);
    expect(target.lowerBound).toBe(requestedDraftLengthBounds(2500).lowerBound); // 2125，不是 1000
    expect(target.hardMinimum).toBeUndefined();
  });

  // 长篇实跑：至少 2000、目标 2500，写了 2113 字却报「比下限少 12 字」（2125 是 2500 的八五折，不是作者定的）。
  it("显式 min 比区间下沿低：提示词照区间写，够不够按作者的 min 判", () => {
    const target = resolveDraftLengthTarget({ lengthRules: { targetWords: 2500, minWords: 2000 } });
    expect(applyDraftLengthConstraint("", target)).toContain("2125-2875");
    expect(draftLengthFloor(target)).toBe(2000);
    const ok = buildDraftLengthReport({ draftBody: "字".repeat(2113), lengthTarget: target });
    expect(ok.lengthStatus).toBe("within_range");
    expect(ok.lowerBound).toBe(2000);
    expect(buildDraftLengthReport({ draftBody: "字".repeat(1990), lengthTarget: target }).lengthStatus).toBe("below_lower_bound");
  });

  it("下限 = 目标时瞄区间中间（写手总往少了写，瞄着下限写多半不够）；平常就瞄目标", () => {
    const floor = resolveDraftLengthTarget({ lengthRules: { targetWords: 2500, minWords: 2500 } });
    expect(draftLengthAim(floor)).toBe(2688);
    expect(applyDraftLengthConstraint("", floor)).toContain("项目写作规则要求至少 2500 字，这次写 2688 字左右");
    const normal = resolveDraftLengthTarget({ lengthRules: { targetWords: 2500 } });
    expect(draftLengthAim(normal)).toBe(2500);
    expect(applyDraftLengthConstraint("", normal)).toContain("项目写作规则要求约 2500 字");
  });

  it("只有显式 min、没有目标：目标也抬到下限（上限区间才有意义）", () => {
    const target = resolveDraftLengthTarget({ lengthRules: { minWords: 3000 } });
    expect(target.source).toBe("writing_rules");
    expect(target.requested).toBe(3000);
    expect(target.lowerBound).toBe(3000);
  });

  it("min=0（用户清空下限）与 min<300（与地板重合）都视为缺省，回落推导算法", () => {
    for (const minWords of [0, 50, 299]) {
      const target = resolveDraftLengthTarget({ lengthRules: { targetWords: 2000, minWords } });
      expect(target.lowerBound).toBe(requestedDraftLengthBounds(2000).lowerBound); // 1700
    }
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
    const rules = { targetWords: 3000, minWords: 0 };
    expect(readWritingRulesLengthIntent(rules).minWords).toBeUndefined();
    expect(readWritingRulesLengthIntent(rules).targetWords).toBe(3000);
  });

  it("低于 300 的目标：出稿侧不认（targetWords 缺省），定稿软推导仍拿得到原值（rawTargetWords）", () => {
    expect(readWritingRulesLengthIntent({ targetWords: 200 })).toEqual({ rawTargetWords: 200 });
  });

  it("低于 300 的下限照原值给定稿执法（作者改成 30 就是 30，不回落到 300）", () => {
    expect(readWritingRulesLengthIntent({ targetWords: 2500, minWords: 30 })).toEqual({ targetWords: 2500, rawTargetWords: 2500, minWords: 30 });
  });
});

describe("lengthRulesOf（设定卡写作规则 → 字数）", () => {
  const at = "2026-10-19T00:00:00.000Z";
  const rulesWith = (extra: Partial<WritingRules>): WritingRules => ({ ...emptyWritingRules(), ...extra });

  it("只取 targetWords / minWords 的值；没写就没有", () => {
    expect(lengthRulesOf(rulesWith({ targetWords: { value: 2400, by: "author", at }, minWords: { value: 2000, by: "ai", at } }))).toEqual({ targetWords: 2400, minWords: 2000 });
    expect(lengthRulesOf(emptyWritingRules())).toEqual({});
    expect(lengthRulesOf(undefined)).toEqual({});
  });

  it("设定卡写作规则直接喂 resolveDraftLengthTarget：来源是 writing_rules", () => {
    const target = resolveDraftLengthTarget({ lengthRules: lengthRulesOf(rulesWith({ targetWords: { value: 2400, by: "author", at } })) });
    expect(target).toMatchObject({ source: "writing_rules", requested: 2400 });
  });
});
