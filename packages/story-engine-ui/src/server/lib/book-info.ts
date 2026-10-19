/**
 * 书的资料（P10）：笔名、简介、标签、目标总字数、日更目标、封面色，外加「归档」。
 * 放在 `project.json`（书的元信息，不是故事真相）：`info` 和 `archived` 两个键，别的键原样留着。
 * 写走书锁 + 原子写（和改书名同一条路）。读的时候宽进：坏值丢掉、超长截断，不报错。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withBookLock } from "@actalk/story-core";
import { isRecord, writeFileAtomic } from "./project-io.js";

export const BOOK_INFO_LIMITS = { author: 40, synopsis: 2000, tag: 12, tags: 12, targetWords: 50_000_000, dailyGoal: 1_000_000, coverTones: 7 } as const;

export interface BookInfo {
  readonly author?: string;
  readonly synopsis?: string;
  readonly tags?: readonly string[];
  readonly targetWords?: number;
  readonly dailyGoal?: number;
  readonly coverTone?: number;
}

export interface BookMeta {
  readonly title: string;
  readonly info: BookInfo;
  readonly archived: boolean;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n?/gu, "\n").trim();
  return text ? Array.from(text).slice(0, max).join("") : undefined;
}

function cleanInt(value: unknown, max: number): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : undefined;
}

/** 宽进：坏值丢掉、超长截断、标签去重去空。 */
export function normalizeBookInfo(raw: unknown): BookInfo {
  if (!isRecord(raw)) return {};
  const author = cleanText(raw.author, BOOK_INFO_LIMITS.author);
  const synopsis = cleanText(raw.synopsis, BOOK_INFO_LIMITS.synopsis);
  const tagList: unknown[] = Array.isArray(raw.tags) ? raw.tags : [];
  const tags = [...new Set(tagList.map((tag) => cleanText(tag, BOOK_INFO_LIMITS.tag)).filter((tag): tag is string => Boolean(tag)))].slice(0, BOOK_INFO_LIMITS.tags);
  const targetWords = cleanInt(raw.targetWords, BOOK_INFO_LIMITS.targetWords);
  const dailyGoal = cleanInt(raw.dailyGoal, BOOK_INFO_LIMITS.dailyGoal);
  const tone = typeof raw.coverTone === "number" && Number.isInteger(raw.coverTone) && raw.coverTone >= 0 && raw.coverTone < BOOK_INFO_LIMITS.coverTones ? raw.coverTone : undefined;
  return {
    ...(author ? { author } : {}),
    ...(synopsis ? { synopsis } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(targetWords ? { targetWords } : {}),
    ...(dailyGoal ? { dailyGoal } : {}),
    ...(tone !== undefined ? { coverTone: tone } : {}),
  };
}

export async function readBookMeta(projectDir: string): Promise<BookMeta> {
  const raw = JSON.parse(await readFile(join(projectDir, "project.json"), "utf-8")) as unknown;
  const project = isRecord(raw) ? raw : {};
  return {
    title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : "未命名故事",
    info: normalizeBookInfo(project.info),
    archived: project.archived === true,
  };
}

/** 改资料 / 归档：info 整份替换（传了才换），archived 传了才改。回改后的。 */
export async function writeBookMeta(projectDir: string, patch: { readonly info?: unknown; readonly archived?: boolean }): Promise<BookMeta> {
  const path = join(projectDir, "project.json");
  await withBookLock(projectDir, async () => {
    const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
    const project: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
    if (patch.info !== undefined) {
      const info = normalizeBookInfo(patch.info);
      if (Object.keys(info).length > 0) project.info = info;
      else delete project.info;
    }
    if (patch.archived !== undefined) {
      if (patch.archived) project.archived = true;
      else delete project.archived;
    }
    // 不碰 updatedAt：改资料、归档不算「最近写过」，书架排序不该因此变。
    await writeFileAtomic(path, `${JSON.stringify(project, null, 2)}\n`);
  });
  return readBookMeta(projectDir);
}

/** 书名做文件名：文件系统不许的字符换成下划线。 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim() || "未命名";
}
