/**
 * 拟章纲（2026-10-08 写作主链重设计·阶段 2「先想后写」）。
 *
 * 十章真机验收：作者只说「接着写」时写手拿到的目标是空话，剧情原地打转（同一个发现被重新发现 5 次）。
 * 出稿前先用一次模型调用拟章纲：接住上一章结尾、至少推进一条开着的线索、至少给一条新信息、写明不要重复什么，
 * 并点名本章涉及的人/物/地——引擎据此翻旧章原文与旧事实（见引擎 chapter-plan.ts / earlier-passages.ts）。
 *
 * 模型无关：输出宽进归一（normalizeChapterPlan）；坏 JSON / 挂了 → 自动重试一次；仍不成 → ok:false + 原因，
 * 由调用方如实告知并回落「无章纲出稿」，绝不拿空章纲冒充。题材中立：提示词不预设任何题材。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findRecurringPhrases,
  normalizeChapterPlan,
  readArcGoalPool,
  readAssetLedger,
  readCharacterBible,
  readChapterPlan,
  readFactLedger,
  readLocationBible,
  readStoryBible,
  readStoryClock,
  readThreadPool,
  readTimelineEvents,
  selectEffectiveFacts,
  writeChapterPlan,
  type ChapterPlan,
} from "@actalk/story-engine";
import { resolveConfiguredChatModel, streamChatModelToText, ThinkingTooLongError } from "../../lib/llm-client.js";
import { checkAndRevisePlan } from "./plan-check.js";

export type PlanCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

export interface PlanChapterInput {
  readonly projectDir: string;
  readonly chapter: number;
  /** 作者这章的方向原话；没给 = 模型按现状自己拟。 */
  readonly direction?: string;
  readonly callModel: PlanCallModel;
}

export type PlanChapterResult =
  | { readonly ok: true; readonly plan: ChapterPlan }
  | { readonly ok: false; readonly reason: string };

/** 拟章纲失败（模型挂了 / 不是 JSON / 缺要点）自动再试的次数。 */
const PLAN_RETRIES = 1;
const PREVIOUS_TAIL_CHARS = 3000;
const MAX_OPEN_THREADS = 15;
const RECENT_CHAPTER_SUMMARIES = 6;
const PLAN_FACT_CAP = 25;
const RECENT_PLAN_TIMES = 5;
const RECURRING_WINDOW = 5;

export interface PlanChapterMaterials {
  readonly premise?: string;
  readonly longFormGoals: readonly string[];
  readonly previousChapter?: { readonly chapter: number; readonly text: string };
  readonly recentChapters: readonly string[];
  readonly openThreads: readonly string[];
  readonly openGoals: readonly string[];
  readonly characters: readonly string[];
  readonly entities: readonly string[];
  readonly protectedSecrets: readonly string[];
  /** 与接下来要写的内容相关的已确立事实（拟章纲时就得避开前后矛盾——验收：三分之一的矛盾在章纲里就写错了）。 */
  readonly facts: readonly string[];
  /** 主谜 / 核心冲突：每 2–3 章要有实质进展。 */
  readonly coreMysteries: readonly string[];
  /** 前几章的时间（取各章章纲的开场时间）：让日期、星期顺得下去。 */
  readonly recentTimes: readonly string[];
  /** 近几章反复出现的描写（确定性检出）：本章别再用。 */
  readonly recurringPhrases: readonly string[];
  /** 前几章用过的桥段（各章章纲要点）：本章换推进方式。 */
  readonly recentBeats: readonly string[];
}

const settle = async <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);

async function readPreviousChapterText(projectDir: string, chapter: number): Promise<PlanChapterMaterials["previousChapter"]> {
  if (chapter <= 1) return undefined;
  const pad = String(chapter - 1).padStart(4, "0");
  const content = await readFile(join(projectDir, "chapters", `${pad}.md`), "utf-8")
    .catch(() => readFile(join(projectDir, "drafts", "fast", `chapter-${pad}.md`), "utf-8"))
    .catch(() => "");
  const body = content.replace(/^#[^\n]*\n/u, "").trim();
  if (!body) return undefined;
  return { chapter: chapter - 1, text: body.length > PREVIOUS_TAIL_CHARS ? `（前略）${body.slice(-PREVIOUS_TAIL_CHARS)}` : body };
}

/** 最近几章的正文（不含标题），找跨章复用的描写用。 */
async function readRecentChapterBodies(projectDir: string, chapter: number): Promise<readonly { readonly chapter: number; readonly body: string }[]> {
  const out: { chapter: number; body: string }[] = [];
  for (let n = Math.max(1, chapter - RECURRING_WINDOW); n < chapter; n += 1) {
    const content = await readFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), "utf-8").catch(() => "");
    const body = content.replace(/^#[^\n]*\n/u, "").trim();
    if (body) out.push({ chapter: n, body });
  }
  return out;
}

/** 前几章章纲的要点（用过的桥段）：本章换别的推进方式，别套同一个路数。 */
async function readRecentPlanBeats(projectDir: string, chapter: number): Promise<readonly string[]> {
  const out: string[] = [];
  for (let n = Math.max(1, chapter - 4); n < chapter; n += 1) {
    const plan = await readChapterPlan(projectDir, n).catch(() => undefined);
    if (plan) out.push(`第 ${n} 章：${plan.beats.join(" / ").slice(0, 160)}`);
  }
  return out;
}

/** 前几章章纲里的开场时间：「第 8 章：六月十六（周日）下午」。 */
async function readRecentPlanTimes(projectDir: string, chapter: number): Promise<readonly string[]> {
  const out: string[] = [];
  for (let n = Math.max(1, chapter - RECENT_PLAN_TIMES); n < chapter; n += 1) {
    const plan = await readChapterPlan(projectDir, n).catch(() => undefined);
    if (plan?.scene.time || plan?.storyDay) {
      out.push(`第 ${n} 章：${plan.storyDay ? `故事第 ${plan.storyDay} 天，` : ""}${plan.scene.time ?? ""}${plan.scene.location ? `，${plan.scene.location}` : ""}`);
    }
  }
  return out;
}

/** 读盘收集拟章纲的材料。全部读失败即空、绝不阻断（拟不成就回落无章纲出稿）。 */
export async function collectPlanMaterials(projectDir: string, chapter: number, direction?: string): Promise<PlanChapterMaterials> {
  const [storyBible, threadPool, goalPool, timeline, characterBible, assetLedger, locationBible, previousChapter, factLedger, recentBodies, recentTimes] = await Promise.all([
    settle(readStoryBible(projectDir), null),
    settle(readThreadPool(projectDir), { threads: [] }),
    settle(readArcGoalPool(projectDir), { goals: [] }),
    settle(readTimelineEvents(projectDir), []),
    settle(readCharacterBible(projectDir), null),
    settle(readAssetLedger(projectDir), { version: "v0" as const, assets: [], containers: [] }),
    settle(readLocationBible(projectDir), null),
    readPreviousChapterText(projectDir, chapter),
    settle(readFactLedger(projectDir), null),
    readRecentChapterBodies(projectDir, chapter),
    readRecentPlanTimes(projectDir, chapter),
  ]);
  const recentBeats = await readRecentPlanBeats(projectDir, chapter);
  const characterNames = (characterBible?.characters ?? []).map((character) => character.name).filter(Boolean);
  const entityNames = [
    ...assetLedger.assets.map((asset) => asset.name).filter(Boolean),
    ...(locationBible?.locations ?? []).map((location) => location.name).filter(Boolean),
  ];
  const facts = selectEffectiveFacts({
    facts: factLedger?.facts ?? [],
    chapter,
    relevantNames: characterNames,
    continuityText: [previousChapter?.text, direction].filter(Boolean).join("\n"),
    cap: PLAN_FACT_CAP,
  }).facts;
  const recurringPhrases = findRecurringPhrases({
    chapters: recentBodies,
    knownNames: [...characterNames, ...entityNames],
    domainText: (factLedger?.facts ?? []).map((fact) => fact.text).join("\n"),
    limit: 10,
  }).map((item) => item.phrase);
  const openThreads = threadPool.threads
    .filter((thread) => thread.status === "open" || thread.status === "touched")
    .sort((a, b) => b.lastTouchedChapter - a.lastTouchedChapter)
    .slice(0, MAX_OPEN_THREADS)
    .map((thread) => {
      // 标题入库时被截成 16 字加「…」：带上第一条证据，模型才看得懂这条线索在问什么。
      const evidence = thread.title.endsWith("…") ? thread.evidence?.[0]?.slice(0, 60) : undefined;
      return `${thread.title}${evidence ? `（${evidence}）` : ""}（上次第 ${thread.lastTouchedChapter} 章）`;
    });
  const openGoals = goalPool.goals
    .filter((goal) => goal.status === "active" || goal.status === "touched")
    .map((goal) => `${goal.title}（${goal.scope === "main_arc" ? "主线" : "阶段目标"}）`);
  const recentChapters = [...timeline]
    .filter((event) => event.chapter < chapter)
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-RECENT_CHAPTER_SUMMARIES)
    .map((event) => `第 ${event.chapter} 章：${event.summary.slice(0, 120)}`);
  return {
    ...(storyBible?.premise ? { premise: storyBible.premise } : {}),
    longFormGoals: storyBible?.longFormGoals ?? [],
    ...(previousChapter ? { previousChapter } : {}),
    recentChapters,
    openThreads,
    openGoals,
    // 带身份和年龄：只给名字时拟章纲会把人用错（验收第 1 章把拆迁办干部许棠写成了送表的熟客），
    // 不给年龄就算不通年代（验收：五十多岁的周婶「六二年亲手换壶」）。
    characters: (characterBible?.characters ?? [])
      .filter((character) => Boolean(character.name))
      .map((character) => {
        const notes = [character.role?.trim().slice(0, 30), character.age?.trim() ? `${character.age.trim()}岁`.replace(/岁岁$/u, "岁") : undefined].filter(Boolean);
        return notes.length > 0 ? `${character.name}（${notes.join("，")}）` : character.name;
      }),
    entities: entityNames,
    protectedSecrets: storyBible?.protectedSecrets ?? [],
    facts,
    coreMysteries: [...(storyBible?.coreMysteries ?? []), ...(storyBible?.centralConflicts ?? [])].filter(Boolean).slice(0, 6),
    recentTimes,
    recurringPhrases,
    recentBeats,
  };
}

export function buildPlanMessages(
  chapter: number,
  materials: PlanChapterMaterials,
  direction?: string,
): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是长篇小说的章纲策划。读前文和故事现状，为下一章拟一份章纲。只输出一个 JSON，不要解释、不要 Markdown。",
    "要求：",
    "1. 紧接上一章结尾：时间、地点、人物各自在哪、手里有什么，都从上一章结尾接上；换场要交代怎么过去的。",
    "2. 这章必须让故事往前走：至少推进一条「开着的线索」或「目标」，并且至少给出一条读者此前不知道的新信息或局面变化（newInformation）。前文已经发现、说过、确认过的东西不算新信息。",
    "3. 不要重演前文：上一章或前几章已经写过的发现、对话、场面，写进 avoid，本章不得再来一遍。",
    "4. 作者给了方向就照方向展开，不要改方向。",
    "5. 优先用已有的人物、地点、物件；确需新人物或新物件可以引入，但要写进 characters / entities。",
    "6. 不要揭开「受保护的秘密」，除非作者方向明确要求。",
    "7. 不能和【已确立事实】矛盾；那里写着已经做过的事（递过的材料、拿到的回执、认出过的记号），本章不要再做一遍。",
    "8. 时间要算得通：scene.time 写清和上一章的关系（第二天上午 / 当天傍晚）或具体日期，和【前几章的时间】顺下来；dayOffset 写本章开场离上一章结尾过了几天（同一天 0、第二天 1、三天后 3；天数由程序往后加，你不用数第几天）；beats 和 time 里不写「第 N 天」；涉及年份时，人物当年多大要对得上他现在的年龄。",
    "9. 要有戏：每章至少一个让局面变化的转折或冲突升级（有人阻拦、出现对立的证据、关系起变化、期限逼近）；不要连续两章做同一类事（又去递材料、又等回复、又把同一个记号认一遍）；【主谜/核心冲突】每两三章要有实质进展。",
    "10. 【近几章反复出现的描写】本章一律换个写法，把它们写进 avoid。",
    "11. 【前几章用过的桥段】里反复出现的推进方式（又有人来打听、又去档案处查、又接到催期限的电话），本章不要再用同一个路数，换一种让局面变化的方式。",
    // 第十五、十七轮要点限到 60 字后矛盾翻倍（物件位置错 15 条）：章纲不再交代东西在哪，写手就乱放。要点写细，但物件状态照事实抄、不另编。
    "12. 每个要点写清谁、在哪、做了什么、局面怎么变；牵涉到的关键物件（文书、信物、钥匙、证据）写明此刻在谁手里或放在哪——照【已确立事实】和上一章结尾抄，不要另编；不写对白原话；不替前文补它没写过的设定（某张纸是谁的笔迹、某样东西原先归谁）。每个要点不超过 120 字。",
    "JSON 字段：",
    "{\"summary\":\"一句话说这章讲什么\",\"beats\":[\"按顺序 3–6 个要点，每个是一件具体发生的事（人、地点、关键物件在谁手里）\"],\"newInformation\":[\"1–3 条本章新出现的信息/变化\"],",
    "\"scene\":{\"location\":\"开场地点\",\"time\":\"开场时间（相对上一章，如第二天上午）\"},\"dayOffset\":离上一章结尾过了几天（整数，同一天 0）,\"characters\":[\"出场人物名\"],",
    "\"entities\":[\"本章涉及的物件/地点/文书名，用前文里的原名\"],\"threadsAdvanced\":[{\"title\":\"推进的线索或目标（照抄下面列表里的说法）\",\"how\":\"怎么推进\"}],",
    "\"avoid\":[\"本章不要重复的东西\"]}",
  ].join("\n");
  const blocks = [
    `【要写的章】第 ${chapter} 章`,
    direction?.trim() ? `【作者这章的方向】${direction.trim()}` : "【作者这章的方向】没有特别指定，按故事现状自然往下推进。",
    materials.premise ? `【故事前提】${materials.premise}` : "",
    materials.longFormGoals.length > 0 ? `【长线目标】${materials.longFormGoals.join("；")}` : "",
    materials.openGoals.length > 0 ? `【目标】\n${materials.openGoals.join("\n")}` : "",
    materials.openThreads.length > 0 ? `【开着的线索】\n${materials.openThreads.join("\n")}` : "",
    materials.recentChapters.length > 0 ? `【前面几章发生了什么】\n${materials.recentChapters.join("\n")}` : "",
    materials.characters.length > 0 ? `【已有人物（括号里是身份和年龄，别用错人、别算错年代）】${materials.characters.join("、")}` : "",
    materials.coreMysteries.length > 0 ? `【主谜/核心冲突】${materials.coreMysteries.join("；")}` : "",
    materials.facts.length > 0 ? `【已确立事实（不能矛盾，做过的别再做）】\n${materials.facts.join("\n")}` : "",
    materials.recentTimes.length > 0 ? `【前几章的时间】\n${materials.recentTimes.join("\n")}` : "",
    materials.recurringPhrases.length > 0 ? `【近几章反复出现的描写（本章别再用）】${materials.recurringPhrases.join("、")}` : "",
    materials.recentBeats.length > 0 ? `【前几章用过的桥段】\n${materials.recentBeats.join("\n")}` : "",
    materials.entities.length > 0 ? `【已登记的物件/地点】${materials.entities.join("、")}` : "",
    materials.protectedSecrets.length > 0 ? `【受保护的秘密（不要揭开）】${materials.protectedSecrets.join("；")}` : "",
    materials.previousChapter
      ? `【上一章（第 ${materials.previousChapter.chapter} 章）正文${materials.previousChapter.text.startsWith("（前略）") ? "结尾" : ""}】\n${materials.previousChapter.text}`
      : "【上一章】没有（这是开篇）。",
  ].filter(Boolean);
  return [{ role: "system", content: system }, { role: "user", content: blocks.join("\n\n") }];
}

function parsePlanJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("章纲不是 JSON");
  return JSON.parse(match[0]);
}

/** 精简版材料：上一章只留结尾 600 字，事实与线索减半。 */
function slimMaterials(materials: PlanChapterMaterials): PlanChapterMaterials {
  const previous = materials.previousChapter;
  return {
    ...materials,
    ...(previous ? { previousChapter: { chapter: previous.chapter, text: `（前略）${previous.text.slice(-600)}` } } : {}),
    facts: materials.facts.slice(0, Math.ceil(materials.facts.length / 2)),
    openThreads: materials.openThreads.slice(0, 8),
    recentChapters: materials.recentChapters.slice(-3),
    recentBeats: materials.recentBeats.slice(-2),
  };
}

const NEXT_DAY = /第二天|第二日|次日|翌日|隔天|隔日|转天/u;
const DAYS_LATER = /([一两二三四五六七八九十\d]+)\s*天(?:以)?后/u;
const CJK_DIGITS: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

const SAME_DAY = /当天|当日|当晚|同一天|同日|紧接上一?章(?:结尾)?/u;

/** 模型给的「离上一章过了几天」：数字、「第二天」「同一天」都收；给不出就 undefined。 */
export function readDayOffset(raw: unknown): number | undefined {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).dayOffset : undefined;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 365 ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const digits = /\d+/u.exec(value);
  if (digits) return Math.min(Number(digits[0]), 365);
  return stepFromTimeText(value);
}

function stepFromTimeText(time: string): number | undefined {
  if (NEXT_DAY.test(time)) return 1;
  const later = DAYS_LATER.exec(time);
  if (later) return CJK_DIGITS[later[1]] ?? (Number(later[1]) || undefined);
  if (SAME_DAY.test(time)) return 0;
  return undefined;
}

/**
 * 故事第几天由程序按上一章往后加，不让模型数（第十九轮：章纲 storyDay 第 4、7 章各少记一天、第 5 章开场写「第 4 天」
 * 天数却记 5——日历跟着错，写手把前天标成「昨天」）。先用模型给的 dayOffset（离上一章结尾过了几天），没给就看开场时间
 * 里的「第二天 / 三天后 / 当天」；都没有才用模型的 storyDay，且不许比上一章早；全没有当同一天。第 1 章由引擎记为第 1 天。
 */
export function reconcileStoryDay(plan: ChapterPlan, dayOffset: number | undefined, lastDay: number | undefined): ChapterPlan {
  if (lastDay === undefined) return plan;
  const step = dayOffset ?? stepFromTimeText(plan.scene.time ?? "");
  if (step !== undefined) return { ...plan, storyDay: lastDay + step };
  if (plan.storyDay === undefined || plan.storyDay < lastDay) return { ...plan, storyDay: lastDay };
  return plan;
}

/** 拟章纲并落盘（drafts/plans/chapter-NNNN.json）。失败自动重试一次；仍失败 ok:false + 原因，不抛。 */
/**
 * 只有一句话加几个要点、人物 / 开场 / 新信息全空的章纲（第二十轮第 5、7 章）：算不出过了几天（日历少记一天）、
 * 翻旧资料的检索词也没了。这种重拟一次；重拟还是这样就用它，不为此判失败。
 */
function isSkeletonPlan(plan: ChapterPlan, dayOffset: number | undefined): boolean {
  return plan.characters.length === 0 && plan.newInformation.length === 0 && !plan.scene.location && !plan.scene.time && dayOffset === undefined;
}

export async function planChapter(input: PlanChapterInput): Promise<PlanChapterResult> {
  const materials = await collectPlanMaterials(input.projectDir, input.chapter, input.direction);
  let lastError = "";
  let skeleton: { readonly plan: ChapterPlan; readonly dayOffset: number | undefined } | undefined;
  const finish = async (plan: ChapterPlan, dayOffset: number | undefined): Promise<PlanChapterResult> => {
    const lastDay = (await readStoryClock(input.projectDir, input.chapter).catch(() => [])).at(-1)?.storyDay;
    const dated = reconcileStoryDay(plan, dayOffset, lastDay);
    // 反复出现的描写确定性地并进 avoid（不赌模型抄没抄进去），写手在章纲段里一定看得到。
    const withAvoid = materials.recurringPhrases.length > 0
      ? { ...dated, avoid: [...dated.avoid, `别再用这些说法：${materials.recurringPhrases.join("、")}`] }
      : dated;
    await writeChapterPlan(input.projectDir, withAvoid);
    return { ok: true, plan: withAvoid };
  };
  for (let attempt = 0; attempt <= PLAN_RETRIES; attempt += 1) {
    // 第二次换精简材料：验收第四轮第 8、9 章两次都被服务商内容过滤（content_filter）拦下，同样的输入重发必然再拦；
    // 去掉上一章原文、只留结尾几百字与事实/线索，输入变了才有机会过。
    const messages = attempt === 0 ? buildPlanMessages(input.chapter, materials, input.direction) : buildPlanMessages(input.chapter, slimMaterials(materials), input.direction);
    try {
      const raw = parsePlanJson(await input.callModel(messages));
      const plan = normalizeChapterPlan(raw, {
        chapter: input.chapter,
        source: "model",
        ...(input.direction?.trim() ? { direction: input.direction } : {}),
      });
      if (!plan) {
        lastError = "章纲缺要点";
        continue;
      }
      const dayOffset = readDayOffset(raw);
      if (isSkeletonPlan(plan, dayOffset) && attempt < PLAN_RETRIES) {
        console.warn(`[draft-pipeline] ch${input.chapter} 章纲只有要点、人物/开场/新信息全空，重拟一次`);
        skeleton = { plan, dayOffset };
        continue;
      }
      return await finish(plan, dayOffset);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (skeleton) return finish(skeleton.plan, skeleton.dayOffset);
  return { ok: false, reason: `章纲没拟成（已自动重试一次）：${lastError || "模型没有返回可用内容"}` };
}

/**
 * 生产用 callModel：chapterSteering 任务槽（思考开关随作者的任务设置），json_object。
 * 走 streamChatModelToText：流式 + 空闲超时（有字节就续命、无总时长上限）；一律不传 max_tokens（铁律）。
 */
/** 拟章纲「光想不写」的上限：超过就改用关思考重拟（第十一轮验收：开思考陷进去 20 分钟，整章卡死）。 */
const PLAN_MAX_THINKING_MS = 150_000;

export const callConfiguredPlanModel: PlanCallModel = async (messages) => {
  const configured = await resolveConfiguredChatModel("chapterSteering");
  const call = async (thinking: boolean) => {
    const { content } = await streamChatModelToText({
      configured: { ...configured, thinking },
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      responseFormat: { type: "json_object" },
      ...(thinking ? { maxThinkingMs: PLAN_MAX_THINKING_MS } : {}),
    });
    if (!content.trim()) throw new Error("章纲模型返回了空内容");
    return content;
  };
  try {
    return await call(configured.thinking);
  } catch (error) {
    if (!(error instanceof ThinkingTooLongError)) throw error;
    console.warn(`[draft-pipeline] 拟章纲思考超过 ${PLAN_MAX_THINKING_MS / 1000} 秒还没出结果，改用不思考重拟`);
    return call(false);
  }
};

/** 章纲审校：输入短、按格式出 JSON，强制关思考（同核对环节；开着它容易陷进长思考）。 */
export const callConfiguredPlanCheckModel: PlanCallModel = async (messages) => {
  const configured = await resolveConfiguredChatModel("chapterSteering");
  const { content } = await streamChatModelToText({
    configured: { ...configured, thinking: false },
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    responseFormat: { type: "json_object" },
  });
  if (!content.trim()) throw new Error("章纲审校返回了空内容");
  return content;
};

export interface ResolvedChapterPlan {
  readonly plan?: ChapterPlan;
  /** 给作者看的一句话：章纲是什么 / 为什么没有。 */
  readonly note: string;
  /** 沿用了这章已有的章纲（同一方向重写时不重拟）。 */
  readonly reused: boolean;
}

/**
 * 出稿前拿到本章章纲：这章已有章纲、且作者方向没变（同为空或原话相同）→ 沿用（「重写这一章」保持同一份章纲）；
 * 否则重拟。拟不成 → plan 缺省 + 如实说明，出稿照旧路径走，绝不阻断出稿。
 */
export async function resolveChapterPlanForDraft(input: PlanChapterInput & {
  /** 章纲审校用的调用（生产注入关思考版）；缺省用拟章纲同一个调用。 */
  readonly checkCallModel?: PlanCallModel;
}): Promise<ResolvedChapterPlan> {
  const direction = input.direction?.trim() ?? "";
  const existing = await readChapterPlan(input.projectDir, input.chapter).catch(() => undefined);
  if (existing && (existing.direction ?? "") === direction) {
    return { plan: existing, note: `沿用本章已有章纲：${existing.summary}`, reused: true };
  }
  const planned = await planChapter({ ...input, ...(direction ? { direction } : {}) });
  if (!planned.ok) return { note: `${planned.reason}；这次按没有章纲出稿。`, reused: false };
  // 动笔前审校一遍：按章纲自己写了什么去翻旧事实，对不上就当场改章纲（第十轮验收：近一半矛盾出在章纲）。
  const checked = await checkAndRevisePlan({ projectDir: input.projectDir, plan: planned.plan, callModel: input.checkCallModel ?? input.callModel });
  const reviewNote = checked.revised
    ? `（章纲审校改了 ${checked.issues.length} 处与前文对不上的地方：${checked.issues.slice(0, 2).join("；")}${checked.issues.length > 2 ? "等" : ""}）`
    : checked.error ? `（章纲审校这次没跑成：${checked.error}）` : "";
  return { plan: checked.plan, note: `本章章纲：${checked.plan.summary}${reviewNote}`, reused: false };
}
