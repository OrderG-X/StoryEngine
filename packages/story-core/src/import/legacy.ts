/**
 * 读老书的数据文件（旧引擎写的），只读、宽松：单条坏了跳过并记下来，整个文件坏了就报错停下。
 *
 * 新旧隔离：这里不 import 旧引擎，老格式用 zod 自己描述，只取导入要用的字段。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BookFileError } from "../store/book.js";

const text = z.string().trim().min(1);
const chapter = z.number().int().min(1);

export const LegacyFact = z.object({
  id: text,
  chapter,
  text,
  source: z.string().optional(),
  kind: z.string().optional(),
  subject: z.string().optional(),
  attribute: z.string().optional(),
  value: z.string().optional(),
  quote: z.string().optional(),
  supersededByChapter: z.number().int().optional(),
  supersededByFactId: z.string().optional(),
});

export const LegacyThread = z.object({
  id: text,
  type: z.string().optional(),
  title: text,
  status: z.string(),
  firstSeenChapter: chapter,
  lastTouchedChapter: z.number().int().optional(),
  evidence: z.array(z.string()).optional(),
});

export const LegacyHook = z.object({
  id: text,
  title: text,
  description: z.string().optional(),
  status: z.string(),
  firstSeenChapter: chapter,
  lastTouchedChapter: z.number().int().optional(),
  resolvedAtChapter: z.number().int().optional(),
  evidence: z.array(z.string()).optional(),
});

export const LegacyGoal = z.object({
  id: text,
  title: text,
  status: z.string(),
  firstSeenChapter: chapter,
  lastTouchedChapter: z.number().int().optional(),
  evidence: z.array(z.string()).optional(),
});

export const LegacyTimelineEntry = z.object({
  chapter,
  day: z.number().int().min(1),
  weekday: z.number().int().min(0).max(6).optional(),
  timeOfDay: z.string().optional(),
  daysInChapter: z.number().int().min(0).optional(),
  source: z.string(),
  quote: z.string().optional(),
});

export const LegacyEvent = z.object({
  chapter,
  summary: z.string().optional(),
  participants: z.array(z.string()).optional(),
});

export const LegacyMatrixEntry = z.object({
  name: text,
  appearances: z.array(z.object({ chapter, evidence: z.string().optional() })).optional(),
});

export const LegacyCharacter = z.object({ id: text, name: text });

export const LegacyAliasEntry = z.object({
  canonicalName: text,
  primary: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  generated: z.array(z.string()).optional(),
});

export type LegacyFact = z.infer<typeof LegacyFact>;
export type LegacyThread = z.infer<typeof LegacyThread>;
export type LegacyHook = z.infer<typeof LegacyHook>;
export type LegacyGoal = z.infer<typeof LegacyGoal>;
export type LegacyTimelineEntry = z.infer<typeof LegacyTimelineEntry>;
export type LegacyEvent = z.infer<typeof LegacyEvent>;
export type LegacyMatrixEntry = z.infer<typeof LegacyMatrixEntry>;
export type LegacyAliasEntry = z.infer<typeof LegacyAliasEntry>;

export interface ImportSkip {
  readonly file: string;
  /** 第几条（从 0 起）或条目编号。 */
  readonly item?: number | string;
  readonly reason: string;
}

export interface LegacyData {
  readonly facts: readonly LegacyFact[];
  readonly threads: readonly LegacyThread[];
  readonly hooks: readonly LegacyHook[];
  readonly goals: readonly LegacyGoal[];
  readonly timeline: readonly LegacyTimelineEntry[];
  readonly events: readonly LegacyEvent[];
  readonly matrix: readonly LegacyMatrixEntry[];
  readonly aliases: readonly LegacyAliasEntry[];
  /** 人物 id → 名字。 */
  readonly characterNames: ReadonlyMap<string, string>;
  readonly skipped: readonly ImportSkip[];
}

export const LEGACY_FILES = {
  facts: "story/fact-ledger.json",
  threads: "story/threads.json",
  hooks: "story/hooks.json",
  goals: "story/arc-goals.json",
  timeline: "story/timeline.json",
  events: "timeline/events.json",
  matrix: "story/character-matrix.json",
  bible: "story/character-bible.json",
  aliases: ".story-engine-ui/alias-tables.json",
} as const;

async function readJson(bookDir: string, file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(bookDir, file), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BookFileError(file, "不是合法的 JSON，没法导入（先修好或删掉这个文件）");
  }
}

/** 从文件里取出那个列表；每条按 schema 收，坏的记进 skipped。 */
function collect<T>(file: string, value: unknown, key: string | undefined, schema: z.ZodType<T>, skipped: ImportSkip[]): T[] {
  if (value === undefined) return [];
  const list = key === undefined ? value : (value as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) {
    skipped.push({ file, reason: key ? `文件里没有 ${key} 列表` : "文件不是列表" });
    return [];
  }
  const items: T[] = [];
  list.forEach((item, index) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) items.push(parsed.data);
    else skipped.push({ file, item: index, reason: `格式不对：${parsed.error.issues[0]?.path.join(".") || "整条"}` });
  });
  return items;
}

async function readCharacterNames(bookDir: string, bibleValue: unknown, skipped: ImportSkip[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const character of collect(LEGACY_FILES.bible, bibleValue, "characters", LegacyCharacter, skipped)) {
    names.set(character.id, character.name);
  }
  let ids: string[] = [];
  try {
    ids = await readdir(join(bookDir, "characters"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // 人物目录里的 profile 优先（作者在设定本里改名改的是它）。
  for (const id of ids.sort()) {
    const file = `characters/${id}/profile.json`;
    const value = await readJson(bookDir, file);
    if (value === undefined) continue;
    const parsed = z.object({ name: text }).safeParse(value);
    if (parsed.success) names.set(id, parsed.data.name);
    else skipped.push({ file, reason: "没有名字" });
  }
  return names;
}

export async function readLegacyData(bookDir: string): Promise<LegacyData> {
  const skipped: ImportSkip[] = [];
  const [facts, threads, hooks, goals, timeline, events, matrix, bible, aliases] = await Promise.all([
    readJson(bookDir, LEGACY_FILES.facts),
    readJson(bookDir, LEGACY_FILES.threads),
    readJson(bookDir, LEGACY_FILES.hooks),
    readJson(bookDir, LEGACY_FILES.goals),
    readJson(bookDir, LEGACY_FILES.timeline),
    readJson(bookDir, LEGACY_FILES.events),
    readJson(bookDir, LEGACY_FILES.matrix),
    readJson(bookDir, LEGACY_FILES.bible),
    readJson(bookDir, LEGACY_FILES.aliases),
  ]);
  const byEntity = (aliases as { byEntity?: unknown } | undefined)?.byEntity;
  return {
    facts: collect(LEGACY_FILES.facts, facts, "facts", LegacyFact, skipped),
    threads: collect(LEGACY_FILES.threads, threads, "threads", LegacyThread, skipped),
    hooks: collect(LEGACY_FILES.hooks, hooks, "hooks", LegacyHook, skipped),
    goals: collect(LEGACY_FILES.goals, goals, "goals", LegacyGoal, skipped),
    timeline: collect(LEGACY_FILES.timeline, timeline, "entries", LegacyTimelineEntry, skipped),
    events: collect(LEGACY_FILES.events, Array.isArray(events) ? events : (events as { events?: unknown } | undefined)?.events, undefined, LegacyEvent, skipped),
    matrix: collect(LEGACY_FILES.matrix, matrix, "entries", LegacyMatrixEntry, skipped),
    aliases: aliases === undefined
      ? []
      : collect(LEGACY_FILES.aliases, byEntity && typeof byEntity === "object" ? Object.values(byEntity) : undefined, undefined, LegacyAliasEntry, skipped),
    characterNames: await readCharacterNames(bookDir, bible, skipped),
    skipped,
  };
}
