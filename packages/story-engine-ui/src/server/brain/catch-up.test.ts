// @vitest-environment node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { maybeStartCheckerCatchUp, readReaderProgress, startReaderCatchUp, type ReaderProgress } from "./catch-up.js";
import { CHECKER_ROLE } from "./checker.js";
import type { BrainCallModel, BrainMessage, ReaderRole } from "./reader-window.js";

const ROLE: ReaderRole = { id: "tester", system: "你是测试专员。", noteTask: "写笔记。", volumeTask: "缩写成一份卷笔记。" };

async function makeBook(chapters: number): Promise<string> {
  const dir = await makeHomeTempDir("catch-up-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n第${chapter}章的正文。\n`, "utf-8");
  }
  return dir;
}

const progressOf = async (dir: string, roleId = ROLE.id): Promise<ReaderProgress | undefined> => readReaderProgress(dir, roleId);

/** 假模型：可以数到第 failAt 章失败。 */
function stepModel(failAt = 0) {
  let count = 0;
  const callModel: BrainCallModel = async (messages) => {
    count += 1;
    if (failAt > 0 && count === failAt) throw new Error("断流了");
    return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1] ?? 1}章笔记`;
  };
  return { callModel, calls: () => count };
}

describe("后台补读：进度落盘", () => {
  it("开始标 reading、每章更新 done、读完 reading=false；总章数按要读的来", async () => {
    const dir = await makeBook(5);
    const seen: number[] = [];
    const probing: BrainCallModel = async (messages) => {
      const chapter = Number(/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]);
      if (chapter) seen.push((await progressOf(dir))?.done ?? -1);
      return `第${chapter}章笔记`;
    };
    await startReaderCatchUp(dir, ROLE, 5, { callModel: probing });
    expect(seen.slice(0, 3)).toEqual([0, 1, 2]); // 写第 2 章前，进度已经写到第 1 章
    const final = await progressOf(dir);
    expect(final).toMatchObject({ role: ROLE.id, reading: false, done: 5, total: 5 });
    expect(final!.error).toBeUndefined();
  });

  it("失败如实：读到哪里记哪里，错误原因落盘，不抛给调用方", async () => {
    const dir = await makeBook(6);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startReaderCatchUp(dir, ROLE, 6, { callModel: stepModel(3).callModel });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    const progress = await progressOf(dir);
    expect(progress).toMatchObject({ reading: false, done: 2, total: 6 });
    expect(progress!.error).toContain("断流了");
  });

  it("中断后再来（服务重启同款）：接着已写的笔记补，不从头读；进度接着走", async () => {
    const dir = await makeBook(6);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startReaderCatchUp(dir, ROLE, 6, { callModel: stepModel(3).callModel }); // 写到第 2 章
    warn.mockRestore();
    const second = stepModel();
    await startReaderCatchUp(dir, ROLE, 6, { callModel: second.callModel });
    expect(second.calls()).toBe(4); // 只补第 3～6 章
    const progress = await progressOf(dir);
    expect(progress).toMatchObject({ reading: false, done: 6, total: 6 });
    expect(progress!.error).toBeUndefined(); // 补成功后错误清掉
  });

  it("同一个角色正在补时再点一次：直接回，不重复排", async () => {
    const dir = await makeBook(4);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: BrainCallModel = async (messages) => { await gate; return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章笔记`; };
    const first = startReaderCatchUp(dir, ROLE, 4, { callModel: slow });
    // 等第一条真的开始（进度文件写出来）再试第二条
    await vi.waitFor(async () => expect(await progressOf(dir)).toMatchObject({ reading: true, total: 4 }), { timeout: 5_000 });
    const before = await readFile(join(dir, "agents", ROLE.id, "progress.json"), "utf-8");
    await startReaderCatchUp(dir, ROLE, 4, { callModel: slow }); // 正在补：直接回
    expect((await readFile(join(dir, "agents", ROLE.id, "progress.json"), "utf-8"))).toBe(before);
    release();
    await first;
    expect(await progressOf(dir)).toMatchObject({ reading: false, done: 4 });
  });

  it("进度文件坏了 / 没写过：当没有，不炸", async () => {
    const dir = await makeBook(2);
    expect(await progressOf(dir)).toBeUndefined();
    await mkdir(join(dir, "agents", ROLE.id), { recursive: true });
    await writeFile(join(dir, "agents", ROLE.id, "progress.json"), "{坏的", "utf-8");
    expect(await progressOf(dir)).toBeUndefined();
  });
});

describe("后台补读：开书时看一眼要不要补", () => {
  it("还没读齐 → 后台接着补；读齐了 / 没有定稿章节 → 不排", async () => {
    const dir = await makeBook(3);
    await maybeStartCheckerCatchUp(dir, { callModel: stepModel().callModel }); // 没笔记 → 排上
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await readReaderProgress(dir, CHECKER_ROLE.id)).toMatchObject({ reading: false, done: 3, total: 3 });
    // 读齐了：再来一次直接回（进度文件不动，说明没再排）
    const before = await readFile(join(dir, "agents", CHECKER_ROLE.id, "progress.json"), "utf-8");
    await maybeStartCheckerCatchUp(dir, { callModel: stepModel().callModel });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(join(dir, "agents", CHECKER_ROLE.id, "progress.json"), "utf-8")).toBe(before);
    // 没有定稿章节的书：不排
    const empty = await makeHomeTempDir("catch-up-empty-");
    await maybeStartCheckerCatchUp(empty, { callModel: stepModel().callModel });
    expect(await readReaderProgress(empty, CHECKER_ROLE.id)).toBeUndefined();
  });
});
