// @vitest-environment node
/**
 * 源码扫描（写作版本 P2a 设计第十一节）：检查类（核账 / 硬伤检查 / 内容审阅 / 查 AI 味）只有执行器一个入口，
 * 路由表、客户端、对话工具、按钮分发都不绕过它；改稿类（按核账改 / 去 AI 味 / 改写）同样（片 2C），想走法同样（片 2D）；
 * 老书上新核心只在登记的几处做（配方和专员里出现就报错）。
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

describe("改稿类只有执行器一个入口（片 2C）", () => {
  it("改写、按核账改、去 AI 味只在 draft.change 的改稿里和出稿流水线里调", async () => {
    expect(await filesMatching(SERVER, /\breviseDraftText\s*\(/u)).toEqual(["services/draft-change/edit.ts", "services/draft-change/revise-text.ts"]);
    expect(await filesMatching(SERVER, /\bfixByUnits\s*\(/u)).toEqual(["services/draft-change/edit.ts", "services/draft-pipeline/quality-steps.ts", "services/unit-fix.ts"]);
    expect(await filesMatching(SERVER, /\brunDeAiFlavorBatch\s*\(/u)).toEqual(["services/de-ai-flavor-batch.ts", "services/draft-change/edit.ts", "services/draft-service.ts"]);
  });

  it("对话工具、按钮分发不直接改稿：revise_draft 只交操作", async () => {
    expect(await filesMatching(join(SERVER, "agent"), /\b(?:reviseDraftText|fixByUnits|runDeAiFlavorBatch|applyAiDraft)\b/u)).toEqual([]);
  });

  it("路由表、界面的客户端里没有改稿类的 HTTP 口", async () => {
    const editPath = /["'`]\/api\/draft\/(?:revision|de-ai-flavor)\b/u;
    expect(await filesMatching(join(SERVER, "routes"), editPath)).toEqual([]);
    expect(await filesMatching(join(SRC, "api"), editPath)).toEqual([]);
  });
});

describe("想走法只有执行器一个入口（片 2D）", () => {
  it("章纲员出走法、核账员核走法只在 plan.propose 配方里调", async () => {
    expect(await filesMatching(SERVER, /\b(?:proposeDirections|checkDirections)\s*\(/u)).toEqual(["editorial/brainstorm.ts", "services/operations/recipes/plan-propose.ts"]);
  });

  it("对话工具、按钮分发里没有 P2a 前的想走法工具名", async () => {
    expect(await filesMatching(join(SERVER, "agent"), /["']brainstorm_chapter["']/u)).toEqual([]);
    expect(await filesMatching(join(SERVER, "routes"), /["']brainstorm_chapter["']/u)).toEqual([]);
  });
});

describe("定稿只有执行器一个入口（片 4A）", () => {
  it("定稿命令只在 commit.prepare 配方里调；清单只在那里出", async () => {
    expect(await filesMatching(SERVER, /\bchapterCommit\b/u)).toEqual(["services/operations/recipes/commit-prepare.ts"]);
    expect(await filesMatching(SERVER, /\bprepareChapterCommit\s*\(/u)).toEqual(["editorial/commit-flow.ts", "services/operations/recipes/commit-prepare.ts"]);
  });

  it("对话工具、按钮分发、界面里没有片 4A 前的定稿入口名", async () => {
    const legacy = /["'](?:commit_preview|commit_apply)["']/u;
    expect(await filesMatching(join(SERVER, "agent"), legacy)).toEqual([]);
    expect(await filesMatching(join(SERVER, "routes"), legacy)).toEqual([]);
  });
});

describe("撤销 / 恢复 / 裁剪只有执行器一个入口（片 4C）", () => {
  it("核心撤销 / 恢复的计划和写回、裁剪只在 history.change 配方里调（存档模块是裁剪的定义处；单测助手给要「恢复过」前提的测试用）", async () => {
    expect(await filesMatching(SERVER, /\b(?:planRevert|planRestore|historyApply|lastUndoable)\b/u)).toEqual(["lib/history-test-helpers.ts", "services/operations/recipes/history-change.ts"]);
    expect(await filesMatching(SERVER, /\b(?:planPrune|applyPrune)\s*\(/u)).toEqual(["lib/snapshot.ts", "services/operations/recipes/history-change.ts"]);
  });

  it("对话工具、按钮分发、路由里没有片 4C 前的撤销 / 裁剪入口名", async () => {
    const legacy = /["'](?:manage_snapshots|prune_snapshots|undo_last_change|prune-confirm)["']/u;
    expect(await filesMatching(join(SERVER, "agent"), legacy)).toEqual([]);
    expect(await filesMatching(join(SERVER, "routes"), legacy)).toEqual([]);
  });
});

describe("改账只有执行器一个入口（片 3B）", () => {
  it("记裁定、理线索只在 ledger.change 配方里调", async () => {
    expect(await filesMatching(SERVER, /\bdecisionRecord\b/u)).toEqual(["services/operations/recipes/ledger-change.ts"]);
    expect(await filesMatching(SERVER, /\breviewOpenThreads\s*\(/u)).toEqual(["editorial/thread-review.ts", "services/operations/recipes/ledger-change.ts"]);
  });

  it("对话工具、按钮分发、界面里没有 P2a 前的改账入口名", async () => {
    const legacy = /["'](?:manage_ledger|ledger_decision|ledger-confirm)["']/u;
    expect(await filesMatching(join(SERVER, "agent"), legacy)).toEqual([]);
    expect(await filesMatching(join(SERVER, "routes"), legacy)).toEqual([]);
    // 界面只留老会话回放用的步骤名（manage_ledger → 「改账」），按钮那两样都没了。
    expect((await filesMatching(SRC, /["'](?:ledger_decision|ledger-confirm)["']/u)).filter((file) => !file.startsWith("server/"))).toEqual([]);
  });
});

/** 路由以外登记过的几处（设计第十一节；定稿预览那处随片 4A 删了，定稿走执行器受理之前那处）。 */
const ON_CORE_CALLERS: Readonly<Record<string, string>> = {
  "book/mirror/ensure.ts": "定义处",
  "services/operations/executor.ts": "submitOperation 受理之前",
};

it("老书上新核心（ensureBookOnCore）只在登记的几处调：开书 / 读书的路由、导入、受理之前", async () => {
  const callers = (await filesMatching(SERVER, /\bensureBookOnCore\s*\(/u)).filter((file) => !file.startsWith("routes/"));
  expect(callers).toEqual(Object.keys(ON_CORE_CALLERS).sort());
});
