// @vitest-environment node
// change_draft（写作版本 P2a 3.1、第七节）：对话里只交写稿意图、回受理回执。章号缺了用作者所在章、刚定稿的前沿推到下一章（接着写不推）；
// 方向、要点逐句核作者原话，核不上不交；作者在稿纸上挑过的走法并进方向；有稿的章没受理时带「接着往下写」「重写」两个按钮。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { chapterCommit, draftSave, readDraftState, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, readOperation } from "../../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe } from "../../services/operations/executor.js";
import { createDraftChangeRecipe, DRAFT_CHANGE_KIND } from "../../services/operations/recipes/draft-change.js";
import { fakeDraftDeps } from "../../services/operations/recipes/draft-change-kit.js";
import { buildProjectRequestContext, type PickedDirection } from "../request-context.js";
import { changeDraftTool, type ChangeDraftReceipt } from "./change-draft.js";

let root: string;
let book: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("change-draft-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "交写稿", genre: "都市", protagonistName: "林远" }));
  registerRecipe(createDraftChangeRecipe(fakeDraftDeps()));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

let seq = 0;
function context(options: { readonly chapter?: number; readonly words?: readonly string[]; readonly picked?: PickedDirection; readonly ref?: boolean } = {}): ToolExecutionContext {
  seq += 1;
  const requestContext = buildProjectRequestContext(
    book,
    options.chapter ?? 1,
    options.words ?? ["写这一章"],
    undefined,
    options.picked,
    options.ref === false ? undefined : { messageId: `msg-${seq}`, issuedAt: new Date().toISOString() },
  );
  return { requestContext } as unknown as ToolExecutionContext;
}

const changeDraft = (input: Record<string, unknown>, ctx: ToolExecutionContext) =>
  (changeDraftTool as unknown as { execute: (input: unknown, context: ToolExecutionContext) => Promise<ChangeDraftReceipt> }).execute(input, ctx);

async function paramsOf(opId: string): Promise<unknown> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record.params;
}

async function save(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraftState(book, chapter)).version;
  expect(await runCommand(book, draftSave, { chapter, body, baseVersion, title: "" }, { caller: "author" })).toMatchObject({ ok: true });
}

async function commit(chapter: number): Promise<void> {
  expect(await runCommand(book, chapterCommit, { chapter, text: `# 第${chapter}章\n\n林远出了门。`, entries: [] }, { caller: "author", idempotencyKey: `c${chapter}` })).toMatchObject({ ok: true });
}

describe("change_draft：只交、只回受理回执", () => {
  it("受理：回操作号；方向是作者原话就原样交，要点里方向没有的接在后面", async () => {
    const receipt = await changeDraft(
      { chapterGoal: "林远去河岸等人", mustHitBeats: ["林远去河岸等人", "带上账册"] },
      context({ words: ["写这一章，林远去河岸等人，要带上账册"] }),
    );
    expect(receipt).toMatchObject({ ok: true, accepted: true, kind: DRAFT_CHANGE_KIND, mode: "write", chapter: 1 });
    expect(await paramsOf(receipt.opId!)).toMatchObject({ chapter: 1, direction: "林远去河岸等人\n带上账册", mustHitBeats: ["林远去河岸等人", "带上账册"] });
  });

  it("方向不是作者原话：不交（还没花额度），说清哪句", async () => {
    const receipt = await changeDraft({ chapterGoal: "林远和老周大吵一架" }, context({ words: ["写这一章"] }));
    expect(receipt).toMatchObject({ ok: false, code: "chapter_goal_not_author_words", chapter: 1 });
    expect(receipt.summary).toContain("「林远和老周大吵一架」");
    expect(await listOperations(book)).toEqual([]);
  });

  it("作者在稿纸上挑过走法：并进方向，作者另外说的接在后面", async () => {
    const receipt = await changeDraft(
      { chapterGoal: "让老周开口" },
      context({ words: ["让老周开口"], picked: { chapter: 1, text: "甲：夜里上楼" } }),
    );
    expect(await paramsOf(receipt.opId!)).toMatchObject({ direction: "甲：夜里上楼\n作者另外说：让老周开口" });
  });

  it("有稿的章没点重写：不受理，带「接着往下写」「重写第 N 章」两个按钮", async () => {
    await save(1, "作者写的半章。");
    const receipt = await changeDraft({}, context());
    expect(receipt).toMatchObject({ ok: false, code: "chapter_has_text", chapter: 1 });
    expect(receipt.rewriteChoices?.map((choice) => choice.label)).toEqual(["接着往下写", "重写第 1 章"]);
    expect(receipt.rewriteChoices?.[1]?.action).toMatchObject({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 1, rewrite: true } });
  });

  it("前一章没定稿：不受理，带上该先定稿的那章", async () => {
    const receipt = await changeDraft({ chapter: 2 }, context());
    expect(receipt).toMatchObject({ ok: false, code: "previous_chapter_not_committed", chapter: 2, pendingChapterToCommit: 1 });
  });

  it("没给章号、所在章刚定稿：推到下一章；接着写不推（接的就是眼前这章）", async () => {
    await commit(1);
    expect(await changeDraft({}, context({ chapter: 1 }))).toMatchObject({ ok: true, chapter: 2 });
    expect(await changeDraft({ mode: "continue" }, context({ chapter: 1 }))).toMatchObject({ ok: false, code: "chapter_committed", chapter: 1 });
  });

  it("模型多传的退化参数（空串、\"False\"、0）在边界里归一", async () => {
    const receipt = await changeDraft({ chapter: "", chapterGoal: "", thenPreview: "False", candidates: "", requestedDraftLength: 0 }, context());
    expect(receipt).toMatchObject({ ok: true, chapter: 1 });
    expect(await paramsOf(receipt.opId!)).toEqual({ chapter: 1, mode: "write" });
  });

  it("没带消息号、没有书：不交、如实说", async () => {
    expect(await changeDraft({}, context({ ref: false }))).toMatchObject({ ok: false, code: "no_message_ref" });
    expect(await changeDraft({}, { requestContext: undefined } as unknown as ToolExecutionContext)).toMatchObject({ ok: false, code: "no_book" });
  });
});
