// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { collectExportBook, exportBook, safeFileName, splitParagraphs } from "./book-export.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("story-engine-export-");
  dirs.push(dir);
  await writeFile(join(dir, "project.json"), JSON.stringify({ id: "story-export", title: "雾港/来信", info: { author: "林某", synopsis: "一封信。" } }), "utf-8");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), "# 第1章 · 死信\n\n　　第一段。\n\n  第二段。\n", "utf-8");
  await writeFile(join(dir, "chapters", "0002.md"), "# 第2章\n\n只有一段。\n", "utf-8");
  await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), "# 第2章 · 改过\n\n改过的一段。\n", "utf-8");
  await writeFile(join(dir, "drafts", "fast", "chapter-0003.md"), "# 第3章 · 还没定\n\n工作稿。\n", "utf-8");
  return dir;
}

describe("导出（P10）", () => {
  it("段落按行切、去掉行首全角空格和空行", () => {
    expect(splitParagraphs("　　甲。\r\n\r\n  乙。\n\n\n丙。  ")).toEqual(["甲。", "乙。", "丙。"]);
  });

  it("默认只收定稿章；章名去掉「第 N 章」前缀；书名、作者、简介从书的资料来", async () => {
    const book = await collectExportBook(await makeBook(), {});
    expect(book).toMatchObject({ title: "雾港/来信", author: "林某", synopsis: "一封信。" });
    expect(book.chapters).toEqual([
      { number: 1, title: "死信", paragraphs: ["第一段。", "第二段。"] },
      { number: 2, paragraphs: ["只有一段。"] },
    ]);
  });

  it("带上工作稿：没定稿的章收进来，两份都有时用工作稿；范围照圈", async () => {
    const dir = await makeBook();
    const book = await collectExportBook(dir, { includeDrafts: true });
    expect(book.chapters.map((c) => [c.number, c.title, c.paragraphs[0]])).toEqual([
      [1, "死信", "第一段。"],
      [2, "改过", "改过的一段。"],
      [3, "还没定", "工作稿。"],
    ]);
    const ranged = await collectExportBook(dir, { includeDrafts: true, from: 2, to: 2 });
    expect(ranged.chapters.map((c) => c.number)).toEqual([2]);
  });

  it("文件名去掉不许的字符、圈了范围带章号；范围里没有章就如实报", async () => {
    const dir = await makeBook();
    expect(safeFileName("a/b:c")).toBe("a_b_c");
    const all = await exportBook(dir, { format: "txt" });
    expect(all).toMatchObject({ filename: "雾港_来信.txt", chapters: 2 });
    expect(all.data.toString("utf-8")).toContain("第1章 死信");
    const ranged = await exportBook(dir, { format: "epub", from: 1, to: 2 });
    expect(ranged.filename).toBe("雾港_来信-第1-2章.epub");
    await expect(exportBook(dir, { format: "txt", from: 3 })).rejects.toThrow("没有定稿的章");
  });

});
