/**
 * 章纲（2026-10-08 写作主链重设计·阶段 2「先想后写」）。
 *
 * 为什么：十章真机验收里，作者只说「接着写」时写手拿到的本章目标是空话（`继续第 N 章。`），既不知道这章要
 * 推进什么新东西（同一个发现被重新发现 5 次、两场问话几乎是同一场戏），也没有任何「这章涉及哪些人/物/地」
 * 可以拿去翻旧资料（三章前「菜场已拆」翻不出来）。章纲是写之前的那一步「想」，同时是「翻」的检索词来源。
 *
 * 本模块只做纯确定性的部分：类型、宽进归一（模型无关：坏字段逐条丢、绝不整份陪葬）、落盘读写、检索词收集。
 * 生成章纲的模型调用在 UI server 层（守 import 边界，引擎无 LLM 依赖）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./project-store.js";

export interface ChapterPlanThreadStep {
  /** 推进的线索/目标标题（尽量逐字取自现有开着的线索）。 */
  readonly title: string;
  /** 本章怎么推进它（一句话）。 */
  readonly how: string;
}

export interface ChapterPlan {
  readonly version: 1;
  readonly chapter: number;
  /** model = 模型按现状拟的；author = 作者改过/亲自给的。 */
  readonly source: "model" | "author";
  /** 作者这章给的方向原话（没给就没有）。 */
  readonly direction?: string;
  /** 一句话：这章讲什么。 */
  readonly summary: string;
  /** 按顺序的 2–8 个要点。 */
  readonly beats: readonly string[];
  /** 本章必须新出现的信息/变化（读者和主角此前不知道的），至少 1 条。 */
  readonly newInformation: readonly string[];
  /** 开场在哪、什么时候。 */
  readonly scene: { readonly location?: string; readonly time?: string };
  /**
   * 故事第几天（第 1 章 = 第 1 天，按天数往后数）。十章验收：「三天前送来的表」过了一周还是三天前、星期一路算错——
   * 写手只看得到相对说法，算不了日子。有了逐章的天数，提到过去的事就能按天数差算「几天前」。缺省 = 老章纲没有。
   */
  readonly storyDay?: number;
  /** 出场人物名。 */
  readonly characters: readonly string[];
  /** 涉及的物件 / 地点 / 文书 / 组织名（翻旧资料的检索词）。 */
  readonly entities: readonly string[];
  /** 推进哪些线索/目标。 */
  readonly threadsAdvanced: readonly ChapterPlanThreadStep[];
  /** 这章不要重复的东西（上一章已经发现/做完的）。 */
  readonly avoid: readonly string[];
  readonly createdAt: string;
}

const MAX_BEATS = 8;
const MAX_LIST = 12;
const MAX_TEXT = 160;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/\s+/gu, " ").trim();
  if (!text || text === "无" || text === "暂无" || text.toLowerCase() === "none") return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** 字符串数组宽进：数组里逐条清洗；给成单个字符串则按换行/分号/顿号拆。 */
function cleanList(value: unknown, max = MAX_LIST, maxText = MAX_TEXT): readonly string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n；;]+/u)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = asRecord(item);
    const text = cleanText(record ? record.text ?? record.name ?? record.title ?? record.summary : item, maxText)
      ?.replace(/^\s*(?:\d+[.、)）]|[-*•·])\s*/u, "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** 名字类数组：先去掉括号注释（「送表的客人（中年男客，未具名）」），再按顿号/逗号拆、限长（名字不会超过 20 字）。 */
function cleanNames(value: unknown): readonly string[] {
  const expanded = (Array.isArray(value) ? value : [value]).flatMap((item) =>
    typeof item === "string" ? item.replace(/[（(][^）)]*[）)]/gu, "").split(/[、，,]+/u) : [item]);
  return cleanList(expanded, MAX_LIST, 20).filter((name) => name.length >= 2);
}

function cleanThreadSteps(value: unknown): readonly ChapterPlanThreadStep[] {
  if (!Array.isArray(value)) return [];
  const out: ChapterPlanThreadStep[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const title = cleanText(record ? record.title ?? record.thread ?? record.name : item);
    if (!title) continue;
    const how = cleanText(record?.how ?? record?.progress ?? record?.action) ?? "";
    out.push({ title, how });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/**
 * 宽进归一：任何合理模型可能给的形状（多余键、数组给成字符串、空串、数字）都收；缺关键字段（summary 与 beats
 * 都没有）→ undefined，由调用方如实说「章纲没拟成」并回落旧路径，绝不拿空章纲冒充。
 */
export function normalizeChapterPlan(
  raw: unknown,
  meta: { readonly chapter: number; readonly source?: "model" | "author"; readonly direction?: string; readonly now?: Date },
): ChapterPlan | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const beats = cleanList(record.beats ?? record.outline ?? record.steps, MAX_BEATS);
  const summary = cleanText(record.summary ?? record.goal) ?? beats[0];
  if (!summary || beats.length === 0) return undefined;
  const scene = asRecord(record.scene);
  const location = cleanText(scene?.location ?? record.location, 40);
  const time = cleanText(scene?.time ?? record.time, 40);
  // 第 1 章就是故事第 1 天（第十四轮第 1 章章纲没给天数，日历从第 2 章才有起点）。
  const storyDay = normalizeStoryDay(record.storyDay ?? scene?.storyDay) ?? (meta.chapter === 1 ? 1 : undefined);
  const direction = cleanText(meta.direction, 400);
  return {
    version: 1,
    chapter: meta.chapter,
    source: meta.source ?? "model",
    ...(direction ? { direction } : {}),
    summary,
    beats,
    newInformation: cleanList(record.newInformation ?? record.newInfo ?? record.reveals, 6),
    scene: { ...(location ? { location } : {}), ...(time ? { time } : {}) },
    // 第 1 章就是故事第 1 天（第十四轮第 1 章章纲没给天数，日历从第 2 章才有起点）。
    ...(storyDay !== undefined ? { storyDay } : {}),
    characters: cleanNames(record.characters),
    entities: cleanNames(record.entities ?? record.objects ?? record.items),
    threadsAdvanced: cleanThreadSteps(record.threadsAdvanced ?? record.threads),
    avoid: cleanList(record.avoid ?? record.doNotRepeat, 8),
    createdAt: (meta.now ?? new Date()).toISOString(),
  };
}

/** 故事第几天：正整数（「第12天」「12」都收），其它一律当没给。 */
function normalizeStoryDay(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const match = /(\d{1,5})/u.exec(text);
  if (!match) return undefined;
  const day = Number(match[1]);
  return Number.isInteger(day) && day >= 1 && day <= 100_000 ? day : undefined;
}

export interface StoryClockEntry {
  readonly chapter: number;
  readonly storyDay: number;
  readonly time?: string;
  readonly summary: string;
}

/** 前面各章章纲里记下的「故事第几天」（近的在后），最多 limit 条。没有天数的老章纲跳过。 */
export async function readStoryClock(projectDir: string, chapter: number, limit = 12): Promise<readonly StoryClockEntry[]> {
  const out: StoryClockEntry[] = [];
  for (let n = chapter - 1; n >= 1 && out.length < limit; n -= 1) {
    const plan = await readChapterPlan(projectDir, n).catch(() => undefined);
    if (!plan?.storyDay) continue;
    out.push({ chapter: n, storyDay: plan.storyDay, ...(plan.scene.time ? { time: plan.scene.time } : {}), summary: plan.summary.slice(0, 60) });
  }
  return out.reverse();
}

export function chapterPlanPath(projectDir: string, chapter: number): string {
  return join(projectDir, "drafts", "plans", `chapter-${String(chapter).padStart(4, "0")}.json`);
}

export async function writeChapterPlan(projectDir: string, plan: ChapterPlan): Promise<string> {
  const path = chapterPlanPath(projectDir, plan.chapter);
  await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

/** 读本章章纲。没有（ENOENT）→ undefined；文件坏了 → undefined + onCorrupt 留痕（读侧降级，不堵出稿）。 */
export async function readChapterPlan(
  projectDir: string,
  chapter: number,
  onCorrupt?: (reason: string) => void,
): Promise<ChapterPlan | undefined> {
  let raw: string;
  try {
    raw = await readFile(chapterPlanPath(projectDir, chapter), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    onCorrupt?.(`第 ${chapter} 章章纲读取失败（${(error as NodeJS.ErrnoException).code ?? "IO"}）`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeChapterPlan(parsed, {
      chapter,
      source: parsed.source === "author" ? "author" : "model",
      ...(typeof parsed.direction === "string" ? { direction: parsed.direction } : {}),
      ...(typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt)) ? { now: new Date(parsed.createdAt) } : {}),
    });
  } catch {
    onCorrupt?.(`第 ${chapter} 章章纲文件损坏（不是合法 JSON），本次按没有章纲出稿`);
    return undefined;
  }
}

function cleanTerms(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values
    .filter((term): term is string => typeof term === "string")
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 20))];
}

/** 翻旧章原文用的检索词：开场地点 + 涉及的物件/地点/文书（人物不算——人物有角色卡，原文里又到处都是）。 */
export function collectPlanEntityTerms(plan: ChapterPlan): readonly string[] {
  return cleanTerms([plan.scene.location, ...plan.entities]);
}

/** 挑旧事实用的检索词：物件/地点 + 出场人物。 */
export function collectPlanRetrievalTerms(plan: ChapterPlan): readonly string[] {
  return cleanTerms([plan.scene.location, ...plan.entities, ...plan.characters]);
}

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_MENTION = /(?:周|星期|礼拜)([一二三四五六日天])/u;

function weekdayIndex(text: string | undefined): number | undefined {
  const match = text ? WEEKDAY_MENTION.exec(text) : null;
  if (!match) return undefined;
  const index = "一二三四五六日".indexOf(match[1] === "天" ? "日" : match[1]);
  return index >= 0 ? index : undefined;
}

/** 从本章往回数的说法：台词里说「昨天 / 前天 / 几天前」照这个说。 */
function relativeDayLabel(delta: number): string {
  if (delta <= 0) return "今天早些时候";
  if (delta === 1) return "昨天";
  if (delta === 2) return "前天";
  return `${delta} 天前`;
}

/**
 * 故事日历换成「从本章看是哪天」：第十五轮台词里的相对时间错了 11 处（「昨天贴的」其实是前天、「上周」其实是本周）——
 * 只给天数让写手自己减，它算不对；直接标好昨天 / 前天 / 几天前、星期几（章纲里写过星期的那天当锚）。
 */
function buildStoryClock(plan: ChapterPlan, clock: readonly StoryClockEntry[]): Record<string, unknown> | undefined {
  const today = plan.storyDay;
  if (!today) return undefined;
  const anchors = [
    ...clock.map((entry) => ({ day: entry.storyDay, weekday: weekdayIndex(entry.time) })),
    { day: today, weekday: weekdayIndex(plan.scene.time) },
  ].filter((item): item is { day: number; weekday: number } => item.weekday !== undefined);
  const anchor = anchors.at(-1);
  const weekdayOf = (day: number): string => (anchor ? WEEKDAY_NAMES[(((anchor.weekday + day - anchor.day) % 7) + 7) % 7] : "");
  const withWeekday = (day: number): string => (anchor ? `，${weekdayOf(day)}` : "");
  return {
    today: `本章是故事第 ${today} 天${withWeekday(today)}${plan.scene.time ? `（${plan.scene.time}）` : ""}`,
    earlier: clock
      .filter((entry) => entry.storyDay <= today)
      .map((entry) => `${relativeDayLabel(today - entry.storyDay)}（故事第 ${entry.storyDay} 天${withWeekday(entry.storyDay)}）：第 ${entry.chapter} 章${entry.time ? `，${entry.time}` : ""}，${entry.summary}`),
    rule: "人物台词和叙述里说到过去的事，照这里标好的「昨天 / 前天 / 几天前」和星期几说，不要自己推算，也不要照抄前文当时说的「三天前」「昨天」——那是站在当时说的。",
  };
}

/** 给写手看的章纲段内容（受保护段 chapter_plan）。clock = 前面各章的故事天数（见 readStoryClock）。 */
export function buildChapterPlanSection(plan: ChapterPlan, clock: readonly StoryClockEntry[] = []): Record<string, unknown> {
  const storyClock = buildStoryClock(plan, clock);
  return {
    instruction: [
      "这是本章章纲。按要点顺序写，每个要点都要真正写到；可以自然补细节、对话和过渡，但不要另起与章纲无关的大事件。",
      "「本章新信息」必须在正文里明确出现（写出来，不是暗示）。「本章不要重复」里的内容不得再写一遍。",
    ].join(""),
    summary: plan.summary,
    beats: plan.beats,
    ...(plan.newInformation.length > 0 ? { newInformation: plan.newInformation } : {}),
    ...(plan.scene.location || plan.scene.time ? { scene: plan.scene } : {}),
    ...(plan.characters.length > 0 ? { characters: plan.characters } : {}),
    ...(plan.entities.length > 0 ? { entities: plan.entities } : {}),
    ...(plan.threadsAdvanced.length > 0 ? { threadsAdvanced: plan.threadsAdvanced } : {}),
    ...(plan.avoid.length > 0 ? { avoid: plan.avoid } : {}),
    ...(plan.direction ? { authorDirection: plan.direction } : {}),
    ...(storyClock ? { storyClock } : {}),
  };
}
