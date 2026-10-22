// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { findInBody, searchBookText } from "./book-search.js";

describe("findInBody：按字面找，给第一处上下文", () => {
  it("数几次、上下文不跨段、截断处带省略号", () => {
    const body = "第一段没有。\n\n他从怀里摸出三枚铜钱，排在桌上，一枚一枚推过去，像在下一盘没人看得懂的棋。\n\n后来铜钱不见了。";
    const hit = findInBody(body, "铜钱");
    expect(hit?.count).toBe(2);
    expect(hit?.quote).toBe("他从怀里摸出三枚铜钱，排在桌上，一枚一枚推过去，像在下一盘没人看得懂");
    expect(hit?.snippet).toBe(`${hit?.quote}…`);
    expect(hit?.quote.includes("\n")).toBe(false);
  });

  it("前面截断也带省略号；英文不分大小写；找不到、空查询返回 undefined", () => {
    const body = "很长很长很长很长很长很长很长很长的前文，然后 Tom 来了。";
    expect(findInBody(body, "tom")?.snippet.startsWith("…")).toBe(true);
    expect(findInBody(body, "铜钱")).toBeUndefined();
    expect(findInBody(body, "  ")).toBeUndefined();
  });
});

describe("searchBookText：每章搜稿纸上那份", () => {
  it("有工作稿搜工作稿，没有搜定稿；按章号排；只给前 limit 章但如实报总数", async () => {
    const dir = await makeHomeTempDir("book-search-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "drafts", "fast"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), "# 渡口\n\n铜钱落在船板上。\n", "utf-8");
    await writeFile(join(dir, "chapters", "0002.md"), "# 旧信\n\n定稿里有铜钱。\n", "utf-8");
    // 第 2 章定稿后又改过：稿纸上是工作稿，工作稿里已经没有铜钱了
    await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), "# 旧信\n\n改过了，什么都没有。\n", "utf-8");
    await writeFile(join(dir, "drafts", "fast", "chapter-0003.md"), "# 夜渡\n\n铜钱、铜钱。\n", "utf-8");

    const all = await searchBookText(dir, "铜钱");
    expect(all.hits.map((hit) => [hit.chapter, hit.title, hit.count])).toEqual([[1, "渡口", 1], [3, "夜渡", 2]]);
    expect(all).toMatchObject({ chapters: 2, occurrences: 3 });

    const first = await searchBookText(dir, "铜钱", 1);
    expect(first.hits.map((hit) => hit.chapter)).toEqual([1]);
    expect(first).toMatchObject({ chapters: 2, occurrences: 3 });

    expect(await searchBookText(dir, " ")).toEqual({ hits: [], chapters: 0, occurrences: 0 });
  });
});
