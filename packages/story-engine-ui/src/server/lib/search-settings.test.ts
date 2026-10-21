// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeHomeTempDir } from "./home-test-tmp.js";
import { clearSearchSettings, readSearchSettings, saveSearchSettings, searchSettingsView } from "./search-settings.js";

let dataDir: string;
const originalDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  dataDir = await makeHomeTempDir("story-engine-search-");
  process.env.SE_DATA_DIR = dataDir;
});
afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("联网搜索设置（P11）", () => {
  it("没文件 / 坏文件 / 认不得的服务 → 当没开", async () => {
    expect(await readSearchSettings()).toBeNull();
    await writeFile(join(dataDir, "search-settings.json"), "{坏", "utf-8");
    expect(await readSearchSettings()).toBeNull();
    await writeFile(join(dataDir, "search-settings.json"), JSON.stringify({ provider: "google", apiKey: "x" }), "utf-8");
    expect(await readSearchSettings()).toBeNull();
    expect(searchSettingsView(null)).toEqual({ provider: null, hasKey: false });
  });

  it("存：只本人可读；同一家不填密钥沿用旧的；换一家得重填；关掉删文件", async () => {
    await expect(saveSearchSettings({ provider: "bocha" })).rejects.toThrow("要填「博查」的密钥");
    await saveSearchSettings({ provider: "bocha", apiKey: " k1 " });
    expect(await readSearchSettings()).toEqual({ provider: "bocha", apiKey: "k1" });
    expect((await stat(join(dataDir, "search-settings.json"))).mode & 0o777).toBe(0o600);

    await saveSearchSettings({ provider: "bocha" });
    expect(await readSearchSettings()).toEqual({ provider: "bocha", apiKey: "k1" });
    await expect(saveSearchSettings({ provider: "tavily" })).rejects.toThrow("要填「Tavily」的密钥");
    await saveSearchSettings({ provider: "tavily", apiKey: "k2" });
    expect(JSON.parse(await readFile(join(dataDir, "search-settings.json"), "utf-8"))).toEqual({ version: 1, provider: "tavily", apiKey: "k2" });
    expect(searchSettingsView(await readSearchSettings())).toEqual({ provider: "tavily", hasKey: true });

    await clearSearchSettings();
    expect(await readSearchSettings()).toBeNull();
    await clearSearchSettings();
  });
});
