// @vitest-environment node
import { describe, expect, it } from "vitest";
import { project, splitUnits } from "@actalk/story-core";
import { buildItemCheckTask, declareUsedNewTags, listItemEnds, mergeItemCheck, nextNewTag, unrecordedMentions } from "./item-check.js";

describe("章末对一遍（P4b 2.4）", () => {
  it("按交回来的条目算章末：按 seq 排、最后一下说了算；清点算成员在箱子里；丢了、毁了照写；没记在哪的标出来", () => {
    const root = {
      newItems: [
        { tag: "N1", name: "铁盒", unit: 1 },
        { tag: "N2", name: "账本", unit: 2 },
        { tag: "N3", name: "钥匙", unit: 3 },
        { tag: "N4", name: "樟木箱", unit: 4 },
      ],
      items: [
        { seq: 2, item: "N1", op: "move", to: { person: "她" }, unit: 5 },
        { seq: 1, item: "N1", op: "at", to: { place: "桌上" }, unit: 1 },
        { seq: 3, item: "N4", op: "census", members: ["N2", "N4"], unit: 6 },
        { seq: 4, item: "I7", op: "gone", gone: "destroyed", unit: 7 },
      ],
    };
    const listed = listItemEnds(root, new Map([["I7", "旧信"]]));
    const byHandle = new Map(listed.map((item) => [item.handle, item]));
    expect(byHandle.get("N1")?.end).toEqual({ text: "她拿着", unit: 5 });
    expect(byHandle.get("N1")?.units).toEqual([1, 5]);
    expect(byHandle.get("N2")?.end?.text).toBe("在樟木箱里（清点）");
    expect(byHandle.get("N3")?.end).toBeUndefined();
    expect(byHandle.get("N4")?.end).toBeUndefined();
    expect(byHandle.get("I7")).toMatchObject({ name: "旧信", end: { text: "毁了" } });
    const task = buildItemCheckTask(listed, [], nextNewTag(root)) ?? "";
    expect(task).toContain("N1 铁盒 · 章末：她拿着（第 5 句）");
    expect(task).toContain("N3 钥匙 · 章末：本章没记它在哪");
    expect(task).toContain("号从 N5 起往后排");
  });

  it("什么都列不出就不问", () => {
    expect(buildItemCheckTask([], [], 1)).toBeUndefined();
  });

  it("已有的东西叫法出现在正文、条目里一条没提：列出来带前文的现在；提到了的、一个字的叫法不找", () => {
    const before = project({
      ledgers: [],
      decisions: [],
    });
    const items = [
      { id: "i1-1", name: "铜钥匙", mentions: ["钥匙"] },
      { id: "i1-2", name: "盘", mentions: [] },
      { id: "i1-3", name: "账本", mentions: [] },
    ];
    const withItems = { ...before, items: items.map((item) => ({ ...item, now: { kind: "unknown" }, history: [] })) } as unknown as typeof before;
    const units = splitUnits("# 第2章\n\n她摸出钥匙。盘里有水。账本在桌上。");
    const out = unrecordedMentions(
      withItems,
      new Map([["I1", "i1-1"], ["I2", "i1-2"], ["I3", "i1-3"]]),
      new Map([["I1", "铜钥匙"], ["I2", "盘"], ["I3", "账本"]]),
      new Set(["I3"]),
      units,
      (id) => (id === "i1-1" ? "她拿着" : undefined),
    );
    expect(out).toEqual([{ handle: "I1", name: "铜钥匙", now: "她拿着", units: [units.find((unit) => unit.text.includes("钥匙"))?.id] }]);
    const task = buildItemCheckTask([], out, 1) ?? "";
    expect(task).toContain("I1 铜钥匙 · 前文记的现在：她拿着");
  });

  it("并进第一遍：补的条目接在最大 seq 后面；新号撞了整份一起换；交回来的不是 JSON 不并", () => {
    const first = {
      newItems: [{ tag: "N1", name: "铁盒", unit: 1 }],
      items: [{ seq: 3, item: "N1", op: "at", to: { place: "桌上" }, unit: 1 }],
    };
    const merged = mergeItemCheck(
      first,
      JSON.stringify({
        newItems: [{ tag: "N1", name: "另一个铁盒", unit: 4 }],
        items: [
          { seq: 1, item: "N1", op: "at", to: { place: "柜里" }, unit: 4 },
          { item: "I2", op: "move", to: { inside: "N1" }, unit: 5 },
        ],
      }),
    );
    expect(merged?.added).toBe(3);
    expect(merged?.root.newItems).toEqual([first.newItems[0], { tag: "N2", name: "另一个铁盒", unit: 4 }]);
    expect(merged?.root.items).toEqual([
      first.items[0],
      { seq: 4, item: "N2", op: "at", to: { place: "柜里" }, unit: 4 },
      { seq: 5, item: "I2", op: "move", to: { inside: "N2" }, unit: 5 },
    ]);
    expect(mergeItemCheck(first, "都对")).toBeUndefined();
    expect(mergeItemCheck(first, '{"newItems":[],"items":[]}')?.added).toBe(0);
  });

  it("用了没声明的 N 号、写了叫法和句号：替它声明；缺一样的不替（照常整条不收）", () => {
    const root = {
      newItems: [{ tag: "N1", name: "铁盒", unit: 1 }],
      items: [
        { seq: 1, item: "N2", as: "布袋", op: "at", to: { place: "床下" }, unit: 3, by: "narration" },
        { seq: 2, item: "N1", op: "move", to: { inside: { item: "N3", as: "抽屉" } }, unit: 4 },
        { seq: 3, item: "N4", op: "at", to: { place: "门外" }, unit: 5 },
      ],
    };
    const out = declareUsedNewTags(root);
    expect(out.declared).toEqual(["N2", "N3"]);
    expect(out.root.newItems).toEqual([
      root.newItems[0],
      { tag: "N2", name: "布袋", unit: 3, by: "narration" },
      { tag: "N3", name: "抽屉", unit: 4, by: "narration" },
    ]);
    expect(declareUsedNewTags({ newItems: [], items: [] }).declared).toEqual([]);
  });
});
