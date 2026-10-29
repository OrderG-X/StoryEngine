// @vitest-environment node
// 确认改账拿着书锁、真相写完还没同步镜像时开写（第 7 轮复核 U3a）：开写在书锁里取依据（第 8 轮起），
// 等改账连同镜像同步做完才开写，写手读到的是新账。
// 真确认改账服务 + 真写稿操作（draft.change）+ 真核心写盘，只替换模型；镜像同步前插一道闸，卡在「真相写完、镜像没同步」那一刻。
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chapterCommit, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { normalizeChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import { __resetOperationStoreForTests } from "../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests } from "../services/operations/executor.js";
import { fakeDraftDeps, settledDraftChange, submitDraftChange } from "../services/operations/recipes/draft-change-kit.js";
import { applyLedgerDecisions } from "./ledger-decisions.js";

const hooks = vi.hoisted(() => ({ beforeMirror: undefined as undefined | (() => Promise<void>) }));
vi.mock("../book/mirror/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../book/mirror/sync.js")>();
  return {
    ...actual,
    syncLegacyMirror: async (...args: Parameters<typeof actual.syncLegacyMirror>) => {
      await hooks.beforeMirror?.();
      return actual.syncLegacyMirror(...args);
    },
  };
});

let root: string | undefined;
beforeEach(() => {
  __resetOperationStoreForTests();
  __resetRecipesForTests();
});
afterEach(async () => {
  await __drainOperationsForTests();
  hooks.beforeMirror = undefined;
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeBook(): Promise<string> {
  root = await mkdtemp(join(process.env.STORY_ENGINE_TEST_RUN_ROOT!, "ledger-draft-mirror-"));
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

it("确认改账拿着书锁、还没同步镜像时开写：等改账做完才开写，写手读到的是新账（第 7 轮 U3a）", async () => {
  const book = await makeBook();
  await commitKey(book, "保险柜的口令是红松。", "红松");
  expect((await syncLegacyMirror(book)).ok).toBe(true);
  await writeChapterPlan(book, normalizeChapterPlan({ summary: "打开保险柜", beats: ["林远打开保险柜"] }, { chapter: 2, source: "author" })!);
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  hooks.beforeMirror = async () => { hooks.beforeMirror = undefined; reached(); await gate; };
  const author = applyLedgerDecisions(book, {
    key: "round7-author-change",
    decisions: [{ type: "fact.assert", chapter: 1, nature: "hard", subject: "保险柜", attribute: "口令", value: "白鹤", text: "保险柜的口令是白鹤。", corrects: "c1-1" }],
  });
  await entered;
  let consumed = "";
  try {
    const drafting = submitDraftChange(book, "write", { chapter: 2 }, fakeDraftDeps({
      plannerCallModel: async () => { throw new Error("应沿用作者章纲"); },
      writerClient: {
        async generateDraft({ context }) {
          consumed = packOf(context);
          return { title: "开柜", content: prose("林远输入白鹤，打开了保险柜。") };
        },
      },
    }));
    // 改账还拿着书锁：交不上、开写取不到依据，写手不开工。
    await new Promise((done) => setTimeout(done, 50));
    expect(consumed).toBe("");
    release();
    expect((await author).ok).toBe(true);
    const submitted = await drafting;
    if (!submitted.ok || !("record" in submitted)) throw new Error(`没受理：${JSON.stringify(submitted)}`);
    const done = await settledDraftChange(book, submitted.record.opId);
    expect(consumed).toContain("白鹤");
    expect(consumed).not.toContain("红松");
    expect(done.result).toMatchObject({ body: { ok: true } });
  } finally {
    release();
    await author;
  }
});
