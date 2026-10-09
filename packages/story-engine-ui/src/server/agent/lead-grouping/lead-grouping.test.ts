import { describe, expect, it } from "vitest";
import { applyLeadGroups, parseLeadGroups, buildLeadGroupingMessages } from "./lead-grouping.js";
import type { NarrativeThread } from "@actalk/story-engine";

const lead = (id: string, title: string, over: Partial<NarrativeThread> = {}): NarrativeThread => ({
  id, type: "lead", title, status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [title], ...over,
});

describe("parseLeadGroups", () => {
  it("抠 JSON + 校验 memberIds>=2", () => {
    const r = parseLeadGroups('好:{"groups":[{"memberIds":["a","b","c"]}]}尾');
    expect(r.groups[0].memberIds).toEqual(["a", "b", "c"]);
  });
  it("宽进：单成员组跳过、多余字段丢掉、id 给成数字也收；不是 JSON 才抛（2026-10-10 真机：严格校验让整次归并没跑成）", () => {
    expect(parseLeadGroups('{"groups":[{"memberIds":["a"]}]}')).toEqual({ groups: [] });
    expect(parseLeadGroups('{"groups":[{"memberIds":["a","b"],"reason":"同一件事"},{"memberIds":[7,8,8]}],"note":"x"}'))
      .toEqual({ groups: [{ memberIds: ["a", "b"] }, { memberIds: ["7", "8"] }] });
    expect(() => parseLeadGroups("没有可合并的")).toThrow();
  });
});

describe("buildLeadGroupingMessages", () => {
  it("把每条 id/标题带进 user 段 + 约束只归同一件事", () => {
    const msgs = buildLeadGroupingMessages([{ id: "x1", title: "听到响动", evidence: "夜里听到响动" }]);
    const user = msgs.find((m) => m.role === "user")!.content;
    const sys = msgs.find((m) => m.role === "system")!.content;
    expect(user).toContain("x1");
    expect(user).toContain("听到响动");
    expect(sys).toContain("同一件事");
  });
});

describe("applyLeadGroups", () => {
  it("修#3：GLM 返回重叠组 [a,b]+[b,c] → b 只被第一组认领，c 不并进已 stale 的 b、evidence 不丢", () => {
    const threads = [
      lead("a", "听到响动", { firstSeenChapter: 1, evidence: ["e-a"] }),
      lead("b", "夜里的响动", { firstSeenChapter: 2, evidence: ["e-b"] }),
      lead("c", "持续的响动声", { firstSeenChapter: 3, evidence: ["e-c"] }),
    ];
    // GLM 返回两个重叠组（b 同时在两组里）
    const r = applyLeadGroups(threads, { groups: [{ memberIds: ["a", "b"] }, { memberIds: ["b", "c"] }] });
    // 第一组：a 为 winner、b 为 loser；第二组 b 已被认领 → 只剩 c → 跳过
    expect([...r.staleIds]).toEqual(["b"]); // 只 stale b，绝不 stale c
    expect(r.mergedPairs).toEqual([{ loserId: "b", winnerId: "a" }]);
    // a 拿到 e-a + e-b；c 原样开放、evidence 完整没丢（不会并进已 stale 的 b）
    expect(r.next.find((t) => t.id === "a")!.evidence).toEqual(expect.arrayContaining(["e-a", "e-b"]));
    const c = r.next.find((t) => t.id === "c")!;
    expect(c.status).toBe("open");
    expect(c.evidence).toEqual(["e-c"]);
  });
  it("一组3响动→winner=firstSeen最早、另2 stale+evidence并入winner", () => {
    const threads = [
      lead("w", "听到响动", { firstSeenChapter: 2, evidence: ["e-w"] }),
      lead("l1", "不连续的响动", { firstSeenChapter: 6, evidence: ["e-l1"] }),
      lead("l2", "主角听到的响动相对稳定", { firstSeenChapter: 9, evidence: ["e-l2"] }),
    ];
    const r = applyLeadGroups(threads, { groups: [{ memberIds: ["w", "l1", "l2"] }] });
    expect([...r.staleIds].sort()).toEqual(["l1", "l2"]);
    expect(r.mergedPairs).toEqual(expect.arrayContaining([
      { loserId: "l1", winnerId: "w" }, { loserId: "l2", winnerId: "w" },
    ]));
    expect(r.next.find((t) => t.id === "w")!.evidence).toEqual(expect.arrayContaining(["e-w", "e-l1", "e-l2"]));
    expect(r.next.find((t) => t.id === "l1")!.status).toBe("stale");
  });
  it("保护:组里 done/stale/intent/无效id 成员忽略,有效<2 则整组跳过", () => {
    const threads = [
      lead("a", "听到响动"),
      { ...lead("b", "别的事"), status: "done" as const },
      { ...lead("c", "又一事"), type: "intent" as const },
    ];
    const r = applyLeadGroups(threads, { groups: [{ memberIds: ["a", "b", "c", "ghost"] }] });
    expect(r.staleIds).toEqual([]);
    expect(r.mergedPairs).toEqual([]);
  });
  it("多组互不干扰", () => {
    const threads = [lead("a", "响动1", { firstSeenChapter: 1 }), lead("b", "响动2", { firstSeenChapter: 3 }), lead("c", "借条1", { firstSeenChapter: 2 }), lead("d", "借条2", { firstSeenChapter: 5 })];
    const r = applyLeadGroups(threads, { groups: [{ memberIds: ["a", "b"] }, { memberIds: ["c", "d"] }] });
    expect([...r.staleIds].sort()).toEqual(["b", "d"]);
  });
});
