// @vitest-environment node
// 后台补读冻结的步骤（写作版本 P4a，Astra 2026-11-07 第 1、2 条）：途中改了原本不占一步的章，回执读到哪按最后一步查到的算；
// 接着做时做完的步骤照检查点重放，这次写过的照算。只跑配方的 run（真检查点读写，假模型），不跑执行器调度。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CHECKER_ROLE } from "../../../editorial/checker.js";
import { ensureReaderWindow, readerNotesStatus, type BrainMessage } from "../../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { inputHashOf, readCheckpoint, writeCheckpoint } from "../../../lib/operations/checkpoints.js";
import { readBackfillParams, type BackfillParams } from "../../../lib/reader-backfill.js";
import type { RecipeContext } from "../executor.js";
import { createBackgroundBackfillRecipe, type BackfillResultBody } from "./background-backfill.js";

const roots: string[] = [];
const chapterPath = (book: string, chapter: number) => join(book, "chapters", `${String(chapter).padStart(4, "0")}.md`);
const writeChapter = (book: string, chapter: number, body: string) => writeFile(chapterPath(book, chapter), `# 第${chapter}章\n\n${body}\n`, "utf-8");
const asked = (messages: readonly BrainMessage[]) => Number(/【第 (\d+) 章 定稿原文】/u.exec(messages.at(-1)!.content)?.[1]);
const fakeNote = async (messages: readonly BrainMessage[]) => `第${asked(messages)}章笔记`;

async function makeBook(count: number): Promise<string> {
  const book = await makeHomeTempDir("backfill-steps-");
  roots.push(book);
  await mkdir(join(book, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= count; chapter += 1) await writeChapter(book, chapter, `第${chapter}章正文。`);
  return book;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** 配方的上下文：步骤按真检查点读写、同输入重放；beforeStep 抛错 = 进程在那一步之前没了。 */
function context(bookDir: string, params: BackfillParams, beforeStep?: (id: string) => void): RecipeContext<BackfillParams> {
  return {
    bookDir,
    params,
    signal: new AbortController().signal,
    progress() {},
    async step<T>(id: string, input: unknown, fn: () => Promise<T>) {
      beforeStep?.(id);
      const hash = inputHashOf(input);
      const saved = await readCheckpoint(bookDir, "steps-op", id);
      if (saved?.inputHash === hash) return saved.output as T;
      const output = await fn();
      await writeCheckpoint(bookDir, "steps-op", { schema: "operation-step/1", stepId: id, inputHash: hash, exec: `1:${id}`, output, finishedAt: new Date().toISOString() });
      return output;
    },
  } as unknown as RecipeContext<BackfillParams>;
}

it("途中改了原本不占一步的第 7 章：restart，回执读到第 6 章（不把没重读的第 7～11 章算成读过）", async () => {
  const book = await makeBook(12);
  await ensureReaderWindow({ projectDir: book, role: CHECKER_ROLE, upTo: 12, callModel: fakeNote });
  await writeChapter(book, 2, "第2章改稿。");
  expect((await readerNotesStatus({ projectDir: book, role: CHECKER_ROLE, upTo: 12 })).stale).toEqual([2, 3, 4]);
  const recipe = createBackgroundBackfillRecipe({
    modelProblem: () => undefined,
    callModel: async (messages) => {
      if (asked(messages) === 4) await writeChapter(book, 7, "第7章途中改稿。");
      return fakeNote(messages);
    },
  });
  const result = await recipe.run(context(book, { ranges: [{ role: "checker", from: 2, to: 12, steps: [2, 3, 4, 12] }] }));
  expect(result.body as BackfillResultBody).toMatchObject({ readThrough: { checker: 6 }, restart: true, progressed: true });
  expect((await readerNotesStatus({ projectDir: book, role: CHECKER_ROLE, upTo: 12 })).stale).toEqual([7, 8, 9]);
});

it("最后一步之前进程没了：接着做时做完的步骤照检查点重放，progressed 照算 true", async () => {
  const book = await makeBook(12);
  await ensureReaderWindow({ projectDir: book, role: CHECKER_ROLE, upTo: 12, callModel: fakeNote });
  await writeChapter(book, 2, "第2章改稿。");
  const recipe = createBackgroundBackfillRecipe({ modelProblem: () => undefined, callModel: fakeNote });
  const params: BackfillParams = { ranges: [{ role: "checker", from: 2, to: 12, steps: [2, 3, 4, 12] }] };
  await expect(recipe.run(context(book, params, (id) => {
    if (id === "checker:12") throw new Error("进程在最后一步之前没了");
  }))).rejects.toThrow("进程");
  let calls = 0;
  const again = createBackgroundBackfillRecipe({ modelProblem: () => undefined, callModel: async (messages) => { calls += 1; return fakeNote(messages); } });
  const result = await again.run(context(book, params));
  expect(calls).toBe(0);
  expect(result.body as BackfillResultBody).toEqual({ readThrough: { checker: 12 }, progressed: true, restart: false, stuck: [] });
});

it("P4a 之前交的记录、每步都照检查点重放：读到哪按现在对得上的笔记算，那时写的旧笔记不算读过（Astra P4a 第 3 轮）", async () => {
  const book = await makeBook(3);
  await ensureReaderWindow({ projectDir: book, role: CHECKER_ROLE, upTo: 3, callModel: fakeNote });
  // 盘上是升级前写的笔记（没有前两章原文的哈希）和那时做完的三步检查点。
  for (let chapter = 1; chapter <= 3; chapter += 1) {
    const path = join(book, "agents", "checker", "notes", `${String(chapter).padStart(4, "0")}.json`);
    const { contextHash: _contextHash, ...old } = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(old), "utf-8");
    await writeCheckpoint(book, "steps-op", { schema: "operation-step/1", stepId: `checker:${chapter}`, inputHash: inputHashOf({ role: "checker", chapter }), exec: `1:checker:${chapter}`, output: { readThrough: chapter, missing: 0, built: 1, volumesBuilt: 0 }, finishedAt: new Date().toISOString() });
  }
  let calls = 0;
  const recipe = createBackgroundBackfillRecipe({ modelProblem: () => undefined, callModel: async (messages) => { calls += 1; return fakeNote(messages); } });
  const result = await recipe.run(context(book, readBackfillParams({ ranges: [{ role: "checker", from: 1, to: 3 }] })!));
  expect(calls).toBe(0);
  expect(result.body as BackfillResultBody).toEqual({ readThrough: { checker: 0 }, progressed: true, restart: true, stuck: [] });
});
