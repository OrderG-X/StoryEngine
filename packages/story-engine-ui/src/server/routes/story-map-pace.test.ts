// @vitest-environment node
//
// 节奏诊断取数（services/pace-report）：字数按定稿正文数（只数汉字、去标题），故事地图带上这份。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit, projectBook, runCommand, type LedgerEntry } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { registerStoryMapRoutes } from "./story-map.js";
import { callRoute } from "./test-helpers.js";
import { readPaceReport } from "../services/pace-report.js";

let rootDir: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("pace-report-");
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

type Entry = Omit<LedgerEntry, "id"> & Record<string, unknown>;

async function newBook(): Promise<string> {
  const { projectDir } = await createStoryProject({ rootDir, title: "节奏", genre: "悬疑", logline: "雾港的信。", protagonistName: "许微" });
  return projectDir;
}

async function commit(projectDir: string, chapter: number, text: string, entries: readonly Entry[]): Promise<void> {
  const result = await runCommand(projectDir, chapterCommit, { chapter, text: `# 第${chapter}章\n\n${text}`, entries }, { caller: "author", idempotencyKey: `c${chapter}` });
  expect(result.ok).toBe(true);
}

describe("节奏诊断取数", () => {
  it("每章字数按定稿正文的汉字数（标题不算），推进几条从账里来", async () => {
    const projectDir = await newBook();
    await commit(projectDir, 1, "许微拆开那封信。", [{ kind: "thread", review: "auto", op: "open", type: "question", title: "信是谁寄的", note: "来信", quote: "许微拆开那封信" }]);
    const thread = (await projectBook(projectDir)).threads[0]!.id;
    await commit(projectDir, 2, "孟叔说，信是从三号仓寄出的。", [{ kind: "thread", review: "auto", op: "advance", thread, note: "查到三号仓", quote: "信是从三号仓寄出的" }]);
    const report = await readPaceReport(projectDir, await projectBook(projectDir));
    expect(report.chapters.map((row) => [row.chapter, row.words, row.opened, row.advanced])).toEqual([[1, 7, 1, 0], [2, 12, 0, 1]]);
    // 两章、字也少：不下结论。
    expect(report.typical).toBeUndefined();
    expect(report.flags).toEqual([]);
  });

  it("故事地图带上节奏", async () => {
    const projectDir = await newBook();
    await commit(projectDir, 1, "许微拆开那封信。", []);
    const response = await callRoute(registerStoryMapRoutes, "GET", `/api/story-map?project=${encodeURIComponent(projectDir)}`);
    expect(response.statusCode).toBe(200);
    expect(response.payload.ok).toBe(true);
    const map = response.payload.map as { pace?: { chapters: { chapter: number; words: number }[]; flags: unknown[] } };
    expect(map.pace?.chapters).toMatchObject([{ chapter: 1, words: 7 }]);
    expect(map.pace?.flags).toEqual([]);
  });
});
