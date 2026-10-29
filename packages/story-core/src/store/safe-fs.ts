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
 * 盖掉 / 删掉别人可能动过的那份（回滚、恢复：placeFileInBook、removeFileInBook，P1 第 22 轮 AJ2、第 24 轮）：拿内容证明，
 * 不拿链接数、inode 代替。Node 没有「目标还是这份才换」的原子 rename（renamex_np / renameat2），就分三步、每步都不丢东西：
 *  1. 先把目标 rename 到调用方给的固定名字（aside，事务目录里）——这之后原处有人放了新的，不会被盖；
 *  2. 拿着打开的它核：挪开的就是核过的那个文件、内容（从头重读）还是该换掉的那份；不是就原样放回（原处又有了就留在 aside），如实失败；
 *  3. 独占放上（link：原处有了就不放，如实失败），再删 aside：删了以后拿着它再从头读一遍，删之前有人往里写过就原样写回 aside、如实失败。
 * 被杀在任何一步，下次照固定名字 settleInterruptedPlace 收拾：放上了还没摘名字的摘掉，挪开了还没放上的放回去，原处又有了的交调用方另存。
 * 第 1 步到第 3 步之间原处是空的（读的一方读到「没有」）：只有回滚、恢复这种本来就有半截事务挡着的地方用。
 * 正常写（moveFileInBook 的 precheckTargetSha）只在 rename 前核一遍目标：守的是书锁之外的写在这之前改过的，核完到 rename
 * 之间那一瞬不守——要守就得留上面的空档，作者存稿、读稿天天走这条路，代价更大；书里的写本来都在书锁里。
 *
 * 抛的错带稳定的 code（UNSAFE_*），信息里只有相对路径。
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, open, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
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

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
}

/** 拿着打开的文件从头读完（不靠文件位置：同一个打开的文件要读好几遍）。 */
async function bytesOf(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return Buffer.concat(chunks);
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
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

function targetChanged(root: string, path: string, label: string): Error {
  return unsafe("UNSAFE_TARGET_CHANGED", `Unsafe ${label}: ${relative(root, path)} is not what was checked before replacing it.`);
}

/**
 * 正常写 rename 前核一遍要被盖掉的那份（见文件头）：不跟软链打开、单链接普通文件、内容是 expect。不在、对不上如实报错。
 */
async function precheckTarget(root: string, path: string, expect: string, label: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) throw targetChanged(root, path, label);
    throw error;
  }
  try {
    await assertHeldFile(handle, path, root, label);
    if (sha256((await bytesOf(handle)).toString("utf-8")) !== expect) throw targetChanged(root, path, label);
  } finally {
    await handle.close();
  }
}

/** 拿着打开的源文件把它换到目标（见文件头：rename 前核、换上后核、目录落盘）。 */
async function renameHeld(
  root: string,
  source: { readonly handle: FileHandle; readonly path: string; readonly dir: DirIdentity },
  target: { readonly path: string; readonly dir: DirIdentity; readonly precheck?: string | undefined },
  label: string,
): Promise<void> {
  await assertSameDir(root, dirname(source.path), source.dir, label);
  await assertHeldFile(source.handle, source.path, root, label);
  await assertSameDir(root, dirname(target.path), target.dir, label);
  if (target.precheck !== undefined) await precheckTarget(root, target.path, target.precheck, label);
  else await replaceableTargetMode(root, target.path, label);
  await rename(source.path, target.path);
  await assertSameDir(root, dirname(target.path), target.dir, label);
  await assertHeldFile(source.handle, target.path, root, label);
  await syncDirectory(dirname(target.path));
  if (dirname(source.path) !== dirname(target.path)) await syncDirectory(dirname(source.path));
}

/**
 * 整份写上 target（上级目录调用方先建好）。原来有的沿用它的权限；原来没有的按 createMode 建（受 umask 管，缺省 0600）。
 * 没换上就删掉临时文件。不核原来那份是什么：清单、代次、另存区、调用方自己的暂存这类只有自己写的文件用。
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

/** 不跟软链打开书里已经写好的 source、核是单链接普通文件，给了 expectSha 的内容要对得上。 */
async function openSource(root: string, source: string, expectSha: string | undefined, label: string): Promise<FileHandle> {
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    await assertHeldFile(handle, source, root, label);
    if (expectSha !== undefined && sha256((await bytesOf(handle)).toString("utf-8")) !== expectSha) {
      throw unsafe("UNSAFE_CONTENT_MISMATCH", `Unsafe ${label}: ${relative(root, source)} does not hold what was written.`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * 正常写：把书里已经写好的 source 挪到 target（核心事务换上暂存）：不跟软链打开 source，内容指纹（给了的话）对上才挪；
 * 目标原来有的沿用它的权限；给了 precheckTargetSha 的，rename 前核目标还是这份（见文件头：只守之前，不守那一瞬）。
 */
export async function moveFileInBook(
  root: string,
  source: string,
  target: string,
  options: { readonly label: string; readonly expectSha?: string | undefined; readonly precheckTargetSha?: string | undefined },
): Promise<void> {
  const { label } = options;
  const sourceDir = await plainDirIdentity(root, dirname(source), label);
  const targetDir = await plainDirIdentity(root, dirname(target), label);
  const handle = await openSource(root, source, options.expectSha, label);
  try {
    const mode = await replaceableTargetMode(root, target, label);
    if (mode !== undefined) await handle.chmod(mode);
    await renameHeld(root, { handle, path: source, dir: sourceDir }, { path: target, dir: targetDir, precheck: options.precheckTargetSha }, label);
  } finally {
    await handle.close();
  }
}

/** aside 是调用方自己的固定名字：得空着（上次留下的先 settleInterruptedPlace 收拾）。 */
async function assertAsideVacant(root: string, aside: string, label: string): Promise<void> {
  if (await lstatOrUndefined(aside)) throw unsafe("UNSAFE_ASIDE_OCCUPIED", `Unsafe ${label}: ${relative(root, aside)} is still holding an earlier file.`);
}

/** 挪开的那份原样放回原处：原处空着才放（link 独占），放回了摘掉 aside；原处又有了、或它不是普通文件，就留在 aside。 */
async function putBack(aside: string, target: string): Promise<void> {
  const stats = await lstatOrUndefined(aside);
  if (!stats?.isFile()) return;
  try {
    await link(aside, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  await unlink(aside);
}

/**
 * 盖掉 / 删掉之前的第 1、2 步（见文件头）：核过目标是 expect → 挪到 aside → 核挪开的就是它、内容从头重读还是 expect。
 * 返回拿着的它（调用方删 aside 时再用）；核不上原样放回、如实报错。
 */
async function takeAside(
  root: string,
  target: { readonly path: string; readonly dir: DirIdentity },
  aside: { readonly path: string; readonly dir: DirIdentity },
  expect: string,
  label: string,
): Promise<FileHandle> {
  await assertAsideVacant(root, aside.path, label);
  let held: FileHandle;
  try {
    held = await open(target.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) throw targetChanged(root, target.path, label);
    throw error;
  }
  try {
    await assertHeldFile(held, target.path, root, label);
    if (sha256((await bytesOf(held)).toString("utf-8")) !== expect) throw targetChanged(root, target.path, label);
    await assertSameDir(root, dirname(target.path), target.dir, label);
    await assertSameDir(root, dirname(aside.path), aside.dir, label);
    await rename(target.path, aside.path);
    let proven = false;
    try {
      await assertSameDir(root, dirname(target.path), target.dir, label);
      await assertSameDir(root, dirname(aside.path), aside.dir, label);
      await assertHeldFile(held, aside.path, root, label);
      proven = sha256((await bytesOf(held)).toString("utf-8")) === expect;
    } catch {
      proven = false;
    }
    if (!proven) {
      await putBack(aside.path, target.path);
      throw targetChanged(root, target.path, label);
    }
    return held;
  } catch (error) {
    await held.close();
    throw error;
  }
}

/**
 * 删掉 aside（第 3 步后半）：aside 上还是拿着的那份才删；删了以后拿着它从头再读一遍，删之前有人往里写过（不是 expect）
 * 就原样写回 aside（独占新建）、如实报错。
 */
async function discardHeld(root: string, aside: string, held: FileHandle, expect: string, label: string): Promise<void> {
  await assertHeldFile(held, aside, root, label);
  await unlink(aside);
  const after = await bytesOf(held);
  if (sha256(after.toString("utf-8")) !== expect) {
    const keep = await open(aside, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      .catch(() => open(`${aside}.${randomBytes(6).toString("hex")}`, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600));
    try {
      await keep.writeFile(after);
      await keep.sync();
    } finally {
      await keep.close();
    }
    await syncDirectory(dirname(aside));
    throw unsafe("UNSAFE_TARGET_CHANGED", `Unsafe ${label}: ${relative(root, aside)} was written to while it was being removed; kept as is.`);
  }
  await syncDirectory(dirname(aside));
}

/**
 * 回滚 / 恢复放上一份（见文件头三步）：source 是书里已经写好的（给了 expectSha 的内容要对得上）；expectTarget 是目标现在该是什么
 * （null = 该不在：直接独占放上；指纹：先挪到 aside 核过，再放上、再删 aside）。放上用 link，被杀在 link 之后 source 和目标是
 * 同一个文件，下次 settleInterruptedPlace 摘掉 source。目标原来有的沿用它的权限。
 */
export async function placeFileInBook(
  root: string,
  source: string,
  target: string,
  options: { readonly label: string; readonly expectSha?: string | undefined } & (
    | { readonly expectTarget: null }
    | { readonly expectTarget: string; readonly aside: string }
  ),
): Promise<void> {
  const { label } = options;
  const sourceDir = await plainDirIdentity(root, dirname(source), label);
  const targetDir = await plainDirIdentity(root, dirname(target), label);
  const handle = await openSource(root, source, options.expectSha, label);
  try {
    const mode = await replaceableTargetMode(root, target, label);
    if (mode !== undefined) await handle.chmod(mode);
    let displaced: { readonly held: FileHandle; readonly aside: string } | undefined;
    if (options.expectTarget !== null) {
      const asideDir = await plainDirIdentity(root, dirname(options.aside), label);
      displaced = { held: await takeAside(root, { path: target, dir: targetDir }, { path: options.aside, dir: asideDir }, options.expectTarget, label), aside: options.aside };
    } else if (await lstatOrUndefined(target)) {
      throw targetChanged(root, target, label);
    }
    try {
      await assertSameDir(root, dirname(source), sourceDir, label);
      await assertHeldFile(handle, source, root, label);
      await assertSameDir(root, dirname(target), targetDir, label);
      try {
        await link(source, target);
      } catch (error) {
        // 原处又有了（挪开之后、或该不在的却来了）：不放；挪开的那份留在 aside，下次收拾时交调用方另存。
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw targetChanged(root, target, label);
        throw error;
      }
      try {
        await assertSameDir(root, dirname(target), targetDir, label);
      } catch (error) {
        // 放的那一下上级被换了（放到了别处）：摘掉刚放的这个名字（还是自己那个文件才摘），source 留着。
        const placed = await lstatOrUndefined(target).catch(() => undefined);
        const own = await handle.stat();
        if (placed && placed.dev === own.dev && placed.ino === own.ino) await unlink(target).catch(() => undefined);
        throw error;
      }
      await unlink(source);
      await assertHeldFile(handle, target, root, label);
      await syncDirectory(dirname(target));
      if (dirname(source) !== dirname(target)) await syncDirectory(dirname(source));
      if (displaced) await discardHeld(root, displaced.aside, displaced.held, options.expectTarget as string, label);
    } finally {
      await displaced?.held.close();
    }
  } finally {
    await handle.close();
  }
}

/**
 * 回滚 / 恢复删掉书里一个文件，只删核过的那份（见文件头）：不在就当删过了；在的话先挪到 aside、核挪开的就是它、内容还是
 * expectSha 才删，删后再核。核不上原样放回、如实报错。
 */
export async function removeFileInBook(root: string, target: string, options: { readonly label: string; readonly expectSha: string; readonly aside: string }): Promise<void> {
  const { label } = options;
  const targetDir = await plainDirIdentity(root, dirname(target), label);
  const asideDir = await plainDirIdentity(root, dirname(options.aside), label);
  if (!(await lstatOrUndefined(target))) return;
  const held = await takeAside(root, { path: target, dir: targetDir }, { path: options.aside, dir: asideDir }, options.expectSha, label);
  try {
    await syncDirectory(dirname(target));
    await discardHeld(root, options.aside, held, options.expectSha, label);
  } finally {
    await held.close();
  }
}

/**
 * 上次 placeFileInBook / removeFileInBook 被杀在半路留下的，照固定名字收拾（见文件头）：sources 里和目标是同一个文件的
 * （放上了、还没摘名字）摘掉；aside 在、原处空着的放回去，原处就是它的摘掉 aside。原处另有一份的：返回 aside 里的内容，
 * 调用方先另存、再 discardAside。aside 不是普通文件如实报错。
 */
export async function settleInterruptedPlace(
  root: string,
  target: string,
  options: { readonly label: string; readonly sources: readonly string[]; readonly aside: string },
): Promise<string | undefined> {
  const { label } = options;
  // 目标的上级不在了：不会有放上一半的，挪开的那份也放不回去（交调用方另存）。
  const targetDir = await plainDirIdentity(root, dirname(target), label).then(() => true, (error: unknown) => {
    if (isMissing(error)) return false;
    throw error;
  });
  for (const source of targetDir ? options.sources : []) {
    const [placed, onTarget] = await Promise.all([lstatOrUndefined(source), lstatOrUndefined(target)]);
    if (placed?.isFile() && onTarget?.isFile() && placed.dev === onTarget.dev && placed.ino === onTarget.ino) {
      await plainDirIdentity(root, dirname(source), label);
      await unlink(source);
      await syncDirectory(dirname(source));
    }
  }
  const aside = await lstatOrUndefined(options.aside);
  if (!aside) return undefined;
  await plainDirIdentity(root, dirname(options.aside), label);
  if (aside.isSymbolicLink() || !aside.isFile()) throw unsafe("UNSAFE_NOT_A_FILE", `Unsafe ${label}: ${relative(root, options.aside)} is not a real file.`);
  if (targetDir && !(await lstatOrUndefined(target))) await putBack(options.aside, target);
  const [left, onTarget] = await Promise.all([lstatOrUndefined(options.aside), lstatOrUndefined(target)]);
  if (!left) {
    await syncDirectory(dirname(target));
    await syncDirectory(dirname(options.aside));
    return undefined;
  }
  if (onTarget && onTarget.dev === left.dev && onTarget.ino === left.ino) {
    await unlink(options.aside);
    return undefined;
  }
  return readFileInBook(root, options.aside, label);
}

/** 删掉 settleInterruptedPlace 交回来的 aside（调用方已另存）：内容还是 expectSha 才删，删后再核（同 discardHeld）。 */
export async function discardAside(root: string, aside: string, options: { readonly label: string; readonly expectSha: string }): Promise<void> {
  await plainDirIdentity(root, dirname(aside), options.label);
  const held = await openSource(root, aside, options.expectSha, options.label).catch((error: unknown) => {
    throw (error as NodeJS.ErrnoException).code === "UNSAFE_CONTENT_MISMATCH" ? targetChanged(root, aside, options.label) : error;
  });
  try {
    await discardHeld(root, aside, held, options.expectSha, options.label);
  } finally {
    await held.close();
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
