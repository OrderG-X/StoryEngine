/**
 * 改句记录：按核账改过的句子（改前 → 改后），每章一份。再核时核账员又说改后那句不对的，降成「可能」交作者定
 * （长篇连写 2026-10-24：倒计时第一遍核账说该减成八天、改了，第二遍又说同一天不该是八天——两遍说法相反，
 * 「改掉本章 N 处」就来回改）。存 `.story-engine-ui/continuity-checks/NNNN.fixes.json`。
 *
 * v2（写作版本 P2a 设计第三节）：`{schema, fixes, published}`。操作里按核账改的那一步换上稿时发布一次，
 * 发布凭证（键 `opId:stepId` → 时间、条数，零条也记）和改句同一次原子写；同键再来不再记（恢复、重做不重复记）。
 * 只留最近 FIX_LOG_MAX 条改句，键不截：键只在来源操作被清理时清（clearFixLogKeys）。老格式（数组）照读，没有键。
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeBookCache } from "./operations/fence.js";
import { isRecord, writeFileAtomic } from "./project-io.js";

export interface FixRecord {
  readonly from: string;
  readonly to: string;
}

export interface FixPublish {
  readonly at: string;
  readonly count: number;
}

const FIX_LOG_SCHEMA = "fix-log/2" as const;
const FIX_LOG_MAX = 50;

interface FixLogFile {
  readonly fixes: readonly FixRecord[];
  readonly published: Readonly<Record<string, FixPublish>>;
}

const fixLogDir = (projectDir: string): string => join(projectDir, ".story-engine-ui", "continuity-checks");
const fixLogPath = (projectDir: string, chapter: number): string => join(fixLogDir(projectDir), `${String(chapter).padStart(4, "0")}.fixes.json`);

const fixesOf = (value: unknown): FixRecord[] =>
  Array.isArray(value)
    ? value.filter((record): record is FixRecord => isRecord(record) && typeof record.from === "string" && typeof record.to === "string" && record.to.trim().length > 0)
    : [];

async function readFixLogFile(path: string): Promise<FixLogFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return { fixes: [], published: {} };
  }
  if (Array.isArray(raw)) return { fixes: fixesOf(raw), published: {} };
  if (!isRecord(raw)) return { fixes: [], published: {} };
  const published: Record<string, FixPublish> = {};
  if (isRecord(raw.published)) {
    for (const [key, value] of Object.entries(raw.published)) {
      if (isRecord(value) && typeof value.at === "string" && typeof value.count === "number") published[key] = { at: value.at, count: value.count };
    }
  }
  return { fixes: fixesOf(raw.fixes), published };
}

async function writeFixLogFile(path: string, log: FixLogFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ schema: FIX_LOG_SCHEMA, fixes: log.fixes.slice(-FIX_LOG_MAX), published: log.published }, null, 2)}\n`);
}

const freshOf = (changes: readonly FixRecord[]): FixRecord[] =>
  changes.filter((change) => change.to.trim().length > 0 && change.to !== change.from).map(({ from, to }) => ({ from, to }));

export async function readFixLog(projectDir: string, chapter: number): Promise<readonly FixRecord[]> {
  return (await readFixLogFile(fixLogPath(projectDir, chapter))).fixes;
}

/** 还没迁进操作的入口记改句（按内容键整份覆盖的缓存写，见 writeBookCache）。 */
export async function appendFixLog(projectDir: string, chapter: number, changes: readonly FixRecord[]): Promise<void> {
  const fresh = freshOf(changes);
  if (fresh.length === 0) return;
  const path = fixLogPath(projectDir, chapter);
  await writeBookCache(projectDir, async () => {
    const log = await readFixLogFile(path);
    await writeFixLogFile(path, { fixes: [...log.fixes, ...fresh], published: log.published });
  });
}

/**
 * 操作里发布一次（调用方拿着书锁、刚换上稿：这一笔已经过了栅栏，同一次持锁里写完）。键在 → 不再记，返回 false。
 */
export async function publishFixLogLocked(projectDir: string, chapter: number, key: string, changes: readonly FixRecord[], now: Date = new Date()): Promise<boolean> {
  const path = fixLogPath(projectDir, chapter);
  const log = await readFixLogFile(path);
  if (log.published[key]) return false;
  const fresh = freshOf(changes);
  await writeFixLogFile(path, { fixes: [...log.fixes, ...fresh], published: { ...log.published, [key]: { at: now.toISOString(), count: fresh.length } } });
  return true;
}

/** 来源操作被清理了（调用方拿着书锁）：清掉它的键。 */
export async function clearFixLogKeys(projectDir: string, opId: string): Promise<void> {
  const prefix = `${opId}:`;
  for (const name of await readdir(fixLogDir(projectDir)).catch(() => [] as string[])) {
    if (!name.endsWith(".fixes.json")) continue;
    const path = join(fixLogDir(projectDir), name);
    const log = await readFixLogFile(path);
    const keys = Object.keys(log.published);
    if (!keys.some((key) => key.startsWith(prefix))) continue;
    await writeFixLogFile(path, { fixes: log.fixes, published: Object.fromEntries(keys.filter((key) => !key.startsWith(prefix)).map((key) => [key, log.published[key]!])) });
  }
}
