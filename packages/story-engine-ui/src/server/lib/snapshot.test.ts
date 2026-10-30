import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { recoverBookTransactions } from "@actalk/story-core";
import {
  CHAT_SESSIONS_EXCLUDE_LINE,
  SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR,
  applyPrune,
  clampPruneKeep,
  coreSnapshotLabel,
  createSnapshot,
  humanizeUndoLabel,
  listSnapshots,
  planPrune,
  snapshotKindOf,
} from "./snapshot.js";

const execFileAsync = promisify(execFile);

describe("humanizeUndoLabel（R2#3·操作历史 label 人话化）", () => {
  it("把 agent:<toolId> 映射成中文动作名", () => {
    expect(humanizeUndoLabel("agent:commit_apply")).toBe("定稿");
    expect(humanizeUndoLabel("agent:foundation_write")).toBe("改设定本");
  });

  it("恢复产物里嵌入的 agent:<toolId> 也一并人话化（不再露『恢复到：agent:commit_apply』）", () => {
    expect(humanizeUndoLabel("恢复到：agent:commit_apply")).toBe("恢复到：定稿");
    expect(humanizeUndoLabel("恢复前自动快照")).toBe("恢复前的自动存档");
  });

  it("未登记工具 id 至少剥掉 agent: 前缀；非 agent 标签原样返回", () => {
    expect(humanizeUndoLabel("agent:some_new_tool")).toBe("some_new_tool");
    expect(humanizeUndoLabel("初始快照")).toBe("初始快照");
  });

  it("带细节后缀 agent:<tool>:<detail> → 「动作：细节」，让同类多次写入可辨（rerun2 P2）；不泄漏 tool id", () => {
    expect(humanizeUndoLabel("agent:foundation_write:建角色 顾长风")).toBe("改设定本：建角色 顾长风");
    expect(humanizeUndoLabel("agent:foundation_write:改资产 事故原始图纸")).toBe("改设定本：改资产 事故原始图纸");
    expect(humanizeUndoLabel("agent:foundation_write:建角色 顾长风")).not.toContain("foundation_write");
    // 恢复产物里带细节也一并人话化
    expect(humanizeUndoLabel("恢复到：agent:foundation_write:建角色 顾长风")).toBe("恢复到：改设定本：建角色 顾长风");
  });
});

// 重构 P9：改设定走核心三条命令，存档点标签是 core:<命令>:<人话>，操作历史归「设定」一类、展示只用人话。
describe("改设定的核心命令存档点（card.write / card.fill / cards.import）", () => {
  it("三条命令都归设定类（bible）", () => {
    expect(snapshotKindOf(coreSnapshotLabel("card.write", "改设定：「林远」的「身份」改了"))).toBe("bible");
    expect(snapshotKindOf(coreSnapshotLabel("card.fill", "改设定：建了人物卡「苏晴」"))).toBe("bible");
    expect(snapshotKindOf(coreSnapshotLabel("cards.import", "搬老设定"))).toBe("bible");
  });

  it("人话标签原样给作者看，不露命令名", () => {
    const label = coreSnapshotLabel("card.fill", "改设定：建了人物卡「苏晴」 等 3 处");
    expect(humanizeUndoLabel(label)).toBe("改设定：建了人物卡「苏晴」 等 3 处");
    expect(humanizeUndoLabel(`恢复到：${label}`)).toBe("恢复到：改设定：建了人物卡「苏晴」 等 3 处");
    expect(humanizeUndoLabel(label)).not.toContain("card.fill");
  });
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-snap-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "测试书" }), "utf-8");
  await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: [] }), "utf-8");
  return dir;
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
});

describe("快照排除对话历史目录（.story-engine-ui/chat-sessions）", () => {
  const sessionsRel = join(".story-engine-ui", "chat-sessions");

  async function writeSession(dir: string, name: string, body: string): Promise<void> {
    await mkdir(join(dir, sessionsRel), { recursive: true });
    await writeFile(join(dir, sessionsRel, name), body, "utf-8");
  }

  it("新书：首个快照即写 info/exclude，会话文件不进 commit（撤销范围本来也不含对话）", async () => {
    const dir = await makeProject();
    await writeSession(dir, "s1.json", "聊天-1");
    const first = await createSnapshot(dir, "agent:generate_draft");
    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split(/\r?\n/u)).toContain(CHAT_SESSIONS_EXCLUDE_LINE);
    expect(await filesInCommit(dir, first.id)).not.toContain(`${SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR}/s1.json`);
    // 幂等回执目录仍随快照（设计如此）
    await mkdir(join(dir, ".story-engine-ui", "commit-idempotency"), { recursive: true });
    await writeFile(join(dir, ".story-engine-ui", "commit-idempotency", "r1.json"), "{}", "utf-8");
    const second = await createSnapshot(dir, "agent:commit_apply");
    expect(await filesInCommit(dir, second.id)).toContain(".story-engine-ui/commit-idempotency/r1.json");

  });

  it("旧书迁移：历史快照里已跟踪的会话文件被摘出索引（磁盘不动），新快照不再带它", async () => {
    const dir = await makeProject();
    await writeSession(dir, "s1.json", "旧聊天");
    // 模拟老版本：exclude 还不存在时建的仓库，会话文件被 add -A 卷进了历史
    await execFileAsync("git", ["-C", dir, "init"]);
    await execFileAsync("git", ["-C", dir, "config", "user.name", "StoryEngine"]);
    await execFileAsync("git", ["-C", dir, "config", "user.email", "snapshot@story-engine.local"]);
    await execFileAsync("git", ["-C", dir, "add", "-A"]);
    await execFileAsync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-m", "初始快照"]);
    const legacy = (await listSnapshots(dir)).at(-1)!; // listSnapshots 内部 ensureRepo → 已补 exclude + 摘索引
    expect(await filesInCommit(dir, legacy.id)).toContain(`${SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR}/s1.json`);
    expect(await readFile(join(dir, sessionsRel, "s1.json"), "utf-8")).toBe("旧聊天"); // 磁盘没动
    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split(/\r?\n/u)).toContain(CHAT_SESSIONS_EXCLUDE_LINE);

    // 新快照：会话文件已不在树里
    await writeFile(join(dir, "project.json"), JSON.stringify({ title: "改名后" }), "utf-8");
    const migrated = await createSnapshot(dir, "agent:foundation_write");
    expect(await filesInCommit(dir, migrated.id)).not.toContain(`${SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR}/s1.json`);
  });

  it("书目录本来就是 git 仓库、电脑上也没 git 身份：补一份本仓库身份，存档照样打得上（CI 跑手撞到）", async () => {
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const dir = await makeProject();
      await execFileAsync("git", ["-C", dir, "init"]);
      await createSnapshot(dir, "a");
      const { stdout } = await execFileAsync("git", ["-C", dir, "config", "--local", "user.email"]);
      expect(stdout.trim()).toBe("snapshot@story-engine.local");
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
    }
  });

  it("作者自己给书仓库配过身份的不动", async () => {
    const dir = await makeProject();
    await execFileAsync("git", ["-C", dir, "init"]);
    await execFileAsync("git", ["-C", dir, "config", "user.email", "me@example.com"]);
    await execFileAsync("git", ["-C", dir, "config", "user.name", "Me"]);
    await createSnapshot(dir, "a");
    const { stdout } = await execFileAsync("git", ["-C", dir, "config", "--local", "user.email"]);
    expect(stdout.trim()).toBe("me@example.com");
  });

  it("exclude 已有用户自定义内容时追加不覆盖、重复调用只写一次", async () => {
    const dir = await makeProject();
    await execFileAsync("git", ["-C", dir, "init"]);
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    await writeFile(join(dir, ".git", "info", "exclude"), "*.tmp", "utf-8"); // 无结尾换行
    await createSnapshot(dir, "a");
    await createSnapshot(dir, "b");
    const lines = (await readFile(join(dir, ".git", "info", "exclude"), "utf-8")).split(/\r?\n/u);
    expect(lines[0]).toBe("*.tmp");
    expect(lines.filter((line) => line === CHAT_SESSIONS_EXCLUDE_LINE)).toHaveLength(1);
  });
});

describe("裁剪操作历史：先算好、再照算好的裁（planPrune / applyPrune，片 4C）", () => {
  async function commitCount(dir: string): Promise<number> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-list", "--count", "HEAD"]);
    return Number(stdout.trim());
  }

  async function revParse(dir: string, ref: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", ref]);
    return stdout.trim();
  }

  // 批量造史：直接打 --allow-empty commit（与快照提交同构，仓库 config 已由首个 createSnapshot 备好）。
  async function seedSnapshots(dir: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
    }
  }

  async function planOf(dir: string, keep?: number) {
    const planned = await planPrune(dir, keep);
    if (planned.kind !== "plan") throw new Error("该裁");
    return planned.plan;
  }

  it("250 条快照 keep=200 → 201 条（200+base）；base 承载分界的整棵树；当前树、工作树分毫不差；裁前完整历史备份在书外", async () => {
    const dir = await makeProject();
    await writeFile(join(dir, "story", "marker.md"), "边界标记", "utf-8");
    await createSnapshot(dir, "agent:foundation_write:建库"); // 顺带 init 仓库（初始快照 + 本条 = 2）
    await seedSnapshots(dir, 248);
    expect(await commitCount(dir)).toBe(250);
    const boundaryTree = await revParse(dir, "HEAD~200^{tree}");
    const headTreeBefore = await revParse(dir, "HEAD^{tree}");
    const oldHead = await revParse(dir, "HEAD");

    const plan = await planOf(dir, 200);
    expect(plan).toMatchObject({ keep: 200, prunedCount: 50, totalBefore: 250, totalAfter: 201, oldHead });
    // 算好不动引用
    expect(await revParse(dir, "HEAD")).toBe(oldHead);

    const bundle = join(await mkdtemp(join(tmpdir(), "se-prune-backup-")), "b.bundle");
    expect(await applyPrune(dir, plan, bundle)).toEqual({ kind: "done", warnings: [] });
    expect(await revParse(dir, "HEAD")).toBe(plan.newHead);
    expect(await commitCount(dir)).toBe(201);
    await access(bundle);
    expect(await revParse(dir, "HEAD^{tree}")).toBe(headTreeBefore);
    expect(await readFile(join(dir, "story", "marker.md"), "utf-8")).toBe("边界标记");

    const list = await listSnapshots(dir, 300);
    expect(list).toHaveLength(201);
    const base = list[list.length - 1]!;
    expect(base.label).toBe("base: 已裁剪 50 条更早快照");
    expect(await revParse(dir, `${base.id}^{tree}`)).toBe(boundaryTree);
    const { stdout: markerInBase } = await execFileAsync("git", ["-C", dir, "show", `${base.id}:story/marker.md`]);
    expect(markerInBase).toBe("边界标记");
    // 旧链回收了
    await expect(execFileAsync("git", ["-C", dir, "cat-file", "-e", oldHead])).rejects.toThrow();
  }, 120_000);

  it("同一个分界算两次得同一个新链头；照算好的裁过一次再来（崩在回收那步）只补回收，不再裁", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    const plan = await planOf(dir, 20);
    expect((await planOf(dir, 20)).newHead).toBe(plan.newHead);
    const bundle = join(await mkdtemp(join(tmpdir(), "se-prune-idem-")), "b.bundle");
    expect((await applyPrune(dir, plan, bundle)).kind).toBe("done");
    expect(await commitCount(dir)).toBe(21);
    expect(await applyPrune(dir, plan, bundle)).toEqual({ kind: "done", warnings: [] });
    expect(await commitCount(dir)).toBe(21);
    expect(await revParse(dir, "HEAD")).toBe(plan.newHead);
  }, 60_000);

  it("算好之后又多了存档：一处不动，回 moved", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28);
    const plan = await planOf(dir, 20);
    await seedSnapshots(dir, 1);
    const head = await revParse(dir, "HEAD");
    const bundle = join(await mkdtemp(join(tmpdir(), "se-prune-moved-")), "b.bundle");
    expect(await applyPrune(dir, plan, bundle)).toEqual({ kind: "moved" });
    expect(await revParse(dir, "HEAD")).toBe(head);
    await expect(access(bundle)).rejects.toThrow();
  }, 60_000);

  it("不足 keep 时不用裁；裁过不再涨就不再裁；涨过再裁：旧 base 换新、折叠条数累加、条数不多不少", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28); // 共 30 条
    expect(await planPrune(dir, 40)).toEqual({ kind: "noop", keep: 40, totalBefore: 30 });
    const backups = await mkdtemp(join(tmpdir(), "se-prune-twice-"));
    await applyPrune(dir, await planOf(dir, 20), join(backups, "1.bundle"));
    expect(await commitCount(dir)).toBe(21);
    expect(await planPrune(dir, 20)).toEqual({ kind: "noop", keep: 20, totalBefore: 21 });

    await seedSnapshots(dir, 10); // 1 旧 base + 30 快照
    const second = await planOf(dir, 20);
    expect(second).toMatchObject({ prunedCount: 10, totalBefore: 31, totalAfter: 21 });
    await applyPrune(dir, second, join(backups, "2.bundle"));
    const list = await listSnapshots(dir, 50);
    expect(list).toHaveLength(21);
    expect(list[list.length - 1]?.label).toBe("base: 已裁剪 20 条更早快照");
  }, 60_000);

  it("keep 下限夹到 20、缺省 200：传 1 按 20 算", async () => {
    expect(clampPruneKeep(1)).toBe(20);
    expect(clampPruneKeep(0)).toBe(200);
    expect(clampPruneKeep(undefined)).toBe(200);
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28);
    expect(await planOf(dir, 1)).toMatchObject({ keep: 20, prunedCount: 10 });
  }, 60_000);

  // 真故障注入（非 mock）：SE_GIT_PATH 指向包装脚本，仅 gc 子命令返回 128，其余子命令原样转发真 git。
  it.skipIf(process.platform === "win32")("引用移成之后 gc 失败：引用不回滚、算裁完，警告如实说空间没收回来", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    await seedSnapshots(dir, 28);
    const oldHead = await revParse(dir, "HEAD");
    const plan = await planOf(dir, 20);
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
    let result;
    try {
      result = await applyPrune(dir, plan, join(wrapperDir, "b.bundle"));
    } finally {
      if (prevGitPath === undefined) delete process.env.SE_GIT_PATH;
      else process.env.SE_GIT_PATH = prevGitPath;
    }
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("裁好了");
    expect(await commitCount(dir)).toBe(21);
    expect(await revParse(dir, "HEAD")).not.toBe(oldHead);
    await execFileAsync("git", ["-C", dir, "cat-file", "-e", oldHead]);
    await execFileAsync("git", ["-C", dir, "fsck", "--no-dangling"]);
  }, 60_000);
});

describe("有收拾不了的半截事务：存档类入口都停下（P1 第 22 轮 AJ3）", () => {
  it("建存档点、算裁剪、照算好的裁都如实失败，稿不动、事务留着（恢复走核心命令，先收拾事务）", async () => {
    const dir = await makeProject();
    const DRAFT = "drafts/fast/chapter-0001.md";
    await mkdir(join(dir, "drafts", "fast"), { recursive: true });
    await writeFile(join(dir, DRAFT), "# 选定 A\n\n完整的 A。\n", "utf-8");
    await createSnapshot(dir, "完整 A");
    for (let i = 0; i < 25; i += 1) await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
    const planned = await planPrune(dir, 20);
    if (planned.kind !== "plan") throw new Error("该裁");
    // 一份退不下去的核心事务：备份多了一个链接，安全层拒绝换回。
    const tx = join(dir, ".story-core-tx", "stuck");
    await mkdir(join(tx, "backup"), { recursive: true });
    await mkdir(join(tx, "staged"), { recursive: true });
    await writeFile(join(tx, "backup", "0"), "# 更早 D\n\n更早的 D。\n", "utf-8");
    await execFileAsync("ln", [join(tx, "backup", "0"), join(dir, "linked-backup")]);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "stuck", createdAt: "2026-10-20T00:00:00Z", status: "prepared", files: [{ path: DRAFT, slot: "0", existed: true }] }));
    await writeFile(join(dir, DRAFT), "# 当前 C\n\n当前的 C。\n", "utf-8");
    expect((await recoverBookTransactions(dir)).problems).toEqual(["stuck"]);

    const residue = { code: "TX_RESIDUE" };
    await expect(createSnapshot(dir, "不该成功")).rejects.toMatchObject(residue);
    await expect(planPrune(dir, 20)).rejects.toMatchObject(residue);
    await expect(applyPrune(dir, planned.plan, join(dir, "..", "bundle"))).rejects.toMatchObject(residue);
    expect(await readFile(join(dir, DRAFT), "utf-8")).toBe("# 当前 C\n\n当前的 C。\n");
    expect((await readdir(join(dir, ".story-core-tx")))).toEqual(["stuck"]);
  });
});
