import { describe, expect, it } from "vitest";
import { searchLibraryIndex, type LibrarySearchSource } from "./librarySearch.js";

const sources: LibrarySearchSource[] = [
  { cat: "chars", catLabel: "人物", items: ["林远", "周伯庸", "林晚舟"] },
  { cat: "places", catLabel: "地点", items: ["恒隆广场", "城北旧仓库"] },
  { cat: "items", catLabel: "物品", items: ["三亿信托", "保险柜"] },
];

describe("searchLibraryIndex", () => {
  it("空/空白查询 → 空结果（不展开浮层）", () => {
    expect(searchLibraryIndex(sources, "")).toEqual([]);
    expect(searchLibraryIndex(sources, "   ")).toEqual([]);
  });

  it("跨类目子串命中，带回类目 id + 标签 + snippet", () => {
    const hits = searchLibraryIndex(sources, "林远");
    expect(hits).toEqual([{ label: "林远", cat: "chars", catLabel: "人物", snippet: "林远" }]);
  });

  it("长条目：snippet 截命中附近的窗口（带省略号），不再整条平铺", () => {
    const long = "这是一段很长很长的故事设定文字，里面在中间某处提到了苏见青这个关键人物，后面还有很多很多别的无关内容继续延展下去凑长度";
    const hits = searchLibraryIndex([{ cat: "story", catLabel: "故事设定", items: [long] }], "苏见青");
    expect(hits[0]?.snippet).toContain("苏见青");
    expect(hits[0]?.snippet.length).toBeLessThan(long.length); // 截了窗口
    expect(hits[0]?.snippet).toContain("…"); // 命中在中间 → 两侧省略
    expect(hits[0]?.label).toBe(long); // label 仍是全文（点击/定位用）
  });

  it("短条目：snippet 即整条（无需截断）", () => {
    const hits = searchLibraryIndex([{ cat: "chars", catLabel: "人物", items: ["林远"] }], "林远");
    expect(hits[0]?.snippet).toBe("林远");
  });

  it("去重：同类目同条目只出一次", () => {
    const dup: LibrarySearchSource[] = [{ cat: "chars", catLabel: "人物", items: ["林远", "林远"] }];
    expect(searchLibraryIndex(dup, "林远")).toHaveLength(1);
  });

  it("一个词命中多类目（含数字/部分词）", () => {
    const hits = searchLibraryIndex(sources, "仓库");
    expect(hits.map((h) => h.label)).toEqual(["城北旧仓库"]);
    const hits2 = searchLibraryIndex(sources, "亿");
    expect(hits2.map((h) => h.cat)).toEqual(["items"]);
  });

  it("大小写不敏感", () => {
    const en: LibrarySearchSource[] = [{ cat: "chars", catLabel: "人物", items: ["Alice", "BOB"] }];
    expect(searchLibraryIndex(en, "alice").map((h) => h.label)).toEqual(["Alice"]);
    expect(searchLibraryIndex(en, "bob").map((h) => h.label)).toEqual(["BOB"]);
  });

  it("精确/前缀命中排在子串命中之前（角色直达优先于故事设定里的提及）", () => {
    const s: LibrarySearchSource[] = [
      { cat: "story", catLabel: "故事设定", items: ["豪门世家林远的背景设定"] }, // 子串(林远 在中间, idx>0)
      { cat: "chars", catLabel: "人物", items: ["林远"] }, // 精确
      { cat: "places", catLabel: "地点", items: ["林远老宅"] }, // 前缀(林远 在开头)
    ];
    const hits = searchLibraryIndex(s, "林远");
    expect(hits.map((h) => h.cat)).toEqual(["chars", "places", "story"]); // 精确 > 前缀 > 子串
  });

  it("带 focus 的条目：命中带回 focus（点了展开那张卡）", () => {
    const hits = searchLibraryIndex([{ cat: "chars", catLabel: "人物", focus: "林远", items: ["林远 阿远", "身份：律师"] }], "律师");
    expect(hits).toEqual([{ label: "身份：律师", cat: "chars", catLabel: "人物", focus: "林远", snippet: "身份：律师" }]);
  });

  it("两张卡写了一样的字：各出一条（不按字去重吞掉另一张卡）", () => {
    const twoCards: LibrarySearchSource[] = [
      { cat: "chars", catLabel: "人物", focus: "林远", items: ["身份：律师"] },
      { cat: "chars", catLabel: "人物", focus: "周伯庸", items: ["身份：律师"] },
    ];
    expect(searchLibraryIndex(twoCards, "律师").map((h) => h.focus)).toEqual(["林远", "周伯庸"]);
  });

  it("结果按 cap 截断", () => {
    const many: LibrarySearchSource[] = [{ cat: "x", catLabel: "X", items: Array.from({ length: 100 }, (_, i) => `项目${i}`) }];
    expect(searchLibraryIndex(many, "项目", 5)).toHaveLength(5);
  });
});
