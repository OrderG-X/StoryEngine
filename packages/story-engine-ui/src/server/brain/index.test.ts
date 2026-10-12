// @vitest-environment node
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { catchUpReaders, isReaderCheckerEnabled, isReaderLedgerEnabled, isReaderPlannerEnabled, warmUpReaders } from "./index.js";
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

beforeEach(() => {
  vi.stubEnv("STORY_CHECKER", undefined as unknown as string);
  vi.stubEnv("STORY_LEDGER", undefined as unknown as string);
  vi.stubEnv("STORY_PLANNER", undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("定稿后预热", () => {
  it("没开核账员（STORY_CHECKER 没设成 reader）→ 什么都不干，不调模型", async () => {
    const dir = await makeBook(3);
    const callModel = vi.fn<BrainCallModel>(async () => "笔记");
    expect(isReaderCheckerEnabled()).toBe(false);
    await warmUpReaders(dir, 3, { callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(await notes(dir, "checker")).toEqual([]);
  });

  it("STORY_CHECKER=reader → 后台把核账员的笔记补到刚定稿的这一章", async () => {
    vi.stubEnv("STORY_CHECKER", "reader");
    const dir = await makeBook(4);
    await warmUpReaders(dir, 3, { callModel: async () => "笔记" });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json", "0003.json"]);
  });

  it("STORY_PLANNER=reader → 预热也给章纲员补笔记（编辑部第 3 步）", async () => {
    vi.stubEnv("STORY_PLANNER", "reader");
    expect(isReaderPlannerEnabled()).toBe(true);
    const dir = await makeBook(3);
    await warmUpReaders(dir, 2, { callModel: async () => "笔记" });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "planner")).toEqual(["0001.json", "0002.json"]);
  });

  it("补笔记失败：不抛错（只 warn），已有的笔记不受影响", async () => {
    vi.stubEnv("STORY_CHECKER", "reader");
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

  it("STORY_LEDGER=reader（核账员没开）→ 预热只补记账员的笔记", async () => {
    vi.stubEnv("STORY_LEDGER", "reader");
    expect(isReaderLedgerEnabled()).toBe(true);
    const dir = await makeBook(3);
    await warmUpReaders(dir, 2, { callModel: async () => "笔记" });
    expect(await notes(dir, "ledger")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "checker")).toEqual([]);
  });

  it("两个都开 → 两个角色的笔记都补", async () => {
    vi.stubEnv("STORY_CHECKER", "reader");
    vi.stubEnv("STORY_LEDGER", "reader");
    const dir = await makeBook(2);
    await catchUpReaders(dir, 2, { callModel: async () => "笔记" });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual(["0001.json", "0002.json"]);
  });

  it("catchUpReaders 只补开着的角色（没开的角色不白调模型）", async () => {
    const dir = await makeBook(2);
    const callModel = vi.fn<BrainCallModel>(async () => "笔记");
    await catchUpReaders(dir, 2, { callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(await notes(dir, "checker")).toEqual([]);
    expect(await notes(dir, "ledger")).toEqual([]);
  });
});
