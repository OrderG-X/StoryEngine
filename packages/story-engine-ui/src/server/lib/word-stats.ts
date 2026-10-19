/**
 * 写作统计（P10）：每天写了多少字、连续写了几天、作者 / AI 各写了多少。
 *
 * 存在 `.story-engine-ui/stats/words.json`（不进存档点：撤销不回退统计，但撤销后会重数一遍）。
 * 每次作者存稿、AI 写稿、定稿、恢复存档后记一次：只重数动了的那章（工作稿优先，没有就数定稿），
 * 差值按来源记（作者 / AI / 其他）。一章字数 = 正文里的汉字数（和书架、写作台同一口径）。
 *
 * 「今天写了多少」= 今天结束时全书字数 − 今天第一次记之前的全书字数（净增，删字会抵掉）。
 * 第一次记的时候（老书、导入的书）先把全书数一遍当底，不算进今天。
 * 记账出错不挡写稿：只 warn，界面上的统计照旧读得出来。
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readChapterPaper, withBookLock } from "@actalk/story-core";
import { countTextWords } from "../../utils/textUtils.js";
import { isRecord, writeFileAtomic } from "./project-io.js";

export const WORD_STATS_PATH = ".story-engine-ui/stats/words.json";
/** 留多少天的记录。 */
const KEEP_DAYS = 400;

export type WordSource = "author" | "ai" | "other";

interface DayRecord {
  /** 今天第一次记之前的全书字数。 */
  readonly start: number;
  /** 今天最后一次记之后的全书字数。 */
  readonly end: number;
  readonly author: number;
  readonly ai: number;
  readonly other: number;
}

interface WordStatsFile {
  readonly version: 1;
  /** 每章当前字数（章号 → 字数）。 */
  readonly chapters: Readonly<Record<string, number>>;
  /** 本地日期 YYYY-MM-DD → 当天记录。 */
  readonly days: Readonly<Record<string, DayRecord>>;
}

export interface WordStatsView {
  readonly totalWords: number;
  readonly today: { readonly net: number; readonly author: number; readonly ai: number };
  /** 连续写了几天（今天还没写就从昨天往前数）。 */
  readonly streak: number;
  /** 最近 30 天（旧在前），每天净增。 */
  readonly recent: readonly { readonly date: string; readonly net: number }[];
}

export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 一章现在的字数：工作稿优先，没有就数定稿；都没有是 0。 */
export async function chapterWordsNow(projectDir: string, chapter: number): Promise<number> {
  const paper = await readChapterPaper(projectDir, chapter);
  const source = paper.draft ?? paper.committed;
  return source ? countTextWords(source.body) : 0;
}

async function listChapterNumbers(projectDir: string): Promise<number[]> {
  const numbers = new Set<number>();
  for (const name of await readdir(join(projectDir, "chapters")).catch(() => [] as string[])) {
    const match = /^(\d{4})\.md$/u.exec(name);
    if (match) numbers.add(Number(match[1]));
  }
  for (const name of await readdir(join(projectDir, "drafts", "fast")).catch(() => [] as string[])) {
    const match = /^chapter-(\d{4})\.md$/u.exec(name);
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers].filter((n) => n > 0).sort((a, b) => a - b);
}

async function scanAllChapters(projectDir: string): Promise<Record<string, number>> {
  const chapters: Record<string, number> = {};
  for (const chapter of await listChapterNumbers(projectDir)) {
    const words = await chapterWordsNow(projectDir, chapter);
    if (words > 0) chapters[String(chapter)] = words;
  }
  return chapters;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/** 读统计文件；没有或坏了回 null。 */
async function readStatsFile(projectDir: string): Promise<WordStatsFile | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(projectDir, WORD_STATS_PATH), "utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.chapters) || !isRecord(raw.days)) return null;
  const chapters: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.chapters)) {
    if (/^\d+$/u.test(key)) chapters[key] = nonNegativeInt(value);
  }
  const days: Record<string, DayRecord> = {};
  for (const [key, value] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(key) || !isRecord(value)) continue;
    days[key] = { start: nonNegativeInt(value.start), end: nonNegativeInt(value.end), author: int(value.author), ai: int(value.ai), other: int(value.other) };
  }
  return { version: 1, chapters, days };
}

const sum = (chapters: Readonly<Record<string, number>>) => Object.values(chapters).reduce((a, b) => a + b, 0);

async function writeStatsFile(projectDir: string, stats: WordStatsFile): Promise<void> {
  const keys = Object.keys(stats.days).sort();
  const days = Object.fromEntries(keys.slice(-KEEP_DAYS).map((key) => [key, stats.days[key]!]));
  const path = join(projectDir, WORD_STATS_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, chapters: stats.chapters, days })}\n`);
}

function applyChange(stats: WordStatsFile, chapters: Record<string, number>, source: WordSource, delta: number, now: Date): WordStatsFile {
  const date = localDate(now);
  const before = sum(stats.chapters);
  const day = stats.days[date] ?? { start: before, end: before, author: 0, ai: 0, other: 0 };
  const next: DayRecord = { ...day, end: sum(chapters), [source]: day[source] + delta };
  return { version: 1, chapters, days: { ...stats.days, [date]: next } };
}

/**
 * 记一章的改动。`before` 是写之前这章的字数（调用方写之前用 `chapterWordsNow` 量的）；
 * 不给就拿上次记下的数。永不抛。
 */
export async function recordChapterWords(projectDir: string, chapter: number, source: WordSource, before?: number, now: Date = new Date()): Promise<void> {
  try {
    await withBookLock(projectDir, async () => {
      const after = await chapterWordsNow(projectDir, chapter);
      const key = String(chapter);
      let stats = await readStatsFile(projectDir);
      if (!stats) {
        // 第一次记：全书数一遍当底（这章按写之前的数），不算进今天。
        const base = await scanAllChapters(projectDir);
        if (before !== undefined) base[key] = before;
        stats = { version: 1, chapters: base, days: {} };
      }
      const old = before ?? stats.chapters[key] ?? 0;
      const chapters = { ...stats.chapters, [key]: after };
      if (after === 0) delete chapters[key];
      await writeStatsFile(projectDir, applyChange({ ...stats, chapters: { ...stats.chapters, [key]: old } }, chapters, source, after - old, now));
    });
  } catch (error) {
    console.warn(`[word-stats] 第 ${chapter} 章字数没记上：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 恢复存档、撤销之后：全书重数一遍，差值记成「其他」。永不抛。 */
export async function resyncWordStats(projectDir: string, now: Date = new Date()): Promise<void> {
  try {
    await withBookLock(projectDir, async () => {
      const stats = await readStatsFile(projectDir);
      if (!stats) return; // 还没开始记：下次写的时候自然数一遍。
      const chapters = await scanAllChapters(projectDir);
      await writeStatsFile(projectDir, applyChange(stats, chapters, "other", sum(chapters) - sum(stats.chapters), now));
    });
  } catch (error) {
    console.warn(`[word-stats] 恢复存档后重数字数没成：${error instanceof Error ? error.message : String(error)}`);
  }
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d + days));
}

/** 读统计（读路径：不写盘、不拿锁）。还没记过就从盘上现数总字数，其余都是 0。 */
export async function readWordStats(projectDir: string, now: Date = new Date()): Promise<WordStatsView> {
  const stats = await readStatsFile(projectDir);
  const today = localDate(now);
  const netOf = (date: string) => {
    const day = stats?.days[date];
    return day ? day.end - day.start : 0;
  };
  const recent = Array.from({ length: 30 }, (_, i) => {
    const date = shiftDate(today, i - 29);
    return { date, net: netOf(date) };
  });
  let streak = 0;
  let cursor = netOf(today) > 0 ? today : shiftDate(today, -1);
  while (netOf(cursor) > 0 && streak < KEEP_DAYS) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  const day = stats?.days[today];
  return {
    totalWords: stats ? sum(stats.chapters) : sum(await scanAllChapters(projectDir)),
    today: { net: netOf(today), author: day?.author ?? 0, ai: day?.ai ?? 0 },
    streak,
    recent,
  };
}
