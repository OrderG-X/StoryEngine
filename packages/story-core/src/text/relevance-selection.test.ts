import { describe, expect, it } from "vitest";
import { selectRelevant } from "./relevance-selection.js";

const base = { text: "", status: "open" as const };
describe("selectRelevant 四维召回", () => {
  it("已收口(closedStatuses)被排除", () => {
    const r = selectRelevant({
      items: [{ ...base, status: "done", text: "已收线", firstSeenChapter: 1 }],
      chapter: 50, closedStatuses: ["done", "resolved", "abandoned"],
    });
    expect(r.selected).toHaveLength(0);
    expect(r.diagnostics.closed).toBe(1);
  });
  it("古老未收口加分压过更新的(治早期沉底)", () => {
    const old = { ...base, text: "赵叔的借条", firstSeenChapter: 2, lastTouchedChapter: 2 };
    const recent = { ...base, text: "近章杂线", firstSeenChapter: 47, lastTouchedChapter: 47 };
    const r = selectRelevant({
      items: [recent, old], chapter: 50, closedStatuses: ["done"],
      ancientThreshold: 10, ancientBonus: 3,
    });
    expect(r.selected[0]).toBe(old); // 古老未收口排在最前
  });
  it("在场角色名命中得高分", () => {
    const hit = { ...base, text: "赵叔欠的钱", firstSeenChapter: 40 };
    const miss = { ...base, text: "路人甲", firstSeenChapter: 40 };
    const r = selectRelevant({
      items: [miss, hit], chapter: 50, closedStatuses: ["done"], relevantNames: ["赵叔"],
    });
    expect(r.selected[0]).toBe(hit);
  });
  it("有效区间外不入选(章号机械判定)", () => {
    const r = selectRelevant({
      items: [{ ...base, text: "未来设定", effectiveFromChapter: 99, firstSeenChapter: 99 }],
      chapter: 50, closedStatuses: ["done"],
    });
    expect(r.selected).toHaveLength(0);
    expect(r.diagnostics.notYetEffective).toBe(1);
  });
  it("无元数据字段的旧数据向后兼容(退化古老护栏+近章,不崩)", () => {
    const r = selectRelevant({
      items: [{ text: "旧线索A" }, { text: "旧线索B" }], chapter: 50, closedStatuses: ["done"],
    });
    expect(r.selected).toHaveLength(2);
  });
});
