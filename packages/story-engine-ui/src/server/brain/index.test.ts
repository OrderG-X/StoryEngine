// @vitest-environment node
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { catchUpReaders, isReaderCheckerEnabled, warmUpReaders } from "./index.js";
import type { BrainCallModel } from "./reader-window.js";

async function makeBook(chapters: number): Promise<string> {
  const dir = await makeHomeTempDir("brain-index-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n正文${chapter}。\n`, "utf-8");
  }
  return dir;
}

const notes = async (dir: string) => (await readdir(join(dir, "agents", "checker", "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();

beforeEach(() => {
  vi.stubEnv("STORY_CHECKER", undefined as unknown as string);
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
    expect(await notes(dir)).toEqual([]);
  });

  it("STORY_CHECKER=reader → 后台把核账员的笔记补到刚定稿的这一章", async () => {
    vi.stubEnv("STORY_CHECKER", "reader");
    const dir = await makeBook(4);
    await warmUpReaders(dir, 3, { callModel: async () => "笔记" });
    expect(await notes(dir)).toEqual(["0001.json", "0002.json", "0003.json"]);
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
    expect(await notes(dir)).toEqual(["0001.json"]);
  });

  it("catchUpReaders 不看环境变量（核账那边后台补笔记用）", async () => {
    const dir = await makeBook(2);
    await catchUpReaders(dir, 2, { callModel: async () => "笔记" });
    expect(await notes(dir)).toEqual(["0001.json", "0002.json"]);
  });
});
