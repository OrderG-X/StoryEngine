/**
 * 拟章纲（2026-10-08 写作主链重设计·阶段 2「先想后写」；2026-10-12 编辑部 T3 起只剩章纲员一条路）。
 *
 * 十章真机验收：作者只说「接着写」时写手拿到的目标是空话，剧情原地打转（同一个发现被重新发现 5 次）。
 * 出稿前先拟章纲：接住上一章结尾、至少推进一条开着的线索、至少给一条新信息、写明不要重复什么，
 * 并点名本章涉及的人/物/地——引擎据此翻旧章原文与旧事实（见引擎 chapter-plan.ts / earlier-passages.ts）。
 *
 * 编排见 resolveChapterPlanForDraft：章纲员窗口拟纲（brain/planner.ts）→ 核账员窗口审纲（brain/checker.ts）
 * → 有问题交回章纲员改一轮（不循环）。本文件留着的是章纲员复用的纯函数：材料收集（collectPlanMaterials）、
 * 章纲 JSON 要求（PLAN_REQUIREMENT_LINES / PLAN_JSON_FIELDS / planMaterialBlocks）、解析与天数归一
 * （parsePlanJson / readDayOffset / reconcileStoryDay / storyDayAtChapterEnd / previousChapterEndDay）。
 * 改提示词必须在题库上比分（docs/editorial-room/ 的规矩），别凭感觉改。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findRecurringPhrases,
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
  type ChapterPlan,
} from "@actalk/story-engine";
import {
  callConfiguredBrainModel,
  callConfiguredPlannerModel,
  catchUpReaders,
  checkPlanByReader,
  describeReaderWait,
  planChapterByPlanner,
  revisePlanByPlanner,
  type BrainCallModel,
} from "../../brain/index.js";
import { withStep } from "../../lib/token-meter.js";

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

/** 章纲 JSON 要求（章纲员路用的同一份文本，改提示词必须在题库上比分——见文件头）。 */
export const PLAN_REQUIREMENT_LINES: readonly string[] = [
  "1. 紧接上一章结尾：时间、地点、人物各自在哪、手里有什么，都从上一章结尾接上；换场要交代怎么过去的。",
  "2. 这章必须让故事往前走：至少推进一条「开着的线索」或「目标」，并且至少给出一条读者此前不知道的新信息或局面变化（newInformation）。前文已经发现、说过、确认过的东西不算新信息。",
  "3. 不要重演前文：上一章或前几章已经写过的发现、对话、场面，写进 avoid，本章不得再来一遍。",
  "4. 作者给了方向就照方向展开，不要改方向。",
  "5. 优先用已有的人物、地点、物件；确需新人物或新物件可以引入，但要写进 characters / entities。",
  "6. 不要揭开「受保护的秘密」，除非作者方向明确要求。",
  "7. 不能和【已确立事实】矛盾；那里写着已经做过的事（递过的材料、拿到的回执、认出过的记号），本章不要再做一遍。",
  "8. 时间要算得通：scene.time 写清和上一章的关系（第二天上午 / 当天傍晚）或具体日期，和【前几章的时间】顺下来；dayOffset 写本章开场离上一章结尾过了几天（同一天 0、第二天 1、三天后 3；天数由程序往后加，你不用数第几天）；本章中途要换天的，那个要点开头就写「第二天上午，……」；beats 和 time 里不写「第 N 天」；涉及年份时，人物当年多大要对得上他现在的年龄。",
  "9. 要有戏：每章至少一个让局面变化的转折或冲突升级（有人阻拦、出现对立的证据、关系起变化、期限逼近）；不要连续两章做同一类事（又去递材料、又等回复、又把同一个记号认一遍）；【主谜/核心冲突】每两三章要有实质进展。",
  "10. 【近几章反复出现的描写】本章一律换个写法，把它们写进 avoid。",
  "11. 【前几章用过的桥段】里反复出现的推进方式（又有人来打听、又去档案处查、又接到催期限的电话），本章不要再用同一个路数，换一种让局面变化的方式。",
  // 第十五、十七轮要点限到 60 字后矛盾翻倍（物件位置错 15 条）：章纲不再交代东西在哪，写手就乱放。要点写细，但物件状态照事实抄、不另编。
  "12. 每个要点写清谁、在哪、做了什么、局面怎么变；牵涉到的关键物件（文书、信物、钥匙、证据）写明此刻在谁手里或放在哪——照【已确立事实】和上一章结尾抄，不要另编；不写对白原话；不替前文补它没写过的设定（某张纸是谁的笔迹、某样东西原先归谁）。每个要点不超过 120 字。",
];
export const PLAN_JSON_FIELDS = [
  "{\"summary\":\"一句话说这章讲什么\",\"beats\":[\"按顺序 3–6 个要点，每个是一件具体发生的事（人、地点、关键物件在谁手里）\"],\"newInformation\":[\"1–3 条本章新出现的信息/变化\"],",
  "\"scene\":{\"location\":\"开场地点\",\"time\":\"开场时间（相对上一章，如第二天上午）\"},\"dayOffset\":离上一章结尾过了几天（整数，同一天 0）,\"characters\":[\"出场人物名\"],",
  "\"entities\":[\"本章涉及的物件/地点/文书名，用前文里的原名\"],\"threadsAdvanced\":[{\"title\":\"推进的线索或目标（照抄下面列表里的说法）\",\"how\":\"怎么推进\"}],",
  "\"avoid\":[\"本章不要重复的东西\"]}",
].join("\n");

/**
 * 材料块渲染（旧路和章纲员路共用）：章纲员路已经读过全书原文，可以不带「上一章正文 / 前面几章摘要」。
 * 章纲要求里点名的【已确立事实】【前几章的时间】等块照旧带上——它们来自账本，不是正文能替代的。
 */
export function planMaterialBlocks(
  chapter: number,
  materials: PlanChapterMaterials,
  direction?: string,
  options: { readonly withoutPreviousChapter?: boolean; readonly withoutRecentSummaries?: boolean } = {},
): readonly string[] {
  return [
    `【要写的章】第 ${chapter} 章`,
    direction?.trim() ? `【作者这章的方向】${direction.trim()}` : "【作者这章的方向】没有特别指定，按故事现状自然往下推进。",
    materials.premise ? `【故事前提】${materials.premise}` : "",
    materials.longFormGoals.length > 0 ? `【长线目标】${materials.longFormGoals.join("；")}` : "",
    materials.openGoals.length > 0 ? `【目标】\n${materials.openGoals.join("\n")}` : "",
    materials.openThreads.length > 0 ? `【开着的线索】\n${materials.openThreads.join("\n")}` : "",
    ...(options.withoutRecentSummaries ? [] : [materials.recentChapters.length > 0 ? `【前面几章发生了什么】\n${materials.recentChapters.join("\n")}` : ""]),
    materials.characters.length > 0 ? `【已有人物（括号里是身份和年龄，别用错人、别算错年代）】${materials.characters.join("、")}` : "",
    materials.coreMysteries.length > 0 ? `【主谜/核心冲突】${materials.coreMysteries.join("；")}` : "",
    materials.facts.length > 0 ? `【已确立事实（不能矛盾，做过的别再做）】\n${materials.facts.join("\n")}` : "",
    materials.recentTimes.length > 0 ? `【前几章的时间】\n${materials.recentTimes.join("\n")}` : "",
    materials.recurringPhrases.length > 0 ? `【近几章反复出现的描写（本章别再用）】${materials.recurringPhrases.join("、")}` : "",
    materials.recentBeats.length > 0 ? `【前几章用过的桥段】\n${materials.recentBeats.join("\n")}` : "",
    materials.entities.length > 0 ? `【已登记的物件/地点】${materials.entities.join("、")}` : "",
    materials.protectedSecrets.length > 0 ? `【受保护的秘密（不要揭开）】${materials.protectedSecrets.join("；")}` : "",
    ...(options.withoutPreviousChapter ? [] : [
      materials.previousChapter
        ? `【上一章（第 ${materials.previousChapter.chapter} 章）正文${materials.previousChapter.text.startsWith("（前略）") ? "结尾" : ""}】\n${materials.previousChapter.text}`
        : "【上一章】没有（这是开篇）。",
    ]),
  ].filter(Boolean);
}

export function parsePlanJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("章纲不是 JSON");
  return JSON.parse(match[0]);
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

/** 只有一句话加几个要点、人物 / 开场 / 新信息全空的章纲（第二十轮第 5、7 章）：算不出过了几天（日历少记一天）、
 * 翻旧资料的检索词也没了。章纲员路也用它判骨架章纲（重拟一次；重拟还是这样就用它，不为此判失败）。 */
export function isSkeletonPlan(plan: ChapterPlan, dayOffset: number | undefined): boolean {
  return plan.characters.length === 0 && plan.newInformation.length === 0 && !plan.scene.location && !plan.scene.time && dayOffset === undefined;
}

/** 要点开头就写了换天（「第二天上午，……」「三天后，……」）：本章到这里跨了几天。转述里的「约好第二天去」不算。 */
const BEAT_OPENS_WITH_DAY_CHANGE = /^[^，。,]{0,2}?(第二天|第二日|次日|翌日|隔天|隔日|转天|([一两二三四五六七八九十\d]+)\s*天(?:以)?后)/u;

/**
 * 上一章结束时是故事第几天：开场那天加上章内要点写明的换天（第二十一轮第 2 章跨了夜，
 * 按开场那天往后推，此后全书少一天）。
 */
export function storyDayAtChapterEnd(plan: ChapterPlan | undefined): number | undefined {
  if (!plan?.storyDay) return undefined;
  let day = plan.storyDay;
  // 第 1 个要点写的是本章开场（「第二天上午，……」），那一天已经算进 storyDay 了，不能再加（第二十二轮第 3、4、6、9 章各多记一天）。
  for (const beat of plan.beats.slice(1)) {
    const match = BEAT_OPENS_WITH_DAY_CHANGE.exec(beat);
    if (!match) continue;
    day += match[2] ? (CJK_DIGITS[match[2]] ?? (Number(match[2]) || 1)) : 1;
  }
  return day;
}

/** 上一章结束时是故事第几天（章纲员路也要用：天数归一在拟和改两处都跑）。 */
export async function previousChapterEndDay(projectDir: string, chapter: number): Promise<number | undefined> {
  const last = (await readStoryClock(projectDir, chapter).catch(() => [])).at(-1);
  if (!last) return undefined;
  // 时间线记了章内换天（定稿时正文声明、原句核过）就用它；没记再按那章章纲的要点推。
  if (last.endDay !== undefined) return last.endDay;
  const previous = await readChapterPlan(projectDir, last.chapter).catch(() => undefined);
  return storyDayAtChapterEnd(previous) ?? last.storyDay;
}

export interface ResolvedChapterPlan {
  readonly plan?: ChapterPlan;
  /** 给作者看的一句话：章纲是什么 / 为什么没有。 */
  readonly note: string;
  /** 沿用了这章已有的章纲（同一方向重写时不重拟）。 */
  readonly reused: boolean;
}

/** 章纲员 / 核账员审纲当场最多补多少章笔记；超过就如实说「还在读前文」，笔记在后台补，这次不硬等。 */
const PLANNER_MAX_CATCH_UP = 10;

/**
 * 编辑部拟章纲：章纲员窗口拟纲 → 核账员窗口审纲 → 有问题交回章纲员改一轮（不循环）。
 * R4.4 冷窗口兜底：章纲员 / 核账员还没读完全书（要补的笔记太多）不再「按没有章纲出稿」——
 * 拿已有笔记 + 最近 K 章原文照拟照审，note 里如实标「这次对照了多少」，笔记在后台接着补，读齐自动回正常路。
 */
async function planByEditorialRoom(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly direction?: string;
  readonly plannerCallModel?: BrainCallModel;
  readonly planCheckReaderCallModel?: BrainCallModel;
}, direction: string): Promise<ResolvedChapterPlan> {
  const plannerCallModel = input.plannerCallModel ?? callConfiguredPlannerModel;
  const planned = await withStep("拟", () => planChapterByPlanner({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(direction ? { direction } : {}),
    callModel: plannerCallModel,
    maxCatchUp: PLANNER_MAX_CATCH_UP,
  }));
  if (!planned.ok) return { note: `${planned.reason}；这次按没有章纲出稿。`, reused: false };
  // 等读那一句（R5.2 必做 2）：拟纲前先等章纲员当场补了笔记，如实说补了哪几章、花了多久。
  const planWaitNote = planned.waited ? `（${describeReaderWait("planner", planned.waited, "拟纲")}。）` : "";
  // 冷窗口拟纲：章纲员还没读完全书（拟是照已有笔记 + 最近 K 章原文拟的），笔记后台接着补。
  // （R5.2 试过「缺 3～8 章不等、缺口补全时改说直接对照原文」——大考卷比分输了，已删，只留等读标注，
  //   数字见 scripts/eval/results/r52-cold-gap-*.json。）
  let planColdNote = "";
  if (planned.cold) {
    void catchUpReaders(input.projectDir, input.chapter - 1, { callModel: plannerCallModel });
    planColdNote = `章纲员还没读完全书（第 ${planned.cold.notedThrough} / ${input.chapter - 1} 章），这次按${
      [
        ...(planned.cold.notedThrough > 0 ? ["已读笔记"] : []),
        ...(planned.cold.rawTo > 0 ? [`第 ${planned.cold.rawFrom}～${planned.cold.rawTo} 章原文`] : []),
      ].join(" + ")
    }拟的纲，更早的细节可能漏。`;
  }
  // 动笔前核账员先审章纲：它读过前文，找章纲里和前文对不上的要点（照片那种：第 5 章已带回家，章纲又安排来取）。
  const checkCallModel = input.planCheckReaderCallModel ?? callConfiguredBrainModel;
  const checked = await withStep("审", () => checkPlanByReader({
    projectDir: input.projectDir,
    plan: planned.plan,
    callModel: checkCallModel,
    maxCatchUp: PLANNER_MAX_CATCH_UP,
  }));
  const brief = (lines: readonly string[]) => `${lines.slice(0, 2).join("；")}${lines.length > 2 ? "等" : ""}`;
  const coldBasis = (cold: { readonly notedThrough: number; readonly rawFrom: number; readonly rawTo: number }): string =>
    [
      ...(cold.notedThrough > 0 ? ["已读笔记"] : []),
      ...(cold.rawTo > 0 ? [`第 ${cold.rawFrom}～${cold.rawTo} 章原文`] : []),
    ].join(" + ");
  // 等读那一句（R5.2）：审纲前先等核账员当场补了笔记。
  const checkWaitNote = checked.waited ? `（${describeReaderWait("checker", checked.waited, "审章纲")}。）` : "";
  // 冷窗口审纲：核账员还没读完全书，这次按已有笔记 + 最近 K 章原文审的，笔记后台接着补（点名 checker）。
  let checkColdNote = "";
  if (checked.cold) {
    void catchUpReaders(input.projectDir, input.chapter - 1, { callModel: checkCallModel, roles: ["checker"] });
    checkColdNote = `核账员还没读完全书（第 ${checked.cold.notedThrough} / ${input.chapter - 1} 章），这次按${coldBasis(checked.cold)}审的纲，更早的细节可能漏。`;
  }
  const coldNote = [planColdNote, checkColdNote].filter(Boolean).map((note) => `（${note}）`).join("");
  const waitNote = `${planWaitNote}${checkWaitNote}`;
  if (checked.failures.length > 0) {
    return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}（章纲审校这次没跑成：${checked.failures[0]}）${coldNote}${waitNote}`, reused: false };
  }
  if (checked.problems.length === 0) {
    return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}${coldNote}${waitNote}`, reused: false };
  }
  // R7.5 作者方向和前文既成事实对不上（authorWilled）：不自动改——改了等于替作者改主意，回执问以哪个为准。
  // 只有章纲员自己拟错的（非 authorWilled）才交回改一轮；全是作者方向时连改纲那一步都省了。
  const asked = checked.problems.filter((problem) => problem.authorWilled);
  const autoFix = checked.problems.filter((problem) => !problem.authorWilled);
  const short = (text: string) => (text.length > 30 ? `${text.slice(0, 30)}…` : text);
  const askSentence = asked.length > 0
    ? `第 ${asked[0]!.point} 条要点「${short(asked[0]!.beat ?? planned.plan.beats[asked[0]!.point - 1] ?? "")}」和第 ${asked[0]!.earlierChapter} 章「${short(asked[0]!.earlierQuote)}」对不上——以哪个为准？这次先照你的方向出稿；要按前文的话说一声，我改这条要点。`
    : "";
  if (autoFix.length === 0) {
    return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}（核账员审出 ${checked.problems.length} 处和前文对不上，都来自你给的方向：${askSentence}）${coldNote}${waitNote}`, reused: false };
  }
  // 有问题：把问题列表交回章纲员窗口，只改有问题的要点，改一轮、不循环。改不成就用原章纲（如实说明）。
  const revised = await withStep("改", () => revisePlanByPlanner({
    projectDir: input.projectDir,
    chapter: input.chapter,
    plan: planned.plan,
    problems: autoFix,
    callModel: plannerCallModel,
    maxCatchUp: PLANNER_MAX_CATCH_UP,
  }));
  if (revised.ok) {
    const reviseColdNote = revised.cold && !planned.cold ? "（改纲这次按最近几章原文改的。）" : "";
    const reviseWaitNote = revised.waited && !planned.waited ? `（${describeReaderWait("planner", revised.waited, "改章纲")}。）` : "";
    return {
      plan: revised.plan,
      note: `本章章纲：${revised.plan.summary}（核账员审出 ${checked.problems.length} 处和前文对不上，已让章纲员改掉 ${autoFix.length} 处：${brief(autoFix.map((problem) => problem.reason))}${askSentence ? `；另有 ${asked.length} 处来自你给的方向：${askSentence}` : ""}）${coldNote}${reviseColdNote}${waitNote}${reviseWaitNote}`,
      reused: false,
    };
  }
  return {
    plan: planned.plan,
    note: `本章章纲：${planned.plan.summary}（核账员审出 ${checked.problems.length} 处和前文对不上，但改章纲没成：${revised.reason}。${askSentence ? `另有 ${asked.length} 处来自你给的方向：${askSentence}` : ""}）${coldNote}${waitNote}`,
    reused: false,
  };
}

/**
 * 出稿前拿到本章章纲：这章已有章纲、且作者方向没变（同为空或原话相同）→ 沿用（「重写这一章」保持同一份章纲）；
 * 否则编辑部重拟。拟不成 → plan 缺省 + 如实说明，出稿照旧路径走，绝不阻断出稿。
 */
export async function resolveChapterPlanForDraft(input: {
  readonly projectDir: string;
  readonly chapter: number;
  /** 作者这章的方向原话；没给 = 章纲员按现状自己拟。 */
  readonly direction?: string;
  /** 章纲员那一路的模型调用（测试注入）；缺省走 chapterSteering 槽（思考开关随作者的任务设置）。 */
  readonly plannerCallModel?: BrainCallModel;
  /** 核账员审章纲的模型调用（测试注入）；缺省走 qualityCheck 槽。 */
  readonly planCheckReaderCallModel?: BrainCallModel;
}): Promise<ResolvedChapterPlan> {
  const direction = input.direction?.trim() ?? "";
  const existing = await readChapterPlan(input.projectDir, input.chapter).catch(() => undefined);
  if (existing && (existing.direction ?? "") === direction) {
    return { plan: existing, note: `沿用本章已有章纲：${existing.summary}`, reused: true };
  }
  return planByEditorialRoom(input, direction);
}
