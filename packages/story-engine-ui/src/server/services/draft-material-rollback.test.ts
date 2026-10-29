// @vitest-environment node
/**
 * 写手读到的材料是别的写写到一半的那份（写作版本 P1 第 18 轮 AF1）：真出稿、真 draft.save，只在构包前后插调度钩子、
 * 在一次真 rename 上注入失败。开工记下 A → 构包时前一章并发存稿已换上 B（青鹭）→ 那笔存稿写 applied 清单时失败、
 * 回滚把正文和工作稿代次都退回 A。材料指纹、工作稿代次都又对上了，但回滚换了写入代次：这版不换上、留成候选。
 * 存稿成功的那种照常按材料变了拦下。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { draftSave, readDraft, readDraftState, runCommand, type CommandOutcome } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { pendingDraftFor } from "../lib/draft-candidates.js";
import { runGenerateDraft } from "./draft-service.js";

const hooks = vi.hoisted(() => ({
  beforeContext: undefined as undefined | (() => Promise<void>),
  afterContext: undefined as undefined | (() => Promise<void>),
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await hooks.beforeRename?.(String(from), String(to));
      const result = await actual.rename(from, to);
      await hooks.afterRename?.(String(from), String(to));
      return result;
    },
  };
});
vi.mock("../writing/context-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../writing/context-gateway.js")>();
  return {
    ...actual,
    buildWriterContext: async (...args: Parameters<typeof actual.buildWriterContext>) => {
      await hooks.beforeContext?.();
      const context = await actual.buildWriterContext(...args);
      await hooks.afterContext?.();
      return context;
    },
  };
});

let root: string;
let book: string;
beforeEach(async () => {
  root = await makeHomeTempDir("draft-material-rollback-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "并发材料", genre: "都市", protagonistName: "林远" }));
  expect((await runCommand(book, draftSave, { chapter: 1, title: "前章原名", body: "林远看见口令是白鹤，他把白鹤二字写在纸上。", baseVersion: null }, { caller: "author" })).ok).toBe(true);
  expect((await runCommand(book, draftSave, { chapter: 2, title: "本章原名", body: "第二章原稿。", baseVersion: null }, { caller: "author" })).ok).toBe(true);
});
afterEach(async () => {
  hooks.beforeContext = hooks.afterContext = hooks.beforeRename = hooks.afterRename = undefined;
  await rm(root, { recursive: true, force: true });
});

function barrier(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

it.each(["写 applied 清单时失败", "存成了"] as const)("构包读到前一章并发存稿的 B（那笔%s）：照 B 写的不换上、留成候选", async (mode) => {
  const failed = mode === "写 applied 清单时失败";
  const original = (await readDraftState(book, 1)).version;
  const swapped = barrier();
  const release = barrier();
  let saving: Promise<CommandOutcome<unknown>> | undefined;
  let savingOutcome: CommandOutcome<unknown> | undefined;
  hooks.beforeContext = async () => {
    hooks.beforeContext = undefined;
    // 前一章的工作稿换上（B）就停住，等构包读完再让那笔存稿往下走。
    hooks.afterRename = async (_from, to) => {
      if (to !== join(book, "drafts/fast/chapter-0001.md")) return;
      hooks.afterRename = undefined;
      swapped.release();
      await release.promise;
    };
    if (failed) {
      hooks.beforeRename = async (from, to) => {
        if (from.endsWith("/manifest.json.tmp") && to.endsWith("/manifest.json") && (await readDraft(book, 1))?.body.includes("青鹭")) {
          hooks.beforeRename = undefined;
          throw Object.assign(new Error("注入：写 applied 清单时磁盘满"), { code: "ENOSPC" });
        }
      };
    }
    saving = runCommand(book, draftSave, { chapter: 1, title: "前章写到半途", body: "林远看见口令是青鹭，他把青鹭二字写在纸上。", baseVersion: original }, { caller: "author" });
    await swapped.promise;
  };
  hooks.afterContext = async () => {
    hooks.afterContext = undefined;
    release.release();
    savingOutcome = await saving!;
  };
  let saw = "";
  const out = await runGenerateDraft({
    projectDir: book, chapter: 2, selectedCharacters: ["林远"], requestedDraftLength: 500, autoDeAi: false,
    writerClient: {
      async generateDraft({ context }) {
        saw = JSON.stringify(context);
        const word = saw.includes("青鹭") ? "青鹭" : "白鹤";
        const para = `林远在门口停下脚步，确认纸上口令仍是${word}，才把纸条递给守门人。守门人看过以后收起纸条，转身从抽屉里取出一把钥匙。`;
        return { content: [para, para, para, para].join("\n\n") };
      },
    },
  });
  expect(saw).toContain("青鹭");
  expect(savingOutcome?.ok).toBe(!failed);
  expect(out).toMatchObject({ ok: false, kept: { reason: "basis_moved" } });
  expect((await readDraft(book, 2))?.body).toBe("第二章原稿。");
  expect((await pendingDraftFor(book, 2))?.body).toContain("青鹭");
  if (failed) expect((await readDraft(book, 1))?.body).toContain("白鹤");
});
