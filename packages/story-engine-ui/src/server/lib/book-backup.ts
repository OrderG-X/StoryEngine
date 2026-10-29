/**
 * 书的备份（P10）：整本书目录原样打成 zip（含存档历史、对话），根上放一个说明文件。
 *
 * - 打包在书锁里做：等手头的写入做完再读，读的过程中不会有人改。
 * - 自动备份：每次定稿后备一份到备份文件夹（默认 `~/StoryEngine-NG/备份/`），每本书一个子文件夹、留最近 10 份。
 *   设置和上次结果存在 `~/.story-engine/backup-settings.json`；自动备份没成功不挡定稿，但如实记下、设置里能看到。
 * - 恢复：认说明文件，整本解成一本新书（放进默认书库），重名加后缀，绝不覆盖现有的书。
 */
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bumpRevision, withBookLock } from "@actalk/story-core";
import { readBookMeta, safeFileName } from "./book-info.js";
import { resolveBooksRootDir, resolveGlobalDataDir } from "./data-dirs.js";
import { isRecord, isSafeProjectPath, writeFileAtomic } from "./project-io.js";
import { createZip, readZip, type ZipEntryInput } from "./zip.js";

export const BACKUP_MANIFEST = "story-engine-backup.json";
export const BACKUP_KEEP = 10;
const BOOK_PREFIX = "book/";
/** 恢复时整包解开后的上限（防解压炸弹）。 */
export const RESTORE_TOTAL_LIMIT = 2 * 1024 * 1024 * 1024;

interface BackupManifest {
  readonly kind: "story-engine-backup";
  readonly version: 1;
  readonly title: string;
  /** 原书目录名（恢复时沿用）。 */
  readonly folder: string;
  readonly createdAt: string;
  readonly files: number;
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 已经压过的不再压（存档历史的 git 对象、图片、压缩包）。 */
function alreadyCompressed(path: string): boolean {
  return path.includes(".git/objects/") || /\.(zip|png|jpe?g|gif|webp|gz|epub|docx)$/iu.test(path);
}

/** 不进备份的：git 留下的锁文件（恢复后会挡住存档）。 */
function skipInBackup(rel: string): boolean {
  return rel.startsWith(".git/") && rel.endsWith(".lock");
}

/** 列出所有文件和空目录（空目录也要留着，恢复后结构一样）。 */
async function walkTree(root: string): Promise<{ readonly files: string[]; readonly emptyDirs: string[] }> {
  const files: string[] = [];
  const emptyDirs: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length === 0 && dir !== root) emptyDirs.push(dir);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
      // 符号链接、设备文件之类不收。
    }
  };
  await visit(root);
  return { files: files.sort(), emptyDirs: emptyDirs.sort() };
}

/** 打一份备份：回 zip 内容和建议的文件名。 */
export async function createBookBackup(projectDir: string, now: Date = new Date()): Promise<{ readonly data: Buffer; readonly filename: string; readonly title: string }> {
  const root = resolve(projectDir);
  return withBookLock(root, async () => {
    const meta = await readBookMeta(root);
    const { files, emptyDirs } = await walkTree(root);
    const toRel = (path: string) => relative(root, path).split(sep).join("/");
    const entries: ZipEntryInput[] = emptyDirs.map((dir) => ({ path: `${BOOK_PREFIX}${toRel(dir)}/` }));
    for (const file of files) {
      const rel = toRel(file);
      if (skipInBackup(rel)) continue;
      const info = await stat(file);
      entries.push({ path: `${BOOK_PREFIX}${rel}`, data: await readFile(file), store: alreadyCompressed(rel), mtime: info.mtime });
    }
    const manifest: BackupManifest = { kind: "story-engine-backup", version: 1, title: meta.title, folder: basename(root), createdAt: now.toISOString(), files: entries.length };
    const data = createZip([{ path: BACKUP_MANIFEST, data: `${JSON.stringify(manifest, null, 2)}\n`, mtime: now }, ...entries]);
    return { data, filename: `${safeFileName(meta.title)}-备份-${stamp(now)}.zip`, title: meta.title };
  });
}

function readManifest(raw: Buffer | undefined): BackupManifest {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw.toString("utf-8")) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || parsed.kind !== "story-engine-backup" || parsed.version !== 1) {
    throw new Error("这不是 StoryEngine 的备份包。");
  }
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "恢复的书";
  const folder = typeof parsed.folder === "string" ? basename(parsed.folder.trim()) : "";
  return { kind: "story-engine-backup", version: 1, title, folder, createdAt: String(parsed.createdAt ?? ""), files: Number(parsed.files ?? 0) };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 从备份解出一本新书（默认书库里）；重名加「-恢复」「-恢复2」…，书名跟着加「（恢复）」，书架上和原书分得清。 */
export async function restoreBookFromBackup(zip: Buffer, now: Date = new Date()): Promise<{ readonly projectPath: string; readonly title: string }> {
  const entries = readZip(zip, { totalLimit: RESTORE_TOTAL_LIMIT });
  const manifest = readManifest(entries.find((entry) => entry.path === BACKUP_MANIFEST && !entry.isDirectory)?.data);
  const files = entries.filter((entry) => entry.path.startsWith(BOOK_PREFIX) && entry.path.length > BOOK_PREFIX.length);
  if (!files.some((entry) => entry.path === `${BOOK_PREFIX}project.json` && !entry.isDirectory)) throw new Error("备份包里没有书（缺 project.json）。");

  const library = join(resolveBooksRootDir(), "story-engine");
  const base = join(library, manifest.folder && manifest.folder !== "." && manifest.folder !== ".." ? manifest.folder : `story-restored-${stamp(now)}`);
  let target = base;
  let suffix = "";
  for (let n = 1; await exists(target); n += 1) {
    suffix = `恢复${n > 1 ? n : ""}`;
    target = `${base}-${suffix}`;
  }
  const title = suffix ? `${manifest.title}（${suffix}）` : manifest.title;
  if (!isSafeProjectPath(target)) throw new Error("书库路径不安全，没恢复。");

  // 先解到同目录下的临时目录，全写完再改名：中途失败不留半本书。
  const staging = `${target}.restoring-${process.pid}-${now.getTime()}`;
  await mkdir(staging, { recursive: true });
  try {
    for (const entry of files) {
      const dest = join(staging, ...entry.path.slice(BOOK_PREFIX.length).split("/"));
      const rel = relative(staging, dest);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("备份包里有越界的路径。");
      if (entry.isDirectory) {
        await mkdir(dest, { recursive: true });
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, entry.data);
    }
    if (suffix) await retitle(join(staging, "project.json"), title);
    // 解出来的书换一个新的写入代次（P1a 第 2 轮、P1b 第 3 轮复核）：备份里的代次是那时候的，书露面之前就换好；
    // 走核心事务写（不跟软链写到书外，P1 第 22 轮 AJ3），换不了整个恢复停下。
    await bumpRevision(staging, now);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { projectPath: target, title };
}

/** 改解出来那本的书名（只动 title，别的照原样）。 */
async function retitle(path: string, title: string): Promise<void> {
  const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
  await writeFile(path, `${JSON.stringify({ ...(isRecord(raw) ? raw : {}), title }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 自动备份
// ---------------------------------------------------------------------------

export interface BackupStatus {
  readonly at: string;
  readonly ok: boolean;
  readonly title: string;
  readonly file?: string;
  readonly error?: string;
}

export interface BackupSettings {
  readonly auto: boolean;
  /** 作者改过的文件夹；没改就是默认的。 */
  readonly dir?: string;
  readonly last?: BackupStatus;
}

function settingsPath(): string {
  return join(resolveGlobalDataDir(), "backup-settings.json");
}

export function defaultBackupDir(): string {
  return join(resolveBooksRootDir(), "备份");
}

export function backupDirOf(settings: BackupSettings): string {
  return settings.dir ?? defaultBackupDir();
}

export async function readBackupSettings(): Promise<BackupSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(settingsPath(), "utf-8"));
  } catch {
    raw = undefined;
  }
  if (!isRecord(raw)) return { auto: true };
  const dir = typeof raw.dir === "string" && raw.dir.trim() && isAbsolute(raw.dir.trim()) ? raw.dir.trim() : undefined;
  const last = isRecord(raw.last) && typeof raw.last.at === "string" && typeof raw.last.ok === "boolean" && typeof raw.last.title === "string"
    ? {
      at: raw.last.at,
      ok: raw.last.ok,
      title: raw.last.title,
      ...(typeof raw.last.file === "string" ? { file: raw.last.file } : {}),
      ...(typeof raw.last.error === "string" ? { error: raw.last.error } : {}),
    }
    : undefined;
  return { auto: raw.auto !== false, ...(dir ? { dir } : {}), ...(last ? { last } : {}) };
}

async function writeBackupSettings(settings: BackupSettings): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFileAtomic(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

/** 备份文件夹得是家目录下的绝对路径（和书一样的安全口径），不能放进某本书里面。 */
export function validateBackupDir(dir: string): string | null {
  const trimmed = dir.trim();
  if (!trimmed || !isAbsolute(trimmed)) return "要填完整的文件夹路径。";
  if (!isSafeProjectPath(join(trimmed, "x"))) return "这个文件夹不能用（要在你的用户目录下）。";
  if (resolve(trimmed).startsWith(`${resolve(join(resolveBooksRootDir(), "story-engine"))}${sep}`)) return "别放在某本书的文件夹里。";
  return null;
}

/** 改设置：auto 传了才改；dir 传空串 = 换回默认。 */
export async function updateBackupSettings(patch: { readonly auto?: boolean; readonly dir?: string }): Promise<BackupSettings> {
  const current = await readBackupSettings();
  let dir = current.dir;
  if (patch.dir !== undefined) {
    if (!patch.dir.trim()) dir = undefined;
    else {
      const problem = validateBackupDir(patch.dir);
      if (problem) throw new Error(problem);
      dir = resolve(patch.dir.trim());
    }
  }
  const next: BackupSettings = {
    auto: patch.auto ?? current.auto,
    ...(dir ? { dir } : {}),
    ...(current.last ? { last: current.last } : {}),
  };
  await writeBackupSettings(next);
  return next;
}

/** 一本书的备份子文件夹：书目录名（改书名不会散成两个文件夹）。 */
export function bookBackupDir(settings: BackupSettings, projectDir: string): string {
  return join(backupDirOf(settings), basename(resolve(projectDir)));
}

/** 定稿后自动备份一份；关着就不做。结果（成没成）记进设置文件。永不抛。 */
export async function autoBackupAfterCommit(projectDir: string, now: Date = new Date()): Promise<BackupStatus | null> {
  const settings = await readBackupSettings();
  if (!settings.auto) return null;
  let status: BackupStatus;
  try {
    const backup = await createBookBackup(projectDir, now);
    const folder = bookBackupDir(settings, projectDir);
    await mkdir(folder, { recursive: true });
    const file = join(folder, backup.filename);
    await writeFile(`${file}.part`, backup.data);
    await rename(`${file}.part`, file);
    await pruneBackups(folder, BACKUP_KEEP);
    status = { at: now.toISOString(), ok: true, title: backup.title, file };
  } catch (error) {
    const title = await readBookMeta(projectDir).then((meta) => meta.title, () => basename(projectDir));
    status = { at: now.toISOString(), ok: false, title, error: error instanceof Error ? error.message : String(error) };
    console.warn(`[backup] 《${title}》定稿后自动备份没成：${status.error}`);
  }
  await writeBackupSettings({ ...(await readBackupSettings()), last: status }).catch(() => undefined);
  return status;
}

/** 一本书的备份只留最近 keep 份（按文件名里的时间排，旧的删掉）。 */
export async function pruneBackups(folder: string, keep: number): Promise<void> {
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".zip"));
  const dated = await Promise.all(names.map(async (name) => ({ name, mtime: (await lstat(join(folder, name))).mtimeMs })));
  dated.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const old of dated.slice(keep)) await unlink(join(folder, old.name)).catch(() => undefined);
}
