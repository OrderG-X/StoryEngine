/**
 * 几份配置文件一起换（模型设置、密钥、任务分配，Astra P2a 第 10 轮第 1 条）：要么全换上、要么全是原样。
 *
 * 文件系统没有多文件事务，以前「先都写好临时文件、再逐个 rename」只把窗口压小：第二个 rename 失败，第一个已经换上了，
 * 接口报 500，盘上却是新地址 + 旧密钥，放锁后下一次调用就把旧密钥发到新站。现在换之前先落一份恢复记录（每个文件原来的内容），
 * 换完删掉；中途失败当场按记录换回原样，换不回（或进程被杀）就留着记录——之后谁要读这几份文件，先按记录换回原样
 * （`recoverConfigCommit`），换不回就抛错，不许拿着半新半旧的设置去解析、发请求。
 *
 * 恢复一律往回退：只有记录删掉了，保存才算成；记录还在说明这次保存没报成功，退回原样和作者看到的一致。
 * 记录里有密钥原文：权限 0600，和密钥文件同口径。调用方持模型设置锁。
 */
import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const CONFIG_COMMIT_SCHEMA = "config-commit/1" as const;

export interface ConfigFileEntry {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

interface JournalEntry {
  readonly path: string;
  /** 换之前的内容；原来没有这个文件是 null。 */
  readonly previous: string | null;
  readonly mode?: number;
  /** 这次写好的临时文件（收拾时顺手删掉）。 */
  readonly staged: string;
}

interface Journal {
  readonly schema: typeof CONFIG_COMMIT_SCHEMA;
  readonly entries: readonly JournalEntry[];
}

/** 单测钩子：换上第 n 个文件之前调一下（模拟中途失败、被杀）。 */
let beforeRenameHook: ((index: number, path: string) => Promise<void>) | undefined;
export function __setConfigCommitHookForTests(hook: ((index: number, path: string) => Promise<void>) | undefined): void {
  beforeRenameHook = hook;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 写到同目录临时文件并落盘（fsync），返回临时文件路径。 */
async function stage(path: string, content: string, mode: number | undefined): Promise<string> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "w", mode ?? 0o644);
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) await chmod(tmp, mode);
  return tmp;
}

async function writeDurable(path: string, content: string, mode: number | undefined): Promise<void> {
  await rename(await stage(path, content, mode), path);
}

function parseJournal(text: string): Journal | undefined {
  try {
    const value = JSON.parse(text) as Partial<Journal>;
    if (value.schema !== CONFIG_COMMIT_SCHEMA || !Array.isArray(value.entries)) return undefined;
    const valid = value.entries.every((entry: Partial<JournalEntry>) =>
      typeof entry.path === "string" && entry.path.length > 0 &&
      (entry.previous === null || typeof entry.previous === "string") &&
      typeof entry.staged === "string" &&
      (entry.mode === undefined || typeof entry.mode === "number"));
    return valid ? (value as Journal) : undefined;
  } catch {
    return undefined;
  }
}

/** 按记录把每个文件换回原样（原来没有的删掉），删掉临时文件，最后删记录。任何一步不成就抛错、记录留着。 */
async function rollBack(journalPath: string, journal: Journal): Promise<void> {
  for (const entry of journal.entries) {
    if (entry.previous === null) await rm(entry.path, { force: true });
    else await writeDurable(entry.path, entry.previous, entry.mode);
    await rm(entry.staged, { force: true });
  }
  await rm(journalPath, { force: true });
}

/**
 * 上次没换完留下的记录：按它换回原样。没有记录什么都不做。换不回、记录读不出来都抛错——调用方别再读这几份文件。
 */
export async function recoverConfigCommit(journalPath: string): Promise<void> {
  const text = await readOrNull(journalPath);
  if (text === null) return;
  const journal = parseJournal(text);
  if (!journal) throw new Error(`上次保存没存完，留下的恢复记录（${basename(journalPath)}）读不出来，没法确定原来的设置：删掉它之后重新填一遍设置和密钥。`);
  try {
    await rollBack(journalPath, journal);
  } catch (error) {
    throw new Error(`上次保存没存完，换回原样也没成（${error instanceof Error ? error.message : String(error)}）：看看数据目录能不能写，再重开软件。`);
  }
}

/**
 * 一起换上这几份文件。先收拾上次留下的（收拾不了就不换）；读原内容 → 写好临时文件 → 落恢复记录 → 逐个换上 → 删记录。
 * 中途失败：当场换回原样再抛；换不回就留着记录抛（之后的读先收拾）。抛了就是没存上。
 */
export async function commitConfigFiles(journalPath: string, files: readonly ConfigFileEntry[]): Promise<void> {
  await recoverConfigCommit(journalPath);
  const previous = await Promise.all(files.map((file) => readOrNull(file.path)));
  const staged: string[] = [];
  try {
    for (const file of files) staged.push(await stage(file.path, file.content, file.mode));
  } catch (error) {
    await Promise.all(staged.map((tmp) => rm(tmp, { force: true }).catch(() => undefined)));
    throw error;
  }
  const journal: Journal = {
    schema: CONFIG_COMMIT_SCHEMA,
    entries: files.map((file, index) => ({
      path: file.path,
      previous: previous[index] ?? null,
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
      staged: staged[index]!,
    })),
  };
  try {
    await writeDurable(journalPath, `${JSON.stringify(journal)}\n`, 0o600);
  } catch (error) {
    await Promise.all(staged.map((tmp) => rm(tmp, { force: true }).catch(() => undefined)));
    await rm(journalPath, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    for (const [index, file] of files.entries()) {
      await beforeRenameHook?.(index, file.path);
      await rename(staged[index]!, file.path);
    }
    await rm(journalPath);
  } catch (error) {
    // 换回原样；换不回记录留着，之后谁读先收拾。
    await rollBack(journalPath, journal).catch(() => undefined);
    throw error;
  }
}
