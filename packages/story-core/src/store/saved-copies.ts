/**
 * 恢复前另存（P1 第 19 轮复核 AG1/AG3）：收拾上次没写完的事务时，要盖掉或删掉的文件，盘上现在的内容如果不是那份事务
 * 自己写的（核不上，或老格式核不了），先原样另存一份再动——升级前后的版本混着用过，残留的事务可能比现在的稿还旧，
 * 拿它的备份往回换会把之后存下的整份稿盖掉，而那常常是唯一的一份。另存不下，这一轮恢复就停（调用方抛出）。
 *
 * 一份一个文件 `.story-core-saved/<号>.json`（story-core-saved/1）：哪个文件、原样的内容、从哪份事务的恢复里存的。
 * 号按「事务 + 文件 + 内容」算：恢复被杀了重来，同一份不会存两遍。工作稿的那份在稿纸上当恢复稿提示作者「找回 / 不要了」；
 * 作者处理了记成已清（清掉字）。不进存档点，作者没处理的不自动清。
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
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

function savedId(from: string, path: string, sha: string): string {
  return `kept-${sha256(`${from}\n${path}\n${sha}`).slice(0, 20)}`;
}

async function writeDurableAtomic(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(dir, name));
}

async function savedDir(bookDir: string): Promise<string> {
  const dir = join(bookDir, SAVED_COPIES_DIR);
  try {
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`另存区不是普通目录，拒绝写：${SAVED_COPIES_DIR}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * 恢复要动这个文件之前，把它现在的内容另存一份（调用方持书锁）。同一份事务里同一个文件、同样的内容已经存过就不再存。
 * 写不下抛出（调用方停下这一轮恢复）。
 */
export async function saveCopyBeforeRestore(bookDir: string, input: { readonly from: string; readonly path: string; readonly content: string }): Promise<void> {
  const sha = sha256(input.content);
  const id = savedId(input.from, input.path, sha);
  const dir = await savedDir(bookDir);
  try {
    await lstat(join(dir, `${id}.json`));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
      typeof value.savedAt !== "string"
    ) return undefined;
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

async function readSaved(bookDir: string, id: string): Promise<SavedCopyFile | undefined> {
  if (!ID.test(id)) return undefined;
  try {
    const parsed = parseSaved(await readFile(join(bookDir, SAVED_COPIES_DIR, `${id}.json`), "utf-8"));
    return parsed?.id === id ? parsed : undefined;
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
