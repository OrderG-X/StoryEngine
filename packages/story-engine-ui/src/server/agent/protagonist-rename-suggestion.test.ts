// @vitest-environment node
//
// 定稿后的「设为主角」建议（重构 P9）：设定本里还没标主角时，按账里的视角人物取视角章最多的那个；
// 有卡就建议标主角，没卡就建议建卡并标主角。只是建议：作者点了才发 intent 给模型，这里绝不写盘。
// 不数出场次数（视角是林小满、宋伯名字出现再多也是建议林小满）；一章视角声明都没有就不建议。
// 真书 + 真账单（核心定稿命令），executeTool 用假的，不调模型。
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/di";
import { cardWrite, chapterCommit, runCommand, type CardOp, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";
import { runUserAction, type UserActionToolExecutor } from "./user-actions.js";

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("rename-suggestion-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "白沙渡", genre: "乡土" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function authorWrite(ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(book, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

/** 定稿一章：names 是出场的人（每人一句正文），viewpoint 是这章跟着谁的眼睛走。 */
async function commit(chapter: number, names: readonly string[], viewpoint?: string): Promise<void> {
  const lines = names.map((name) => `${name}走到渡口边上站了一会儿。`);
  const entries: EntryInput[] = names.map((name, index) => ({
    kind: "presence",
    review: "auto",
    name,
    nameUsed: name,
    quote: lines[index]!,
    ...(name === viewpoint ? { viewpoint: true } : {}),
  }));
  const outcome = await runCommand(book, chapterCommit, { chapter, text: `# 第${chapter}章\n\n${lines.join("")}`, entries }, { caller: "author", idempotencyKey: `c${chapter}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("buildProtagonistRenameSuggestion（设定本没标主角时按视角人物建议）", () => {
  it("视角人物是林小满、宋伯出场更多 → 建议林小满（还没卡：建卡并标主角），不数出场", async () => {
    await commit(1, ["林小满", "宋伯"], "林小满");
    await commit(2, ["宋伯", "宋伯他弟"]);
    await commit(3, ["宋伯", "林小满"], "林小满");

    const suggestion = await buildProtagonistRenameSuggestion(book);

    expect(suggestion).toBeDefined();
    expect(suggestion!.label).toBe("把『林小满』设为主角");
    expect(suggestion!.intent).toContain("给「林小满」建一张人物卡并标成主角");
    expect(suggestion!.intent).toContain("已定稿的 2 章都是跟着林小满的眼睛走的");
    expect(suggestion!.intent).not.toContain("出场最多");
    expect(`${suggestion!.label}${suggestion!.intent}`).not.toMatch(/k-\d/u);
  });

  it("已经有这张人物卡、只是没标主角 → 建议标主角，别的不动", async () => {
    await authorWrite([{ op: "card.create", kind: "character", name: "陆沉" }]);
    await commit(1, ["陆沉", "阿禾"], "陆沉");
    await commit(2, ["陆沉", "阿禾"], "陆沉");

    const suggestion = await buildProtagonistRenameSuggestion(book);

    expect(suggestion!.label).toBe("把『陆沉』设为主角");
    expect(suggestion!.intent).toContain("把人物卡「陆沉」标成主角");
    expect(suggestion!.intent).toContain("已定稿的 2 章");
    expect(suggestion!.intent).toContain("只标主角，别的不动");
  });

  it("设定本里已经标了主角 → 不建议", async () => {
    await authorWrite([{ op: "card.create", kind: "character", name: "林小满", protagonist: true }]);
    await commit(1, ["宋伯"], "宋伯");

    await expect(buildProtagonistRenameSuggestion(book)).resolves.toBeUndefined();
  });

  it("一章视角声明都没有 → 不建议（没有依据不猜名字，不退回数出场次数）", async () => {
    await commit(1, ["林小满", "宋伯"]);
    await commit(2, ["宋伯"]);
    await commit(3, ["宋伯"]);

    await expect(buildProtagonistRenameSuggestion(book)).resolves.toBeUndefined();
  });

  it("还没有定稿章 → 不建议", async () => {
    await expect(buildProtagonistRenameSuggestion(book)).resolves.toBeUndefined();
  });

  it("只是建议：一个字节都不写", async () => {
    await commit(1, ["林小满"], "林小满");
    const before = await readFile(join(book, "ledger", "cards.json"), "utf-8");
    await buildProtagonistRenameSuggestion(book);
    expect(await readFile(join(book, "ledger", "cards.json"), "utf-8")).toBe(before);
  });
});

describe("runUserAction 定稿收尾追加「设为主角」建议（只加不改原选项）", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  function collect() {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    return { events, sendEvent: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }) };
  }

  const committed: UserActionToolExecutor = async () => ({ ok: true, committed: true, chapter: 1, summary: "第 1 章已定稿。" });

  it("定稿成功 + 没标主角 + 有视角人物 → 原选项照旧、末尾多一个「把『陆沉』设为主角」", async () => {
    await commit(1, ["陆沉"], "陆沉");
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 1 },
      requestContext: new RequestContext(),
      executeTool: committed,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
      projectDir: book,
    });

    const next = events.at(-1)!.data.output as { choices: { label: string; intent: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["AI 写第 2 章", "把『陆沉』设为主角"]);
    expect(next.choices[1]!.intent).toContain("陆沉");
  });

  it("没给 projectDir（其他调用方）→ 行为与原来完全一致，不多选项", async () => {
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 1 },
      requestContext: new RequestContext(),
      executeTool: committed,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
    });

    const next = events.at(-1)!.data.output as { choices: { label: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["AI 写第 2 章"]);
  });

  it("定稿没成（committed:false）→ 不给建议（没定稿就没有新依据）", async () => {
    await commit(1, ["陆沉"], "陆沉");
    const executeTool: UserActionToolExecutor = async () => ({ ok: false, committed: false, summary: "还没预览，不能定稿。" });
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 1 },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
      projectDir: book,
    });

    const next = events.at(-1)!.data.output as { choices: { label: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["重新预览"]);
  });
});
