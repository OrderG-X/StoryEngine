// @vitest-environment node
// 改完账就开写（第 7 轮复核 U3a 起）：写手的材料从真相现算（P2b 删了镜像），读到的就是新账，没有「还没同步」的空当。
// 真改账操作（ledger.change，作者直接改）+ 真写稿操作（draft.change）+ 真核心写盘，只替换模型。
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chapterCommit, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { normalizeChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { __resetOperationStoreForTests } from "../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, submitOperation } from "../services/operations/executor.js";
import { LEDGER_CHANGE_KIND, ledgerChangeRecipe } from "../services/operations/recipes/ledger-change.js";
import { fakeDraftDeps, settledDraftChange, submitDraftChange } from "../services/operations/recipes/draft-change-kit.js";

let root: string | undefined;
beforeEach(() => {
  __resetOperationStoreForTests();
  __resetRecipesForTests();
});
afterEach(async () => {
  await __drainOperationsForTests();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeBook(): Promise<string> {
  root = await mkdtemp(join(process.env.STORY_ENGINE_TEST_RUN_ROOT!, "ledger-then-draft-"));
  vi.stubEnv("SE_BOOKS_DIR", join(root, "books"));
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  return (await createStoryProject({ rootDir: join(root, "books"), title: "改账开写", genre: "都市", protagonistName: "林远" })).projectDir;
}

async function commitKey(book: string, text: string, key: string): Promise<void> {
  const entries = [{ kind: "fact" as const, review: "author" as const, nature: "hard" as const, subject: "保险柜", attribute: "口令", value: key, text, quote: text }];
  const result = await runCommand(book, chapterCommit, { chapter: 1, text: `# 第一章\n\n${text}`, entries }, { caller: "author", idempotencyKey: key });
  expect(result).toMatchObject({ ok: true, result: { rejected: [] } });
}

const packOf = (context: { readonly sections: readonly { readonly name: string; readonly content?: unknown }[] }): string =>
  JSON.stringify(context.sections.find((section) => section.name === "writing_context_pack")?.content);
const prose = (line: string): string => Array(6).fill(`${line}林远沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。巷子尽头有人推开门，朝他招了招手，示意他先进去等一会儿。`).join("\n\n");

it("改完账就开写：写手读到的是新账（第 7 轮 U3a）", async () => {
  const book = await makeBook();
  await commitKey(book, "保险柜的口令是红松。", "红松");
  await writeChapterPlan(book, normalizeChapterPlan({ summary: "打开保险柜", beats: ["林远打开保险柜"] }, { chapter: 2, source: "author" })!);
  registerRecipe(ledgerChangeRecipe);
  const changed = await submitOperation(book, {
    kind: LEDGER_CHANGE_KIND,
    mode: "author",
    params: { changes: [{ op: "update", targetText: "红松", text: "保险柜的口令是白鹤。", value: "白鹤" }] },
    requestKey: "round7-author-change",
    issuedAt: new Date().toISOString(),
    origin: { kind: "button" },
  });
  if (!changed.ok || !("record" in changed)) throw new Error(`改账没受理：${JSON.stringify(changed)}`);
  await __drainOperationsForTests();
  let consumed = "";
  const submitted = await submitDraftChange(book, "write", { chapter: 2 }, fakeDraftDeps({
    plannerCallModel: async () => { throw new Error("应沿用作者章纲"); },
    writerClient: {
      async generateDraft({ context }) {
        consumed = packOf(context);
        return { title: "开柜", content: prose("林远输入白鹤，打开了保险柜。") };
      },
    },
  }));
  if (!submitted.ok || !("record" in submitted)) throw new Error(`没受理：${JSON.stringify(submitted)}`);
  const done = await settledDraftChange(book, submitted.record.opId);
  expect(consumed).toContain("白鹤");
  expect(consumed).not.toContain("红松");
  expect(done.result).toMatchObject({ body: { ok: true } });
});
