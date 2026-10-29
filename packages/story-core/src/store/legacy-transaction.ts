/**
 * 老定稿链（`.story-engine-tx/`）的事务恢复（写作版本 P1 第 17 轮复核 AE2/AE3：从界面的 book/ 层挪进核心）。
 *
 * 老定稿链本身已删（重构 P7，2026-10-18），这里只收老版本中途崩溃留下的残留。**收拾一本书的事务只有核心一处**：
 * `recoverTransactions`（transaction.ts）先收这里的老格式、再收核心自己的，写命令、`withSettledBook`、存档都走它——
 * 存稿、AI 换稿这类先读盘再定参数的，读到的一定是两种事务都收拾过的书。调用方必须已持书锁。
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { freshDraftGensWrite, revisionWrite } from "./control.js";
import { draftChapterOfPath } from "./paths.js";

/** 老定稿链的事务目录。 */
export const LEGACY_TX_DIR = ".story-engine-tx";

export interface CommitTransactionManifest {
  readonly version: 2;
  readonly chapter: number;
  readonly createdAt: string;
  readonly files: readonly string[];
  readonly backups: readonly CommitTransactionBackup[];
  readonly status: "staged" | "applied" | "failed" | "recovered";
  /** P1-6：回滚不完备的残留原因（新建文件无法自证为事务写入内容，原地保留并放行） */
  readonly recoveryIssues?: readonly string[];
}

export interface CommitTransactionBackup {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly backupPath?: string;
  readonly sha256?: string;
}

interface TransactionFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * #7：事务目录的活跃保留窗口——`.story-engine-tx/` 顶层按章号只保留最近 N 个
 * `commit-chapter-NNNN` 目录，更旧的「终态干净」目录（applied，或回滚干净的 recovered）
 * 归档进 `.story-engine-tx/archive/`（恢复扫描/残留通知只扫顶层，归档目录天然出扫描面）。
 * 归档用单次 rename(2)（同盘原子、无递归删除竞态）；归档区只留最近 LEGACY_TX_ARCHIVE_RETENTION 份。
 * 永不归档：recovered-with-issues（listLegacyRecoveryNotices 的持续上浮证据）、
 * staged/failed（未决事务，交给恢复路径收尾）、snapshot-manifest 目录（历史审计证据）。
 */
export const LEGACY_TX_ACTIVE_RETENTION = 5;

/**
 * 归档区只留最近这么多份（2026-10-10 引擎升级第 4 期）。每份事务都备份了当时要改的整份故事文件，
 * 书越长每份越大，原来只搬不删：58 章的书事务目录 27MB，按章数平方涨，500 章约 1.8GB。
 * 归档区是已经收敛的旧事务（applied / 干净回滚），不参与恢复扫描；超过上限的按章号从旧到新删掉。
 * 未决的（staged / failed）和带分歧证据的（recovered-with-issues）从来不进归档区，不受影响。
 */
export const LEGACY_TX_ARCHIVE_RETENTION = 20;

export type CommitIoTestPhase = "after-precheck-before-open" | "after-open-before-verify";
type CommitIoTestHook = (phase: CommitIoTestPhase, targetPath: string) => Promise<void> | void;
let commitIoTestHook: CommitIoTestHook | undefined;

/** Deterministic race injection for filesystem safety regression tests only. */
export function setLegacyTxIoHookForTests(hook: CommitIoTestHook | undefined): void {
  commitIoTestHook = hook;
}

/** 收拾老格式事务残留（调用方已持书锁；`recoverTransactions` 在收核心事务之前调）。收拾不了抛 `LegacyResidueError`。 */
export async function recoverLegacyTransactions(bookDir: string): Promise<void> {
  try {
    await recoverProjectCommitTransactionsUnlocked(bookDir);
  } catch (error) {
    throw new LegacyResidueError(error);
  }
}

/** 老格式事务收拾不了（清单坏了、路径不安全……）：原样留着，不读不写这本书。 */
export class LegacyResidueError extends Error {
  readonly code: string;
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "LegacyResidueError";
    const code = (original as NodeJS.ErrnoException | undefined)?.code;
    this.code = typeof code === "string" ? code : "LEGACY_TX_RESIDUE";
  }
}

/**
 * 有没有还没收拾的老格式事务（读的一方用，和核心的 `hasPendingTransactions` 一起看）：清单是 staged / failed、清单读不了、
 * 没清单却有文件的都算；收拾过的（applied / recovered）、快照清单的审计目录、空目录壳不算。只读，不动任何文件。
 */
export async function hasPendingLegacyTransactions(bookDir: string): Promise<boolean> {
  const txRoot = join(bookDir, LEGACY_TX_DIR);
  let entries;
  try {
    entries = await readdir(txRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    return true;
  }
  for (const entry of entries) {
    if (!/^commit-chapter-\d+$/u.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
    const txDir = join(txRoot, entry.name);
    let raw: string;
    try {
      raw = await readFile(join(txDir, "manifest.json"), "utf-8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") return true;
      const hasSnapshotManifest = await lstat(join(txDir, "snapshot-manifest.json")).then((stats) => stats.isFile(), () => false);
      if (hasSnapshotManifest) continue;
      if (!(await isZeroFileDirectoryShell(txDir).catch(() => false))) return true;
      continue;
    }
    let status: unknown;
    try {
      status = (JSON.parse(raw) as { status?: unknown } | null)?.status;
    } catch {
      return true;
    }
    if (status !== "applied" && status !== "recovered") return true;
  }
  return false;
}

/**
 * 一条「已放行但回滚不完整」的事务残留通知。
 * 只放章号/事务目录名/条目计数——具体原因（含盘上绝对路径）留在 txDir/manifest.json 里，
 * 用户可见面绝不上浮原文（路径泄漏纪律）。
 */
export interface LegacyRecoveryNotice {
  readonly chapter: number;
  readonly transactionId: string;
  readonly issueCount: number;
}

/**
 * A3（P1-6 上浮）：列出盘上仍挂着的「recovered + recoveryIssues」事务残留。
 * recover 放行后 manifest 原地保留（同章重提被新事务吸收前一直在），对应的分歧态也就一直在——
 * 此函数给 report.issues / overview warnings 一个可持续的上浮信号，绝非只报一次就静默。
 * 只读 manifest、不动任何文件；坏 manifest 由 recover 路径 fail-closed 拦截，这里跳过不重复判。
 */
export async function listLegacyRecoveryNotices(projectDir: string): Promise<readonly LegacyRecoveryNotice[]> {
  const txRoot = join(projectDir, LEGACY_TX_DIR);
  let entries;
  try {
    entries = await readdir(txRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const notices: LegacyRecoveryNotice[] = [];
  for (const entry of entries) {
    const match = /^commit-chapter-(\d+)$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(txRoot, entry.name, "manifest.json"), "utf-8")) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.status !== "recovered" || !Array.isArray(parsed.recoveryIssues)) continue;
    const issues = parsed.recoveryIssues.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (issues.length === 0) continue;
    notices.push({ chapter: Number(match[1]), transactionId: entry.name, issueCount: issues.length });
  }
  return notices.sort((left, right) => left.chapter - right.chapter);
}

/**
 * Snapshot undo (git restore) unlinks every file a finalized transaction left
 * behind — git tracks files, not directories — leaving a zero-file shell with
 * no manifest. An empty shell holds no recovery evidence, so it is safe to
 * drop; anything containing files (or symlinks) must still fail closed.
 */
async function isZeroFileDirectoryShell(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    if (!(await isZeroFileDirectoryShell(join(dir, entry.name)))) return false;
  }
  return true;
}

/**
 * Remove a verified zero-file shell bottom-up. rmdir(2) only removes empty
 * directories, so a file racing back in fails the cleanup instead of being
 * deleted — recursive rm cannot offer that guarantee (no unlinkat).
 */
async function removeZeroFileDirectoryShell(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeZeroFileDirectoryShell(join(dir, entry.name));
    }
  }
  await rmdir(dir);
}

async function recoverProjectCommitTransactionsUnlocked(projectDir: string): Promise<void> {
  const txRoot = join(projectDir, LEGACY_TX_DIR);
  let rootStats;
  try {
    rootStats = await lstat(txRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw taggedError("UNSAFE_TX_ROOT", `Unsafe commit transaction root at ${relative(resolve(projectDir), txRoot)}; refusing formal-state reads.`);
  }
  const entries = await readdir(txRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^commit-chapter-(\d+)$/u.exec(entry.name);
    if (!match) continue;
    const txDir = join(txRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw taggedError("UNSAFE_TX_RESIDUE", `Unsafe commit transaction residue at ${relative(resolve(projectDir), txDir)}; refusing formal-state reads.`);
    }
    const chapter = Number(match[1]);
    // Historical finalized snapshot scaffolds use snapshot-manifest.json and
    // intentionally remain as audit evidence. Engine transactions always own
    // manifest.json; only those are recoverable here.
    const hasEngineManifest = await lstat(join(txDir, "manifest.json"))
      .then((stats) => stats.isFile() && !stats.isSymbolicLink())
      .catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      });
    if (!hasEngineManifest) {
      const snapshotManifestPath = join(txDir, "snapshot-manifest.json");
      const hasSnapshotManifest = await lstat(snapshotManifestPath)
        .then((stats) => stats.isFile() && !stats.isSymbolicLink())
        .catch(() => false);
      if (hasSnapshotManifest) {
        await validateSnapshotOnlyCommitResidue(projectDir, snapshotManifestPath, entry.name, chapter);
        continue;
      }
      // Zero-file shells (e.g. undo unlinked every staged file) carry no
      // evidence; drop them instead of bricking the project. Cleanup uses
      // rmdir-only primitives — if a file raced back in, removal fails and
      // the fail-closed throw below still applies.
      if (await isZeroFileDirectoryShell(txDir)) {
        try {
          await removeZeroFileDirectoryShell(txDir);
          continue;
        } catch {
          // Fall through to the fail-closed throw.
        }
      }
      throw taggedError("UNREADABLE_TX_RESIDUE", `Unreadable commit transaction residue at ${relative(resolve(projectDir), txDir)}; refusing formal-state reads.`);
    }
    await recoverCommitTransactionResidue(projectDir, txDir, chapter);
  }
  // #7：恢复收尾后做一次事务目录治理（保留窗口 + 归档）。这是 housekeeping 而非正确性前提——
  // 失败（权限/瞬态 IO）就把目录原样留给下一轮，绝不让归档把正式状态读写堵死。
  try {
    await archiveSettledCommitTransactionsUnlocked(projectDir);
  } catch {
    // 归档失败 ≠ 数据问题：目录保留在原位，恢复扫描照常处理（applied/recovered 均为已收敛状态）。
  }
}

/**
 * #7：把超出保留窗口的「终态干净」事务目录原子归档进 `.story-engine-tx/archive/`。
 * 只做 rename(2)（同盘原子、整目录 all-or-nothing），不递归删除——旧实现刻意保留
 * applied 目录当证据（"recursive path cleanup cannot be made race-free"），本函数不改这个
 * 约束：活跃区只搬不删，搬出恢复扫描/残留通知的视野（两者只扫顶层 `commit-chapter-\d+`）；归档区超过上限的最旧几份删掉，
 * 顶层从此只留最近 N 章，长跑不再无限堆积。调用方必须已持有书锁。
 */
async function archiveSettledCommitTransactionsUnlocked(projectDir: string): Promise<void> {
  const txRoot = join(projectDir, LEGACY_TX_DIR);
  let entries;
  try {
    entries = await readdir(txRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const chapters: { readonly chapter: number; readonly dirName: string }[] = [];
  for (const entry of entries) {
    const match = /^commit-chapter-(\d+)$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    chapters.push({ chapter: Number(match[1]), dirName: entry.name });
  }
  // 章号最新的 N 个保持在原位（近期取证窗口），更旧的才候选归档（不够 N 个时没有候选，照样整理归档区）。
  const candidates = chapters
    .sort((left, right) => right.chapter - left.chapter)
    .slice(LEGACY_TX_ACTIVE_RETENTION);
  for (const candidate of candidates) {
    const txDir = join(txRoot, candidate.dirName);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(txDir, "manifest.json"), "utf-8")) as unknown;
    } catch {
      // 读不了/解析不了：不是归档对象。坏 manifest 由恢复路径 fail-closed 把关，这里绝不碰。
      continue;
    }
    if (!isRecord(raw)) continue;
    const manifest = parseRecoverableCommitManifest(raw, candidate.chapter);
    if (!manifest) continue;
    // 只归档终态干净的事务：applied（成功终态）或「recovered 且无 recoveryIssues」（回滚干净的残留）。
    // recovered-with-issues 是「已放行但盘上分歧仍在」的持续证据（listLegacyRecoveryNotices 会一直
    // 上浮到 report.issues/overview warnings），归档它等于把分歧信号静默抹掉——绝不动。
    if (manifest.status !== "applied" && manifest.status !== "recovered") continue;
    if (manifest.status === "recovered"
      && Array.isArray(raw.recoveryIssues)
      && raw.recoveryIssues.some((item): item is string => typeof item === "string" && item.length > 0)) {
      continue;
    }
    // rename 前复核源目录仍是真实目录（恢复循环刚校验过，这里是防 TOCTOU 的廉价兜底）。
    const stats = await lstat(txDir).catch(() => undefined);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) continue;
    const archiveRoot = join(txRoot, "archive");
    await ensureSafeDirectory(projectDir, archiveRoot, true, "commit transaction archive root");
    // 同章重提后再归档会撞同名：归档名加序号后缀，绝不覆盖既有归档（历史证据只增不减）。
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const targetName = attempt === 1 ? candidate.dirName : `${candidate.dirName}--${attempt}`;
      const target = join(archiveRoot, targetName);
      try {
        await rename(txDir, target);
        break;
      } catch (error) {
        if (!isNodeError(error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY" && error.code !== "EPERM" && error.code !== "ENOTDIR")) {
          // 真正的 IO 故障：跳过这个目录（留在原位），继续处理其余候选——归档绝不半途炸掉恢复扫描。
          break;
        }
        // EEXIST/ENOTEMPTY：归档目标被占，换下一个后缀重试。
      }
    }
  }
  await pruneTransactionArchiveUnlocked(projectDir);
}

/**
 * 归档区超过 LEGACY_TX_ARCHIVE_RETENTION 份就删最旧的（按章号，同章按重提序号）。
 * 只删归档区里名字对得上 `commit-chapter-NNNN[--N]`、本身是真目录（不是符号链接）的；调用方持有书锁。
 * 删不掉就留着，下次再试——这是空间治理，不是正确性前提。
 */
async function pruneTransactionArchiveUnlocked(projectDir: string): Promise<void> {
  const archiveRoot = join(projectDir, LEGACY_TX_DIR, "archive");
  const rootStats = await lstat(archiveRoot).catch(() => undefined);
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()) return;
  const archived: { readonly name: string; readonly chapter: number; readonly attempt: number }[] = [];
  for (const entry of await readdir(archiveRoot, { withFileTypes: true })) {
    const match = /^commit-chapter-(\d+)(?:--(\d+))?$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    archived.push({ name: entry.name, chapter: Number(match[1]), attempt: Number(match[2] ?? 1) });
  }
  if (archived.length <= LEGACY_TX_ARCHIVE_RETENTION) return;
  const oldest = archived
    .sort((left, right) => left.chapter - right.chapter || left.attempt - right.attempt)
    .slice(0, archived.length - LEGACY_TX_ARCHIVE_RETENTION);
  for (const item of oldest) {
    const target = join(archiveRoot, item.name);
    const stats = await lstat(target).catch(() => undefined);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) continue;
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function validateSnapshotOnlyCommitResidue(
  projectDir: string,
  manifestPath: string,
  transactionId: string,
  chapter: number,
): Promise<void> {
  // manifestPath 一律落成项目内相对路径再进文案——thrown message 可能被调用方原样上抛/打印。
  const manifestRel = relative(resolve(projectDir), manifestPath);
  if (transactionId !== `commit-chapter-${padChapter(chapter)}` || chapter <= 0) {
    throw taggedError("UNSAFE_SNAPSHOT_RESIDUE_ID", `Unsafe snapshot-only commit residue id: ${transactionId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    throw taggedError(
      "UNREADABLE_SNAPSHOT_MANIFEST",
      `Unreadable snapshot-only commit manifest at ${manifestRel}: ${briefError(error, projectDir)}`,
      error,
    );
  }
  if (!isRecord(parsed)) throw taggedError("INVALID_SNAPSHOT_MANIFEST", `Invalid snapshot-only commit manifest at ${manifestRel}`);
  const expectedChapterPath = `chapters/${padChapter(chapter)}.md`;
  if (
    parsed.status !== "finalized"
    || parsed.chapter !== chapter
    || typeof parsed.finalizedAt !== "string"
    || !Number.isFinite(Date.parse(parsed.finalizedAt))
    || parsed.noFormalStateWriteConfirmed !== true
    || parsed.productionApplyImplemented !== false
    || parsed.routeWired !== true
    || parsed.formalApplyMode !== "chapter_only_v0a"
    || parsed.stateWritesEnabled !== false
    || parsed.defaultFormalWritesEnabled !== false
    || parsed.cleanupPerformed !== false
    || !Array.isArray(parsed.files)
    || !Array.isArray(parsed.appliedChangedFiles)
    || parsed.files.length !== 1
    || parsed.appliedChangedFiles.length !== 1
    || parsed.appliedChangedFiles[0] !== expectedChapterPath
  ) {
    throw taggedError("INVALID_SNAPSHOT_MANIFEST", `Invalid snapshot-only commit manifest at ${manifestRel}`);
  }
  const file = parsed.files[0];
  if (!isRecord(file) || file.relativePath !== expectedChapterPath) {
    throw taggedError("UNSAFE_SNAPSHOT_TARGET", `Unsafe snapshot-only commit target at ${manifestRel}`);
  }
  const validRollback = file.rollbackAction === "delete_if_created"
    ? file.snapshotPath == null
    : file.rollbackAction === "restore_previous"
      && file.snapshotPath === `.story-engine-tx/${transactionId}/snapshot/${expectedChapterPath}`
      && typeof file.byteLength === "number"
      && Number.isSafeInteger(file.byteLength)
      && file.byteLength >= 0
      && typeof file.sha256 === "string"
      && /^[0-9a-f]{64}$/u.test(file.sha256);
  if (!validRollback) throw taggedError("INVALID_SNAPSHOT_ROLLBACK", `Invalid snapshot-only commit rollback metadata at ${manifestRel}`);
}

async function recoverCommitTransactionResidue(
  projectDir: string,
  txDir: string,
  expectedChapter: number,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(txDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const txRel = relative(resolve(projectDir), txDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw taggedError("UNSAFE_TX_RESIDUE", `Unsafe commit transaction residue at ${txRel}; refusing to delete or overwrite it.`);
  }

  let parsed: unknown;
  try {
    const manifestPath = join(txDir, "manifest.json");
    await assertSafeProjectPath(projectDir, manifestPath, false, "commit transaction manifest");
    parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    throw taggedError(
      "UNREADABLE_TX_RESIDUE",
      `Unreadable commit transaction residue at ${txRel}; refusing to delete it: ${briefError(error, projectDir)}`,
      error,
    );
  }
  const manifest = parseRecoverableCommitManifest(parsed, expectedChapter);
  if (!manifest) {
    throw taggedError("UNRECOVERABLE_TX_MANIFEST", `Unrecoverable commit transaction manifest at ${txRel}; refusing to delete or overwrite it.`);
  }

  if (manifest.status === "recovered") return;
  // #7（长跑 2026-10-04 真机 50 章实证）：applied 是成功终态，恢复扫描对它无事可做、更不能改写。
  // apply 的收尾顺序是「逐文件 fsync 全部落盘 → 最后写 applied manifest」，manifest 落成 applied 即
  // 证明事务写入全部完成；此前这里对 applied 无条件改写成 recovered——而恢复扫描无处不在（每次提交、
  // 每次读概览 buildStateOverview、快照操作都先收拾一遍），于是每个成功
  // 事务的 applied 终态在收尾后的第一次概览刷新就被降级成 recovered，成功/中断在盘上从此不可区分
  // （测试书 50/50 manifest 全停 recovered、零 recoveryIssues）。「recovered」只留给真正被中断、
  // 由恢复路径收尾的事务（staged/failed）。
  if (manifest.status === "applied") return;
  // recover 路径不传 writtenFiles：staged/failed 残留的新建文件可能含用户未保存的编辑，
  // 磁盘内容不能自证为「事务写入的内容」。保持 fail-closed（拒绝删除并如实记录），
  // 只有 apply 路径（内存里有确切 writtenContent）才安全删除。
  const rollbackIssues = await restoreCommitTransactionBackups(projectDir, txDir, manifest.backups);
  // 正文换回了原样：写入代次换一个新的，读到过中途那版的预览、缓存一律对不上（写作版本 P1a 第 2 轮复核）。
  // 调用方持着书锁（核心 recoverTransactions 在锁里调），直接写代次文件。
  // 换回来的里有工作稿：工作稿代次也换新纪元（P1b 第 3 轮复核），照中途那版发的存稿对不上。
  if (manifest.backups.length > 0) {
    const touchedDraft = manifest.backups.some((backup) => draftChapterOfPath(backup.relativePath) !== undefined);
    for (const write of [revisionWrite(new Date()), ...(touchedDraft ? [freshDraftGensWrite()] : [])]) {
      const path = join(projectDir, write.path);
      await ensureSafeDirectory(projectDir, dirname(path), true, "store-control parent");
      await writeTextNoFollow(projectDir, path, write.content, "store-control");
    }
  }
  if (rollbackIssues.length > 0) {
    // P1-6 治永久锁死：回滚不完整时不再永久抛错阻塞后续提交。无法判定的新建文件
    // 原地保留（用户数据分毫不动），事务标记 recovered 放行——后续提交会自然覆盖它。
    // 恢复手段从「报错让用户手工删 .story-engine-tx」升级为「如实记录 + 自动放行」。
    await writeManifest(projectDir, txDir, {
      ...manifest,
      status: "recovered",
      recoveryIssues: rollbackIssues,
    });
    return;
  }
  await writeManifest(projectDir, txDir, { ...manifest, status: "recovered" });
}

async function restoreCommitTransactionBackups(
  projectDir: string,
  txDir: string,
  backups: readonly CommitTransactionBackup[],
  /** 事务写入的新文件内容（P1-6：新建文件回滚的删除凭据） */
  writtenFiles?: readonly TransactionFile[],
): Promise<string[]> {
  const issues: string[] = [];
  const writtenByPath = new Map(
    (writtenFiles ?? []).map((file) => [file.relativePath, file.content] as const),
  );
  for (const backup of [...backups].reverse()) {
    const targetPath = join(projectDir, backup.relativePath);
    try {
      if (backup.existed) {
        const backupPath = join(txDir, backup.backupPath!);
        await assertSafeProjectPath(projectDir, backupPath, false, "commit backup");
        const content = await readFile(backupPath, "utf-8");
        if (sha256Text(content) !== backup.sha256) {
          throw taggedError("TX_BACKUP_CHECKSUM_MISMATCH", `backup checksum mismatch at ${relative(resolve(projectDir), backupPath)}`);
        }
        await ensureSafeDirectory(projectDir, dirname(targetPath), true, "formal target parent");
        await writeTextNoFollow(projectDir, targetPath, content, "formal rollback target");
      } else {
        await removeFileNoFollow(
          projectDir,
          targetPath,
          "formal rollback target",
          writtenByPath.get(backup.relativePath),
        );
      }
    } catch (error) {
      // 相对文件名 + errno code/自造错误码：这条 issues 会同时进 report.issues（用户可见）和
      // manifest.recoveryIssues（盘上取证）——error.message 原文带绝对路径，绝不直拼。
      issues.push(`Rollback failed for ${backup.relativePath}: ${briefError(error, projectDir)}`);
    }
  }
  return issues;
}

function parseRecoverableCommitManifest(value: unknown, expectedChapter: number): CommitTransactionManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 2
    || value.chapter !== expectedChapter
    || typeof value.createdAt !== "string"
    || !Array.isArray(value.files)
    || !Array.isArray(value.backups)
    || (value.status !== "staged" && value.status !== "applied" && value.status !== "failed" && value.status !== "recovered")
  ) {
    return undefined;
  }
  const files = value.files.filter((item): item is string => typeof item === "string");
  if (files.length !== value.files.length || !isUniqueSafeRelativePaths(files)) return undefined;
  const backups: CommitTransactionBackup[] = [];
  for (const item of value.backups) {
    if (!isRecord(item) || typeof item.relativePath !== "string" || typeof item.existed !== "boolean") return undefined;
    if (!isSafeTransactionRelativePath(item.relativePath)) return undefined;
    if (item.existed) {
      if (
        typeof item.backupPath !== "string"
        || item.backupPath !== join("backups", item.relativePath)
        || !isSafeTransactionRelativePath(item.backupPath)
        || typeof item.sha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(item.sha256)
      ) return undefined;
      backups.push({
        relativePath: item.relativePath,
        existed: true,
        backupPath: item.backupPath,
        sha256: item.sha256,
      });
    } else {
      if (item.backupPath !== undefined || item.sha256 !== undefined) return undefined;
      backups.push({ relativePath: item.relativePath, existed: false });
    }
  }
  if (
    backups.length !== files.length
    || !isUniqueSafeRelativePaths(backups.map((backup) => backup.relativePath))
    || files.some((file) => !backups.some((backup) => backup.relativePath === file))
  ) return undefined;
  return {
    version: 2,
    chapter: expectedChapter,
    createdAt: value.createdAt,
    files,
    backups,
    status: value.status,
  };
}

function isUniqueSafeRelativePaths(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length && paths.every(isSafeTransactionRelativePath);
}

function isSafeTransactionRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  const segments = path.split(/[\\/]/u);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function writeManifest(projectDir: string, txDir: string, manifest: CommitTransactionManifest): Promise<void> {
  await writeTextNoFollow(projectDir, join(txDir, "manifest.json"), jsonText(manifest), "commit transaction manifest");
}

async function assertSafeProjectPath(
  projectDir: string,
  candidatePath: string,
  allowMissing: boolean,
  label: string,
): Promise<void> {
  const root = resolve(projectDir);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    // 越界目标只给相对关系（"../…" 已足够定位），绝不落绝对路径进 message。
    throw taggedError("UNSAFE_PATH_OUTSIDE_PROJECT", `Unsafe ${label} path outside project: ${rel}`);
  }
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw taggedError("UNSAFE_PROJECT_ROOT", `Unsafe ${label}: project root is not a real directory.`);
  }
  let current = root;
  const segments = rel.split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    try {
      const stats = await lstat(current);
      const currentRel = relative(root, current) || ".";
      if (stats.isSymbolicLink()) throw taggedError("UNSAFE_SYMLINK", `Unsafe ${label}: symbolic link at ${currentRel}`);
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw taggedError("UNSAFE_PARENT", `Unsafe ${label}: non-directory parent at ${currentRel}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}

async function ensureSafeDirectory(
  projectDir: string,
  directoryPath: string,
  create: boolean,
  label: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, directoryPath, create, label);
  if (create) await mkdir(directoryPath, { recursive: true });
  await assertSafeProjectPath(projectDir, directoryPath, false, label);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw taggedError("UNSAFE_DIRECTORY", `Unsafe ${label}: expected a real directory at ${relative(resolve(projectDir), directoryPath)}`);
  }
}

async function writeTextNoFollow(
  projectDir: string,
  targetPath: string,
  content: string,
  label: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  await commitIoTestHook?.("after-precheck-before-open", targetPath);
  // Deliberately omit O_TRUNC here. Opening an existing file must not mutate a
  // byte until its parent realpath and the opened inode have both been proven
  // to be the same contained file. If O_CREAT races into an attacker-swapped
  // empty location, the only possible residue before rejection is an empty
  // file; existing outside data is never truncated or overwritten.
  const handle = await open(
    targetPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await commitIoTestHook?.("after-open-before-verify", targetPath);
    await verifyOpenedProjectFile(projectDir, targetPath, handle, label);
    await handle.truncate(0);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertSafeProjectPath(projectDir, targetPath, false, label);
}

async function verifyOpenedProjectFile(
  projectDir: string,
  targetPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  label: string,
): Promise<void> {
  const [rootRealPath, parentRealPath, handleStats, pathStats] = await Promise.all([
    realpath(projectDir),
    realpath(dirname(targetPath)),
    handle.stat(),
    lstat(targetPath),
  ]);
  const parentRelative = relative(rootRealPath, parentRealPath);
  if (isAbsolute(parentRelative) || parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
    throw taggedError("UNSAFE_CONTAINMENT", `Unsafe ${label}: parent realpath escaped project containment.`);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw taggedError("UNSAFE_NOT_A_FILE", `Unsafe ${label}: final path is not a real file.`);
  }
  if (handleStats.dev !== pathStats.dev || handleStats.ino !== pathStats.ino) {
    throw taggedError("UNSAFE_INODE_MISMATCH", `Unsafe ${label}: opened inode no longer matches the target path.`);
  }
  if (handleStats.nlink !== 1) {
    throw taggedError("UNSAFE_HARDLINK", `Unsafe ${label}: hard-linked targets are not allowed.`);
  }
}

/**
 * 回滚「事务前不存在的文件」（新建的章节文件）。此前一律拒绝删除 → apply 中段崩溃后
 * 每次提交都进 recover → 抛 Rollback failed → 项目永久锁死，只能手工删 .story-engine-tx
 * （2026-09-15 审计 P1-6）。
 *
 * 安全收紧而非放开：只有当磁盘内容【仍是本事务刚写入的内容】时才删（哈希比对）——
 * 这证明文件是本次未完成的提交产生的、没被用户/别的进程改过，删了不会丢任何用户数据。
 * 内容不匹配则保留并如实记录，绝不误删。
 */
async function removeFileNoFollow(
  projectDir: string,
  targetPath: string,
  label: string,
  writtenContent?: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  try {
    await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const targetRel = relative(resolve(projectDir), targetPath);
  if (writtenContent === undefined) {
    throw taggedError(
      "TX_UNVERIFIED_DELETE",
      `Refusing to path-delete ${label} at ${targetRel}; no transaction content recorded for verification.`,
    );
  }
  const currentContent = await readFile(targetPath, "utf-8");
  if (sha256Text(currentContent) !== sha256Text(writtenContent)) {
    throw taggedError(
      "TX_CONTENT_CHANGED",
      `Refusing to path-delete ${label} at ${targetRel}; content no longer matches the transaction's write (file was modified after the failed commit).`,
    );
  }
  await rm(targetPath, { force: true });
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 引擎自造错误：给稳定 .code，让剔除 error.message 的上游 catch（report.issues/诊断面）
 * 仍能保留语义关键字；message 原文（含内部绝对路径）只留在 Error 对象里供抛出方/调试用。
 */
function taggedError(code: string, message: string, cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 错误的简短说法（不带绝对路径：会进作者看得到的文案和盘上的取证记录）。 */
function briefError(error: unknown, projectDir?: string): string {
  if (error instanceof SyntaxError) return "JSON 解析失败";
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const kind = typeof code === "string" && code.length > 0
      ? `错误码 ${code}`
      : (() => {
        const message = error.message.trim();
        return message.length > 0 && !message.includes("/") && !message.includes("\\")
          ? message
          : `错误类型 ${error.name || "Error"}`;
      })();
    const rawPath = (error as NodeJS.ErrnoException).path;
    if (projectDir !== undefined && typeof rawPath === "string" && rawPath.length > 0) {
      const rel = relative(resolve(projectDir), resolve(rawPath));
      if (rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        return `${kind}（${rel}）`;
      }
    }
    return kind;
  }
  return "未知错误";
}
