// @vitest-environment node
// 定稿票的依据在读字数下限、人物名单之前取（写作版本 P1 第 8 轮复核 V4）。真入口、真硬闸、真设定卡、真确认；
// 只在入口调用 prepareChapterCommit 之前插一次作者改设定（时序屏障）。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cardWrite, draftSave, readChapterText, readDraftFile, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { confirmChapterCommit } from "../../editorial/commit-flow.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { buildCommitPreviewToolOutput, ticketStoreFor } from "./commit-preview.js";

const hook = vi.hoisted(() => ({ beforePrepare: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../editorial/commit-flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../editorial/commit-flow.js")>();
  return {
    ...actual,
    prepareChapterCommit: async (...args: Parameters<typeof actual.prepareChapterCommit>) => {
      await hook.beforePrepare?.();
      return actual.prepareChapterCommit(...args);
    },
  };
});

let root: string;
let book: string;
const body = "林远推开钟楼的门。" + "他在钟楼里来回踱步，反复掂量手里那把钥匙的分量，盘算着接下来每一步该怎么走。".repeat(10);
const model = async (_messages: unknown, options: { readonly json: boolean }) => (options.json
  ? JSON.stringify({ summary: { text: "林远进钟楼", quote: "林远推开钟楼的门" }, presence: [{ name: "林远", nameUsed: "林远", viewpoint: true, quote: "林远推开钟楼的门" }] })
  : "笔记：林远进钟楼。");

beforeEach(async () => {
  root = await makeHomeTempDir("commit-preview-basis-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "定稿依据", genre: "悬疑", protagonistName: "林远" }));
  expect(await runCommand(book, draftSave, { chapter: 1, title: "", body, baseVersion: null }, { caller: "author" })).toMatchObject({ ok: true });
});
afterEach(async () => {
  hook.beforePrepare = undefined;
  await rm(root, { recursive: true, force: true });
});

const changeRules = async (): Promise<void> => {
  expect(await runCommand(book, cardWrite, { ops: [{ op: "rules.set", field: "minWords", value: 1000 }, { op: "card.delete", card: "林远" }] }, { caller: "author", idempotencyKey: "change-rules" })).toMatchObject({ ok: true });
};

it("读完字数下限和人物名单之后作者改了设定：这张票不出（或确认时作废），旧检查不能照样定稿（第 8 轮 V4）", async () => {
  hook.beforePrepare = async () => {
    hook.beforePrepare = undefined;
    await changeRules();
  };
  const preview = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: model });
  const applied = preview.previewToken
    ? await confirmChapterCommit({ bookDir: book, ticket: preview.previewToken, text: (await readDraftFile(book, 1))!.text, tickets: ticketStoreFor(book) })
    : { ok: false };
  expect(applied.ok).toBe(false);
  expect(await readChapterText(book, 1)).toBeUndefined();
  // 现在重新预览：按新的下限拦下。
  const fresh = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: model });
  expect(fresh).toMatchObject({ canCommit: false });
  expect(fresh.blockingReasons?.join("")).toContain("1000");
});

it("改设定在预览之前：照常按新下限拦下，不出票（对照）", async () => {
  await changeRules();
  const preview = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: model });
  expect(preview).toMatchObject({ canCommit: false });
  expect(preview.previewToken).toBeUndefined();
  expect(await readChapterText(book, 1)).toBeUndefined();
});
