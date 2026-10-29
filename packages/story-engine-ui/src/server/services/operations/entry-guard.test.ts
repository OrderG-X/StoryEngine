// @vitest-environment node
/**
 * 源码扫描（写作版本 P2a 设计第十一节）：检查类（核账 / 硬伤检查 / 内容审阅 / 查 AI 味）只有执行器一个入口，
 * 路由表、客户端、对话工具、按钮分发都不绕过它；老书上新核心只在登记的几处做（配方和专员里出现就报错）。
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = dirname(SERVER);

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function filesMatching(dir: string, pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await sourceFiles(dir)) {
    if (pattern.test(await readFile(file, "utf8"))) hits.push(relative(dir, file).split("\\").join("/"));
  }
  return hits.sort();
}

describe("检查类只有执行器一个入口", () => {
  it("四个检查的跑法只有 inspect.run 配方调", async () => {
    const callers = await filesMatching(SERVER, /\b(?:runContinuityCheck|runQualityCheck|runReview|runFlavorCheck|freezeChapterText)\s*\(/u);
    expect(callers).toEqual(["services/inspect-service.ts", "services/operations/recipes/inspect-run.ts"]);
  });

  it("对话工具、按钮分发里没有 P2a 前的四个检查工具名", async () => {
    expect(await filesMatching(join(SERVER, "agent"), /["'](?:check_continuity|quality_check|ai_review|check_ai_flavor)["']/u)).toEqual([]);
  });

  it("路由表、界面的客户端里没有检查类的 HTTP 口", async () => {
    const inspectPath = /["'`]\/api\/(?:draft\/(?:ai-review|quality|ai-flavor|continuity)|continuity-check|quality-check|ai-review)\b/u;
    expect(await filesMatching(join(SERVER, "routes"), inspectPath)).toEqual([]);
    expect(await filesMatching(join(SRC, "api"), inspectPath)).toEqual([]);
  });
});

/** 路由以外登记过的几处；后三处在迁那一类操作的那片里删（设计第十一节）。 */
const ON_CORE_CALLERS: Readonly<Record<string, string>> = {
  "book/mirror/ensure.ts": "定义处",
  "services/operations/executor.ts": "submitOperation 受理之前",
  "agent/ledger-decisions.ts": "理账",
  "agent/tools/commit-preview.ts": "定稿预览",
  "editorial/brainstorm.ts": "想走法",
};

it("老书上新核心（ensureBookOnCore）只在登记的几处调：开书 / 读书的路由、导入、受理之前", async () => {
  const callers = (await filesMatching(SERVER, /\bensureBookOnCore\s*\(/u)).filter((file) => !file.startsWith("routes/"));
  expect(callers).toEqual(Object.keys(ON_CORE_CALLERS).sort());
});
