/**
 * 多文件事务：一条命令要写的所有文件，要么全写上，要么全不写。
 *
 * 做法（和旧引擎的定稿事务同一个思路，精简过）：
 *  1. 在 `.story-core-tx/<事务号>/` 下备份要覆盖的旧文件、写好所有新文件（都 fsync）；
 *  2. 写清单 manifest.json（status = prepared）——清单落盘之前，书里一个字节都没动；
 *  3. 逐个 rename 新文件到位（单个 rename 是原子的）；
 *  4. 清单改成 applied，删掉事务目录。
 * 中途断电或进程被杀：下次写之前 `recoverTransactions` 把 prepared 的事务回滚（已换上的文件换回备份、
 * 新建的删掉），applied 的只清目录。调用方把版本号文件放在最后一个写，读的一方据此判断有没有读到一半。
 *
 * 安全边界：书目录本身是软链时按真实路径算；目标文件或它的任何一级上级目录是软链，一律拒绝（不跟着链写到书外）。
 * 清单坏了的事务不知道换到哪一步，原样留着、写命令拒绝开工；作者确认后由 setAsideBrokenTransactions
 * 挪进 `.story-core-kept/` 留证（不删），那里攒到 KEPT_REPORT_THRESHOLD 份以上就在恢复报告里如实提醒。
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { withBookLock } from "./lock.js";
import { assertInsideBook, KEPT_TX_DIR, TX_DIR } from "./paths.js";

/** 留证区里超过这么多份，恢复报告里提醒一次（不自动删）。 */
export const KEPT_REPORT_THRESHOLD = 20;

export interface TxWrite {
  /** 相对书目录的路径。 */
  readonly path: string;
  readonly content: string;
}

interface ManifestFile {
  readonly path: string;
  readonly existed: boolean;
  readonly slot: string;
}

interface Manifest {
  readonly schema: "story-core-tx/1";
  readonly id: string;
  readonly createdAt: string;
  readonly status: "prepared" | "applied";
  readonly files: readonly ManifestFile[];
}

export interface RecoveryReport {
  /** 回滚了的事务号。 */
  readonly rolledBack: readonly string[];
  /** 只清了目录的（已完成或还没开始换文件的）。 */
  readonly cleaned: readonly string[];
  /** 处理不了、原样留着的（清单坏了，或事务目录不是普通目录）。留着不删，绝不当没发生。 */
  readonly problems: readonly string[];
  /** 留证区里已经挪过去的坏事务份数。 */
  readonly kept: number;
  /** 留证区超过 KEPT_REPORT_THRESHOLD 份了。 */
  readonly keptOverLimit: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 书目录的真实路径（书目录本身是软链时跟到底）。 */
async function realBook(bookDir: string): Promise<string> {
  return realpath(bookDir);
}

/**
 * 从书目录往下逐级检查 relativeDir 的每一级：是软链或不是目录就拒绝。还不存在的那一级起不用查（之后 mkdir 建的是真目录）。
 */
async function assertPlainDirs(root: string, relativeDir: string): Promise<void> {
  if (relativeDir === "." || relativeDir === "") return;
  let current = root;
  for (const part of relativeDir.split(sep)) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`上级目录是软链或不是目录，拒绝写：${relativeDir}`);
    }
  }
}

/** 目标路径：在书里、上级目录全是真目录、自己不是软链也不是目录。返回 existed。 */
async function checkTarget(root: string, path: string): Promise<boolean> {
  await assertPlainDirs(root, dirname(path));
  try {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`目标不是普通文件，拒绝覆盖：${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeManifest(txDir: string, manifest: Manifest): Promise<void> {
  const temporary = join(txDir, "manifest.json.tmp");
  await writeDurable(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, join(txDir, "manifest.json"));
}

async function copyDurable(from: string, to: string): Promise<void> {
  await writeDurable(to, await readFile(from, "utf-8"));
}

/** 把一份 prepared 的事务退回去：已换上的文件换回备份，事务新建的文件删掉。 */
async function rollback(bookDir: string, txDir: string, manifest: Manifest): Promise<void> {
  for (const file of manifest.files) {
    // 新文件还在暂存区 = 这个文件还没换上，书里是旧样子，不用动。
    if (await exists(join(txDir, "staged", file.slot))) continue;
    const path = assertInsideBook(file.path);
    await assertPlainDirs(bookDir, dirname(path));
    const target = join(bookDir, path);
    if (!file.existed) {
      await rm(target, { force: true });
      continue;
    }
    // 备份已经不在 = 上次回滚到一半时已经换回去了。
    const backup = join(txDir, "backup", file.slot);
    if (await exists(backup)) await rename(backup, target);
  }
}

export async function commitFiles(givenBookDir: string, writes: readonly TxWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const bookDir = await realBook(givenBookDir);
  await assertPlainDirs(bookDir, TX_DIR);
  const seen = new Set<string>();
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const txDir = join(bookDir, TX_DIR, id);
  await mkdir(join(txDir, "staged"), { recursive: true });
  await mkdir(join(txDir, "backup"), { recursive: true });
  const files: ManifestFile[] = [];
  try {
    for (const [index, write] of writes.entries()) {
      const path = assertInsideBook(write.path);
      if (seen.has(path)) throw new Error(`同一个事务里重复写同一个文件：${path}`);
      seen.add(path);
      const target = join(bookDir, path);
      const slot = String(index);
      const existed = await checkTarget(bookDir, path);
      if (existed) await copyDurable(target, join(txDir, "backup", slot));
      await writeDurable(join(txDir, "staged", slot), write.content);
      files.push({ path, existed, slot });
    }
  } catch (error) {
    // 清单还没写，书里什么都没动：直接丢掉暂存。
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  const manifest: Manifest = { schema: "story-core-tx/1", id, createdAt: new Date().toISOString(), status: "prepared", files };
  await writeManifest(txDir, manifest);
  try {
    for (const file of files) {
      const target = join(bookDir, file.path);
      await assertPlainDirs(bookDir, dirname(file.path));
      await mkdir(dirname(target), { recursive: true });
      await rename(join(txDir, "staged", file.slot), target);
    }
  } catch (error) {
    await rollback(bookDir, txDir, manifest);
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  await writeManifest(txDir, { ...manifest, status: "applied" });
  await rm(txDir, { recursive: true, force: true });
}

/** 有没有没收尾的事务（读的一方用：有就说明正在写或上次写断了）。 */
export async function hasPendingTransactions(bookDir: string): Promise<boolean> {
  try {
    return (await readdir(join(bookDir, TX_DIR))).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type TxState =
  | { readonly kind: "no-manifest" }
  | { readonly kind: "manifest"; readonly manifest: Manifest }
  | { readonly kind: "broken" };

/** 看一个事务目录是什么情况。不是普通目录（软链、文件）、清单读不了，都算坏的。 */
async function inspect(txDir: string): Promise<TxState> {
  const stat = await lstat(txDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: "broken" };
  let raw: string;
  try {
    raw = await readFile(join(txDir, "manifest.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "no-manifest" };
    return { kind: "broken" };
  }
  try {
    const manifest = JSON.parse(raw) as Manifest;
    const valid =
      manifest.schema === "story-core-tx/1" &&
      (manifest.status === "prepared" || manifest.status === "applied") &&
      Array.isArray(manifest.files) &&
      manifest.files.every((file) => typeof file?.path === "string" && typeof file.slot === "string" && typeof file.existed === "boolean");
    return valid ? { kind: "manifest", manifest } : { kind: "broken" };
  } catch {
    return { kind: "broken" };
  }
}

async function listDir(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function keptCount(bookDir: string): Promise<number> {
  return (await listDir(join(bookDir, KEPT_TX_DIR)))?.length ?? 0;
}

/** 收拾上次没写完的事务。只在写锁里调（写命令开工前）。 */
export async function recoverTransactions(givenBookDir: string): Promise<RecoveryReport> {
  const bookDir = await realBook(givenBookDir);
  const kept = await keptCount(bookDir);
  const report = (rolledBack: string[], cleaned: string[], problems: string[]): RecoveryReport => ({
    rolledBack,
    cleaned,
    problems,
    kept,
    keptOverLimit: kept > KEPT_REPORT_THRESHOLD,
  });
  const root = join(bookDir, TX_DIR);
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootStat) return report([], [], []);
  // 事务根本身是软链或文件：里面的东西一样都不碰。
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return report([], [], [TX_DIR]);
  const rolledBack: string[] = [];
  const cleaned: string[] = [];
  const problems: string[] = [];
  for (const name of (await listDir(root)) ?? []) {
    const txDir = join(root, name);
    const state = await inspect(txDir);
    if (state.kind === "broken") {
      problems.push(name);
      continue;
    }
    if (state.kind === "manifest" && state.manifest.status === "prepared") {
      try {
        await rollback(bookDir, txDir, state.manifest);
      } catch {
        // 回滚不下去（清单指到书外、上级目录被换成软链……）：原样留着，交给作者。
        problems.push(name);
        continue;
      }
      rolledBack.push(name);
    } else {
      // 没清单 = 书里没动过；applied = 已经全换上了。都只清目录。
      cleaned.push(name);
    }
    await rm(txDir, { recursive: true, force: true });
  }
  return report(rolledBack, cleaned, problems);
}

/**
 * 作者确认后，把收拾不了的坏事务挪进留证区（单次 rename，不删）。之后写命令就能照常开工。
 * 自己拿写锁；返回挪走了哪些、留证区现在共几份。
 */
export async function setAsideBrokenTransactions(givenBookDir: string): Promise<{ readonly moved: readonly string[]; readonly kept: number; readonly keptOverLimit: boolean }> {
  const bookDir = await realBook(givenBookDir);
  return withBookLock(bookDir, async () => {
    const recovery = await recoverTransactions(bookDir);
    const moved: string[] = [];
    if (recovery.problems.length > 0) {
      await assertPlainDirs(bookDir, KEPT_TX_DIR);
      await mkdir(join(bookDir, KEPT_TX_DIR), { recursive: true });
      const stamp = Date.now().toString(36);
      for (const name of recovery.problems) {
        const from = name === TX_DIR ? join(bookDir, TX_DIR) : join(bookDir, TX_DIR, name);
        await rename(from, join(bookDir, KEPT_TX_DIR, `${stamp}-${name.replace(/[^\w.-]/gu, "_")}`));
        moved.push(name);
      }
    }
    const kept = await keptCount(bookDir);
    return { moved, kept, keptOverLimit: kept > KEPT_REPORT_THRESHOLD };
  });
}
