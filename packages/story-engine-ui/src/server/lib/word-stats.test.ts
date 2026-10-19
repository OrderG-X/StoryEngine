// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeHomeTempDir } from "./home-test-tmp.js";
import { chapterWordsNow, localDate, readWordStats, recordChapterWords, resyncWordStats, WORD_STATS_PATH } from "./word-stats.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("story-engine-words-");
  dirs.push(dir);
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "雾港来信" }), "utf-8");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), "# 第1章 · 死信\n\n一二三四五，六七八九十。\n", "utf-8");
  return dir;
}

const draft = (dir: string, chapter: number, body: string) =>
  writeFile(join(dir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${body}\n`, "utf-8");

const DAY1 = new Date(2026, 9, 18, 10);
const DAY2 = new Date(2026, 9, 19, 10);
const DAY3 = new Date(2026, 9, 20, 10);

describe("写作统计（P10）", () => {
  it("一章字数：工作稿优先、只数汉字、章名不算", async () => {
    const dir = await makeBook();
    expect(await chapterWordsNow(dir, 1)).toBe(10);
    await draft(dir, 1, "改成三个字");
    expect(await chapterWordsNow(dir, 1)).toBe(5);
    expect(await chapterWordsNow(dir, 9)).toBe(0);
  });

  it("第一次记：全书当底不算进今天；之后按来源记差值，净增 = 结束 − 开始", async () => {
    const dir = await makeBook();
    const before = await chapterWordsNow(dir, 2);
    await draft(dir, 2, "作者写了八个汉字。");
    await recordChapterWords(dir, 2, "author", before, DAY3);
    let stats = await readWordStats(dir, DAY3);
    expect(stats.totalWords).toBe(18);
    expect(stats.today).toEqual({ net: 8, author: 8, ai: 0 });

    const aiBefore = await chapterWordsNow(dir, 2);
    await draft(dir, 2, "作者写了八个汉字。AI又补了六个字");
    await recordChapterWords(dir, 2, "ai", aiBefore, DAY3);
    stats = await readWordStats(dir, DAY3);
    expect(stats.today).toEqual({ net: 14, author: 8, ai: 6 });
    expect(stats.totalWords).toBe(24);
  });

  it("连续天数：今天没写从昨天往前数；30 天柱子旧在前", async () => {
    const dir = await makeBook();
    await draft(dir, 2, "一二");
    await recordChapterWords(dir, 2, "author", 0, DAY1);
    await draft(dir, 2, "一二三四");
    await recordChapterWords(dir, 2, "author", undefined, DAY2);
    let stats = await readWordStats(dir, DAY3);
    expect(stats.streak).toBe(2);
    expect(stats.today.net).toBe(0);
    expect(stats.recent).toHaveLength(30);
    expect(stats.recent.at(-1)).toEqual({ date: localDate(DAY3), net: 0 });
    expect(stats.recent.at(-2)).toEqual({ date: localDate(DAY2), net: 2 });

    await draft(dir, 2, "一二三四五");
    await recordChapterWords(dir, 2, "author", undefined, DAY3);
    stats = await readWordStats(dir, DAY3);
    expect(stats.streak).toBe(3);
  });

  it("恢复存档后重数：差值记成其他；还没开始记就不动；读的时候不写盘", async () => {
    const dir = await makeBook();
    await resyncWordStats(dir, DAY3);
    await expect(readFile(join(dir, WORD_STATS_PATH), "utf-8")).rejects.toThrow();
    expect((await readWordStats(dir, DAY3)).totalWords).toBe(10);
    await expect(readFile(join(dir, WORD_STATS_PATH), "utf-8")).rejects.toThrow();

    await draft(dir, 2, "一二三四五六");
    await recordChapterWords(dir, 2, "author", 0, DAY3);
    await rm(join(dir, "drafts", "fast", "chapter-0002.md"));
    await resyncWordStats(dir, DAY3);
    const stats = await readWordStats(dir, DAY3);
    expect(stats.totalWords).toBe(10);
    expect(stats.today).toEqual({ net: 0, author: 6, ai: 0 });
  });

  it("记不上不抛（书目录没了）", async () => {
    await expect(recordChapterWords("/nonexistent/book", 1, "author")).resolves.toBeUndefined();
  });
});
