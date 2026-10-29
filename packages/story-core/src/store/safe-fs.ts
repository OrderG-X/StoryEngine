/**
 * 书里整份换上一个文件的底层（P1 第 21 轮 AI2）：核心事务、老格式事务、另存区写文件都走这里，不各写各的。
 *
 * 写一份新内容：目标同目录新建临时文件（O_CREAT | O_EXCL | O_NOFOLLOW）→ 写、落盘 → rename 前再核一遍 → rename
 * → 换上后核 → 目录落盘。把已经写好的文件挪到位（核心事务的暂存、备份）同一套：先不跟软链打开它、核内容指纹，拿着打开的它去换。
 *
 * rename 前核（拿着打开的那个文件）：
 *  - 从书目录到源、目标的上级，每一级都是真目录、不是软链，而且还是开工时那一个目录（设备号 + inode），真实路径在书里；
 *  - 源路径上还是打开的那个文件、普通文件、只有一个链接；
 *  - 目标不在，或是只有一个链接的普通文件（原来有的沿用它的权限）。
 * 换上后核：目标就是打开的那个文件、上级没换过。Node 没有 renameat，核完到 rename 之间还有极短的窗口：
 * 那时被调换的，换上后的核验如实报错（调用方当没换成、事务留着重来），绝不当成功。
 *
 * 抛的错带稳定的 code（UNSAFE_*），信息里只有相对路径。
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** 测试钩子停的点（老格式事务的单测在这两处调换路径）。 */
export type SafeWriteHookPoint = "after-precheck-before-open" | "after-open-before-verify";
export type SafeWriteHook = (point: SafeWriteHookPoint, targetPath: string) => Promise<void> | void;

interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

function unsafe(code: string, message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function escapes(rel: string): boolean {
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * 从书目录到 dir 每一级都是真目录（书目录自己也不能是软链）；返回 dir 的身份。哪一级不在照原样抛（ENOENT）。
 */
export async function plainDirIdentity(root: string, dir: string, label: string): Promise<DirIdentity> {
  const rel = relative(root, dir);
  if (escapes(rel)) throw unsafe("UNSAFE_PATH_OUTSIDE_PROJECT", `Unsafe ${label}: path outside project: ${rel}`);
  let stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw unsafe("UNSAFE_PROJECT_ROOT", `Unsafe ${label}: project root is not a real directory.`);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    stats = await lstat(current);
    if (stats.isSymbolicLink()) throw unsafe("UNSAFE_SYMLINK", `Unsafe ${label}: symbolic link at ${relative(root, current)}`);
    if (!stats.isDirectory()) throw unsafe("UNSAFE_PARENT", `Unsafe ${label}: non-directory parent at ${relative(root, current)}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

/** dir 还是开工时那一个目录、整条路上没有软链、真实路径在书里。 */
async function assertSameDir(root: string, dir: string, before: DirIdentity, label: string): Promise<void> {
  const now = await plainDirIdentity(root, dir, label);
  if (now.dev !== before.dev || now.ino !== before.ino) {
    throw unsafe("UNSAFE_DIRECTORY_SWAPPED", `Unsafe ${label}: directory changed underneath at ${relative(root, dir) || "."}`);
  }
  const [rootReal, dirReal] = await Promise.all([realpath(root), realpath(dir)]);
  if (escapes(relative(rootReal, dirReal))) throw unsafe("UNSAFE_CONTAINMENT", `Unsafe ${label}: parent realpath escaped project containment.`);
}

/** 路径上的就是打开的那个文件、普通文件、只有一个链接。 */
async function assertHeldFile(handle: FileHandle, path: string, root: string, label: string): Promise<Stats> {
  const [held, onPath] = await Promise.all([handle.stat(), lstat(path)]);
  const rel = relative(root, path);
  if (onPath.isSymbolicLink() || !onPath.isFile() || !held.isFile()) throw unsafe("UNSAFE_NOT_A_FILE", `Unsafe ${label}: ${rel} is not a real file.`);
  if (held.dev !== onPath.dev || held.ino !== onPath.ino) throw unsafe("UNSAFE_INODE_MISMATCH", `Unsafe ${label}: ${rel} is no longer the file that was opened.`);
  if (held.nlink !== 1) throw unsafe("UNSAFE_HARDLINK", `Unsafe ${label}: hard-linked files are not allowed (${rel}).`);
  return held;
}

/** 要被整份换掉的目标：不在是 undefined；只有一个链接的普通文件返回它的权限位；软链、目录、多链接的拒绝。 */
export async function replaceableTargetMode(root: string, target: string, label: string): Promise<number | undefined> {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const rel = relative(root, target);
  if (stats.isSymbolicLink() || !stats.isFile()) throw unsafe("UNSAFE_NOT_A_FILE", `Unsafe ${label}: ${rel} is not a real file.`);
  if (stats.nlink !== 1) throw unsafe("UNSAFE_HARDLINK", `Unsafe ${label}: hard-linked targets are not allowed (${rel}).`);
  return stats.mode & 0o7777;
}

/** 目录落盘（rename 换上的那一项被杀也还在）。 */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 拿着打开的源文件把它换到目标（见文件头：rename 前核、换上后核、目录落盘）。 */
async function renameHeld(
  root: string,
  source: { readonly handle: FileHandle; readonly path: string; readonly dir: DirIdentity },
  target: { readonly path: string; readonly dir: DirIdentity },
  label: string,
): Promise<void> {
  await assertSameDir(root, dirname(source.path), source.dir, label);
  await assertHeldFile(source.handle, source.path, root, label);
  await assertSameDir(root, dirname(target.path), target.dir, label);
  await replaceableTargetMode(root, target.path, label);
  await rename(source.path, target.path);
  await assertSameDir(root, dirname(target.path), target.dir, label);
  await assertHeldFile(source.handle, target.path, root, label);
  await syncDirectory(dirname(target.path));
  if (dirname(source.path) !== dirname(target.path)) await syncDirectory(dirname(source.path));
}

/**
 * 整份写上 target（上级目录调用方先建好）。原来有的沿用它的权限；原来没有的按 createMode 建（受 umask 管，缺省 0600）。
 * 没换上就删掉临时文件。
 */
export async function writeFileInBook(
  root: string,
  target: string,
  content: string,
  options: { readonly label: string; readonly createMode?: number; readonly hook?: SafeWriteHook | undefined },
): Promise<void> {
  const { label } = options;
  const dir = dirname(target);
  const dirId = await plainDirIdentity(root, dir, label);
  await replaceableTargetMode(root, target, label);
  await options.hook?.("after-precheck-before-open", target);
  const temporary = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    options.createMode ?? 0o600,
  );
  let placed = false;
  try {
    try {
      await options.hook?.("after-open-before-verify", target);
      await assertSameDir(root, dir, dirId, label);
      await assertHeldFile(handle, temporary, root, label);
      const mode = await replaceableTargetMode(root, target, label);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.writeFile(content, "utf-8");
      await handle.sync();
      await renameHeld(root, { handle, path: temporary, dir: dirId }, { path: target, dir: dirId }, label);
      placed = true;
    } finally {
      await handle.close();
    }
  } finally {
    if (!placed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * 把书里已经写好的 source 挪到 target（核心事务的暂存、备份换上）：不跟软链打开 source，内容指纹（给了的话）对上才挪；
 * 目标原来有的沿用它的权限。
 */
export async function moveFileInBook(
  root: string,
  source: string,
  target: string,
  options: { readonly label: string; readonly expectSha?: string | undefined },
): Promise<void> {
  const { label } = options;
  const sourceDir = await plainDirIdentity(root, dirname(source), label);
  const targetDir = await plainDirIdentity(root, dirname(target), label);
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    await assertHeldFile(handle, source, root, label);
    if (options.expectSha !== undefined && sha256(await handle.readFile("utf-8")) !== options.expectSha) {
      throw unsafe("UNSAFE_CONTENT_MISMATCH", `Unsafe ${label}: ${relative(root, source)} does not hold what was written.`);
    }
    const mode = await replaceableTargetMode(root, target, label);
    if (mode !== undefined) await handle.chmod(mode);
    await renameHeld(root, { handle, path: source, dir: sourceDir }, { path: target, dir: targetDir }, label);
  } finally {
    await handle.close();
  }
}

/**
 * 不跟软链读书里一个文件：整条上级是真目录、自己是只有一个链接的普通文件，读完再核上级没换过。不在是 undefined。
 */
export async function readFileInBook(root: string, path: string, label: string): Promise<string | undefined> {
  let dirId: DirIdentity;
  let handle: FileHandle;
  try {
    dirId = await plainDirIdentity(root, dirname(path), label);
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    await assertHeldFile(handle, path, root, label);
    const text = await handle.readFile("utf-8");
    await assertSameDir(root, dirname(path), dirId, label);
    return text;
  } finally {
    await handle.close();
  }
}
