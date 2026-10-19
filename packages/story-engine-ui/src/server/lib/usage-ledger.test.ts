// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeHomeTempDir } from "./home-test-tmp.js";
import { runInUsageScope, noteUsageBook, withUsageBook } from "./usage-scope.js";

// test-setup 把 recordUsage 换成了空操作，这里拿真的。
const ledger = await vi.importActual<typeof import("./usage-ledger.js")>("./usage-ledger.js");
const { readUsagePrices, readUsageSummary, recordUsage, usageDir, writeUsagePrice } = ledger;

let dataDir: string;
let bookDir: string;
const originalDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  dataDir = await makeHomeTempDir("story-engine-usage-");
  process.env.SE_DATA_DIR = dataDir;
  bookDir = join(dataDir, "books", "story-fog");
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "project.json"), JSON.stringify({ title: "雾港来信" }), "utf-8");
});
afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const sample = (input: number, output: number, cachedInput = 0) => ({ input, output, cachedInput, reasoning: 0 });
const NOW = new Date(2026, 9, 20, 15);
const YESTERDAY = new Date(2026, 9, 19, 9);
const LAST_MONTH = new Date(2026, 8, 25, 9);

describe("全局用量账（P10）", () => {
  it("每次一行记到当月文件；书从调用上下文带；没回用量的不记", async () => {
    await withUsageBook(bookDir, () => recordUsage({ task: "fastDraft", provider: "glm", providerLabel: "智谱", model: "glm-5", sample: sample(1000, 200), now: NOW }));
    await runInUsageScope(async () => {
      noteUsageBook(bookDir);
      await recordUsage({ task: "triage", provider: "glm", model: "glm-5", sample: sample(500, 50), now: NOW });
    });
    await recordUsage({ provider: "glm", model: "glm-5", sample: undefined, now: NOW });
    await recordUsage({ provider: "ds", model: "chat", sample: sample(10, 10), now: NOW });
    const lines = (await readFile(join(usageDir(), "2026-10.jsonl"), "utf-8")).trim().split("\n").map((row) => JSON.parse(row));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ d: "2026-10-20", book: bookDir, task: "fastDraft", provider: "glm", model: "glm-5", input: 1000, output: 200 });
    expect(lines[1]).toMatchObject({ book: bookDir, task: "triage" });
    expect(lines[2]).toMatchObject({ task: "other" });
    expect(lines[2]).not.toHaveProperty("book");
  });

  it("汇总：今天 / 本月 / 近 30 天，按书 / 功能 / 模型分列，书名现读；坏行跳过", async () => {
    await withUsageBook(bookDir, async () => {
      await recordUsage({ task: "fastDraft", provider: "glm", model: "glm-5", sample: sample(1000, 200), now: NOW });
      await recordUsage({ task: "triage", provider: "glm", model: "glm-5", sample: sample(400, 100), now: YESTERDAY });
      await recordUsage({ task: "triage", provider: "glm", model: "glm-5", sample: sample(9000, 9000), now: LAST_MONTH });
    });
    await recordUsage({ task: "qualityCheck", provider: "ds", model: "chat", sample: sample(50, 50), now: NOW });
    await writeFile(join(usageDir(), "2026-10.jsonl"), "{坏行\n", { flag: "a" });

    const summary = await readUsageSummary(NOW);
    expect(summary.today).toMatchObject({ calls: 2, input: 1050, output: 250, unpriced: true });
    expect(summary.today.cost).toBeUndefined();
    expect(summary.month).toMatchObject({ calls: 3, input: 1450 });
    expect(summary.days).toHaveLength(30);
    expect(summary.days.at(-1)).toMatchObject({ date: "2026-10-20", input: 1050 });
    expect(summary.days.at(-2)).toMatchObject({ date: "2026-10-19", input: 400 });
    expect(summary.days.reduce((total, day) => total + day.input, 0)).toBe(1450 + 9000);
    expect(summary.byBook.map((group) => [group.title, group.input])).toEqual([["雾港来信", 10400], ["", 50]]);
    expect(summary.byTask.map((group) => [group.key, group.calls])).toEqual([["triage", 2], ["fastDraft", 1], ["qualityCheck", 1]]);
    expect(summary.byModel.map((group) => group.key)).toEqual(["glm|glm-5", "ds|chat"]);
  });

  it("单价：填了才算钱（缓存命中按命中价、不填按输入价），没填的标出来；清掉；不合法不存", async () => {
    await recordUsage({ task: "fastDraft", provider: "glm", model: "glm-5", sample: sample(2_000_000, 1_000_000, 1_000_000), now: NOW });
    await recordUsage({ task: "fastDraft", provider: "ds", model: "chat", sample: sample(10, 10), now: NOW });
    await writeUsagePrice("glm|glm-5", { input: 4, cachedInput: 1, output: 16 });
    let summary = await readUsageSummary(NOW);
    expect(summary.today.cost).toBeCloseTo(4 + 1 + 16);
    expect(summary.today.unpriced).toBe(true);
    expect(summary.byModel.find((group) => group.key === "glm|glm-5")).toMatchObject({ price: { input: 4, cachedInput: 1, output: 16 }, unpriced: false });

    await writeUsagePrice("glm|glm-5", { input: 4, output: 16 });
    summary = await readUsageSummary(NOW);
    expect(summary.today.cost).toBeCloseTo(8 + 16);

    await expect(writeUsagePrice("glm|glm-5", { input: -1, output: 2 })).rejects.toThrow("不小于 0");
    await writeUsagePrice("glm|glm-5", null);
    expect(await readUsagePrices()).toEqual({});
  });
});
