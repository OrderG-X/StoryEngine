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
import { withBookLock } from "@actalk/story-core";
import { writeFileAtomic } from "./project-store.js";
import type { PlanClock } from "./story-timeline.js";

export interface ChapterPlanThreadStep {
  /** 推进的线索/目标标题（尽量逐字取自现有开着的线索）。 */
  readonly title: string;
  /** 本章怎么推进它（一句话）。 */
  readonly how: string;
}

/** 章纲员没照作者方向原话安排的地方（方向和前文既成事实对不上时改成了说得通的安排）：回执要告诉作者。 */
export interface ChapterPlanDirectionChange {
  /** 作者方向里的原话（章纲员路已核对真在方向里）。 */
  readonly said: string;
  /** 章纲里改成了什么。 */
  readonly changedTo: string;
  /** 为什么改：和前文哪里对不上。 */
  readonly why: string;
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
   * 本章开场离第 after 章（拟纲时的上一个当下章）结尾过了几天；可负（换到另一条线、往回接）。十章验收：「三天前送来的表」
   * 过了一周还是三天前——写手只看得到相对说法，算不了日子，所以写的时候按它把前面各章标成「昨天 / 前天 / 几天前」。
   * 绝对第几天不存（写作版本 P3a）：前文的天数会变（作者改天数、补账），存了就过时，用的时候按投影现算。缺省 = 说不准。
   */
  readonly dayOffset?: number;
  /** dayOffset 是离哪一章结尾算的。没有 = 前面没有当下章（本章就是第 1 天）或说不准。 */
  readonly after?: number;
  /** 整章不在当下线上：past = 回忆、倒叙；other = 梦、想象、传闻。缺省 = 当下。 */
  readonly frame?: "past" | "other";
  /** 出场人物名。 */
  readonly characters: readonly string[];
  /** 涉及的物件 / 地点 / 文书 / 组织名（翻旧资料的检索词）。 */
  readonly entities: readonly string[];
  /** 推进哪些线索/目标。 */
  readonly threadsAdvanced: readonly ChapterPlanThreadStep[];
  /** 这章不要重复的东西（上一章已经发现/做完的）。 */
  readonly avoid: readonly string[];
  /** 没照作者方向原话安排的地方（P7：章纲员把「铜盒」悄悄改成「怀表」、作者不知道）。缺省 = 照原话安排的 / 老章纲。 */
  readonly directionChanges?: readonly ChapterPlanDirectionChange[];
  /** 拟纲时前文的指纹（前面各章正文、账、设定、前面各章是哪天）：变了就不沿用这份章纲。缺省 = 老章纲 / 作者给的。 */
  readonly basis?: string;
  readonly createdAt: string;
}

const MAX_BEATS = 8;
const MAX_LIST = 12;
const MAX_TEXT = 160;
/** 一条要点最长多少字（改纲按核账改出来的要点会长些）：拟纲、改纲、落盘、读回都按这一个数，写手拿到的就是盘上那份。 */
export const PLAN_BEAT_MAX = 400;

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
      // 不猜白名单：切句
      ? value.split(/[\n；;]+/u)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = asRecord(item);
    const text = cleanText(record ? record.text ?? record.name ?? record.title ?? record.summary : item, maxText)
      // 不猜白名单：切句
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
    // 不猜白名单：切句
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
/**
 * 「故事第 N 天」只是记日子的内部编号，不该进要点和开场时间（第十八轮：章纲要点写「故事第 7 天上午」，
 * 正文照抄出「受理回执日期栏印着第十一天」「今天是第几天你自己算」）。离上一章过了几天只留在 dayOffset 字段。
 */
// 阿拉伯数字的「第2天」也是编号（第十九轮章纲写「第3天上午」）；汉字的「第二天」是正常说法，不动。
// 不猜白名单开始：日期归一
const STORY_DAY_NUMBERING = /[（(]?\s*(?:故事第\s*[\d一二三四五六七八九十百]+|第\s*\d+)\s*天\s*[）)]?[，,、]?\s*/gu;
// 不猜白名单结束

function stripStoryDayNumbering(text: string): string {
  // 不猜白名单：日期归一
  return text.replace(STORY_DAY_NUMBERING, "").replace(/[（(]\s*[）)]/gu, "").trim();
}

export function normalizeChapterPlan(
  raw: unknown,
  meta: { readonly chapter: number; readonly source?: "model" | "author"; readonly direction?: string; readonly basis?: string; readonly now?: Date },
): ChapterPlan | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const beats = cleanList(record.beats ?? record.outline ?? record.steps, MAX_BEATS, PLAN_BEAT_MAX).map(stripStoryDayNumbering).filter(Boolean);
  const rawSummary = cleanText(record.summary ?? record.goal);
  const summary = (rawSummary ? stripStoryDayNumbering(rawSummary) : "") || beats[0];
  if (!summary || beats.length === 0) return undefined;
  const scene = asRecord(record.scene);
  const location = cleanText(scene?.location ?? record.location, 40);
  const rawTime = cleanText(scene?.time ?? record.time, 40);
  const time = rawTime ? stripStoryDayNumbering(rawTime) || undefined : undefined;
  const dayOffset = normalizeDayOffset(record.dayOffset);
  const after = typeof record.after === "number" && Number.isInteger(record.after) && record.after >= 1 && record.after < meta.chapter ? record.after : undefined;
  const frame = typeof record.frame === "string" ? FRAME_WORDS.get(record.frame.trim()) : undefined;
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
    ...(frame ? { frame } : dayOffset !== undefined ? { dayOffset, ...(after !== undefined ? { after } : {}) } : {}),
    characters: cleanNames(record.characters),
    entities: cleanNames(record.entities ?? record.objects ?? record.items),
    threadsAdvanced: cleanThreadSteps(record.threadsAdvanced ?? record.threads),
    avoid: cleanList(record.avoid ?? record.doNotRepeat, 8),
    ...directionChangesOf(record.directionChanges, direction),
    ...(meta.basis ? { basis: meta.basis } : {}),
    createdAt: (meta.now ?? new Date()).toISOString(),
  };
}

/** 改了作者方向的声明：三栏都有才收；这章没给方向就不可能「改了方向」，一条不收。 */
function directionChangesOf(value: unknown, direction: string | undefined): { directionChanges?: readonly ChapterPlanDirectionChange[] } {
  if (!direction || !Array.isArray(value)) return {};
  const out: ChapterPlanDirectionChange[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const said = cleanText(record?.said, 200);
    const changedTo = cleanText(record?.changedTo, 200);
    const why = cleanText(record?.why, 200);
    if (said && changedTo && why) out.push({ said, changedTo, why });
    if (out.length >= MAX_LIST) break;
  }
  return out.length > 0 ? { directionChanges: out } : {};
}

/** 离上一章过了几天：整数（可负），太离谱的当没给。 */
function normalizeDayOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 36_500 ? value : undefined;
}

/** 整章不在当下线上的说法（模型可能给中文或英文枚举；别的一律当「当下」）。 */
const FRAME_WORDS: ReadonlyMap<string, "past" | "other"> = new Map([["past", "past"], ["回忆", "past"], ["倒叙", "past"], ["other", "other"], ["梦", "other"], ["想象", "other"]]);

export function chapterPlanPath(projectDir: string, chapter: number): string {
  return join(projectDir, "drafts", "plans", `chapter-${String(chapter).padStart(4, "0")}.json`);
}

/**
 * 章纲落盘：先按读回的同一套归一（读回来和返回的一模一样），在书锁里写（AI 换上稿子前在书锁里核章纲，
 * 核完到换上之间不会被另一轮拟纲换掉，第 6 轮复核 T9）。返回落盘的那份：调用方往后只用它（第 6 轮 T7）。
 * 出稿操作里不走这里：拟好的那份由 `plan-save` 步骤走核心 `plan.save`（写作版本 P2a 3.1），文本是 chapterPlanFileText。
 */
export async function writeChapterPlan(projectDir: string, plan: ChapterPlan): Promise<ChapterPlan> {
  const stored = storedChapterPlan(plan);
  await withBookLock(projectDir, () => writeFileAtomic(chapterPlanPath(projectDir, plan.chapter), chapterPlanFileText(stored)));
  return stored;
}

/** 章纲文件的整份文本（落盘、核心 plan.save 都用这一份）：先归一成读回来的样子。 */
export function chapterPlanFileText(plan: ChapterPlan): string {
  return `${JSON.stringify(storedChapterPlan(plan), null, 2)}\n`;
}

/** 这份章纲落盘、再读回来是什么样（readChapterPlan 同一套归一）：拟纲只在内存里拟时，往后用的就是这份。 */
export function storedChapterPlan(plan: ChapterPlan): ChapterPlan {
  const stored = planFromFile(JSON.parse(JSON.stringify(plan)) as Record<string, unknown>, plan.chapter);
  if (!stored) throw new Error(`第 ${plan.chapter} 章章纲没有要点，不能落盘`);
  return stored;
}

function planFromFile(parsed: Record<string, unknown>, chapter: number): ChapterPlan | undefined {
  return normalizeChapterPlan(parsed, {
    chapter,
    source: parsed.source === "author" ? "author" : "model",
    ...(typeof parsed.direction === "string" ? { direction: parsed.direction } : {}),
    ...(typeof parsed.basis === "string" ? { basis: parsed.basis } : {}),
    ...(typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt)) ? { now: new Date(parsed.createdAt) } : {}),
  });
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
    return planFromFile(JSON.parse(raw) as Record<string, unknown>, chapter);
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

const CLOCK_RULE = "人物台词和叙述里说到过去的事，照这里标好的「昨天 / 前天 / 几天前」和星期几说，不要自己推算，也不要照抄前文当时说的「三天前」「昨天」——那是站在当时说的；没标「离今天」的，是隔了多久说不准，别替它定。回忆、梦里的日子是那段自己的。「故事第几天」只是给你对日子的内部编号，正文和台词里绝不出现「第 N 天」这种说法。";

/** 给写手看的章纲段内容（受保护段 chapter_plan）。clock = 写这章时的故事日历（story-timeline 的 planClock）。 */
export function buildChapterPlanSection(plan: ChapterPlan, clock?: PlanClock): Record<string, unknown> {
  const storyClock = clock ? { ...clock, rule: CLOCK_RULE } : undefined;
  return {
    instruction: [
      "这是本章章纲。按要点顺序写，每个要点都要真正写到；可以自然补细节、对话和过渡，但不要另起与章纲无关的大事件。",
      "「本章新信息」必须在正文里明确出现（写出来，不是暗示）。「本章不要重复」里的内容不得再写一遍。",
    ].join(""),
    // 第十八轮：要点交代了物件在哪，正文第 7–10 章开头都机械点名一遍「身份证、死亡证明、户口本」。
    objectsNote: "要点里写的物件在谁手里、放在哪，是给你对照用的：正文用到它时照着写，不要在开头把随身带的东西逐一点名。",
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
