// @vitest-environment node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardWrite, chapterCommit, runCommand, type CardOp, type EntryInput } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { buildStateOverview } from "../book/state-overview.js";
import { withUiOverviewDetails } from "./ui-overview.js";

async function writeCards(projectDir: string, ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
  expect(outcome.ok).toBe(true);
}

/** 定一章：正文里写一句「X走进来。」，presence 按给的名字记，viewpoint 指谁的视角。 */
async function commitChapter(projectDir: string, chapter: number, people: readonly string[], viewpoint?: string): Promise<void> {
  const text = `# 第${chapter}章\n\n${people.map((name) => `${name}走进来。`).join("")}`;
  const entries: EntryInput[] = people.map((name) => ({
    kind: "presence",
    review: "auto",
    name,
    nameUsed: name,
    ...(name === viewpoint ? { viewpoint: true } : {}),
    quote: `${name}走进来`,
  }));
  const outcome = await runCommand(projectDir, chapterCommit, { chapter, text, entries }, { caller: "author", idempotencyKey: `c-${chapter}-${Math.random()}` });
  expect(outcome.ok).toBe(true);
}

async function details(projectDir: string) {
  return withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir }));
}

describe("withUiOverviewDetails · 主角建议（重构 P9）", () => {
  it("设定本里没标主角：按视角章最多的人建议（有卡的标 carded）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ui-overview-suggest-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "没标主角" });
    await writeCards(projectDir, [{ op: "card.create", kind: "character", name: "林远" }]);
    await commitChapter(projectDir, 1, ["苏晴", "林远"], "苏晴");
    await commitChapter(projectDir, 2, ["林远"], "林远");
    await commitChapter(projectDir, 3, ["林远", "苏晴"], "林远");

    const overview = await details(projectDir);

    expect(overview.protagonistSuggestion).toEqual({ name: "林远", viewpointChapters: 2, carded: true });
  });

  it("视角章最多的人还没建卡：照样建议，标 carded=false（采纳时建一张标了主角的卡）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ui-overview-suggest-uncarded-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "没卡的视角人物" });
    await writeCards(projectDir, [{ op: "card.create", kind: "character", name: "林远" }]);
    await commitChapter(projectDir, 1, ["苏晴", "林远"], "苏晴");
    await commitChapter(projectDir, 2, ["苏晴"], "苏晴");
    await commitChapter(projectDir, 3, ["林远"], "林远");

    const overview = await details(projectDir);

    expect(overview.protagonistSuggestion).toEqual({ name: "苏晴", viewpointChapters: 2, carded: false });
  });

  it("已经标了主角：没有建议（哪怕别人视角章更多）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ui-overview-has-protagonist-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "标了主角", protagonistName: "林远" });
    await commitChapter(projectDir, 1, ["苏晴"], "苏晴");
    await commitChapter(projectDir, 2, ["苏晴"], "苏晴");

    const overview = await details(projectDir);

    expect(overview.characters.protagonist).toBe("林远");
    expect(overview).not.toHaveProperty("protagonistSuggestion");
  });

  it("一章都没有视角声明：没有候选，不退回按出场数猜", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ui-overview-no-viewpoint-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "没有视角" });
    await commitChapter(projectDir, 1, ["苏晴", "林远"]);
    await commitChapter(projectDir, 2, ["苏晴"]);

    const overview = await details(projectDir);

    expect(overview.characters.knownCharacters.map((item) => item.name)).toEqual(["苏晴", "林远"]);
    expect(overview).not.toHaveProperty("protagonistSuggestion");
  });
});
