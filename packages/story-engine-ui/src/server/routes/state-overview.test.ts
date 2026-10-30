// @vitest-environment node
// 开书（GET /api/state-overview）遇到旧格式账单：升得了就升；升不了书照样打开，概况如实说升级没成、为什么（写作版本 P2b 片 2）。
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { registerStateOverviewRoutes } from "./state-overview.js";
import { callRoute } from "./test-helpers.js";

const CH1 = "# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。";

let rootDir: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("state-overview-");
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function oldBook(entries: unknown[]): Promise<string> {
  const { projectDir } = await createStoryProject({ rootDir, title: "旧账", protagonistName: "沈青禾" });
  await writeFile(join(projectDir, "chapters", "0001.md"), CH1);
  await mkdir(join(projectDir, "ledger", "chapters"), { recursive: true });
  await writeFile(join(projectDir, "ledger", "chapters", "0001.json"), `${JSON.stringify({
    schema: "chapter-ledger/1", chapter: 1, textSha256: createHash("sha256").update(CH1, "utf-8").digest("hex"), committedAt: "2026-10-01T00:00:00.000Z", origin: "commit", entries,
  }, null, 2)}\n`);
  return projectDir;
}

const open = (projectDir: string) => callRoute(registerStateOverviewRoutes, "GET", `/api/state-overview?project=${encodeURIComponent(projectDir)}`);

describe("开书遇到旧格式账单", () => {
  it("升成新格式，概况照常出（线索、章数都在）", async () => {
    const projectDir = await oldBook([{ id: "c1-1", kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "停了", quote: "钟停在三点十五分", thread: "t1-1" }]);
    const response = await open(projectDir);
    expect(response.statusCode).toBe(200);
    const overview = response.payload.overview as { project: { currentChapter: number }; threads: { title: string }[]; uiHints: { warnings: string[] } };
    expect(overview.project.currentChapter).toBe(1);
    expect(JSON.stringify(overview.threads)).toContain("钟为什么停");
    expect(overview.uiHints.warnings.join("")).not.toContain("账读不出来");
    expect(JSON.parse(await readFile(join(projectDir, "ledger", "chapters", "0001.json"), "utf-8")).schema).toBe("chapter-ledger/2");
  });

  it("升不了：书照样打开，警告里写清升级没成、是第几章", async () => {
    const projectDir = await oldBook([{ id: "c1-1", kind: "summary", review: "auto", text: "梗概" }]);
    const response = await open(projectDir);
    expect(response.statusCode).toBe(200);
    const warnings = (response.payload.overview as { uiHints: { warnings: string[] } }).uiHints.warnings.join("\n");
    expect(warnings).toContain("账本升级没成");
    expect(warnings).toContain("第 1 章");
    expect(warnings).not.toContain("重新打开");
  });
});
