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
 * 写入代次（REVISION_PATH）例外：换上了就不退回。回滚只要真退回过文件，内容全换回原样之后就换一个新代次（写作版本 P1b
 * 第 3 轮复核；P1 第 18 轮 AF1 起不论这次写没写代次）：途中有人读到了一半新内容，回滚后内容、工作稿代次都回到原样，
 * 开工时记下的依据又全对上——换了代次，照途中读到的材料算的东西一律对不上。写代次的调用方把它放在第一个写。
 * 没收拾的事务有好几份（老格式残留 + 核心的）：按开工先后倒着退（后开工的先退），同一个文件谁先谁后分不清就不退、如实报。
 *
 * 安全边界：书目录本身是软链时按真实路径算；目标文件或它的任何一级上级目录是软链，一律拒绝（不跟着链写到书外）。
 * 清单坏了的事务不知道换到哪一步，原样留着、写命令拒绝开工；作者确认后由 setAsideBrokenTransactions
 * 挪进 `.story-core-kept/` 留证（不删），那里攒到 KEPT_REPORT_THRESHOLD 份以上就在恢复报告里如实提醒。
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import {
  hasPendingLegacyTransactions,
  LegacyResidueError,
  scanLegacyTransactions,
  tidyLegacyTransactions,
  undoLegacyTransaction,
  type PendingLegacyTransaction,
} from "./legacy-transaction.js";
import { withBookLock } from "./lock.js";
import { revisionWrite } from "./control.js";
import { assertInsideBook, KEPT_TX_DIR, REVISION_PATH, TX_DIR } from "./paths.js";

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

/** 把一份 prepared 的事务退回去：已换上的文件换回备份，事务新建的文件删掉；真换上过文件的，最后再换一个新代次（见文件头）。 */
async function rollback(bookDir: string, txDir: string, manifest: Manifest): Promise<void> {
  let changed = false;
  for (const file of manifest.files) {
    // 新文件还在暂存区 = 这个文件还没换上，书里是旧样子，不用动。
    if (await exists(join(txDir, "staged", file.slot))) continue;
    // 换上过（包括上次回滚到一半已经换回去的）：书被这次写动过。
    changed = true;
    // 代次换上了不退回，等内容都换回去再换新的。
    if (file.path === REVISION_PATH) continue;
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
  if (changed) {
    const fresh = revisionWrite(new Date());
    await assertPlainDirs(bookDir, dirname(fresh.path));
    await mkdir(dirname(join(bookDir, fresh.path)), { recursive: true });
    const temporary = join(txDir, "revision.json.tmp");
    await writeDurable(temporary, fresh.content);
    await rename(temporary, join(bookDir, fresh.path));
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

/** 有没有没收尾的事务（读的一方用：有就说明正在写或上次写断了）。老格式（升级前崩溃留下的）没收拾的也算。 */
export async function hasPendingTransactions(bookDir: string): Promise<boolean> {
  try {
    if ((await readdir(join(bookDir, TX_DIR))).length > 0) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return hasPendingLegacyTransactions(bookDir);
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

/** 一份要退的事务（老格式或核心的）：开工时间、会换回哪些文件（→ 换回成什么）。 */
interface Undo {
  readonly format: "legacy" | "core";
  readonly name: string;
  readonly createdAt: string;
  readonly restores: ReadonlyMap<string, string | null>;
  readonly manifest?: Manifest;
}

interface CoreScan {
  readonly prepared: readonly Undo[];
  readonly cleaned: readonly string[];
  readonly problems: readonly string[];
}

const digest = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

/** 核心事务逐个看清（只读）：要回滚的（prepared）带上它会换回哪些文件；坏的记进 problems；没清单 / applied 的只清目录。 */
async function scanCoreTransactions(bookDir: string): Promise<CoreScan> {
  const root = join(bookDir, TX_DIR);
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootStat) return { prepared: [], cleaned: [], problems: [] };
  // 事务根本身是软链或文件：里面的东西一样都不碰。
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { prepared: [], cleaned: [], problems: [TX_DIR] };
  const prepared: Undo[] = [];
  const cleaned: string[] = [];
  const problems: string[] = [];
  for (const name of (await listDir(root)) ?? []) {
    const txDir = join(root, name);
    const state = await inspect(txDir);
    if (state.kind === "broken") {
      problems.push(name);
      continue;
    }
    if (state.kind !== "manifest" || state.manifest.status !== "prepared") {
      // 没清单 = 书里没动过；applied = 已经全换上了。都只清目录。
      cleaned.push(name);
      continue;
    }
    const restores = new Map<string, string | null>();
    for (const file of state.manifest.files) {
      // 没换上的、代次（退的时候换新的，不换回）不算；路径不对的回滚时如实失败。
      if (file.path === REVISION_PATH || (await exists(join(txDir, "staged", file.slot)))) continue;
      let path: string;
      try {
        path = assertInsideBook(file.path);
      } catch {
        continue;
      }
      if (!file.existed) {
        restores.set(path, null);
        continue;
      }
      // 备份已经不在 = 上次回滚到一半时已经换回去了，这份不再动它。
      const backup = await readFile(join(txDir, "backup", file.slot), "utf-8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (backup !== undefined) restores.set(path, digest(backup));
    }
    prepared.push({ format: "core", name, createdAt: state.manifest.createdAt, restores, manifest: state.manifest });
  }
  return { prepared, cleaned, problems };
}

function legacyUndo(tx: PendingLegacyTransaction): Undo {
  return { format: "legacy", name: tx.name, createdAt: tx.createdAt, restores: new Map([...tx.restores].map(([path, before]) => [normalize(path), before])) };
}

/**
 * 退的先后（P1 第 18 轮 AF2）：按开工时间倒着退，后开工的先退——后开工的备份的正是先开工那份写到一半的样子，
 * 先退先开工的、再退后开工的，就把那份半截稿换回来了。两份换回同一个文件、换回的内容不一样、开工时间又分不清
 * （一样、读不出来）的，谁先退都可能错，一份都不退：返回分不清的那几份。
 */
function undoOrder(undos: readonly Undo[]): readonly Undo[] | { readonly ambiguous: readonly Undo[] } {
  const time = (undo: Undo): number => Date.parse(undo.createdAt);
  const ambiguous = new Set<Undo>();
  for (const [index, left] of undos.entries()) {
    for (const right of undos.slice(index + 1)) {
      const conflict = [...left.restores].some(([path, before]) => right.restores.has(path) && right.restores.get(path) !== before);
      if (!conflict) continue;
      if (!Number.isFinite(time(left)) || !Number.isFinite(time(right)) || time(left) === time(right)) {
        ambiguous.add(left);
        ambiguous.add(right);
      }
    }
  }
  if (ambiguous.size > 0) return { ambiguous: [...ambiguous] };
  const key = (undo: Undo): number => (Number.isFinite(time(undo)) ? time(undo) : Number.NEGATIVE_INFINITY);
  return [...undos].sort((left, right) => key(right) - key(left));
}

/**
 * 收拾上次没写完的事务：老格式残留（`.story-engine-tx/`，老版本崩溃留下的）和核心自己的一起，按开工先后倒着退，
 * 再收尾（清目录、归档）。只在书锁里调（写命令开工前、先读盘再定参数之前）。老格式收拾不了、或和别的事务分不清先后，
 * 抛 `LegacyResidueError`（写命令照「残留」如实失败）；核心的坏事务原样留着、记进 problems。
 */
export async function recoverTransactions(givenBookDir: string): Promise<RecoveryReport> {
  const bookDir = await realBook(givenBookDir);
  const legacy = await scanLegacyTransactions(bookDir);
  const core = await scanCoreTransactions(bookDir);
  const kept = await keptCount(bookDir);
  const report = (rolledBack: string[], cleaned: string[], problems: string[]): RecoveryReport => ({
    rolledBack,
    cleaned,
    problems,
    kept,
    keptOverLimit: kept > KEPT_REPORT_THRESHOLD,
  });
  const order = undoOrder([...legacy.map(legacyUndo), ...core.prepared]);
  const rolledBack: string[] = [];
  const problems = [...core.problems];
  if ("ambiguous" in order) {
    if (order.ambiguous.some((undo) => undo.format === "legacy")) {
      throw new LegacyResidueError(Object.assign(new Error("老格式残留和别的未完成写入改了同一个文件，分不清先后"), { code: "TX_OVERLAP_ORDER_UNKNOWN" }));
    }
    // 只有核心的分不清：都原样留着（不退也不清），交给作者。
    return report([], [], [...problems, ...order.ambiguous.map((undo) => undo.name)]);
  }
  for (const undo of order) {
    if (undo.format === "legacy") {
      await undoLegacyTransaction(bookDir, undo.name);
      continue;
    }
    const txDir = join(bookDir, TX_DIR, undo.name);
    try {
      await rollback(bookDir, txDir, undo.manifest!);
    } catch {
      // 回滚不下去（清单指到书外、上级目录被换成软链……）：原样留着，交给作者；比它先开工的也先不退（不然退到一半的书叠在没退的上面）。
      problems.push(undo.name);
      return report(rolledBack, [], problems);
    }
    rolledBack.push(undo.name);
    await rm(txDir, { recursive: true, force: true });
  }
  await tidyLegacyTransactions(bookDir);
  for (const name of core.cleaned) await rm(join(bookDir, TX_DIR, name), { recursive: true, force: true });
  return report(rolledBack, [...core.cleaned], problems);
}

/** 拿书锁收拾一遍（不在写命令里、要先把书收拾干净再看的：开书接上新核心、测试）。 */
export async function recoverBookTransactions(givenBookDir: string): Promise<RecoveryReport> {
  return withBookLock(givenBookDir, () => recoverTransactions(givenBookDir));
}

/**
 * 作者确认后，把收拾不了的坏事务挪进留证区（单次 rename，不删）。之后写命令就能照常开工。
 * 自己拿写锁；返回挪走了哪些、留证区现在共几份。
 */
export async function setAsideBrokenTransactions(givenBookDir: string): Promise<{ readonly moved: readonly string[]; readonly kept: number; readonly keptOverLimit: boolean }> {
  const bookDir = await realBook(givenBookDir);
  return withBookLock(bookDir, async () => {
    let problems: readonly string[];
    try {
      problems = (await recoverTransactions(bookDir)).problems;
    } catch (error) {
      // 老格式残留收拾不了不归留证区管（写命令照旧如实失败）：只挪核心自己的坏事务，别的一样不动。
      if (!(error instanceof LegacyResidueError)) throw error;
      problems = (await scanCoreTransactions(bookDir)).problems;
    }
    const moved: string[] = [];
    if (problems.length > 0) {
      await assertPlainDirs(bookDir, KEPT_TX_DIR);
      await mkdir(join(bookDir, KEPT_TX_DIR), { recursive: true });
      const stamp = Date.now().toString(36);
      for (const name of problems) {
        const from = name === TX_DIR ? join(bookDir, TX_DIR) : join(bookDir, TX_DIR, name);
        await rename(from, join(bookDir, KEPT_TX_DIR, `${stamp}-${name.replace(/[^\w.-]/gu, "_")}`));
        moved.push(name);
      }
    }
    const kept = await keptCount(bookDir);
    return { moved, kept, keptOverLimit: kept > KEPT_REPORT_THRESHOLD };
  });
}
