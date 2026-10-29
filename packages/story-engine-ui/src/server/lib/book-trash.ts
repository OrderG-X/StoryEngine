/**
 * 书的回收站（P10）：删书不再 `rm -rf`，整本书挪进书库根下的 `回收站/`，30 天内能恢复，过期才真删。
 *
 * 每条：`回收站/<条目>/book/` 是整本书原样（含存档历史、对话），`trash.json` 记书名、原路径、删除时间。
 * 挪动在书锁里做（等手头的写入做完再挪）；跨盘挪不动就复制再删。
 * 恢复挪回原路径；原路径被占了（比如又建了同目录名的书）就加后缀，绝不覆盖。
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { bumpRevision, withBookLock } from "@actalk/story-core";
import { resolveBooksRootDir } from "./data-dirs.js";
import { isSafeProjectPath } from "./project-io.js";

export const TRASH_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_FILE = "trash.json";
const BOOK_DIR = "book";

export function resolveTrashDir(): string {
  return join(resolveBooksRootDir(), "回收站");
}

interface TrashRecord {
  readonly version: 1;
  readonly title: string;
  readonly originalPath: string;
  readonly deletedAt: string;
}

export interface TrashItem {
  readonly id: string;
  readonly title: string;
  readonly originalPath: string;
  readonly deletedAt: string;
  /** 还剩几天被真删（向上取整，最少 0）。 */
  readonly daysLeft: number;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 跨盘 rename 会报 EXDEV：复制一份再删原处。 */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isSafeId(id: string): boolean {
  return Boolean(id) && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0");
}

async function readRecord(entryDir: string): Promise<TrashRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(join(entryDir, RECORD_FILE), "utf-8")) as Partial<TrashRecord>;
    if (typeof parsed.title !== "string" || typeof parsed.originalPath !== "string" || typeof parsed.deletedAt !== "string") return null;
    if (!Number.isFinite(Date.parse(parsed.deletedAt))) return null;
    return { version: 1, title: parsed.title, originalPath: parsed.originalPath, deletedAt: parsed.deletedAt };
  } catch {
    return null;
  }
}

/** 把一本书挪进回收站，回条目 id。 */
export async function moveBookToTrash(projectDir: string, title: string, now: Date = new Date()): Promise<string> {
  const source = resolve(projectDir);
  const trashDir = resolveTrashDir();
  if (isInside(source, trashDir) || isInside(trashDir, source)) throw new Error("这个目录和回收站重叠，不能这样删。");
  return withBookLock(source, async () => {
    await mkdir(trashDir, { recursive: true });
    const baseId = `${basename(source)}-${stamp(now)}`;
    let id = baseId;
    for (let n = 2; await exists(join(trashDir, id)); n += 1) id = `${baseId}-${n}`;
    const entry = join(trashDir, id);
    await mkdir(entry);
    const record: TrashRecord = { version: 1, title, originalPath: source, deletedAt: now.toISOString() };
    await writeFile(join(entry, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    try {
      await moveDir(source, join(entry, BOOK_DIR));
    } catch (error) {
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return id;
  });
}

/** 列回收站（新删的在前）；顺手真删超过 30 天的。认不出的目录不碰。 */
export async function listTrash(now: Date = new Date()): Promise<TrashItem[]> {
  const trashDir = resolveTrashDir();
  const names = await readdir(trashDir).catch(() => [] as string[]);
  const items: TrashItem[] = [];
  for (const id of names) {
    if (!isSafeId(id)) continue;
    const entry = join(trashDir, id);
    const record = await readRecord(entry);
    if (!record || !(await exists(join(entry, BOOK_DIR)))) continue;
    const expiresAt = Date.parse(record.deletedAt) + TRASH_KEEP_DAYS * DAY_MS;
    if (expiresAt <= now.getTime()) {
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    items.push({ id, title: record.title, originalPath: record.originalPath, deletedAt: record.deletedAt, daysLeft: Math.max(0, Math.ceil((expiresAt - now.getTime()) / DAY_MS)) });
  }
  return items.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
}

async function requireEntry(id: string): Promise<{ readonly entry: string; readonly record: TrashRecord }> {
  if (!isSafeId(id)) throw new Error("回收站里没有这本书。");
  const entry = join(resolveTrashDir(), id);
  const record = await readRecord(entry);
  if (!record || !(await exists(join(entry, BOOK_DIR)))) throw new Error("回收站里没有这本书。");
  return { entry, record };
}

/** 恢复：挪回原路径；被占了就加「-恢复」「-恢复2」…，回恢复到的路径。 */
export async function restoreFromTrash(id: string): Promise<{ readonly projectPath: string; readonly title: string }> {
  const { entry, record } = await requireEntry(id);
  // 原路径来自回收站里的说明文件：不在安全范围内（被人改过）就放回默认书库。
  const original = isSafeProjectPath(record.originalPath)
    ? resolve(record.originalPath)
    : join(resolveBooksRootDir(), "story-engine", basename(record.originalPath) || id);
  let target = original;
  for (let n = 1; await exists(target); n += 1) target = `${original}-恢复${n > 1 ? n : ""}`;
  await mkdir(dirname(target), { recursive: true });
  // 搬回来的书换一个新的写入代次（读过原路径后来那一版的预览、缓存不能当没变）：走核心事务写，store-control 是软链之类
  // 换不了就停下，回收站这一条原样留着（P1 第 22 轮 AJ4）。
  await bumpRevision(join(entry, BOOK_DIR));
  await moveDir(join(entry, BOOK_DIR), target);
  await rm(entry, { recursive: true, force: true });
  return { projectPath: target, title: record.title };
}

/** 彻底删除一条（作者在回收站里再确认过才调）。 */
export async function purgeFromTrash(id: string): Promise<{ readonly title: string }> {
  const { entry, record } = await requireEntry(id);
  await rm(entry, { recursive: true, force: true });
  return { title: record.title };
}
