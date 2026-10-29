/**
 * 老定稿链（`.story-engine-tx/`）的事务恢复（写作版本 P1 第 17 轮复核 AE2/AE3：从界面的 book/ 层挪进核心）。
 *
 * 老定稿链本身已删（重构 P7，2026-10-18），这里只收老版本中途崩溃留下的残留。**收拾一本书的事务只有核心一处**：
 * `recoverTransactions`（transaction.ts）把这里没收拾的老格式事务和核心自己的一起，按开工先后倒着退（P1 第 18 轮 AF2），
 * 写命令、`withSettledBook`、存档都走它——存稿、AI 换稿这类先读盘再定参数的，读到的一定是两种事务都收拾过的书。
 * 这里只给这几样：只读的逐个看清（`scanLegacyTransactions`，读侧 `hasPendingLegacyTransactions` 用同一份判断）、
 * 退回一份（`undoLegacyTransaction`：要盖掉的先另存、退不下去整份抛）、标成收拾过（`markLegacyTransactionRecovered`）、
 * 收尾（`tidyLegacyTransactions`：删空目录壳、归档）。调用方必须已持书锁。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { DRAFT_GENS_PATH, draftChapterOfPath, isControlPath } from "./paths.js";
import { writeFileInBook, type SafeWriteHook, type SafeWriteHookPoint } from "./safe-fs.js";

/** 老定稿链的事务目录。 */
export const LEGACY_TX_DIR = ".story-engine-tx";

export interface CommitTransactionManifest {
  readonly version: 2;
  readonly chapter: number;
  readonly createdAt: string;
  readonly files: readonly string[];
  readonly backups: readonly CommitTransactionBackup[];
  readonly status: "staged" | "applied" | "failed" | "recovered";
  /** 老版本恢复留下的「回滚不完备」原因（P1-6）。现在退不下去就挡着、不标收拾过（P1 第 19 轮 AG1）；这里只读老书上已有的。 */
  readonly recoveryIssues?: readonly string[];
}

export interface CommitTransactionBackup {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly backupPath?: string;
  readonly sha256?: string;
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

export type CommitIoTestPhase = SafeWriteHookPoint;
type CommitIoTestHook = SafeWriteHook;
let commitIoTestHook: CommitIoTestHook | undefined;

/** Deterministic race injection for filesystem safety regression tests only. */
export function setLegacyTxIoHookForTests(hook: CommitIoTestHook | undefined): void {
  commitIoTestHook = hook;
}

/** 一份还没收拾的老格式事务（清单是 staged / failed）：恢复时和核心的事务一起按开工先后倒着退。 */
export interface PendingLegacyTransaction {
  /** 事务目录名（`commit-chapter-NNNN`）。 */
  readonly name: string;
  readonly createdAt: string;
  /** 退回时要换回的文件 → 换回成什么（原文的 sha256；事务前没有这个文件是 null）。 */
  readonly restores: ReadonlyMap<string, string | null>;
}

/** 老格式事务收拾不了（清单坏了、路径不安全、和核心事务谁先谁后分不清……）：原样留着，不读不写这本书。 */
export class LegacyResidueError extends Error {
  readonly code: string;
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "LegacyResidueError";
    const code = (original as NodeJS.ErrnoException | undefined)?.code;
    this.code = typeof code === "string" ? code : "LEGACY_TX_RESIDUE";
  }
}

async function asResidue<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof LegacyResidueError ? error : new LegacyResidueError(error);
  }
}

/**
 * 老格式事务逐个看清（只读，不动任何文件）：还没收拾的（staged / failed）列出来；收拾不了的（事务根或目录不是真目录、
 * 清单读不了或不对、审计清单不对、没清单却有文件）抛 `LegacyResidueError`。恢复和读侧用的是这同一份判断。
 */
export async function scanLegacyTransactions(bookDir: string): Promise<readonly PendingLegacyTransaction[]> {
  return asResidue(async () => {
    const pending: PendingLegacyTransaction[] = [];
    for (const entry of await scanLegacyEntries(bookDir)) {
      if (entry.kind !== "tx" || (entry.manifest.status !== "staged" && entry.manifest.status !== "failed")) continue;
      pending.push({
        name: entry.name,
        createdAt: entry.manifest.createdAt,
        restores: new Map(entry.manifest.backups.map((backup) => [backup.relativePath, backup.existed ? backup.sha256! : null] as const)),
      });
    }
    return pending;
  });
}

/**
 * 退回时要盖掉 / 删掉的文件，现在的内容不是这份事务写的（老格式核不了）：先交给它另存（P1 第 19 轮 AG3）。另存不下要抛。
 * `instance` 是这一份事务的实例号（目录名 + 清单指纹，P1 第 20 轮 AH3）：老格式按章号起目录名，同一章重定稿会复用，
 * 只拿目录名去重会把上一回的另存（作者可能已经「不要了」）当成这一回的。
 */
export type KeepCurrent = (input: { readonly instance: string; readonly path: string; readonly content: string }) => Promise<void>;

/** 退回一份做了什么：换没换过文件、碰了哪几章工作稿、碰没碰工作稿代次（调用方据此换代次）。 */
export interface LegacyUndoResult {
  readonly changed: boolean;
  readonly draftChapters: readonly number[];
  /** 清单里有工作稿代次（AH2）：只碰了它、说不清哪章的，调用方整本换新纪元。 */
  readonly gensTouched: boolean;
}

/** 一份老格式事务的实例号：目录名 + 清单指纹。被杀了重来清单没变，号不变；同名的新一份清单不同，号就不同。 */
function legacyInstance(name: string, manifest: CommitTransactionManifest): string {
  return `${name}@${sha256Text(jsonText(manifest)).slice(0, 16)}`;
}

/**
 * 退回一份没收拾的老格式事务（调用方已持书锁、按开工先后排好了序）：备份换回去，事务新建的删掉；盖掉 / 删掉之前，现在的内容
 * 和要换回的不一样就先另存（keep）。有一个文件退不下去就整份抛 `LegacyResidueError`、清单不改（P1 第 19 轮 AG1：不标「收拾过」，
 * 下次开书照样挡着、重试；比它先开工的一份都不退）。两份代次不从备份换回（AG2，调用方退完换新的）。
 * 退完不标收拾过：调用方换完代次再调 `markLegacyTransactionRecovered`（被杀在中间，重开还是没收拾的，再退一遍）。
 */
export async function undoLegacyTransaction(bookDir: string, name: string, keep: KeepCurrent): Promise<LegacyUndoResult> {
  return asResidue(async () => {
    const txDir = legacyTxDir(bookDir, name);
    const manifest = await pendingLegacyManifest(bookDir, txDir, name);
    if (!manifest) return { changed: false, draftChapters: [], gensTouched: false };
    const instance = legacyInstance(name, manifest);
    const issues = await restoreCommitTransactionBackups(bookDir, txDir, manifest.backups, (path, content) => keep({ instance, path, content }));
    if (issues.length > 0) throw taggedError("TX_ROLLBACK_INCOMPLETE", `Legacy commit transaction ${name} could not be fully rolled back: ${issues.join("; ")}`);
    return {
      changed: manifest.backups.length > 0,
      draftChapters: [...new Set(manifest.backups.flatMap((backup) => {
        const chapter = draftChapterOfPath(backup.relativePath);
        return chapter === undefined ? [] : [chapter];
      }))],
      gensTouched: manifest.backups.some((backup) => normalize(backup.relativePath) === DRAFT_GENS_PATH),
    };
  });
}

/** 一份老格式事务退完、代次也换过了：标成收拾过。 */
export async function markLegacyTransactionRecovered(bookDir: string, name: string): Promise<void> {
  return asResidue(async () => {
    const txDir = legacyTxDir(bookDir, name);
    const manifest = await pendingLegacyManifest(bookDir, txDir, name);
    if (manifest) await writeManifest(bookDir, txDir, { ...manifest, status: "recovered" });
  });
}

function legacyTxDir(bookDir: string, name: string): string {
  if (!/^commit-chapter-\d+$/u.test(name)) throw taggedError("UNSAFE_TX_RESIDUE_ID", `Unsafe commit transaction residue id: ${name}`);
  return join(bookDir, LEGACY_TX_DIR, name);
}

/** 收尾（都退完之后）：删掉空目录壳、旧的干净事务归档。空目录壳删不掉抛 `LegacyResidueError`。 */
export async function tidyLegacyTransactions(bookDir: string): Promise<void> {
  return asResidue(async () => {
    const entries = await scanLegacyEntries(bookDir);
    for (const entry of entries) {
      if (entry.kind !== "shell") continue;
      // Zero-file shells (e.g. undo unlinked every staged file) carry no
      // evidence; drop them instead of bricking the project. Cleanup uses
      // rmdir-only primitives — if a file raced back in, removal fails and
      // the fail-closed throw below still applies.
      try {
        await removeZeroFileDirectoryShell(entry.txDir);
      } catch (error) {
        throw taggedError("UNREADABLE_TX_RESIDUE", `Unreadable commit transaction residue at ${relative(resolve(bookDir), entry.txDir)}; refusing formal-state reads.`, error);
      }
    }
    // #7：恢复收尾后做一次事务目录治理（保留窗口 + 归档）。这是 housekeeping 而非正确性前提——
    // 失败（权限/瞬态 IO）就把目录原样留给下一轮，绝不让归档把正式状态读写堵死。
    try {
      await archiveSettledCommitTransactionsUnlocked(bookDir);
    } catch {
      // 归档失败 ≠ 数据问题：目录保留在原位，恢复扫描照常处理（applied/recovered 均为已收敛状态）。
    }
  });
}

/**
 * 有没有还没收拾的老格式事务（读的一方用，和核心的 `hasPendingTransactions` 一起看）：和恢复同一份判断（P1 第 18 轮 C181）——
 * 恢复要退的（staged / failed）、恢复收拾不了的（清单读不了或缺字段、审计清单不对、没清单却有文件）都算；
 * 收拾过的（applied / recovered）、对得上的审计目录、空目录壳不算。只读，不动任何文件。
 */
export async function hasPendingLegacyTransactions(bookDir: string): Promise<boolean> {
  try {
    return (await scanLegacyTransactions(bookDir)).length > 0;
  } catch {
    return true;
  }
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

type LegacyEntry =
  | { readonly kind: "snapshot" }
  | { readonly kind: "shell"; readonly txDir: string }
  | { readonly kind: "tx"; readonly name: string; readonly manifest: CommitTransactionManifest };

/** 老格式事务目录逐个看清（只读）。收拾不了的直接抛（错误带稳定 code，文案不带绝对路径）。 */
async function scanLegacyEntries(projectDir: string): Promise<readonly LegacyEntry[]> {
  const txRoot = join(projectDir, LEGACY_TX_DIR);
  let rootStats;
  try {
    rootStats = await lstat(txRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw taggedError("UNSAFE_TX_ROOT", `Unsafe commit transaction root at ${relative(resolve(projectDir), txRoot)}; refusing formal-state reads.`);
  }
  const result: LegacyEntry[] = [];
  for (const entry of await readdir(txRoot, { withFileTypes: true })) {
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
        result.push({ kind: "snapshot" });
        continue;
      }
      if (await isZeroFileDirectoryShell(txDir)) {
        result.push({ kind: "shell", txDir });
        continue;
      }
      throw taggedError("UNREADABLE_TX_RESIDUE", `Unreadable commit transaction residue at ${relative(resolve(projectDir), txDir)}; refusing formal-state reads.`);
    }
    result.push({ kind: "tx", name: entry.name, manifest: await readCommitManifest(projectDir, txDir, chapter) });
  }
  return result;
}

/** 读事务清单并核对（读不了、对不上都抛）。 */
async function readCommitManifest(projectDir: string, txDir: string, expectedChapter: number): Promise<CommitTransactionManifest> {
  const txRel = relative(resolve(projectDir), txDir);
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
  return manifest;
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

/**
 * 一份还没收拾的老格式事务的清单（staged / failed）；已经收拾过（recovered）、成功了的（applied）、目录不在了是 undefined。
 * 目录不是真目录、清单坏了抛出。
 *
 * #7（长跑 2026-10-04 真机 50 章实证）：applied 是成功终态，恢复对它无事可做、更不能改写——apply 的收尾顺序是
 * 「逐文件 fsync 全部落盘 → 最后写 applied manifest」，落成 applied 即证明事务写入全部完成。「recovered」只留给真正被中断、
 * 由恢复路径收尾的事务。
 */
async function pendingLegacyManifest(projectDir: string, txDir: string, name: string): Promise<CommitTransactionManifest | undefined> {
  let stats;
  try {
    stats = await lstat(txDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const txRel = relative(resolve(projectDir), txDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw taggedError("UNSAFE_TX_RESIDUE", `Unsafe commit transaction residue at ${txRel}; refusing to delete or overwrite it.`);
  }
  const manifest = await readCommitManifest(projectDir, txDir, Number(/^commit-chapter-(\d+)$/u.exec(name)![1]));
  return manifest.status === "staged" || manifest.status === "failed" ? manifest : undefined;
}

async function restoreCommitTransactionBackups(
  projectDir: string,
  txDir: string,
  backups: readonly CommitTransactionBackup[],
  keep: (relativePath: string, content: string) => Promise<void>,
): Promise<string[]> {
  const issues: string[] = [];
  for (const backup of [...backups].reverse()) {
    // 两份代次只往前走（P1 第 19 轮 AG2）：不从备份换回，调用方退完换新的。
    if (isControlPath(backup.relativePath)) continue;
    const targetPath = join(projectDir, backup.relativePath);
    try {
      let content: string | undefined;
      if (backup.existed) {
        const backupPath = join(txDir, backup.backupPath!);
        await assertSafeProjectPath(projectDir, backupPath, false, "commit backup");
        content = await readFile(backupPath, "utf-8");
        if (sha256Text(content) !== backup.sha256) {
          throw taggedError("TX_BACKUP_CHECKSUM_MISMATCH", `backup checksum mismatch at ${relative(resolve(projectDir), backupPath)}`);
        }
      }
      // 现在盘上的：老格式没记事务写了什么，和要换回的不一样就先另存（之后存下的稿可能就这一份，AG3）。
      const current = await readCurrentNoFollow(projectDir, targetPath, "formal rollback target");
      if (current !== undefined && current !== content) await keep(backup.relativePath, current);
      if (content !== undefined) {
        await ensureSafeDirectory(projectDir, dirname(targetPath), true, "formal target parent");
        await writeTextNoFollow(projectDir, targetPath, content, "formal rollback target");
      } else if (current !== undefined) {
        await assertSafeProjectPath(projectDir, targetPath, true, "formal rollback target");
        await rm(targetPath, { force: true });
      }
    } catch (error) {
      // 相对文件名 + errno code/自造错误码（error.message 原文带绝对路径，绝不直拼）。
      issues.push(`Rollback failed for ${backup.relativePath}: ${briefError(error, projectDir)}`);
      // 有一处退不下去就停：后面的不再动（调用方整份当没收拾、挡着）。
      break;
    }
  }
  return issues;
}

/** 目标现在的内容（不跟软链）；不在是 undefined；不是普通文件抛出。 */
async function readCurrentNoFollow(projectDir: string, targetPath: string, label: string): Promise<string | undefined> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw taggedError("UNSAFE_ROLLBACK_TARGET", `Refusing to touch ${label} at ${relative(resolve(projectDir), targetPath)}; not a regular file.`);
  return readFile(targetPath, "utf-8");
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

/**
 * 不跟软链地整份换上（P1 第 20 轮 AH4、第 21 轮 AI2）：走 safe-fs 的 writeFileInBook——同目录新建临时文件、落盘，
 * rename 前核上级目录没换、临时文件还是自己那个、目标可换，换上后核换上的就是它。被杀在任何一步，目标要么是原来的整份、
 * 要么是新的整份；途中路径被调换就如实报错、清单留着重来。原来有的文件沿用它的权限；原来没有的按 0600 建。
 */
async function writeTextNoFollow(
  projectDir: string,
  targetPath: string,
  content: string,
  label: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  await writeFileInBook(resolve(projectDir), resolve(targetPath), content, { label, hook: commitIoTestHook });
  await assertSafeProjectPath(projectDir, targetPath, false, label);
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
