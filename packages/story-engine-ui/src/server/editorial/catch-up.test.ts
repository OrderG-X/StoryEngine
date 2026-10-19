// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { readReaderProgress, readReadersCatchUpStatus, startReaderCatchUp, writeReaderReadingProgress, type ReaderProgress } from "./catch-up.js";
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

  it("读到一半书被删（挪进回收站）：不在原处建出幽灵目录；排在后面的角色不再调模型", async () => {
    const dir = await makeBook(4);
    const moved = `${dir}-trashed`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const deleting: BrainCallModel = async () => {
      calls += 1;
      if (calls === 2) await rename(dir, moved);
      return "笔记";
    };
    await startReaderCatchUp(dir, ROLE, 4, { callModel: deleting });
    expect(existsSync(dir)).toBe(false);
    await startReaderCatchUp(dir, { ...ROLE, id: "next" }, 4, { callModel: deleting });
    expect(existsSync(dir)).toBe(false);
    expect(calls).toBe(2);
    warn.mockRestore();
    await rm(moved, { recursive: true, force: true });
  });
});

describe("开书时先把第一个要读的角色标成在读（R4.3）", () => {
  it("writeReaderReadingProgress：没进度 → reading:true、done 接着已有的、total 不小于上次", async () => {
    const dir = await makeBook(6);
    // 没写过：0/6 起步。
    await writeReaderReadingProgress(dir, ROLE.id, 6);
    expect(await progressOf(dir)).toMatchObject({ role: ROLE.id, reading: true, done: 0, total: 6 });
    // 上次读到 2、目标是 8：done 接着 2，total 抬到 8。
    await writeAtomicallyHelper(dir, ROLE.id, { role: ROLE.id, reading: false, done: 2, total: 6, updatedAt: "t" });
    await writeReaderReadingProgress(dir, ROLE.id, 8);
    expect(await progressOf(dir)).toMatchObject({ reading: true, done: 2, total: 8 });
  });

  it("writeReaderReadingProgress：已经在读就不重写（不把正在走的进度打回）", async () => {
    const dir = await makeBook(4);
    await writeAtomicallyHelper(dir, ROLE.id, { role: ROLE.id, reading: true, done: 3, total: 4, updatedAt: "t" });
    const before = await readFile(join(dir, "agents", ROLE.id, "progress.json"), "utf-8");
    await writeReaderReadingProgress(dir, ROLE.id, 4);
    expect(await readFile(join(dir, "agents", ROLE.id, "progress.json"), "utf-8")).toBe(before);
  });

  it("readReadersCatchUpStatus：三个角色按 checker→ledger→planner 带，没写过的 0/0、全读完 reading:false", async () => {
    const dir = await makeBook(3);
    await writeAtomicallyHelper(dir, "checker", { role: "checker", reading: true, done: 1, total: 3, updatedAt: "t" });
    await writeAtomicallyHelper(dir, "ledger", { role: "ledger", reading: false, done: 3, total: 3, updatedAt: "t" });
    expect(await readReadersCatchUpStatus(dir)).toEqual({
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 1, total: 3 },
        { role: "ledger", reading: false, done: 3, total: 3 },
        { role: "planner", reading: false, done: 0, total: 0 },
      ],
    });
    // checker 也读完：整体 reading:false（界面这行进度就该消失）。
    await writeAtomicallyHelper(dir, "checker", { role: "checker", reading: false, done: 3, total: 3, updatedAt: "t" });
    expect((await readReadersCatchUpStatus(dir)).reading).toBe(false);
  });

  it("readReadersCatchUpStatus 的 total 现算（R5.3）：开读时记的 58 旧了，chapters/ 定稿到 0059 就按 59 给", async () => {
    const dir = await makeBook(58);
    await writeAtomicallyHelper(dir, "checker", { role: "checker", reading: true, done: 34, total: 58, updatedAt: "t" });
    await writeAtomicallyHelper(dir, "ledger", { role: "ledger", reading: false, done: 58, total: 58, updatedAt: "t" });
    // 读的途中作者定稿第 59 章（progress.json 里的 58 还是开读那一刻的数）。
    await writeFile(join(dir, "chapters", "0059.md"), "# 第59章\n\n第59章的正文。\n", "utf-8");
    expect(await readReadersCatchUpStatus(dir)).toEqual({
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 34, total: 59 },
        { role: "ledger", reading: false, done: 58, total: 59 },
        { role: "planner", reading: false, done: 0, total: 0 }, // 没写过的角色不硬造 0/59
      ],
    });
  });
});

/** 测试里直接摆一个 progress.json（readReaderProgress 认的形状）。 */
async function writeAtomicallyHelper(dir: string, roleId: string, payload: ReaderProgress): Promise<void> {
  await mkdir(join(dir, "agents", roleId), { recursive: true });
  await writeFile(join(dir, "agents", roleId, "progress.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

// 开书时看一眼要不要补（maybeStartReadersCatchUp，三个角色版）的测试在 index.test.ts——函数在 index.ts，
// 要看三个角色的开关和共用队列。
