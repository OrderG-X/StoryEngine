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
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertInsideBook, TX_DIR } from "./paths.js";

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
  /** 处理不了、原样留着的（清单坏了）。留着不删，绝不当没发生。 */
  readonly problems: readonly string[];
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
    const target = join(bookDir, file.path);
    if (!file.existed) {
      await rm(target, { force: true });
      continue;
    }
    // 备份已经不在 = 上次回滚到一半时已经换回去了。
    const backup = join(txDir, "backup", file.slot);
    if (await exists(backup)) await rename(backup, target);
  }
}

export async function commitFiles(bookDir: string, writes: readonly TxWrite[]): Promise<void> {
  if (writes.length === 0) return;
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
      let existed = false;
      try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`目标不是普通文件，拒绝覆盖：${path}`);
        existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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

/** 收拾上次没写完的事务。只在写锁里调（写命令开工前）。 */
export async function recoverTransactions(bookDir: string): Promise<RecoveryReport> {
  const root = join(bookDir, TX_DIR);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rolledBack: [], cleaned: [], problems: [] };
    throw error;
  }
  const rolledBack: string[] = [];
  const cleaned: string[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const txDir = join(root, name);
    let raw: string | undefined;
    try {
      raw = await readFile(join(txDir, "manifest.json"), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw === undefined) {
      // 清单没落盘就断了：书里没动过。
      await rm(txDir, { recursive: true, force: true });
      cleaned.push(name);
      continue;
    }
    let manifest: Manifest;
    try {
      manifest = JSON.parse(raw) as Manifest;
      if (manifest.schema !== "story-core-tx/1" || !Array.isArray(manifest.files)) throw new Error("清单格式不对");
    } catch {
      problems.push(name);
      continue;
    }
    if (manifest.status === "prepared") {
      await rollback(bookDir, txDir, manifest);
      rolledBack.push(name);
    } else {
      cleaned.push(name);
    }
    await rm(txDir, { recursive: true, force: true });
  }
  return { rolledBack, cleaned, problems };
}
