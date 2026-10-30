/**
 * 撤销、整本恢复读存档（写作版本 P2a 片 4B，设计 8.1 / 8.2）。核心不碰 git：怎么读存档树由调用方注入（HistoryReader），
 * 服务端用 git 实现（树 → 撤销范围里的路径和内容键；按键取原始字节；算一份字节的键，和树里的同一种算法）。
 *
 * 一次计划里的读法（HistoryStore）：树的列表按树缓存；字节按内容键缓存，有上限（按字节，满了按最近最少用丢，丢了下次再取）；
 * 现在书里的那几份钉住不丢（它们不在存档里，丢了取不回来）。单个文件超过 32 MB 明确拒绝。
 * 读的都是已经在书锁里读好的东西：不写盘、不拿锁。
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CARDS_PATH, CHAPTER_LEDGER_DIR, chapterFromFileName, DECISIONS_PATH, isUndoablePath, UNDOABLE_DIRS, UNDOABLE_FILES } from "../store/paths.js";
import { sha256Bytes } from "../store/transaction.js";
import { AuthorDecisionsFile, type AuthorDecision } from "../schema/decisions.js";
import { ChapterLedger } from "../schema/ledger.js";
import { SettingCardsFile } from "../schema/cards.js";

export interface HistoryReader {
  /** 这棵存档树里撤销范围内的文件：路径 → 内容键。树不在了（裁掉、回收了）→ undefined。 */
  list(tree: string): Promise<ReadonlyMap<string, string> | undefined>;
  /** 按内容键取原始字节；取不到抛错。 */
  read(key: string): Promise<Uint8Array>;
  /** 一份字节的内容键（和 list 给的同一种）。 */
  keyOf(bytes: Uint8Array): string;
}

/** 一版撤销范围：路径 → 内容键；不在 = 这一版没有这个文件。 */
export type Version = ReadonlyMap<string, string>;

export const HISTORY_FILE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

export class HistoryFileError extends Error {
  constructor(readonly code: "file_too_big" | "not_text" | "file_invalid" | "tree_unreadable", readonly path: string, message: string) {
    super(message);
    this.name = "HistoryFileError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 字节 → 文字（不是 UTF-8 如实失败；原样往返，不丢 BOM）。 */
export function textOf(bytes: Uint8Array, path: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new HistoryFileError("not_text", path, `存档里的这份不是文字，恢复不了：${path}`);
  }
}

export class HistoryStore {
  private readonly lists = new Map<string, Version | undefined>();
  private readonly pinned = new Map<string, Uint8Array>();
  private readonly cached = new Map<string, Uint8Array>();
  private cachedBytes = 0;
  private readonly parsed = new Map<string, unknown>();

  constructor(private readonly reader: HistoryReader, private readonly budget = CACHE_BUDGET_BYTES) {}

  /** 钉住一份（现在书里的）：返回它的键。 */
  pin(bytes: Uint8Array): string {
    const key = this.reader.keyOf(bytes);
    this.pinned.set(key, bytes);
    return key;
  }

  async list(tree: string): Promise<Version | undefined> {
    if (this.lists.has(tree)) return this.lists.get(tree);
    const found = await this.reader.list(tree);
    const version = found ? new Map([...found].filter(([path]) => isUndoablePath(path))) : undefined;
    this.lists.set(tree, version);
    return version;
  }

  async bytes(key: string, path: string): Promise<Uint8Array> {
    const pinned = this.pinned.get(key);
    if (pinned) return pinned;
    const hit = this.cached.get(key);
    if (hit) {
      this.cached.delete(key);
      this.cached.set(key, hit);
      return hit;
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.reader.read(key);
    } catch (error) {
      throw new HistoryFileError("tree_unreadable", path, `存档里的这份取不出来：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (bytes.byteLength > HISTORY_FILE_MAX_BYTES) throw new HistoryFileError("file_too_big", path, `存档里的这份超过 32 MB，不处理：${path}`);
    this.cached.set(key, bytes);
    this.cachedBytes += bytes.byteLength;
    for (const [oldKey, old] of this.cached) {
      if (this.cachedBytes <= this.budget || oldKey === key) break;
      this.cached.delete(oldKey);
      this.cachedBytes -= old.byteLength;
    }
    return bytes;
  }

  async sha(key: string | undefined, path: string): Promise<string | null> {
    return key === undefined ? null : sha256Bytes(await this.bytes(key, path));
  }

  /** 按内容键解析一份（同一份只解析一次）。 */
  private async parse<T>(key: string, path: string, parse: (value: unknown) => T): Promise<T> {
    const memo = `${path.startsWith(CHAPTER_LEDGER_DIR) ? "ledger" : path}|${key}`;
    if (this.parsed.has(memo)) return this.parsed.get(memo) as T;
    let value: T;
    try {
      value = parse(JSON.parse(textOf(await this.bytes(key, path), path)));
    } catch (error) {
      if (error instanceof HistoryFileError) throw error;
      throw new HistoryFileError("file_invalid", path, `这一版的 ${path} 读不了，撤不了。`);
    }
    this.parsed.set(memo, value);
    return value;
  }

  ledger(key: string, path: string): Promise<ChapterLedger> {
    return this.parse(key, path, (value) => ChapterLedger.parse(value));
  }

  async decisions(key: string | undefined): Promise<readonly AuthorDecision[]> {
    return key === undefined ? [] : (await this.parse(key, DECISIONS_PATH, (value) => AuthorDecisionsFile.parse(value))).decisions;
  }

  async cards(key: string | undefined): Promise<SettingCardsFile | undefined> {
    return key === undefined ? undefined : this.parse(key, CARDS_PATH, (value) => SettingCardsFile.parse(value));
  }
}

/** 账单文件的章号（不是账单返回 undefined）。 */
export function ledgerChapterOfPath(path: string): number | undefined {
  const prefix = `${CHAPTER_LEDGER_DIR}/`;
  if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/") || !path.endsWith(".json")) return undefined;
  return chapterFromFileName(path.slice(prefix.length));
}

/** 撤销核引用要比的那几份：全部账单、裁定、设定卡（设计 8.1「依赖」：按全集比）。 */
export function isReferenceFile(path: string): boolean {
  return path === DECISIONS_PATH || path === CARDS_PATH || ledgerChapterOfPath(path) !== undefined;
}

/**
 * 现在书里撤销范围的文件（调用方在书锁里调）：路径 → 字节。不是普通文件（软链、目录）如实失败，超过 32 MB 如实失败。
 */
export async function readUndoableFiles(bookDir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const take = async (path: string): Promise<void> => {
    let stats;
    try {
      stats = await lstat(join(bookDir, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new HistoryFileError("file_invalid", path, `书里的这份不是普通文件，不处理：${path}`);
    if (stats.size > HISTORY_FILE_MAX_BYTES) throw new HistoryFileError("file_too_big", path, `书里的这份超过 32 MB，不处理：${path}`);
    files.set(path, await readFile(join(bookDir, path)));
  };
  for (const dir of UNDOABLE_DIRS) {
    let names: string[];
    try {
      names = await readdir(join(bookDir, dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      throw error;
    }
    for (const name of names.sort()) if (isUndoablePath(`${dir}/${name}`)) await take(`${dir}/${name}`);
  }
  for (const path of UNDOABLE_FILES) await take(path);
  return files;
}

/** 整个撤销范围的摘要（整本恢复冻结它，设计 8.2）：每个路径和它的 sha256 排好算一个哈希。 */
export function rangeDigestOf(files: ReadonlyMap<string, Uint8Array>): string {
  const lines = [...files].map(([path, bytes]) => `${path}\t${sha256Bytes(bytes)}\n`).sort();
  return sha256Bytes(lines.join(""));
}
