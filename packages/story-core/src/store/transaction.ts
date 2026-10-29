/**
 * 多文件事务：一条命令要写的所有文件，要么全写上，要么全不写。
 *
 * 成员两种：写（整份换成新内容，按字节）、删（写作版本 P2a：撤销、整本恢复要删存档里没有的文件）。
 * 做法（和旧引擎的定稿事务同一个思路，精简过）：
 *  1. 在 `.story-core-tx/<事务号>/` 下备份要覆盖或删掉的旧文件、写好所有新文件（都 fsync）；
 *  2. 写清单 manifest.json（`story-core-tx/2`，status = prepared，每个成员带换之前的哈希）——清单落盘之前，书里一个字节都没动；
 *  3. 逐个应用：写 = rename 新文件到位（单个 rename 是原子的）；删 = 删掉原件；
 *  4. 清单改成 applied，删掉事务目录。
 * 中途断电或进程被杀：下次写之前 `recoverTransactions` 把 prepared 的事务回滚（已换上的文件换回备份、
 * 新建的删掉、已删的从备份放回），applied 的只清目录。老的 `story-core-tx/1` 清单（只有写）照样回滚。调用方把版本号文件放在最后一个写，读的一方据此判断有没有读到一半。
 * 写入代次（REVISION_PATH）例外：换上了就不退回，回滚把内容全换回原样之后再换一个新的（写作版本 P1b 第 3 轮复核）。
 * 调用方把它放在第一个写：事务途中读到的依据带的是途中的代次，回滚后的书又是另一个代次，照途中读到的材料算的东西一律对不上
 * （只留着途中那个代次不够：途中开工读到新代次 + 一半新内容，回滚后代次没变、内容回到原样，开工依据又对上了）。
 *
 * 安全边界：书目录本身是软链时按真实路径算；目标文件或它的任何一级上级目录是软链，一律拒绝（不跟着链写到书外）。
 * 清单坏了的事务不知道换到哪一步，原样留着、写命令拒绝开工；作者确认后由 setAsideBrokenTransactions
 * 挪进 `.story-core-kept/` 留证（不删），那里攒到 KEPT_REPORT_THRESHOLD 份以上就在恢复报告里如实提醒。
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { withBookLock } from "./lock.js";
import { revisionWrite } from "./control.js";
import { assertInsideBook, KEPT_TX_DIR, REVISION_PATH, TX_DIR } from "./paths.js";

/** 留证区里超过这么多份，恢复报告里提醒一次（不自动删）。 */
export const KEPT_REPORT_THRESHOLD = 20;

export interface TxWrite {
  /** 相对书目录的路径。 */
  readonly path: string;
  /** 字符串按 UTF-8 写；字节原样写。 */
  readonly content: string | Uint8Array;
}

/** 内容一定是文本的写（控制文件这类）：不进事务直接原子写的地方也能用。 */
export interface TxTextWrite extends TxWrite {
  readonly content: string;
}

export interface TxDelete {
  readonly path: string;
  readonly delete: true;
}

/** 事务里的一个成员。删一个本来就不在的文件什么都不做。 */
export type TxChange = TxWrite | TxDelete;

export const isTxDelete = (change: TxChange): change is TxDelete => "delete" in change && change.delete === true;

/** 一个成员换之前、换之后的内容哈希（sha256，按字节）；null = 不存在。 */
export interface TxEffect {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

interface ManifestFile {
  readonly path: string;
  readonly kind: "write" | "delete";
  readonly existed: boolean;
  readonly slot: string;
  readonly beforeSha: string | null;
}

interface Manifest {
  readonly schema: "story-core-tx/2";
  readonly id: string;
  readonly createdAt: string;
  readonly status: "prepared" | "applied";
  readonly files: readonly ManifestFile[];
}

export const sha256Bytes = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

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

async function writeDurable(path: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content);
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

/** 按字节复制一份（fsync），返回内容哈希。 */
async function copyDurable(from: string, to: string): Promise<string> {
  const bytes = await readFile(from);
  await writeDurable(to, bytes);
  return sha256Bytes(bytes);
}

/** 把一份 prepared 的事务退回去：已换上的文件换回备份，事务新建的文件删掉，已删的放回；换过代次的，最后再换一个新代次。 */
async function rollback(bookDir: string, txDir: string, manifest: Manifest): Promise<void> {
  let revisionSwapped = false;
  for (const file of manifest.files) {
    if (file.kind === "delete") {
      const path = assertInsideBook(file.path);
      await assertPlainDirs(bookDir, dirname(path));
      const target = join(bookDir, path);
      // 原件还在 = 还没删，不用动；不在 = 已删，从备份放回（备份也不在 = 上次回滚到一半时已经放回去了）。
      if (await exists(target)) continue;
      const backup = join(txDir, "backup", file.slot);
      if (await exists(backup)) {
        await mkdir(dirname(target), { recursive: true });
        await rename(backup, target);
      }
      continue;
    }
    // 新文件还在暂存区 = 这个文件还没换上，书里是旧样子，不用动。
    if (await exists(join(txDir, "staged", file.slot))) continue;
    // 代次换上了不退回，等内容都换回去再换新的（见文件头）。
    if (file.path === REVISION_PATH) {
      revisionSwapped = true;
      continue;
    }
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
  if (revisionSwapped) {
    const fresh = revisionWrite(new Date());
    await assertPlainDirs(bookDir, dirname(fresh.path));
    const temporary = join(txDir, "revision.json.tmp");
    await writeDurable(temporary, fresh.content);
    await rename(temporary, join(bookDir, fresh.path));
  }
}

/** 写 / 删一批文件，要么全成、要么全不成。返回每个成员换之前、换之后的哈希（删一个本来不在的文件不算成员）。 */
export async function commitFiles(givenBookDir: string, changes: readonly TxChange[]): Promise<readonly TxEffect[]> {
  if (changes.length === 0) return [];
  const bookDir = await realBook(givenBookDir);
  await assertPlainDirs(bookDir, TX_DIR);
  const seen = new Set<string>();
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const txDir = join(bookDir, TX_DIR, id);
  await mkdir(join(txDir, "staged"), { recursive: true });
  await mkdir(join(txDir, "backup"), { recursive: true });
  const files: ManifestFile[] = [];
  const effects: TxEffect[] = [];
  try {
    for (const [index, change] of changes.entries()) {
      const path = assertInsideBook(change.path);
      if (seen.has(path)) throw new Error(`同一个事务里重复写同一个文件：${path}`);
      seen.add(path);
      const target = join(bookDir, path);
      const slot = String(index);
      const existed = await checkTarget(bookDir, path);
      const beforeSha = existed ? await copyDurable(target, join(txDir, "backup", slot)) : null;
      if (isTxDelete(change)) {
        if (!existed) continue;
        files.push({ path, kind: "delete", existed, slot, beforeSha });
        effects.push({ path, before: beforeSha, after: null });
        continue;
      }
      await writeDurable(join(txDir, "staged", slot), change.content);
      files.push({ path, kind: "write", existed, slot, beforeSha });
      effects.push({ path, before: beforeSha, after: sha256Bytes(change.content) });
    }
  } catch (error) {
    // 清单还没写，书里什么都没动：直接丢掉暂存。
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  if (files.length === 0) {
    await rm(txDir, { recursive: true, force: true });
    return [];
  }
  const manifest: Manifest = { schema: "story-core-tx/2", id, createdAt: new Date().toISOString(), status: "prepared", files };
  await writeManifest(txDir, manifest);
  try {
    for (const file of files) {
      const target = join(bookDir, file.path);
      await assertPlainDirs(bookDir, dirname(file.path));
      if (file.kind === "delete") {
        await unlink(target);
        continue;
      }
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
  return effects;
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

/** 认 v2 和老的 v1（v1 的成员都是写，没记换之前的哈希）。 */
function parseManifest(value: unknown): TxState {
  const manifest = value as { schema?: unknown; id?: unknown; createdAt?: unknown; status?: unknown; files?: unknown };
  if (manifest?.status !== "prepared" && manifest?.status !== "applied") return { kind: "broken" };
  if (!Array.isArray(manifest.files)) return { kind: "broken" };
  const base = (file: Record<string, unknown>) => typeof file?.path === "string" && typeof file.slot === "string" && typeof file.existed === "boolean";
  let files: ManifestFile[];
  if (manifest.schema === "story-core-tx/1") {
    if (!manifest.files.every(base)) return { kind: "broken" };
    files = (manifest.files as { path: string; slot: string; existed: boolean }[]).map((file) => ({ path: file.path, kind: "write", existed: file.existed, slot: file.slot, beforeSha: null }));
  } else if (manifest.schema === "story-core-tx/2") {
    const valid = manifest.files.every((file: Record<string, unknown>) => base(file) && (file.kind === "write" || file.kind === "delete") && (file.beforeSha === null || typeof file.beforeSha === "string"));
    if (!valid) return { kind: "broken" };
    files = manifest.files as ManifestFile[];
  } else {
    return { kind: "broken" };
  }
  return { kind: "manifest", manifest: { schema: "story-core-tx/2", id: String(manifest.id), createdAt: String(manifest.createdAt), status: manifest.status, files } };
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
    return parseManifest(JSON.parse(raw));
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
