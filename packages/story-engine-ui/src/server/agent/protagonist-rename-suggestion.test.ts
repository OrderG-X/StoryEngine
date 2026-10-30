// @vitest-environment node
//
// 定稿后的「设为主角」建议（重构 P9）：设定本里还没标主角时，按账里的视角人物取视角章最多的那个；
// 有卡就建议标主角，没卡就建议建卡并标主角。只是建议：作者点了才发 intent 给模型，这里绝不写盘。
// 不数出场次数（视角是林小满、宋伯名字出现再多也是建议林小满）；一章视角声明都没有就不建议。
// 真书 + 真账单（核心定稿命令）；定稿收尾那组用假的定稿配方（不调模型），走真执行器和真收尾。
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, chapterCommit, runCommand, type CardOp, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../lib/operations/context.js";
import { __resetLiveForTests } from "../lib/operations/live.js";
import { __resetOperationStoreForTests } from "../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe } from "../services/operations/executor.js";
import { COMMIT_PREPARE_KIND, type CommitPrepareBody } from "../services/operations/recipes/commit-prepare.js";
import { commitAction } from "./next-steps.js";
import { runOperationAction } from "./operation-turn.js";
import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";

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

describe("定稿收尾追加「设为主角」建议（只加不改原选项）", () => {
  beforeEach(() => {
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    __resetLiveForTests();
    __resetRecipesForTests();
    vi.stubEnv("SE_DATA_DIR", join(rootDir, "data"));
  });
  afterEach(async () => {
    await __drainOperationsForTests();
    __resetRecipesForTests();
    vi.unstubAllEnvs();
  });

  /** 假的定稿配方：照给的结果收（不记账、不写盘）。 */
  function fakeCommit(body: Pick<CommitPrepareBody, "committed">): void {
    registerRecipe<{ readonly chapter: number }>({
      kind: COMMIT_PREPARE_KIND,
      version: 1,
      lane: "foreground",
      async prepare(_bookDir, input) {
        return { ok: true, params: input.params as { readonly chapter: number }, writeScope: { chapters: [] }, budget: 1 };
      },
      async run(ctx) {
        const chapter = ctx.params.chapter;
        return { schema: "operation-result/1", summary: body.committed ? `第 ${chapter} 章已定稿。` : `第 ${chapter} 章现在还定不了。`, body: { kind: COMMIT_PREPARE_KIND, chapter, ...body } };
      },
      stepBudget: () => 0,
      modelTasks: () => [],
    });
  }

  async function finish(): Promise<{ readonly text: string; readonly choices: readonly { readonly label: string; readonly intent: string }[] }> {
    const events: { readonly event: string; readonly data: Record<string, unknown> }[] = [];
    await runOperationAction({
      action: commitAction(1),
      projectDir: book,
      sendEvent: (event, data) => { events.push({ event, data: data as Record<string, unknown> }); },
      scrubber: { push: (text: string) => text, flush: () => "" },
      signal: new AbortController().signal,
    });
    const next = events.filter((item) => item.event === "tool-result" && item.data.toolName === "suggest_next_steps").at(-1)?.data.output as { choices: { label: string; intent: string }[] } | undefined;
    return { text: events.filter((item) => item.event === "text-delta").map((item) => item.data.text).join(""), choices: next?.choices ?? [] };
  }

  it("定稿成功 + 没标主角 + 有视角人物 → 原选项照旧、末尾多一个「把『陆沉』设为主角」", async () => {
    await commit(1, ["陆沉"], "陆沉");
    fakeCommit({ committed: true });
    const { choices } = await finish();
    expect(choices.map((choice) => choice.label)).toEqual(["AI 写第 2 章", "把『陆沉』设为主角"]);
    expect(choices[1]!.intent).toContain("陆沉");
  });

  it("定稿没成（定不了）→ 不给建议（没定稿就没有新依据）", async () => {
    await commit(1, ["陆沉"], "陆沉");
    fakeCommit({ committed: false });
    const { text, choices } = await finish();
    expect(text).toBe("第 1 章现在还定不了，原因在清单里。");
    expect(choices).toEqual([]);
  });
});
