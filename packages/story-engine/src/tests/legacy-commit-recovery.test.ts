import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMIT_TRANSACTION_ACTIVE_RETENTION,
  COMMIT_TRANSACTION_ARCHIVE_RETENTION,
  formatCommitRecoveryNotice,
  listCommitRecoveryNotices,
  recoverProjectCommitTransactions,
  withProjectCommitLock,
} from "../legacy-commit-recovery.js";
import { buildStateOverview } from "../state-overview.js";
import { createStoryProject } from "../project-store.js";

// 老定稿链已删（重构 P7）；这里锁住的是老版本中途崩溃留下的事务残留怎么收。
// 残留按老定稿链写盘的格式手工造：manifest.json（version 2）+ backups/ 下的原文件。

describe("老定稿链事务残留的恢复", () => {
  it.skipIf(process.platform === "win32")("软链别名和原路径共用一把锁", async () => {
    const projectDir = await createFixtureProject();
    const aliasDir = `${projectDir}-alias`;
    await symlink(projectDir, aliasDir);
    const entered: string[] = [];
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = withProjectCommitLock(projectDir, async () => {
      entered.push("first");
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = withProjectCommitLock(aliasDir, async () => {
      entered.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(entered).toEqual(["first"]);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "second"]);
  });

  it("锁可重入：持锁时再要同一本书的锁不会死等", async () => {
    const projectDir = await createFixtureProject();
    const result = await withProjectCommitLock(projectDir, () => withProjectCommitLock(projectDir, async () => "inner"));
    expect(result).toBe("inner");
  });

  it("staged 残留：能核对的备份还原，核不了的新建文件原地保留，标 recovered 放行", async () => {
    const projectDir = await createFixtureProject();
    const stateRelativePath = join("characters", "guo-xu", "state.json");
    const statePath = join(projectDir, stateRelativePath);
    const originalState = await readFile(statePath, "utf-8");
    await writeStagedResidue(projectDir, 9, [
      { relativePath: stateRelativePath, previous: originalState },
      { relativePath: join("chapters", "0009.md") },
    ]);
    await writeFile(statePath, "{\"characterId\":\"guo-xu\",\"emotion\":\"partial-crash-corruption\"}\n", "utf-8");
    await writeFile(join(projectDir, "chapters", "0009.md"), "partial chapter write", "utf-8");

    await recoverProjectCommitTransactions(projectDir);

    await expect(readFile(statePath, "utf-8")).resolves.toBe(originalState);
    await expect(readFile(join(projectDir, "chapters", "0009.md"), "utf-8")).resolves.toBe("partial chapter write");
    await expect(readTransactionStatus(projectDir, 9)).resolves.toBe("recovered");
    const manifest = await readFile(join(projectDir, ".story-engine-tx", "commit-chapter-0009", "manifest.json"), "utf-8");
    expect(manifest).toMatch(/"recoveryIssues"/u);
    // 已 recovered 的残留不再重复处理，也不会再拦住读盘。
    await expect(recoverProjectCommitTransactions(projectDir)).resolves.toBeUndefined();
  });

  it("快照撤销留下的空目录壳直接清掉，不把书锁死", async () => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0003");
    await mkdir(join(txDir, "snapshot", "chapters"), { recursive: true });
    await mkdir(join(txDir, "chapters"), { recursive: true });

    await recoverProjectCommitTransactions(projectDir);

    await expect(access(txDir)).rejects.toThrow();
    await expect(access(join(projectDir, ".story-engine-tx"))).resolves.toBeUndefined();
  });

  it("没有 manifest 却有文件的事务目录：拒绝读盘、一个字不动", async () => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0004");
    await mkdir(join(txDir, "snapshot"), { recursive: true });
    await writeFile(join(txDir, "snapshot", "stray.txt"), "unidentified residue", "utf-8");

    await expect(recoverProjectCommitTransactions(projectDir)).rejects.toThrow(/Unreadable commit transaction residue/iu);
    await expect(readFile(join(txDir, "snapshot", "stray.txt"), "utf-8")).resolves.toBe("unidentified residue");
  });

  it.skipIf(process.platform === "win32")("事务根目录是软链：拒绝读盘", async () => {
    const projectDir = await createFixtureProject();
    const outsideTxRoot = await mkdtemp(join(tmpdir(), "story-engine-outside-tx-"));
    await symlink(outsideTxRoot, join(projectDir, ".story-engine-tx"));

    await expect(recoverProjectCommitTransactions(projectDir)).rejects.toThrow(/Unsafe commit transaction root/iu);
    await expect(readdir(outsideTxRoot)).resolves.toEqual([]);
  });

  it.each([
    ["truncated", "{not-json"],
    ["chapter mismatch", JSON.stringify(validSnapshotOnlyManifest(2))],
    ["unsafe changed path", JSON.stringify({ ...validSnapshotOnlyManifest(1), appliedChangedFiles: ["chapters/0002.md"] })],
  ])("只有快照清单的残留（%s）：拒绝读盘", async (_label, manifestText) => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(txDir, "snapshot-manifest.json"), manifestText, "utf-8");

    await expect(recoverProjectCommitTransactions(projectDir)).rejects.toThrow(/snapshot|residue|manifest|unsafe/iu);
    await expect(access(txDir)).resolves.toBeUndefined();
  });

  it("合格的快照清单残留当审计证据留着", async () => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(txDir, "snapshot-manifest.json"), `${JSON.stringify(validSnapshotOnlyManifest(1), null, 2)}\n`, "utf-8");

    await expect(recoverProjectCommitTransactions(projectDir)).resolves.toBeUndefined();
    await expect(access(txDir)).resolves.toBeUndefined();
  });

  it("放行但没回滚干净的残留持续上浮：通知列出来、总览 warnings 里有，文案不带绝对路径", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "chapters", "0003.md"), "half-applied chapter kept on disk", "utf-8");
    await writeStagedResidue(projectDir, 3, [{ relativePath: "chapters/0003.md" }]);

    await recoverProjectCommitTransactions(projectDir);

    const notices = await listCommitRecoveryNotices(projectDir);
    expect(notices).toEqual([expect.objectContaining({ chapter: 3, transactionId: "commit-chapter-0003" })]);
    const text = formatCommitRecoveryNotice(notices[0]!);
    expect(text).toContain("transaction_recovered_partial");
    expect(text).toContain("第 3 章");
    expect(text).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
    const overview = await buildStateOverview({ projectDir, chapter: 4 });
    expect(overview.uiHints.warnings.join(" ")).toContain("transaction_recovered_partial");
  });

  it("applied 是成功终态：恢复扫描不改写它，也不算残留", async () => {
    const projectDir = await createFixtureProject();
    await writeSettledTransaction(projectDir, 5, "applied");

    await recoverProjectCommitTransactions(projectDir);
    await recoverProjectCommitTransactions(projectDir);

    await expect(readTransactionStatus(projectDir, 5)).resolves.toBe("applied");
    await expect(listCommitRecoveryNotices(projectDir)).resolves.toEqual([]);
  });

  it("超出保留窗口的干净事务原子归档；带分歧的和最近 N 章不归档", async () => {
    const projectDir = await createFixtureProject();
    const txRoot = join(projectDir, ".story-engine-tx");
    for (let chapter = 1; chapter <= 8; chapter += 1) {
      if (chapter === 2) continue;
      await writeSettledTransaction(projectDir, chapter, "applied");
    }
    await writeSettledTransaction(projectDir, 2, "recovered", ["Rollback failed for chapters/0002.md: TX_CONTENT_CHANGED"]);

    await recoverProjectCommitTransactions(projectDir);

    const topLevel = (await readdir(txRoot)).filter((name) => /^commit-chapter-\d+$/u.test(name)).sort();
    expect(topLevel).toEqual([
      "commit-chapter-0002",
      ...[4, 5, 6, 7, 8].map((chapter) => `commit-chapter-${String(chapter).padStart(4, "0")}`),
    ]);
    const archived = JSON.parse(await readFile(join(txRoot, "archive", "commit-chapter-0001", "manifest.json"), "utf-8")) as { status: string };
    expect(archived.status).toBe("applied");
    await expect(access(join(txRoot, "archive", "commit-chapter-0003"))).resolves.toBeUndefined();
    expect(COMMIT_TRANSACTION_ACTIVE_RETENTION).toBe(5);
  });

  it("归档区超过上限按章号删最旧的", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-archive-prune-"));
    const archiveRoot = join(projectDir, ".story-engine-tx", "archive");
    await mkdir(archiveRoot, { recursive: true });
    const total = COMMIT_TRANSACTION_ARCHIVE_RETENTION + 5;
    for (let chapter = 1; chapter <= total; chapter += 1) {
      const dir = join(archiveRoot, `commit-chapter-${String(chapter).padStart(4, "0")}`);
      await mkdir(join(dir, "backups"), { recursive: true });
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 2, chapter, status: "applied" }), "utf-8");
    }
    await mkdir(join(archiveRoot, "commit-chapter-0003--2"), { recursive: true });

    await recoverProjectCommitTransactions(projectDir);

    const left = (await readdir(archiveRoot)).sort();
    expect(left).toHaveLength(COMMIT_TRANSACTION_ARCHIVE_RETENTION);
    expect(left[0]).toBe(`commit-chapter-${String(total - COMMIT_TRANSACTION_ARCHIVE_RETENTION + 1).padStart(4, "0")}`);
    expect(left.at(-1)).toBe(`commit-chapter-${String(total).padStart(4, "0")}`);
  });
});

/** 按老定稿链的格式造一个写到一半的事务：previous 有值 = 事务前文件存在（备份了原文），没值 = 事务新建的文件。 */
async function writeStagedResidue(
  projectDir: string,
  chapter: number,
  files: readonly { readonly relativePath: string; readonly previous?: string }[],
): Promise<void> {
  const txDir = join(projectDir, ".story-engine-tx", `commit-chapter-${String(chapter).padStart(4, "0")}`);
  await mkdir(txDir, { recursive: true });
  const backups = [];
  for (const file of files) {
    if (file.previous === undefined) {
      backups.push({ relativePath: file.relativePath, existed: false });
      continue;
    }
    const backupPath = join("backups", file.relativePath);
    await mkdir(join(txDir, backupPath, ".."), { recursive: true });
    await writeFile(join(txDir, backupPath), file.previous, "utf-8");
    backups.push({
      relativePath: file.relativePath,
      existed: true,
      backupPath,
      sha256: createHash("sha256").update(file.previous, "utf-8").digest("hex"),
    });
  }
  await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
    version: 2,
    chapter,
    createdAt: "2026-07-13T00:00:00.000Z",
    files: files.map((file) => file.relativePath),
    backups,
    status: "staged",
  }, null, 2)}\n`, "utf-8");
}

async function writeSettledTransaction(
  projectDir: string,
  chapter: number,
  status: "applied" | "recovered",
  recoveryIssues?: readonly string[],
): Promise<void> {
  const txDir = join(projectDir, ".story-engine-tx", `commit-chapter-${String(chapter).padStart(4, "0")}`);
  await mkdir(txDir, { recursive: true });
  await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
    version: 2,
    chapter,
    createdAt: "2026-10-04T00:00:00.000Z",
    files: [],
    backups: [],
    status,
    ...(recoveryIssues ? { recoveryIssues } : {}),
  }, null, 2)}\n`, "utf-8");
}

function validSnapshotOnlyManifest(chapter: number): Record<string, unknown> {
  const chapterPath = `chapters/${String(chapter).padStart(4, "0")}.md`;
  return {
    status: "finalized",
    chapter,
    createdAt: "2026-07-13T00:00:00.000Z",
    finalizedAt: "2026-07-13T00:01:00.000Z",
    files: [{ relativePath: chapterPath, snapshotPath: null, rollbackAction: "delete_if_created" }],
    noFormalStateWriteConfirmed: true,
    productionApplyImplemented: false,
    routeWired: true,
    formalApplyMode: "chapter_only_v0a",
    stateWritesEnabled: false,
    defaultFormalWritesEnabled: false,
    cleanupPerformed: false,
    appliedChangedFiles: [chapterPath],
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function readTransactionStatus(projectDir: string, chapter: number): Promise<string> {
  const text = await readFile(
    join(projectDir, ".story-engine-tx", `commit-chapter-${String(chapter).padStart(4, "0")}`, "manifest.json"),
    "utf-8",
  );
  return (JSON.parse(text) as { status: string }).status;
}

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-recovery-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "恢复测试",
    genre: "xianxia",
    premise: "老版本中途崩溃留下的事务残留。",
    mainCharacterName: "Guo Xu / 主角",
  });
  return projectDir;
}
