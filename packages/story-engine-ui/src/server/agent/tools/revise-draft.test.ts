// @vitest-environment node
// revise_draft（写作版本 P2a 片 2C）：对话里改一段或几段只交意图、回受理回执。一条作者消息只交一次（几处都放 edits）；
// 模型传的退化形状（只改一处放顶层、edits 是 JSON 串、空串、大小写不一的 style）在边界里归一；没原文、超上限、没稿如实不交。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { draftSave, readDraftState, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, readOperation } from "../../lib/operations/store.js";
import { EDIT_MAX_REVISIONS } from "../../services/draft-change/params.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe } from "../../services/operations/executor.js";
import { createDraftChangeRecipe } from "../../services/operations/recipes/draft-change.js";
import { fakeDraftDeps } from "../../services/operations/recipes/draft-change-kit.js";
import { buildProjectRequestContext } from "../request-context.js";
import type { SubmitReceipt } from "./op-tools.js";
import { reviseDraftTool } from "./revise-draft.js";

let root: string;
let book: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("revise-draft-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "交改稿", genre: "都市", protagonistName: "林远" }));
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
function context(options: { readonly ref?: boolean } = {}): ToolExecutionContext {
  seq += 1;
  const requestContext = buildProjectRequestContext(
    book,
    1,
    ["改一下"],
    undefined,
    undefined,
    options.ref === false ? undefined : { messageId: `msg-${seq}`, issuedAt: new Date().toISOString() },
  );
  return { requestContext } as unknown as ToolExecutionContext;
}

const revise = (input: Record<string, unknown>, ctx: ToolExecutionContext = context()) =>
  (reviseDraftTool as unknown as { execute: (input: unknown, context: ToolExecutionContext) => Promise<SubmitReceipt & { readonly chapter?: number }> }).execute(input, ctx);

async function paramsOf(opId: string): Promise<unknown> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record.params;
}

async function save(body: string): Promise<void> {
  const baseVersion = (await readDraftState(book, 1)).version;
  expect(await runCommand(book, draftSave, { chapter: 1, body, baseVersion, title: "" }, { caller: "author" })).toMatchObject({ ok: true });
}

describe("revise_draft：只交、只回受理回执", () => {
  it("一句话改几处：放进 edits 一次交，受理回操作号", async () => {
    await save("他推开门。屋里很暗。");
    const receipt = await revise({ edits: [{ targetText: "他推开门。", revisionGoal: "放轻动作" }, { targetText: "屋里很暗。", replacementText: "屋里没点灯。" }] });
    expect(receipt).toMatchObject({ ok: true, accepted: true, mode: "revise", chapter: 1 });
    expect(await paramsOf(receipt.opId!)).toMatchObject({
      mode: "revise",
      chapter: 1,
      edits: [{ targetText: "他推开门。", revisionGoal: "放轻动作" }, { targetText: "屋里很暗。", replacementText: "屋里没点灯。" }],
    });
  });

  it("模型的退化形状在边界里归一：只改一处放顶层、edits 是 JSON 串、没原文的那条去掉、style 大小写不一", async () => {
    await save("他推开门。屋里很暗。");
    const top = await revise({ targetText: "他推开门。", revisionGoal: "放轻动作", edits: "", style: "DeAI" });
    expect(await paramsOf(top.opId!)).toEqual({ mode: "revise", chapter: 1, edits: [{ targetText: "他推开门。", revisionGoal: "放轻动作" }], style: "deai" });
    await __drainOperationsForTests();
    const json = await revise({ edits: JSON.stringify([{ targetText: "屋里很暗。", revisionGoal: "具体些" }, { targetText: "", revisionGoal: "多给的空条" }]) });
    expect(await paramsOf(json.opId!)).toEqual({ mode: "revise", chapter: 1, edits: [{ targetText: "屋里很暗。", revisionGoal: "具体些" }] });
  });

  it("没给原文、超了上限、这章没稿：不交，如实说", async () => {
    expect(await revise({ edits: [{ revisionGoal: "改顺" }] })).toMatchObject({ ok: false, code: "bad_params", chapter: 1 });
    const many = Array.from({ length: EDIT_MAX_REVISIONS + 1 }, (_, index) => ({ targetText: `第${index}句。`, revisionGoal: "改顺" }));
    const tooMany = await revise({ edits: many });
    expect(tooMany).toMatchObject({ ok: false, code: "bad_params" });
    expect(tooMany.summary).toContain(`一次最多改 ${EDIT_MAX_REVISIONS} 处`);
    expect(await revise({ targetText: "他推开门。", revisionGoal: "放轻动作" })).toMatchObject({ ok: false, code: "no_draft", chapter: 1 });
    expect(await listOperations(book)).toEqual([]);
  });

  it("没带消息号、没有书：不交、如实说", async () => {
    expect(await revise({ targetText: "他推开门。" }, context({ ref: false }))).toMatchObject({ ok: false, code: "no_message_ref" });
    expect(await revise({ targetText: "他推开门。" }, { requestContext: undefined } as unknown as ToolExecutionContext)).toMatchObject({ ok: false, code: "no_book" });
  });
});
