// @vitest-environment node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  catchUpReaders,
  isReaderCatchUpQueued,
  maybeStartReadersCatchUp,
  readReaderProgress,
  warmUpReaders,
} from "./index.js";
import type { BrainCallModel } from "./reader-window.js";

async function makeBook(chapters: number): Promise<string> {
  const dir = await makeHomeTempDir("brain-index-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n正文${chapter}。\n`, "utf-8");
  }
  return dir;
}

const notes = async (dir: string, role: string) => (await readdir(join(dir, "agents", role, "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("预热 / 补读（R3 后三个角色都常开，没有开关）", () => {
  it("预热：三个角色的笔记都补到刚定稿的这一章", async () => {
    const dir = await makeBook(3);
    await warmUpReaders(dir, 2, { callModel: async () => "笔记" });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "planner")).toEqual(["0001.json", "0002.json"]);
  });

  it("补笔记失败：不抛错（只 warn），已有的笔记不受影响", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = await makeBook(3);
    let count = 0;
    const flaky: BrainCallModel = async () => {
      count += 1;
      if (count === 2) throw new Error("限流了");
      return "笔记";
    };
    await expect(warmUpReaders(dir, 3, { callModel: flaky })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await notes(dir, "checker")).toEqual(["0001.json"]);
  });

  it("catchUpReaders 点名只补指定的角色", async () => {
    const dir = await makeBook(2);
    await catchUpReaders(dir, 2, { callModel: async () => "笔记", roles: ["checker"] });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual([]);
    expect(await notes(dir, "planner")).toEqual([]);
  });
});

describe("三个角色共用一条补读队列（按角色依次补，不并发）", () => {
  it("任何时刻最多一个模型调用在飞，且按 checker → ledger → planner 依次补完", async () => {
    const dir = await makeBook(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const roles: string[] = [];
    const callModel: BrainCallModel = async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      roles.push(messages[0]!.content.includes("连续性编辑") ? "checker" : messages[0]!.content.includes("记账员") ? "ledger" : "planner");
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return "笔记";
    };
    await warmUpReaders(dir, 2, { callModel });
    expect(maxInFlight).toBe(1); // 没有两个角色的补读同时打模型
    expect(roles).toEqual(["checker", "checker", "ledger", "ledger", "planner", "planner"]); // 一个角色补完才轮到下一个
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "planner")).toEqual(["0001.json", "0002.json"]);
  });

  it("同一本书同一组角色，已排队的一轮目标不低于这次要的 → 不重排；跑完就撤", async () => {
    const dir = await makeBook(2);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: BrainCallModel = async () => { await gate; return "笔记"; };
    const first = warmUpReaders(dir, 2, { callModel: slow });
    await vi.waitFor(() => expect(isReaderCatchUpQueued(dir, ["checker", "ledger", "planner"], 2)).toBe(true), { timeout: 5_000 });
    expect(isReaderCatchUpQueued(dir, ["checker", "ledger", "planner"], 1)).toBe(true); // 目标更低也算盖住
    expect(isReaderCatchUpQueued(dir, ["checker"], 2)).toBe(false); // 角色不同不算
    const callsBefore = (await notes(dir, "checker")).length + (await notes(dir, "ledger")).length + (await notes(dir, "planner")).length;
    await warmUpReaders(dir, 2, { callModel: slow }); // 重触发：直接回，不排第二轮
    release();
    await first;
    expect((await notes(dir, "checker")).length + (await notes(dir, "ledger")).length + (await notes(dir, "planner")).length).toBeGreaterThan(callsBefore);
    expect(isReaderCatchUpQueued(dir, ["checker", "ledger", "planner"], 2)).toBe(false); // 跑完撤了
  });
});

describe("开书时看一眼要不要补（maybeStartReadersCatchUp）", () => {
  it("没读齐 → 后台接着补齐三个角色；读齐了再来直接回；没有定稿章节的书不排", async () => {
    const dir = await makeBook(3);
    await maybeStartReadersCatchUp(dir, { callModel: async () => "笔记" }); // 没笔记 → 排上
    await vi.waitFor(async () => {
      for (const role of ["checker", "ledger", "planner"]) {
        await expect(readReaderProgress(dir, role)).resolves.toMatchObject({ reading: false, done: 3, total: 3 });
      }
    }, { timeout: 5_000 });
    // 读齐了：再来一次直接回（进度文件不动，说明没再排）
    const before = await readFile(join(dir, "agents", "checker", "progress.json"), "utf-8");
    await maybeStartReadersCatchUp(dir, { callModel: async () => "笔记" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(join(dir, "agents", "checker", "progress.json"), "utf-8")).toBe(before);
    // 没有定稿章节的书：不排
    const empty = await makeHomeTempDir("brain-index-empty-");
    await maybeStartReadersCatchUp(empty, { callModel: async () => "笔记" });
    expect(await readReaderProgress(empty, "checker")).toBeUndefined();
  });
});
