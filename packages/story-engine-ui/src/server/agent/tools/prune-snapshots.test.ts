// @vitest-environment node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { afterEach, describe, expect, it } from "vitest";

import { createSnapshot, listSnapshots } from "../../lib/snapshot.js";
import { buildProjectRequestContext } from "../request-context.js";
import { pruneSnapshotsTool, runPruneSnapshots } from "./prune-snapshots.js";

const execFileAsync = promisify(execFile);

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prune-snapshots-tool-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "测试书" }), "utf-8");
  await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: [] }), "utf-8");
  return dir;
}

// 批量造史：--allow-empty commit（与快照提交同构，仓库 config 已由首个 createSnapshot 备好）。
async function seedSnapshots(dir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
  }
}

async function revParse(dir: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", ref]);
  return stdout.trim();
}

/** 造 30 条提交的历史（createSnapshot 顺带 init 仓库：初始快照 + 本条 = 2，再补 28 条）。 */
async function makeProjectWithHistory(): Promise<string> {
  const dir = await makeProject();
  await createSnapshot(dir, "起点");
  await seedSnapshots(dir, 28);
  return dir;
}

const savedSeDataDir = process.env.SE_DATA_DIR;
afterEach(() => {
  // 真裁会写 bundle 备份；测试一律经 SE_DATA_DIR 重定向到临时区，用完即还原，绝不碰真实 ~/.story-engine。
  if (savedSeDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = savedSeDataDir;
});

async function redirectBackupDir(): Promise<string> {
  const seDataDir = await mkdtemp(join(tmpdir(), "prune-snapshots-se-data-"));
  process.env.SE_DATA_DIR = seDataDir;
  return seDataDir;
}

type ToolResult = {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly summary: string;
  readonly blockedReason?: string;
  readonly keep?: number;
  readonly prunedCount?: number;
  readonly backupBundlePath?: string;
};

function executeTool(input: Record<string, unknown>, projectDir: string, userTurnText?: string): Promise<ToolResult> {
  const context = {
    requestContext: buildProjectRequestContext(projectDir, undefined, undefined, userTurnText),
  } as unknown as ToolExecutionContext;
  const execute = pruneSnapshotsTool.execute as unknown as (
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolResult>;
  return execute(input, context);
}

describe("runPruneSnapshots（壳函数）", () => {
  it("默认 dry-run 只预览：如实回报将裁多少，历史分毫不动、不建备份", async () => {
    const dir = await makeProjectWithHistory();
    const headBefore = await revParse(dir, "HEAD");
    const seDataDir = await redirectBackupDir();

    const result = await runPruneSnapshots(dir, { keep: 25 });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.prunedCount).toBe(5);
    expect(result.totalAfter).toBe(26);
    expect(result.freedCommits).toBe(4);
    expect(result.summary).toContain("预览");
    expect(result.summary).toContain("确认裁剪");
    expect(result.backupBundlePath).toBeUndefined();
    expect(await revParse(dir, "HEAD")).toBe(headBefore);
    expect((await listSnapshots(dir, 100)).length).toBe(30);
    // dry-run 连备份目录都不建
    await expect(access(join(seDataDir, "snapshot-backups"))).rejects.toThrow();
  }, 60_000);

  it("confirm=true 真裁：折成 base + bundle 备份落 SE_DATA_DIR，summary 不含裸提交哈希", async () => {
    const dir = await makeProjectWithHistory();
    const seDataDir = await redirectBackupDir();

    const result = await runPruneSnapshots(dir, { keep: 25, confirm: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.prunedCount).toBe(5);
    expect((await listSnapshots(dir, 100)).length).toBe(26); // 25 保留 + 1 base
    expect(result.backupBundlePath).toBeDefined();
    expect(result.backupBundlePath!.startsWith(seDataDir)).toBe(true);
    await access(result.backupBundlePath!);
    expect(result.summary).toContain("已把操作历史裁到最近 25 条");
    expect(result.summary).not.toMatch(/[0-9a-f]{40}/u); // 不把 baseCommitId 这类裸 id 念给用户
    // 如实声明：裁剪不在「撤销上一改动」链上，兜底是 bundle 备份（undo 撤不到纯历史折叠）
    expect(result.summary).toContain("不在「撤销上一改动」链上");
  }, 60_000);

  it("不足 keep 时 no-op 如实回报（预览与真裁都不落盘）", async () => {
    const dir = await makeProjectWithHistory();
    await redirectBackupDir();

    const dry = await runPruneSnapshots(dir, { keep: 200 });
    expect(dry.ok).toBe(true);
    expect(dry.prunedCount).toBe(0);
    expect(dry.summary).toContain("不需要裁剪");

    const real = await runPruneSnapshots(dir, { keep: 200, confirm: true });
    expect(real.ok).toBe(true);
    expect(real.prunedCount).toBe(0);
    expect(real.summary).toContain("无需裁剪");
    // dryRun 口径=「没落盘」：confirm:true 但无需裁剪、什么都没改 → 仍是 true（与预览/被拦/失败同口径）
    expect(real.dryRun).toBe(true);
    expect(real.backupBundlePath).toBeUndefined();
    expect((await listSnapshots(dir, 100)).length).toBe(30);
  }, 60_000);

  it("keep:0 按「0=默认」归一为缺省 200（与兄弟工具 nonnegative 惯例对齐，不再被 schema 拒/夹到 20）", async () => {
    const dir = await makeProjectWithHistory();

    // 壳函数层：keep:0 → 默认 200 → 30 条历史无需裁剪（若被夹到 20 会裁掉 10 条）
    const shell = await runPruneSnapshots(dir, { keep: 0 });
    expect(shell.ok).toBe(true);
    expect(shell.keep).toBe(200);
    expect(shell.prunedCount).toBe(0);
    expect((await listSnapshots(dir, 100)).length).toBe(30);

    // 工具层：schema nonnegative 收下 0（曾经 .positive() 直接拒），经归一同样按默认走
    const viaTool = await executeTool({ keep: 0 }, dir);
    expect(viaTool.ok).toBe(true);
    expect(viaTool.keep).toBe(200);
    expect(viaTool.prunedCount).toBe(0);
  }, 60_000);

  it("项目路径坏掉（不是目录）时 ok:false 如实回报原因，绝不静默", async () => {
    // 注意：lib 对「尚无快照仓库的正常项目」会惰性 init（与 createSnapshot 同语义）并如实回报无需裁剪，
    // 那不是失败路径；真正的失败=路径本身不可用（如被同名文件占位，git 连 init 都进不去）。
    const dir = await mkdtemp(join(tmpdir(), "prune-snapshots-broken-"));
    const filePath = join(dir, "not-a-dir");
    await writeFile(filePath, "占位文件", "utf-8");

    const result = await runPruneSnapshots(filePath);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("失败");
    // 铁律④：失败原因绝不内嵌本地绝对路径（复审实锤：此前 error.message 原文拼进 summary）
    expect(result.summary).toContain("(本地路径)");
    expect(result.summary).not.toContain(dir);
    // 失败=没落盘，dryRun 恒 true（与「没落盘」口径自洽）
    expect(result.dryRun).toBe(true);
  });

  it("真裁（confirm=true）失败同样 dryRun:true（没落盘）且摘要不含本地绝对路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prune-snapshots-broken-"));
    const filePath = join(dir, "not-a-dir");
    await writeFile(filePath, "占位文件", "utf-8");

    const result = await runPruneSnapshots(filePath, { confirm: true });

    expect(result.ok).toBe(false);
    expect(result.dryRun).toBe(true); // 曾报 false——真裁失败其实没落盘（update-ref 前失败整体回滚）
    expect(result.summary).toContain("裁剪操作历史失败");
    expect(result.summary).not.toContain(dir);
  });
});

describe("prune_snapshots 工具（意图门只守真裁）", () => {
  it("本轮用户原话没有确认裁剪意图 → confirm=true 被拦，历史不动", async () => {
    const dir = await makeProjectWithHistory();
    const headBefore = await revParse(dir, "HEAD");

    const result = await executeTool(
      { keep: 25, confirm: true },
      dir,
      "继续写第56章正文。只写这一章，不要写其他章。",
    );

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("user_turn_no_prune_confirm_intent");
    expect(result.summary).toContain("确认裁剪");
    // 被拦=没落盘（连预览都没跑），dryRun 按「没落盘」口径报 true（字段语义自洽，复审 P2）
    expect(result.dryRun).toBe(true);
    expect(await revParse(dir, "HEAD")).toBe(headBefore);
    expect((await listSnapshots(dir, 100)).length).toBe(30);
  }, 60_000);

  it("首次只说『裁剪一下快照历史』（无确认措辞）→ confirm=true 同样被拦，引导先预览", async () => {
    const dir = await makeProjectWithHistory();
    const headBefore = await revParse(dir, "HEAD");

    const result = await executeTool({ keep: 25, confirm: true }, dir, "裁剪一下快照历史");

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("user_turn_no_prune_confirm_intent");
    expect(await revParse(dir, "HEAD")).toBe(headBefore);
  }, 60_000);

  it("用户明确说「确认裁剪」→ confirm=true 真裁落盘", async () => {
    const dir = await makeProjectWithHistory();
    await redirectBackupDir();

    const result = await executeTool({ keep: 25, confirm: true }, dir, "确认裁剪快照历史");

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.prunedCount).toBe(5);
    expect((await listSnapshots(dir, 100)).length).toBe(26);
  }, 60_000);

  it("预览（不带 confirm）不过意图门：无关原话也照调照报", async () => {
    const dir = await makeProjectWithHistory();

    const result = await executeTool({ keep: 25 }, dir, "继续写第56章正文");

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.prunedCount).toBe(5);
    expect((await listSnapshots(dir, 100)).length).toBe(30); // 预览不动历史
  }, 60_000);

  it("缺 userTurnText（前端按钮/旧会话）→ 真裁放行（向后兼容）", async () => {
    const dir = await makeProjectWithHistory();
    await redirectBackupDir();

    const result = await executeTool({ keep: 25, confirm: true }, dir);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect((await listSnapshots(dir, 100)).length).toBe(26);
  }, 60_000);
});
