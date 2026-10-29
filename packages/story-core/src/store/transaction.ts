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
 * 恢复的三条规矩（P1 第 19 轮复核）：
 *  - **代次只往前走**：写入代次换上了就不退回；收拾半截事务时两份代次（写入代次、工作稿代次）都不从任何备份换回。每退完一份、
 *    标它收拾过之前换新的：写入代次换新；碰过哪几章工作稿，那几章的工作稿号换新（只碰了工作稿代次、不知道哪章的，整本换新纪元）。
 *    途中有人读到了一半新内容，照它算的依据、版本号一律对不上；被杀在哪一步，重开再退一遍只会更新
 *    （写作版本 P1b 第 3 轮、P1 第 18 轮 AF1、第 19 轮 AG2）。写代次的调用方把它放在第一个写。
 *    进程内写到一半失败（一直拿着书锁、备份是刚拍的）照原样换回工作稿代次：开工前读到的版本号照样能存，途中读到的对不上。
 *  - **不毁唯一副本**：要盖掉 / 删掉的文件，盘上现在的内容不是这份事务写的（清单记着写了什么，核不上；老格式核不了），
 *    先原样另存（store/saved-copies.ts）再动——升级前后的版本混着用过，残留的事务可能比现在的稿还旧（AG3）。另存不下就停。
 *  - **失败就挡住**：哪一份退不下去（老格式的也一样），比它先开工的一份都不退、它自己不标收拾过，写命令如实拒绝开工（AG1）。
 * 没收拾的事务有好几份（老格式残留 + 核心的）：按开工先后倒着退（后开工的先退），同一个文件谁先谁后分不清就不退、如实报。
 *
 * 安全边界：书目录本身是软链时按真实路径算；目标文件或它的任何一级上级目录是软链，一律拒绝（不跟着链写到书外）。
 * 清单坏了的事务不知道换到哪一步，原样留着、写命令拒绝开工；作者确认后由 setAsideBrokenTransactions
 * 挪进 `.story-core-kept/` 留证（不删），那里攒到 KEPT_REPORT_THRESHOLD 份以上就在恢复报告里如实提醒。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import {
  hasPendingLegacyTransactions,
  LegacyResidueError,
  markLegacyTransactionRecovered,
  scanLegacyTransactions,
  tidyLegacyTransactions,
  undoLegacyTransaction,
  type PendingLegacyTransaction,
} from "./legacy-transaction.js";
import { withBookLock } from "./lock.js";
import { draftGensWrite, freshDraftGensWrite, readDraftGens, revisionWrite } from "./control.js";
import { assertInsideBook, DRAFT_GENS_PATH, draftChapterOfPath, isControlPath, KEPT_TX_DIR, REVISION_PATH, TX_DIR } from "./paths.js";
import { moveFileInBook, readFileInBook, writeFileInBook } from "./safe-fs.js";
import { saveCopyBeforeRestore } from "./saved-copies.js";

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
  /** 这次写的内容的 sha256（P1 第 19 轮）：回滚时盘上的还是它，就是这次写到一半的，换回不用另存。老清单没有。 */
  readonly wrote?: string;
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

/** 事务目录里新建一个文件（暂存、备份）：只新建、不跟软链，落盘。权限和以前一样受 umask 管。 */
async function createDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o666);
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeManifest(bookDir: string, txDir: string, manifest: Manifest): Promise<void> {
  await writeFileInBook(bookDir, join(txDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { label: "transaction manifest" });
}

/** 退回一份做了什么：真换上过文件没有、碰了哪几章工作稿、碰没碰工作稿代次（调用方据此换代次）。 */
interface RollbackResult {
  readonly changed: boolean;
  readonly draftChapters: readonly number[];
  readonly gensTouched: boolean;
}

/**
 * 回滚要盖掉 / 删掉 target 之前：盘上现在的内容既不是这次写的（wrote），也不是要换回的，就先另存（见文件头「不毁唯一副本」）。
 * 目标是软链、不是普通文件，拒绝。
 */
async function keepForeignCurrent(bookDir: string, input: { readonly from: string; readonly path: string; readonly wrote?: string; readonly restore?: string }): Promise<void> {
  const target = join(bookDir, input.path);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`回滚目标不是普通文件，拒绝动：${input.path}`);
  const current = await readFile(target, "utf-8");
  if (current === input.restore) return;
  if (input.wrote !== undefined && digest(current) === input.wrote) return;
  await saveCopyBeforeRestore(bookDir, { from: input.from, path: input.path, content: current });
}

/**
 * 把一份 prepared 的事务退回去：已换上的文件换回备份，事务新建的文件删掉。写入代次不动；工作稿代次只有进程内失败
 * （`inProcess`）才换回，收拾半截事务时不动（见文件头）。不换代次：调用方看返回的，换代次（advanceEpochs）之后再清掉这份事务。
 */
async function rollback(bookDir: string, txDir: string, manifest: Manifest, inProcess = false): Promise<RollbackResult> {
  let changed = false;
  let gensTouched = false;
  const draftChapters = new Set<number>();
  for (const file of manifest.files) {
    // 新文件还在暂存区 = 这个文件还没换上，书里是旧样子，不用动。
    if (await exists(join(txDir, "staged", file.slot))) continue;
    // 换上过（包括上次回滚到一半已经换回去的）：书被这次写动过。
    changed = true;
    if (file.path === REVISION_PATH) continue;
    if (file.path === DRAFT_GENS_PATH) {
      gensTouched = true;
      if (!inProcess) continue;
    }
    const path = assertInsideBook(file.path);
    const chapter = draftChapterOfPath(path);
    if (chapter !== undefined) draftChapters.add(chapter);
    await assertPlainDirs(bookDir, dirname(path));
    const target = join(bookDir, path);
    const backup = join(txDir, "backup", file.slot);
    // 备份已经不在 = 上次回滚到一半时已经换回去了，不再动它。
    if (file.existed && !(await exists(backup))) continue;
    const restore = file.existed ? await readFile(backup, "utf-8") : undefined;
    await keepForeignCurrent(bookDir, { from: coreInstance(manifest), path, ...(file.wrote !== undefined ? { wrote: file.wrote } : {}), ...(restore !== undefined ? { restore } : {}) });
    if (!file.existed) await rm(target, { force: true });
    else await moveFileInBook(bookDir, backup, target, { label: "rollback target", expectSha: digest(restore!) });
  }
  return { changed, draftChapters: [...draftChapters], gensTouched };
}

async function writeControl(bookDir: string, write: TxWrite): Promise<void> {
  const path = assertInsideBook(write.path);
  await assertPlainDirs(bookDir, dirname(path));
  await mkdir(dirname(join(bookDir, path)), { recursive: true });
  await checkTarget(bookDir, path);
  // 同目录临时文件 + 一次 rename（safe-fs）：被杀在中间要么是旧的、要么是新的，不会是半截；途中路径被调换如实报错。
  await writeFileInBook(bookDir, join(bookDir, path), write.content, { label: "control file", createMode: 0o666 });
}

/**
 * 退完一份之后换代次（见文件头「代次只往前走」）：写入代次换新的；碰过的那几章工作稿号换新的（drafts 给了才换）；
 * 只碰了工作稿代次、说不清哪章的，整本换新纪元。
 */
async function advanceEpochs(bookDir: string, drafts?: { readonly chapters: readonly number[]; readonly gensTouched: boolean }): Promise<void> {
  await writeControl(bookDir, revisionWrite(new Date()));
  if (!drafts) return;
  if (drafts.chapters.length > 0) await writeControl(bookDir, draftGensWrite(await readDraftGens(bookDir), drafts.chapters, randomUUID()));
  else if (drafts.gensTouched) await writeControl(bookDir, freshDraftGensWrite());
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
      if (existed) await createDurable(join(txDir, "backup", slot), (await readFileInBook(bookDir, target, "transaction target"))!);
      await createDurable(join(txDir, "staged", slot), write.content);
      files.push({ path, existed, slot, wrote: digest(write.content) });
    }
  } catch (error) {
    // 清单还没写，书里什么都没动：直接丢掉暂存。
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  const manifest: Manifest = { schema: "story-core-tx/1", id, createdAt: new Date().toISOString(), status: "prepared", files };
  await writeManifest(bookDir, txDir, manifest);
  try {
    for (const file of files) {
      const target = join(bookDir, file.path);
      await assertPlainDirs(bookDir, dirname(file.path));
      await mkdir(dirname(target), { recursive: true });
      await moveFileInBook(bookDir, join(txDir, "staged", file.slot), target, { label: "transaction target", ...(file.wrote !== undefined ? { expectSha: file.wrote } : {}) });
    }
  } catch (error) {
    // 进程内失败：一直拿着书锁，工作稿代次照原样换回（见文件头），写入代次换新。
    const undone = await rollback(bookDir, txDir, manifest, true);
    if (undone.changed) await advanceEpochs(bookDir);
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  await writeManifest(bookDir, txDir, { ...manifest, status: "applied" });
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
      manifest.files.every((file) => typeof file?.path === "string" && typeof file.slot === "string" && typeof file.existed === "boolean" && (file.wrote === undefined || typeof file.wrote === "string"));
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

/** 一份核心事务的实例号（另存去重用，P1 第 20 轮 AH3）：事务号 + 清单指纹。回滚中清单不改，被杀了重来号不变。 */
function coreInstance(manifest: Manifest): string {
  return `${manifest.id}@${digest(JSON.stringify(manifest)).slice(0, 16)}`;
}

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
      if (isControlPath(file.path) || (await exists(join(txDir, "staged", file.slot)))) continue;
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
      // 退不下去、另存不下、换不了代次：整轮停、抛「残留」（不标收拾过，下次照样挡着；比它先开工的一份都不退）。
      try {
        const undone = await undoLegacyTransaction(bookDir, undo.name, ({ instance, path, content }) => saveCopyBeforeRestore(bookDir, { from: instance, path, content }));
        if (undone.changed) await advanceEpochs(bookDir, { chapters: undone.draftChapters, gensTouched: undone.gensTouched });
        await markLegacyTransactionRecovered(bookDir, undo.name);
      } catch (error) {
        throw error instanceof LegacyResidueError ? error : new LegacyResidueError(error);
      }
      continue;
    }
    const txDir = join(bookDir, TX_DIR, undo.name);
    try {
      const undone = await rollback(bookDir, txDir, undo.manifest!);
      if (undone.changed) await advanceEpochs(bookDir, { chapters: undone.draftChapters, gensTouched: undone.gensTouched });
    } catch {
      // 回滚不下去（清单指到书外、上级目录被换成软链、另存不下……）：原样留着，交给作者；比它先开工的也先不退（不然退到一半的书叠在没退的上面）。
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
