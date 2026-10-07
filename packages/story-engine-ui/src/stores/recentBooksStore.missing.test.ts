import { describe, expect, it } from "vitest";
import { missingDefaultLibraryPaths } from "./recentBooksStore.js";

const book = (projectPath: string) => ({ projectPath }) as never;

describe("书架清掉默认书库里已经不存在的书", () => {
  it("只判书库根目录下、盘上没有的；别处打开的书不动；缺扫描信息不误删", () => {
    const books = [book("/lib/story-engine/a"), book("/lib/story-engine/gone"), book("/elsewhere/c")];
    const missing = missingDefaultLibraryPaths(books, { root: "/lib/story-engine", existingPaths: ["/lib/story-engine/a"] });
    expect([...missing]).toEqual(["/lib/story-engine/gone"]);
    expect(missingDefaultLibraryPaths(books, { root: "/lib/story-engine" }).size).toBe(0);
    expect(missingDefaultLibraryPaths(books).size).toBe(0);
  });
});
