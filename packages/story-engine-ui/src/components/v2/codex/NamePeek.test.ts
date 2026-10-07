import { describe, expect, it } from "vitest";
import { findNameOccurrences } from "./NamePeek.js";

describe("findNameOccurrences：正文里的角色名位置", () => {
  it("长名优先、互不重叠，单字名不标", () => {
    expect(findNameOccurrences("周屿推门，阿琴婆婆在打盹，周屿没叫她。", ["周屿", "阿琴", "周", "阿琴婆婆"])).toEqual([
      { start: 0, end: 2, name: "周屿" },
      { start: 5, end: 9, name: "阿琴婆婆" },
      { start: 13, end: 15, name: "周屿" },
    ]);
  });
  it("没有名字或空文本 → 空", () => {
    expect(findNameOccurrences("", ["周屿"])).toEqual([]);
    expect(findNameOccurrences("周屿", [])).toEqual([]);
  });
});
