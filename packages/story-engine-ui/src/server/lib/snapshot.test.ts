import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile, access, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withProjectCommitLock } from "@actalk/story-engine";
import { createSnapshot, humanizeUndoLabel, listSnapshots, pruneSnapshots, restoreSnapshot, runWithSnapshot, undoLastChange } from "./snapshot.js";

const execFileAsync = promisify(execFile);

describe("humanizeUndoLabel（R2#3·操作历史 label 人话化）", () => {
  it("把 agent:<toolId> 映射成中文动作名", () => {
    expect(humanizeUndoLabel("agent:commit_apply")).toBe("定稿");
    expect(humanizeUndoLabel("agent:foundation_write")).toBe("更新故事资料");
  });

  it("恢复产物里嵌入的 agent:<toolId> 也一并人话化（不再露『恢复到：agent:commit_apply』）", () => {
    expect(humanizeUndoLabel("恢复到：agent:commit_apply")).toBe("恢复到：定稿");
    expect(humanizeUndoLabel("恢复前自动快照")).toBe("恢复前自动快照");
  });

  it("未登记工具 id 至少剥掉 agent: 前缀；非 agent 标签原样返回", () => {
    expect(humanizeUndoLabel("agent:some_new_tool")).toBe("some_new_tool");
    expect(humanizeUndoLabel("初始快照")).toBe("初始快照");
  });

  it("带细节后缀 agent:<tool>:<detail> → 「动作：细节」，让同类多次写入可辨（rerun2 P2）；不泄漏 tool id", () => {
    expect(humanizeUndoLabel("agent:foundation_write:建角色 顾长风")).toBe("更新故事资料：建角色 顾长风");
    expect(humanizeUndoLabel("agent:foundation_write:改资产 事故原始图纸")).toBe("更新故事资料：改资产 事故原始图纸");
    expect(humanizeUndoLabel("agent:foundation_write:建角色 顾长风")).not.toContain("foundation_write");
    // 恢复产物里带细节也一并人话化
    expect(humanizeUndoLabel("恢复到：agent:foundation_write:建角色 顾长风")).toBe("恢复到：更新故事资料：建角色 顾长风");
  });
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-snap-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "测试书" }), "utf-8");
  await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: [] }), "utf-8");
  return dir;
}

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function filesInCommit(projectDir: string, id: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", projectDir, "ls-tree", "-r", "--name-only", id]);
  return stdout.trim().split("\n").filter(Boolean);
}

describe("snapshot library", () => {
  it("creates a git repo and a labelled snapshot on first call", async () => {
    const dir = await makeProject();
    const snap = await createSnapshot(dir, "入库前快照");
    expect(snap.id).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.label).toBe("入库前快照");
    await access(join(dir, ".git")); // 不抛错即存在
  });

  it("lists snapshots newest-first", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "第一次");
    await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: ["a"] }), "utf-8");
    await createSnapshot(dir, "第二次");
    const list = await listSnapshots(dir);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.label).toBe("第二次");
    expect(list[0]!.timestamp).toBeGreaterThanOrEqual(list[1]!.timestamp);
  });

  it("restores modified file contents to the target snapshot", async () => {
    const dir = await makeProject();
    const snap = await createSnapshot(dir, "好状态");
    await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: ["bad"] }), "utf-8");
    await createSnapshot(dir, "坏状态");
    await restoreSnapshot(dir, snap.id);
    const content = JSON.parse(await readFile(join(dir, "story", "threads.json"), "utf-8")) as { threads: string[] };
    expect(content.threads).toEqual([]);
  });

  it("removes files created after the target snapshot", async () => {
    const dir = await makeProject();
    const snap = await createSnapshot(dir, "无新文件");
    await writeFile(join(dir, "story", "extra.json"), "{}", "utf-8");
    await createSnapshot(dir, "有新文件");
    await restoreSnapshot(dir, snap.id);
    await expect(access(join(dir, "story", "extra.json"))).rejects.toThrow();
  });

  it("removes the renamed file when a file was renamed after the target snapshot", async () => {
    const dir = await makeProject();
    const original = await readFile(join(dir, "story", "threads.json"), "utf-8");
    const snap = await createSnapshot(dir, "改名前");
    // 改名 = 写新删旧；内容一致会触发 git rename 侦测（R 而非 A）
    await writeFile(join(dir, "story", "renamed.json"), original, "utf-8");
    await unlink(join(dir, "story", "threads.json"));
    await createSnapshot(dir, "改名后");
    await restoreSnapshot(dir, snap.id);
    await expect(access(join(dir, "story", "renamed.json"))).rejects.toThrow();
    const restored = await readFile(join(dir, "story", "threads.json"), "utf-8");
    expect(restored).toBe(original);
  });

  it("removes files with non-ASCII names created after the target snapshot", async () => {
    const dir = await makeProject();
    const snap = await createSnapshot(dir, "中文文件名基线");
    await writeFile(join(dir, "story", "第12章.md"), "正文", "utf-8");
    await createSnapshot(dir, "新增中文文件");
    await restoreSnapshot(dir, snap.id);
    await expect(access(join(dir, "story", "第12章.md"))).rejects.toThrow();
  });

  it("rejects an invalid snapshot id without polluting history", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "唯一快照");
    const before = (await listSnapshots(dir)).length;
    await expect(restoreSnapshot(dir, "not-a-real-id")).rejects.toThrow();
    const after = (await listSnapshots(dir)).length;
    expect(after).toBe(before);
  });

  it("rejects commit residue before restore creates its pre-restore snapshot", async () => {
    const dir = await makeProject();
    const target = await createSnapshot(dir, "安全目标");
    const before = await listSnapshots(dir);
    const txDir = join(dir, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(txDir, "snapshot-manifest.json"), "{truncated", "utf-8");

    await expect(restoreSnapshot(dir, target.id)).rejects.toThrow(/snapshot|residue|manifest/iu);

    const after = await listSnapshots(dir);
    expect(after).toHaveLength(before.length);
    await expect(readFile(join(txDir, "snapshot-manifest.json"), "utf-8")).resolves.toBe("{truncated");
  });

  // PR C：撤销竞态。createSnapshot 持锁原子，但旧 withSnapshot 是「createSnapshot（持锁）→ run（锁外落盘）」，
  // 快照边界与落盘不在同一临界区 → 并发时另一操作的快照会切进 run 中间、捕获部分态（或撤销逃逸）。
  // runWithSnapshot 把「快照 + 落盘」罩进同一 project 锁，令二者原子。
  it("runWithSnapshot makes snapshot+write atomic: a concurrent snapshot never captures a partial multi-step write", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "基线"); // 先建库

    const part1Written = deferred();
    const gate = deferred();

    // A：两步写（part1 → 等门 → part2），整体必须原子——快照边界不能切进中间。
    const pA = runWithSnapshot(dir, "A", async () => {
      await writeFile(join(dir, "part1.txt"), "1", "utf-8");
      part1Written.resolve();
      await gate.promise;
      await writeFile(join(dir, "part2.txt"), "2", "utf-8");
      return "A-done";
    });

    await part1Written.promise; // A 已写 part1、停在门前（持锁中）
    const pB = createSnapshot(dir, "B-并发快照"); // 此刻并发触发一次快照
    gate.resolve();
    const [aResult, bSnap] = await Promise.all([pA, pB]);

    expect(aResult.result).toBe("A-done");
    expect(aResult.snapshot.id).toMatch(/^[0-9a-f]{40}$/);

    // B 的快照绝不能是部分态：含 part1 必含 part2，反之亦然。
    const files = await filesInCommit(dir, bSnap.id);
    expect(files.includes("part1.txt")).toBe(files.includes("part2.txt"));
  });

  it.skipIf(process.platform === "win32")("shares the canonical lock between a real snapshot path and its symlink alias", async () => {
    const dir = await makeProject();
    const alias = `${dir}-alias`;
    await symlink(dir, alias);
    const entered = deferred();
    const release = deferred();
    const snapshotRun = runWithSnapshot(dir, "别名共锁", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let aliasEntered = false;
    const aliasRun = withProjectCommitLock(alias, async () => {
      aliasEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aliasEntered).toBe(false);
    release.resolve();
    await Promise.all([snapshotRun, aliasRun]);
    expect(aliasEntered).toBe(true);
  });

  it("keeps history after restore (undo of undo is possible)", async () => {
    const dir = await makeProject();
    const snap = await createSnapshot(dir, "起点");
    await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: ["x"] }), "utf-8");
    await createSnapshot(dir, "改动");
    await restoreSnapshot(dir, snap.id);
    const list = await listSnapshots(dir);
    const labels = list.map((s) => s.label);
    expect(labels[0]).toContain("恢复到");
    expect(labels).toContain("改动"); // 历史没有被抹掉
  });
});

// C 批：对话里「撤销上一步」。恢复到最近一个『内容与当前不同、非撤销产物』的检查点
// （每个 agent 写操作前都有检查点）。连续撤销逐步回退、跳过撤销自身产物、无可撤销时诚实 null。
describe("undoLastChange 对话撤销", () => {
  // 真书永远有基线文件（project.json 等），用 makeProject 而非空目录——空 commit 上 restoreSnapshot 的
  // `git checkout <id> -- .` 会因无文件报错，那不是真实场景。
  it("撤销最近一次未提交写入（含新增 untracked 文件），回到该写操作前", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "agent:foundation_write"); // 写操作前检查点
    await writeFile(join(dir, "world.json"), "新资料"); // 工具写入（未提交、untracked）
    const r = await undoLastChange(dir);
    expect(r).not.toBeNull();
    expect(r?.undoneLabel).toBe("更新故事资料");
    await expect(access(join(dir, "world.json"))).rejects.toThrow(); // 写入被撤销
  });

  it("没有可撤销的改动 → 返回 null（绝不谎称已撤销）", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "agent:foundation_write"); // 检查点后无任何改动
    expect(await undoLastChange(dir)).toBeNull();
  });

  it("连续撤销逐步回退，跳过撤销产物、不卡原地", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "agent:generate_draft"); // step1 前
    await writeFile(join(dir, "a.md"), "A"); // step1 写
    await createSnapshot(dir, "agent:commit_apply"); // step2 前（a.md 入库）
    await writeFile(join(dir, "b.md"), "B"); // step2 写
    expect((await undoLastChange(dir))?.undoneLabel).toBe("定稿"); // 撤 step2
    await expect(access(join(dir, "b.md"))).rejects.toThrow();
    expect(await readFile(join(dir, "a.md"), "utf-8")).toBe("A"); // a.md 仍在
    expect((await undoLastChange(dir))?.undoneLabel).toBe("出稿"); // 再撤 step1
    await expect(access(join(dir, "a.md"))).rejects.toThrow();
  });
});

// afterfix #2：runWithSnapshot 落盘收尾——每次写操作后把产物即时收进 git，工作树保持干净，
// 杜绝「最后一次写操作产物长期 dirty 残留」（Codex 三轮误判「入库没写盘」）。收尾 commit 标成产物、
// undo 与操作历史都跳过它，撤销语义完全不变。
describe("runWithSnapshot 落盘收尾·写后工作树干净（Codex afterfix #2）", () => {
  async function gitStatusPorcelain(dir: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain"]);
    return stdout.trim();
  }

  it("写操作后工作树干净——产物即时进 git，不再长期 dirty 残留", async () => {
    const dir = await makeProject();
    await runWithSnapshot(dir, "agent:commit_apply", async () => {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "0001.md"), "第一章正文");
      await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: ["新线索"] }));
      return { ok: true };
    });
    expect(await gitStatusPorcelain(dir)).toBe(""); // 入库后 git 干净（不再残留 chapters/threads 等 dirty）
  });

  it("收尾后 undo 仍精确撤销该写操作、且撤销后也干净（落盘收尾 commit 被 undo 跳过）", async () => {
    const dir = await makeProject();
    await runWithSnapshot(dir, "agent:commit_apply", async () => {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "0001.md"), "正文");
      return { ok: true };
    });
    const r = await undoLastChange(dir);
    expect(r?.undoneLabel).toBe("定稿");
    await expect(access(join(dir, "chapters", "0001.md"))).rejects.toThrow(); // 入库被撤销
    expect(await gitStatusPorcelain(dir)).toBe(""); // 撤销后也干净
  });

  it("连续两次 runWithSnapshot 逐步撤销：先撤入库、再撤出稿——收尾 commit 绝不被误当『重做』目标", async () => {
    const dir = await makeProject();
    await runWithSnapshot(dir, "agent:generate_draft", async () => {
      await mkdir(join(dir, "drafts"), { recursive: true });
      await writeFile(join(dir, "drafts", "a.md"), "A");
      return { ok: true };
    });
    await runWithSnapshot(dir, "agent:commit_apply", async () => {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "0001.md"), "B");
      return { ok: true };
    });
    expect((await undoLastChange(dir))?.undoneLabel).toBe("定稿"); // 撤 step2
    await expect(access(join(dir, "chapters", "0001.md"))).rejects.toThrow();
    expect(await readFile(join(dir, "drafts", "a.md"), "utf-8")).toBe("A"); // 出稿产物仍在（没被收尾 commit 带回）
    expect((await undoLastChange(dir))?.undoneLabel).toBe("出稿"); // 再撤 step1
    await expect(access(join(dir, "drafts", "a.md"))).rejects.toThrow();
  });
});

// 磁盘治理：pruneSnapshots 把旧史折叠成 base 提交。append-only 语义保留（base 承载被裁边界完整 tree、
// 裁前另有 bundle 备份），但最近 keep 条撤销链逐条可用、磁盘随 gc 真正回收。
describe("pruneSnapshots 磁盘治理（历史裁剪）", () => {
  async function commitCount(dir: string): Promise<number> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-list", "--count", "HEAD"]);
    return Number(stdout.trim());
  }

  async function revParse(dir: string, ref: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", ref]);
    return stdout.trim();
  }

  // 批量造史：直接打 --allow-empty commit（与快照提交同构，仓库 config 已由首个 createSnapshot 备好），
  // 比循环走 createSnapshot 快一个量级——本组测的是裁剪行为，不是建快照。
  async function seedSnapshots(dir: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
    }
  }

  it("250 条快照 keep=200 → 201 条（200+base）；base tree 完整检出无损；最近一条仍可撤销", async () => {
    const dir = await makeProject();
    await writeFile(join(dir, "story", "marker.md"), "边界标记", "utf-8");
    await createSnapshot(dir, "agent:foundation_write:建库"); // 顺带 init 仓库（初始快照 + 本条 = 2）
    await seedSnapshots(dir, 248);
    expect(await commitCount(dir)).toBe(250);
    // 裁后 base 应承载「第 50 条（从旧数）」的完整 tree；当前 HEAD tree 须分毫不差
    const boundaryTree = await revParse(dir, "HEAD~200^{tree}");
    const headTreeBefore = await revParse(dir, "HEAD^{tree}");
    const oldHead = await revParse(dir, "HEAD");
    const backupDir = await mkdtemp(join(tmpdir(), "se-prune-backup-"));

    const result = await pruneSnapshots(dir, { keep: 200, dryRun: false, backupDir });
    expect(result.dryRun).toBe(false);
    expect(result.prunedCount).toBe(50);
    expect(result.totalBefore).toBe(250);
    expect(result.totalAfter).toBe(201);
    expect(result.freedCommits).toBe(49);
    expect(await commitCount(dir)).toBe(201);
    await access(result.backupBundlePath!); // 裁前完整历史已备份到项目目录外

    // 当前完整状态不丢：HEAD tree 与工作树文件都与裁前一致
    expect(await revParse(dir, "HEAD^{tree}")).toBe(headTreeBefore);
    expect(await readFile(join(dir, "story", "marker.md"), "utf-8")).toBe("边界标记");

    // base 提交在链尾、消息注明折叠条数，tree == 被裁边界提交的 tree（完整无损）
    const list = await listSnapshots(dir, 300);
    expect(list).toHaveLength(201);
    const base = list[list.length - 1]!;
    expect(base.id).toBe(result.baseCommitId);
    expect(base.label).toBe("base: 已裁剪 50 条更早快照");
    expect(await revParse(dir, `${base.id}^{tree}`)).toBe(boundaryTree);
    const baseFiles = await filesInCommit(dir, base.id);
    expect(baseFiles).toContain("project.json");
    expect(baseFiles).toContain("story/threads.json");
    expect(baseFiles).toContain("story/marker.md");
    const { stdout: markerInBase } = await execFileAsync("git", ["-C", dir, "show", `${base.id}:story/marker.md`]);
    expect(markerInBase).toBe("边界标记");

    // 旧链已不可逐条撤销：reflog expire + gc 后，裁前 HEAD 提交对象被回收
    await expect(execFileAsync("git", ["-C", dir, "cat-file", "-e", oldHead])).rejects.toThrow();

    // 最近 keep 条撤销链逐条可用：裁后新写一步，撤销仍精确回退
    await runWithSnapshot(dir, "agent:foundation_write", async () => {
      await writeFile(join(dir, "world.json"), "新资料", "utf-8");
    });
    const r = await undoLastChange(dir);
    expect(r?.undoneLabel).toBe("更新故事资料");
    await expect(access(join(dir, "world.json"))).rejects.toThrow();
  }, 120_000);

  it("dry-run 只预览不落盘：不改历史、不建 base、连备份目录都不建", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    const headBefore = await revParse(dir, "HEAD");
    const backupDir = join(await mkdtemp(join(tmpdir(), "se-prune-dry-")), "backups");

    const result = await pruneSnapshots(dir, { keep: 25, dryRun: true, backupDir });
    expect(result.dryRun).toBe(true);
    expect(result.prunedCount).toBe(5);
    expect(result.totalAfter).toBe(26);
    expect(result.freedCommits).toBe(4);
    expect(result.baseCommitId).toBeUndefined();
    expect(result.backupBundlePath).toBeUndefined();
    expect(await commitCount(dir)).toBe(30);
    expect(await revParse(dir, "HEAD")).toBe(headBefore);
    await expect(access(backupDir)).rejects.toThrow();
  }, 60_000);

  it("不足 keep 时 no-op；重复 prune 幂等（既有 base 之上的真实快照 ≤ keep 即不再裁）", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    const backupDir = await mkdtemp(join(tmpdir(), "se-prune-idem-"));

    const noop = await pruneSnapshots(dir, { keep: 40, dryRun: false, backupDir });
    expect(noop.prunedCount).toBe(0);
    expect(noop.backupBundlePath).toBeUndefined(); // no-op 连备份都不建
    expect(await commitCount(dir)).toBe(30);

    const first = await pruneSnapshots(dir, { keep: 20, dryRun: false, backupDir });
    expect(first.prunedCount).toBe(10);
    expect(await commitCount(dir)).toBe(21);
    const headAfterFirst = await revParse(dir, "HEAD");

    const second = await pruneSnapshots(dir, { keep: 20, dryRun: false, backupDir });
    expect(second.prunedCount).toBe(0);
    expect(await commitCount(dir)).toBe(21);
    expect(await revParse(dir, "HEAD")).toBe(headAfterFirst);

    const list = await listSnapshots(dir, 50);
    expect(list[list.length - 1]?.label).toBe("base: 已裁剪 10 条更早快照"); // 计数不被重复 prune 虚增
  }, 60_000);

  it("裁过再涨过 keep 二次裁：旧 base 换新，totalAfter/freedCommits 不多报/少报 1（off-by-one 回归）", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    const backupDir = await mkdtemp(join(tmpdir(), "se-prune-twice-"));

    const first = await pruneSnapshots(dir, { keep: 20, dryRun: false, backupDir });
    expect(first.prunedCount).toBe(10);
    expect(await commitCount(dir)).toBe(21); // 20 保留 + 1 base

    await seedSnapshots(dir, 10); // 涨到 31 条（1 旧 base + 30 快照），再按 keep=20 裁
    const dry = await pruneSnapshots(dir, { keep: 20, dryRun: true, backupDir });
    expect(dry.prunedCount).toBe(10);
    expect(dry.totalBefore).toBe(31);
    expect(dry.totalAfter).toBe(21); // 旧 base 也出链：21 不是 22
    expect(dry.freedCommits).toBe(10); // 净释放 10 不是 9
    expect(await commitCount(dir)).toBe(31); // dry-run 不落盘

    const second = await pruneSnapshots(dir, { keep: 20, dryRun: false, backupDir });
    expect(second.totalAfter).toBe(21);
    expect(second.freedCommits).toBe(10);
    expect(await commitCount(dir)).toBe(21);
    const list = await listSnapshots(dir, 50);
    expect(list).toHaveLength(21);
    expect(list[list.length - 1]?.label).toBe("base: 已裁剪 20 条更早快照"); // 折叠计数累加 10+10
  }, 60_000);

  it("keep 下限夹逼到 20：传 1 按 20 裁，防误裁光", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    const backupDir = await mkdtemp(join(tmpdir(), "se-prune-clamp-"));

    const result = await pruneSnapshots(dir, { keep: 1, dryRun: false, backupDir });
    expect(result.keep).toBe(20);
    expect(result.prunedCount).toBe(10);
    expect(await commitCount(dir)).toBe(21);
  }, 60_000);

  // 真故障注入（非 mock）：SE_GIT_PATH 指向包装脚本，仅 gc 子命令返回 128，其余子命令原样转发真 git。
  // 验证 P2-2 修复：update-ref 成功后的 gc 失败 → 引用不回滚、结果照返、warning 如实上报。
  it.skipIf(process.platform === "win32")("update-ref 成功后 gc 失败：引用不回滚、裁剪结果照返并带 warning", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    const oldHead = await revParse(dir, "HEAD");
    const backupDir = await mkdtemp(join(tmpdir(), "se-prune-gcfail-backup-"));
    const wrapperDir = await mkdtemp(join(tmpdir(), "se-prune-gcfail-git-"));
    const wrapper = join(wrapperDir, "git-gc-fail.sh");
    await writeFile(
      wrapper,
      "#!/bin/sh\nfor a in \"$@\"; do\n  if [ \"$a\" = \"gc\" ]; then\n    echo \"fatal: injected gc failure\" >&2\n    exit 128\n  fi\ndone\nexec git \"$@\"\n",
      "utf-8",
    );
    await chmod(wrapper, 0o755);

    const prevGitPath = process.env.SE_GIT_PATH;
    process.env.SE_GIT_PATH = wrapper;
    let result!: Awaited<ReturnType<typeof pruneSnapshots>>;
    try {
      result = await pruneSnapshots(dir, { keep: 20, dryRun: false, backupDir });
    } finally {
      if (prevGitPath === undefined) delete process.env.SE_GIT_PATH;
      else process.env.SE_GIT_PATH = prevGitPath;
    }

    // gc 失败不抛错：裁剪视为完成，warning 如实说明「回收失败」而非谎称回滚
    expect(result.prunedCount).toBe(10);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("裁剪已完成");
    expect(result.warnings?.[0]).toContain("回收失败");
    // 引用停在新链头、绝不回滚：裁后 21 条（若回滚到 oldHead 会是 30 条，若仓库损坏会报错）
    expect(await commitCount(dir)).toBe(21);
    expect(await revParse(dir, "HEAD")).not.toBe(oldHead);
    const list = await listSnapshots(dir, 50);
    expect(list).toHaveLength(21);
    expect(list[list.length - 1]?.label).toBe("base: 已裁剪 10 条更早快照");
    // gc 没跑成，旧对象仍在盘上（磁盘晚点回收无妨）；仓库整体仍可用
    await execFileAsync("git", ["-C", dir, "cat-file", "-e", oldHead]);
    await execFileAsync("git", ["-C", dir, "fsck", "--no-dangling"]);
  }, 60_000);
});
