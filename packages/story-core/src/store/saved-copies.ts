/**
 * 恢复前另存（P1 第 19 轮复核 AG1/AG3）：收拾上次没写完的事务时，要盖掉或删掉的文件，盘上现在的内容如果不是那份事务
 * 自己写的（核不上，或老格式核不了），先原样另存一份再动——升级前后的版本混着用过，残留的事务可能比现在的稿还旧，
 * 拿它的备份往回换会把之后存下的整份稿盖掉，而那常常是唯一的一份。另存不下，这一轮恢复就停（调用方抛出）。
 *
 * 一份一个文件 `.story-core-saved/<号>.json`（story-core-saved/1）：哪个文件、原样的内容、从哪份事务实例的恢复里存的。
 * 号按「事务实例 + 文件 + 内容」算：恢复被杀了重来，同一份不会存两遍。工作稿的那份在稿纸上当恢复稿提示作者「找回 / 不要了」；
 * 作者处理了记成已清（清掉字）。不进存档点，作者没处理的不自动清。
 *
 * 去重只认存妥了的（P1 第 20 轮 AH1）：盘上有一份普通文件、读得出、同一事务实例同一文件、原文和指纹都对得上、作者还没处理。
 * 同名的是目录、软链、坏的、原文对不上、已经清过的，都不算——另起一个号再存一份（号被占了不等于存过）。
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseDraftFile } from "../draft/format.js";
import { draftChapterOfPath, SAVED_COPIES_DIR } from "./paths.js";

export const SAVED_COPY_SCHEMA = "story-core-saved/1" as const;

interface SavedCopyFile {
  readonly schema: typeof SAVED_COPY_SCHEMA;
  readonly id: string;
  /** 相对书目录的路径。 */
  readonly path: string;
  readonly content: string;
  readonly sha: string;
  /** 从哪份事务的恢复里存的（事务号，只留证）。 */
  readonly from: string;
  readonly savedAt: string;
  readonly settled?: true;
}

/** 稿纸上提示的一份（工作稿另存的）。 */
export interface SavedDraft {
  readonly id: string;
  readonly chapter: number;
  readonly title?: string;
  readonly body: string;
  readonly savedAt: string;
  readonly settled: boolean;
}

const ID = /^kept-[0-9a-f]{20}$/u;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

function savedId(from: string, path: string, sha: string, salt?: string): string {
  return `kept-${sha256(`${from}\n${path}\n${sha}${salt === undefined ? "" : `\n${salt}`}`).slice(0, 20)}`;
}

/** 目录落盘（rename 换上的那一项被杀也还在）。 */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 先写同目录临时文件（新建、不跟软链）、落盘，再一次 rename 换上，目录落盘。 */
async function writeDurableAtomic(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(dir, name));
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
  await syncDirectory(dir);
}

async function assertPlainDir(dir: string): Promise<void> {
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`另存区不是普通目录，拒绝写：${SAVED_COPIES_DIR}`);
}

async function savedDir(bookDir: string): Promise<string> {
  const dir = join(bookDir, SAVED_COPIES_DIR);
  try {
    await assertPlainDir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dir);
    await assertPlainDir(dir);
    await syncDirectory(bookDir);
  }
  return dir;
}

/** 名字被占着没有（什么都算：普通文件、目录、软链，断了的也算）。 */
async function occupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 这一份是不是已经存妥了（见文件头）：同一事务实例、同一文件、原文和指纹都对、作者还没处理。 */
function sameUnsettledCopy(file: SavedCopyFile, input: { readonly from: string; readonly path: string; readonly content: string }, sha: string): boolean {
  return file.settled !== true && file.from === input.from && file.path === input.path && file.content === input.content && file.sha === sha;
}

/**
 * 恢复要动这个文件之前，把它现在的内容另存一份（调用方持书锁）。同一事务实例里同一个文件、同样的内容已经存妥了就不再存；
 * 号被别的东西占着（见文件头）另起一个号存。写不下抛出（调用方停下这一轮恢复）。
 */
export async function saveCopyBeforeRestore(bookDir: string, input: { readonly from: string; readonly path: string; readonly content: string }): Promise<void> {
  const sha = sha256(input.content);
  const dir = await savedDir(bookDir);
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = await readSaved(bookDir, name.slice(0, -".json".length));
    if (file && sameUnsettledCopy(file, input, sha)) return;
  }
  let id = savedId(input.from, input.path, sha);
  if (await occupied(join(dir, `${id}.json`))) id = savedId(input.from, input.path, sha, randomBytes(8).toString("hex"));
  const file: SavedCopyFile = { schema: SAVED_COPY_SCHEMA, id, path: input.path, content: input.content, sha, from: input.from, savedAt: new Date().toISOString() };
  await writeDurableAtomic(dir, `${id}.json`, `${JSON.stringify(file, null, 2)}\n`);
}

function parseSaved(raw: string): SavedCopyFile | undefined {
  try {
    const value = JSON.parse(raw) as Partial<SavedCopyFile>;
    if (
      value.schema !== SAVED_COPY_SCHEMA ||
      typeof value.id !== "string" || !ID.test(value.id) ||
      typeof value.path !== "string" ||
      typeof value.content !== "string" ||
      typeof value.sha !== "string" ||
      typeof value.from !== "string" ||
      typeof value.savedAt !== "string" ||
      (value.settled !== undefined && value.settled !== true)
    ) return undefined;
    // 没处理的原文要和指纹对得上（处理过的清了字，不核）。
    if (value.settled !== true && sha256(value.content) !== value.sha) return undefined;
    return value as SavedCopyFile;
  } catch {
    return undefined;
  }
}

function asDraft(file: SavedCopyFile): SavedDraft | undefined {
  const chapter = draftChapterOfPath(file.path);
  if (chapter === undefined) return undefined;
  const draft = parseDraftFile(file.content);
  return {
    id: file.id,
    chapter,
    ...(draft.title ? { title: draft.title } : {}),
    body: draft.body,
    savedAt: file.savedAt,
    settled: file.settled === true,
  };
}

/** 读一份（不跟软链、只认普通文件）：读不出、对不上的是 undefined。 */
async function readSaved(bookDir: string, id: string): Promise<SavedCopyFile | undefined> {
  if (!ID.test(id)) return undefined;
  try {
    const handle = await open(join(bookDir, SAVED_COPIES_DIR, `${id}.json`), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const parsed = parseSaved(await handle.readFile("utf-8"));
      return parsed?.id === id ? parsed : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** 是不是另存区的号（稿纸「找回 / 不要了」按号分流）。 */
export function isSavedCopyId(id: string): boolean {
  return ID.test(id);
}

/** 这一章工作稿另存的、作者还没处理的（新的在前）。只读：不拿锁、不写盘。 */
export async function listSavedDrafts(bookDir: string, chapter: number): Promise<readonly SavedDraft[]> {
  let names: string[];
  try {
    names = await readdir(join(bookDir, SAVED_COPIES_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts: SavedDraft[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = await readSaved(bookDir, name.slice(0, -".json".length));
    const draft = file && !file.settled ? asDraft(file) : undefined;
    if (draft && draft.chapter === chapter) drafts.push(draft);
  }
  return drafts.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** 读一份工作稿另存的（作者点「找回 / 不要了」时核）。不是工作稿的、读不出的是 undefined。 */
export async function readSavedDraft(bookDir: string, id: string): Promise<SavedDraft | undefined> {
  const file = await readSaved(bookDir, id);
  return file ? asDraft(file) : undefined;
}

/** 作者处理了（找回了 / 不要了）：记成已清、清掉字（调用方持书锁）。已经清了、不在了都算成。 */
export async function settleSavedCopy(bookDir: string, id: string): Promise<void> {
  const file = await readSaved(bookDir, id);
  if (!file || file.settled) return;
  const dir = await savedDir(bookDir);
  const settled: SavedCopyFile = { ...file, content: "", settled: true };
  await writeDurableAtomic(dir, `${id}.json`, `${JSON.stringify(settled, null, 2)}\n`);
}
