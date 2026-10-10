import { describe, expect, it } from "vitest";
import { applyChapterFactUpdate } from "../fact-ledger-store.js";
import { emptyStoryTimeline, parseWeekday, placeChapter } from "../story-timeline.js";
import type { FactEntry } from "../types.js";

const old: FactEntry[] = [
  { id: "fact-1-0", chapter: 1, text: "便签在收银台抽屉里", source: "auto" },
  { id: "fact-1-1", chapter: 1, text: "作者手记：苏晚怕猫", source: "manual" },
];

function timeline() {
  let t = emptyStoryTimeline();
  t = placeChapter(t, { chapter: 1, declared: { weekday: parseWeekday("周三"), quote: "周三" } }).timeline;
  t = placeChapter(t, { chapter: 2, declared: { daysSincePrevious: 1, quote: "第二天" } }).timeline;
  return t;
}

describe("账本 v2：本章事实变更", () => {
  it("新事实带出处和三元组；日子按时间线换；本章明写的变化作废旧条（留指针）", () => {
    const result = applyChapterFactUpdate(old, 2, {
      adds: [{ text: "周屿本章说的后天上午回来", quote: "后天上午回来", subject: "周屿", attribute: "回来", value: "后天上午", kind: "event" }],
      changes: [{ factId: "fact-1-0", newText: "便签被苏晚拿出来打了电话又放回抽屉", quote: "照着上面的号码拨过去" }],
    }, timeline());
    const added = result.facts.filter((fact) => fact.chapter === 2);
    expect(added[0]).toMatchObject({ id: "fact-2-0", text: "周屿故事第 4 天（周六）上午回来", quote: "后天上午回来", subject: "周屿", value: "故事第 4 天（周六）上午", kind: "event", source: "auto" });
    expect(result.facts.find((fact) => fact.id === "fact-1-0")).toMatchObject({ supersededByChapter: 2, supersededByFactId: "fact-2-1" });
    expect(result.added).toBe(2);
    expect(result.superseded).toEqual(["便签在收银台抽屉里"]);
  });

  it("重定稿同一章：先撤本章上次自动记的、恢复被本章作废的旧条；作者手记的不动；不重复", () => {
    const first = applyChapterFactUpdate(old, 2, {
      adds: [{ text: "王婶搬来五年" }],
      changes: [{ factId: "fact-1-0", newText: "便签放回了抽屉" }],
    });
    const manualOnChapter2: FactEntry = { id: "fact-2-9", chapter: 2, text: "作者补记：雨停了", source: "manual" };
    const again = applyChapterFactUpdate([...first.facts, manualOnChapter2], 2, { adds: [{ text: "王婶搬来五年" }], changes: [] });
    expect(again.facts.filter((fact) => fact.chapter === 2).map((fact) => fact.text)).toEqual(["作者补记：雨停了", "王婶搬来五年"]);
    expect(again.facts.find((fact) => fact.id === "fact-1-0")?.supersededByChapter).toBeUndefined();
    expect(again.facts.some((fact) => fact.text === "作者手记：苏晚怕猫")).toBe(true);
  });

  it("变化指向不存在或已作废的旧条 → 不作废，但新说法照记", () => {
    const result = applyChapterFactUpdate(old, 2, { adds: [], changes: [{ factId: "fact-9-9", newText: "新说法" }] });
    expect(result.superseded).toEqual([]);
    expect(result.facts.some((fact) => fact.text === "新说法")).toBe(true);
  });
});

describe("状态事实自动作废（2026-10-10 引擎升级第 4 期）", () => {
  const ledger: FactEntry[] = [
    { id: "fact-1-0", chapter: 1, text: "铜钥匙在苏晚的钥匙串上", source: "auto", subject: "铜钥匙", attribute: "在谁手里", value: "苏晚的钥匙串上", kind: "state" },
    { id: "fact-1-1", chapter: 1, text: "林秋旧居是槐树巷五号", source: "auto", subject: "林秋", attribute: "旧住址", value: "槐树巷五号", kind: "hard" },
  ];

  it("同一主体同一属性的状态有了新值 → 旧值从本章起作废、留指针；回执里点名", () => {
    const result = applyChapterFactUpdate(ledger, 4, {
      adds: [{ text: "铜钥匙在周屿手心里", quote: "钥匙落在周屿手心里", subject: "铜钥匙", attribute: "在谁手里", value: "周屿手心里", kind: "state" }],
      changes: [],
    });
    expect(result.facts.find((fact) => fact.id === "fact-1-0")).toMatchObject({ supersededByChapter: 4, supersededByFactId: "fact-4-0" });
    expect(result.superseded).toEqual(["铜钥匙在苏晚的钥匙串上"]);
  });

  it("不该变的（hard）值不同 → 不自动作废（那是矛盾，交给核账）；值一样 → 不作废", () => {
    const hard = applyChapterFactUpdate(ledger, 4, {
      adds: [{ text: "林秋旧居是槐树巷九号", subject: "林秋", attribute: "旧住址", value: "槐树巷九号", kind: "hard" }],
      changes: [],
    });
    expect(hard.facts.find((fact) => fact.id === "fact-1-1")?.supersededByChapter).toBeUndefined();
    const same = applyChapterFactUpdate(ledger, 4, {
      adds: [{ text: "铜钥匙还在苏晚的钥匙串上", subject: "铜钥匙", attribute: "在谁手里", value: "苏晚的钥匙串上", kind: "state" }],
      changes: [],
    });
    expect(same.facts.find((fact) => fact.id === "fact-1-0")?.supersededByChapter).toBeUndefined();
  });

  it("重定稿：撤掉本章上次记的，也恢复被它自动作废的旧值", () => {
    const first = applyChapterFactUpdate(ledger, 4, {
      adds: [{ text: "铜钥匙在周屿手心里", subject: "铜钥匙", attribute: "在谁手里", value: "周屿手心里", kind: "state" }],
      changes: [],
    });
    const again = applyChapterFactUpdate(first.facts, 4, { adds: [], changes: [] });
    expect(again.facts.find((fact) => fact.id === "fact-1-0")?.supersededByChapter).toBeUndefined();
  });
});
