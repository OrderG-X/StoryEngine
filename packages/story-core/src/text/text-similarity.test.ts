import { describe, expect, it } from "vitest";
import { bigramSimilarity } from "./text-similarity.js";

describe("bigramSimilarity", () => {
  it("同一 hook 的近重复响动碎片高相似", () => {
    expect(bigramSimilarity("听到不连续的响动", "不连续的响动")).toBeGreaterThan(0.5);
  });
  it("不相干线索低相似", () => {
    expect(bigramSimilarity("抽屉夹层的借条", "工地围墙松动的砖")).toBeLessThan(0.2);
  });
  it("空串安全返回 0", () => { expect(bigramSimilarity("", "x")).toBe(0); });
});
