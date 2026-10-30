// @vitest-environment node
//
// 写前备忘路由：GET /api/pre-write-memo 读新核心投影，算到要写那章的前一章。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit, runCommand, type PreWriteMemo } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { registerPreWriteMemoRoutes } from "./pre-write-memo.js";
import { callRoute } from "./test-helpers.js";

let rootDir: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("pre-write-memo-");
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const getMemo = (projectDir: string, chapter: string) =>
  callRoute(registerPreWriteMemoRoutes, "GET", `/api/pre-write-memo?project=${encodeURIComponent(projectDir)}&chapter=${chapter}`);

async function bookWithTwoChapters(): Promise<string> {
  const { projectDir } = await createStoryProject({ rootDir, title: "写前备忘", genre: "悬疑", logline: "雾港的信。", protagonistName: "许微" });
  const one = await runCommand(projectDir, chapterCommit, {
    chapter: 1,
    text: "# 第1章\n\n许微在邮政局拆开那封信。信上只写了一个仓号。",
    entries: [
      { kind: "time", review: "auto", start: { offset: { unit: "day", min: 0, max: 0 }, basis: "text", quote: "许微在邮政局拆开那封信" }, sameDay: true },
      { kind: "presence", review: "auto", name: "许微", nameUsed: "许微", viewpoint: true, quote: "许微在邮政局拆开那封信" },
      { kind: "thread", review: "auto", op: "open", type: "question", title: "信是谁寄的", note: "来了一封怪信", quote: "许微在邮政局拆开那封信" },
      { kind: "fact", review: "auto", nature: "state", subject: "怪信", attribute: "在哪", value: "许微手里", text: "信在许微手里", quote: "许微在邮政局拆开那封信" },
    ],
  }, { caller: "author", idempotencyKey: "c1" });
  expect(one.ok).toBe(true);
  const two = await runCommand(projectDir, chapterCommit, {
    chapter: 2,
    text: "# 第2章\n\n第二天傍晚，孟叔把钥匙交给许微。她把信锁进了抽屉。",
    entries: [
      { kind: "time", review: "auto", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "第二天傍晚，孟叔把钥匙交给许微" }, sameDay: true, timeOfDay: "傍晚" },
      { kind: "summary", review: "auto", text: "孟叔交出钥匙，许微锁好信。", quote: "孟叔把钥匙交给许微" },
      { kind: "presence", review: "auto", name: "许微", nameUsed: "许微", viewpoint: true, quote: "孟叔把钥匙交给许微" },
      { kind: "presence", review: "auto", name: "孟叔", nameUsed: "孟叔", quote: "孟叔把钥匙交给许微" },
      { kind: "fact", review: "auto", nature: "state", subject: "怪信", attribute: "在哪", value: "抽屉里", text: "信锁进了抽屉", quote: "她把信锁进了抽屉" },
    ],
  }, { caller: "author", idempotencyKey: "c2" });
  expect(two.ok).toBe(true);
  return projectDir;
}

describe("GET /api/pre-write-memo", () => {
  it("写第 3 章：上一章停在第 2 天傍晚、谁在场、梗概；线索和最近变了的状态", async () => {
    const projectDir = await bookWithTwoChapters();
    const response = await getMemo(projectDir, "3");
    expect(response.statusCode).toBe(200);
    expect(response.payload.ok).toBe(true);
    const memo = response.payload.memo as PreWriteMemo & { readonly days?: string };
    expect(memo.previous).toMatchObject({
      chapter: 2,
      summary: "孟叔交出钥匙，许微锁好信。",
      present: ["许微", "孟叔"],
      viewpoint: "许微",
      time: { presentLine: true, start: { lo: 2, hi: 2 }, end: { lo: 2, hi: 2 }, timeOfDay: "傍晚" },
    });
    expect(memo.days).toBe("第 2 天傍晚");
    // 「信是谁寄的」第 1 章埋、才停 1 章：不列，只计数。
    expect(memo.threads).toEqual([]);
    expect(memo.moreThreads).toBe(1);
    expect(memo.changes).toEqual([{ subject: "怪信", attribute: "在哪", value: "抽屉里", chapter: 2, quote: "她把信锁进了抽屉" }]);
  });

  it("回头改第 2 章：只看第 1 章，第 2 章的账不露进来", async () => {
    const projectDir = await bookWithTwoChapters();
    const memo = (await getMemo(projectDir, "2")).payload.memo as PreWriteMemo;
    expect(memo.previous?.chapter).toBe(1);
    expect(memo.threads.map((thread) => [thread.title, thread.reason, thread.previousOp])).toEqual([["信是谁寄的", "previous", "open"]]);
    expect(memo.changes.map((change) => change.value)).toEqual(["许微手里"]);
  });

  it("写第 1 章：前面没有定稿的章，备忘是空的", async () => {
    const projectDir = await bookWithTwoChapters();
    const memo = (await getMemo(projectDir, "1")).payload.memo as PreWriteMemo;
    expect(memo).toEqual({ chapter: 1, threads: [], moreThreads: 0, changes: [] });
  });

  it("章号不是正整数：如实说没说清，不瞎算", async () => {
    const projectDir = await bookWithTwoChapters();
    for (const chapter of ["", "0", "-1", "2.5", "abc"]) {
      const response = await getMemo(projectDir, chapter);
      expect(response.statusCode).toBe(400);
      expect(response.payload.ok).toBe(false);
    }
  });
});
