/**
 * 拟章纲（2026-10-08 写作主链重设计·阶段 2「先想后写」；2026-10-12 编辑部 T3 起只剩章纲员一条路）。
 *
 * 十章真机验收：作者只说「接着写」时写手拿到的目标是空话，剧情原地打转（同一个发现被重新发现 5 次）。
 * 出稿前先拟章纲：接住上一章结尾、至少推进一条开着的线索、至少给一条新信息、写明不要重复什么，
 * 并点名本章涉及的人/物/地——引擎据此翻旧章原文与旧事实（见引擎 chapter-plan.ts / earlier-passages.ts）。
 *
 * 编排在 plan-chapter.ts（resolveChapterPlanForDraft）：章纲员窗口拟纲（planner.ts）→ 核账员窗口审纲（checker.ts）
 * → 有问题交回章纲员改一轮（不循环）。本文件是章纲员、头脑风暴复用的材料和纯函数（P7 第 6 步从 plan-chapter 拆出，
 * 拆掉 plan-chapter ↔ planner 的 import 环）：材料收集（collectPlanMaterials）、
 * 章纲 JSON 要求（PLAN_REQUIREMENT_LINES / PLAN_JSON_FIELDS / planMaterialBlocks）、解析与天数归一
 * （parsePlanJson / readDayOffset / reconcileStoryDay / storyDayAtChapterEnd / previousChapterEndDay）。
 * 改提示词必须在题库上比分（docs/editorial-room/ 的规矩），别凭感觉改。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findRecurringPhrases, parseDraftFile } from "@actalk/story-core";
import { readBible, type BibleView } from "@actalk/story-core";
import { readStoryViews, type StoryViews } from "../book/story-views.js";
import { readChapterPlan, readStoryClock, type ChapterPlan } from "../book/chapter-plan.js";
import { unknownDayOf } from "../book/story-timeline.js";
import { selectEffectiveFacts } from "../writing/fact-selection.js";
import { foundationMessage, readFoundationDigest } from "./foundation-digest.js";

const PREVIOUS_TAIL_CHARS = 3000;
const MAX_OPEN_THREADS = 15;
const RECENT_CHAPTER_SUMMARIES = 6;
const PLAN_FACT_CAP = 25;
const RECENT_PLAN_TIMES = 5;
const RECURRING_WINDOW = 5;

export interface PlanChapterMaterials {
  /** 设定本摘要（故事设定 / 人物 / 地点 / 物品 / 其他设定，和核账员同一份）：前提、主线、人物关系、过去的事都在这里（白沙渡试写）。 */
  readonly foundation?: string;
  readonly previousChapter?: { readonly chapter: number; readonly text: string };
  readonly recentChapters: readonly string[];
  readonly openThreads: readonly string[];
  readonly openGoals: readonly string[];
  /** 设定本里的人物 + 账里出场过、还没建卡的人（名字）。 */
  readonly characters: readonly string[];
  /** 设定本里的地点 / 物品 / 其他设定（名字）。 */
  readonly entities: readonly string[];
  /** 与接下来要写的内容相关的已确立事实（拟章纲时就得避开前后矛盾——验收：三分之一的矛盾在章纲里就写错了）。 */
  readonly facts: readonly string[];
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
  const body = parseDraftFile(content).body;
  if (!body) return undefined;
  return { chapter: chapter - 1, text: body.length > PREVIOUS_TAIL_CHARS ? `（前略）${body.slice(-PREVIOUS_TAIL_CHARS)}` : body };
}

/** 最近几章的正文（不含标题），找跨章复用的描写用。 */
async function readRecentChapterBodies(projectDir: string, chapter: number): Promise<readonly { readonly chapter: number; readonly body: string }[]> {
  const out: { chapter: number; body: string }[] = [];
  for (let n = Math.max(1, chapter - RECURRING_WINDOW); n < chapter; n += 1) {
    const content = await readFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), "utf-8").catch(() => "");
    const body = parseDraftFile(content).body;
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
  const [bible, views, previousChapter, recentBodies, recentTimes] = await Promise.all([
    settle(readBible(projectDir).then((read): BibleView | undefined => read.bible), undefined),
    settle(readStoryViews(projectDir).then((read): StoryViews | undefined => read), undefined),
    readPreviousChapterText(projectDir, chapter),
    readRecentChapterBodies(projectDir, chapter),
    readRecentPlanTimes(projectDir, chapter),
  ]);
  const threadPool = views?.threads ?? { threads: [] };
  const goalPool = views?.goals ?? { goals: [] };
  const timeline = views?.events ?? [];
  const factLedger = views?.facts;
  // 设定本读不了当没有（拟纲照常，只是少一份对照）；哪类资料都没有的新书也是 undefined。
  const foundation = await readFoundationDigest(projectDir).catch(() => undefined);
  const recentBeats = await readRecentPlanBeats(projectDir, chapter);
  const characterNames = [
    ...(bible?.characters ?? []).map((entry) => entry.card.name),
    ...(bible?.uncarded ?? []).filter((entry) => entry.character).map((entry) => entry.name),
  ];
  const entityNames = [...(bible?.places ?? []), ...(bible?.items ?? []), ...(bible?.lore ?? [])].map((entry) => entry.card.name);
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
    ...(foundation ? { foundation: foundationMessage(foundation) } : {}),
    ...(previousChapter ? { previousChapter } : {}),
    recentChapters,
    openThreads,
    openGoals,
    characters: characterNames,
    entities: entityNames,
    facts,
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
  "4. 作者给了方向就照方向展开，不要改方向。方向里有和前文既成事实对不上的（东西已经不在那人手里、人已不在、事已发生过）时，可以改成说得通的安排，但每一处都要写进 directionChanges：said 逐字抄方向原话，changedTo 写改成了什么，why 写和前文哪里对不上——不许悄悄改。照原话安排的不用写。",
  "5. 优先用已有的人物、地点、物件；确需新人物或新物件可以引入，但要写进 characters / entities。",
  "6. 设定本里写着还没揭开、不能说破的，不要揭开，除非作者方向明确要求。",
  "7. 不能和【已确立事实】【设定本】矛盾：已确立事实里写着已经做过的事（递过的材料、拿到的回执、认出过的记号），本章不要再做一遍；人物关系、年龄、过去发生过的事照设定本安排。",
  "8. 时间要算得通：scene.time 写清和上一章的关系（第二天上午 / 当天傍晚）或具体日期，和【前几章的时间】顺下来；dayOffset 写本章开场离上一章结尾过了几天（同一天 0、第二天 1、三天后 3；天数由程序往后加，你不用数第几天）；本章中途要换天的，那个要点开头就写「第二天上午，……」；beats 和 time 里不写「第 N 天」；涉及年份时，人物当年多大要对得上他现在的年龄。",
  "9. 要有戏：每章至少一个让局面变化的转折或冲突升级（有人阻拦、出现对立的证据、关系起变化、期限逼近）；不要连续两章做同一类事（又去递材料、又等回复、又把同一个记号认一遍）；设定本里的主线冲突、核心谜团每两三章要有实质进展。",
  "10. 【近几章反复出现的描写】本章一律换个写法，把它们写进 avoid。",
  "11. 【前几章用过的桥段】里反复出现的推进方式（又有人来打听、又去档案处查、又接到催期限的电话），本章不要再用同一个路数，换一种让局面变化的方式。",
  // 第十五、十七轮要点限到 60 字后矛盾翻倍（物件位置错 15 条）：章纲不再交代东西在哪，写手就乱放。要点写细，但物件状态照事实抄、不另编。
  "12. 每个要点写清谁、在哪、做了什么、局面怎么变；牵涉到的关键物件（文书、信物、钥匙、证据）写明此刻在谁手里或放在哪——照【已确立事实】和上一章结尾抄，不要另编；不写对白原话；不替前文补它没写过的设定（某张纸是谁的笔迹、某样东西原先归谁）。每个要点不超过 120 字。",
];
/**
 * 第 1 章前面还没有正文：要求第 1、3 条（接上一章、别重演前文）换成开篇的说法（换题材长篇实跑 2026-10-27：
 * 章纲员拿着「跟读到第 0 章」拟第 1 章，开场写成「紧接上一章的次日」，还把设定本里还没写的事当成「上一章」写进 avoid）。
 */
export const OPENING_PLAN_NOTE = "设定本写的是前提和背景：里面的事除非写明发生在故事开始之前，都还没在正文里写过，别当成前文已经写过的。";
const OPENING_REQUIREMENT_LINES: Readonly<Record<number, string>> = {
  0: "1. 这是全书第 1 章，前面还没有正文：从故事的开头写起，不要写成接着哪一章；scene.time 写开场时间，dayOffset 填 0（第 8 条里和上一章比的说法不适用）。",
  2: `3. ${OPENING_PLAN_NOTE}avoid 里不写「上一章」「前文」。`,
};
export function planRequirementLines(chapter: number): readonly string[] {
  return chapter <= 1 ? PLAN_REQUIREMENT_LINES.map((line, index) => OPENING_REQUIREMENT_LINES[index] ?? line) : PLAN_REQUIREMENT_LINES;
}
export const PLAN_JSON_FIELDS = [
  "{\"summary\":\"一句话说这章讲什么\",\"beats\":[\"按顺序 3–6 个要点，每个是一件具体发生的事（人、地点、关键物件在谁手里）\"],\"newInformation\":[\"1–3 条本章新出现的信息/变化\"],",
  "\"scene\":{\"location\":\"开场地点\",\"time\":\"开场时间（相对上一章，如第二天上午）\"},\"dayOffset\":离上一章结尾过了几天（整数，同一天 0）,\"characters\":[\"出场人物名\"],",
  "\"entities\":[\"本章涉及的物件/地点/文书名，用前文里的原名\"],\"threadsAdvanced\":[{\"title\":\"推进的线索或目标（照抄下面列表里的说法）\",\"how\":\"怎么推进\"}],",
  "\"avoid\":[\"本章不要重复的东西\"],\"directionChanges\":[{\"said\":\"作者方向原话\",\"changedTo\":\"改成了什么\",\"why\":\"和前文哪里对不上\"}]（没改就给空数组）}",
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
    materials.openGoals.length > 0 ? `【目标】\n${materials.openGoals.join("\n")}` : "",
    materials.openThreads.length > 0 ? `【开着的线索】\n${materials.openThreads.join("\n")}` : "",
    ...(options.withoutRecentSummaries ? [] : [materials.recentChapters.length > 0 ? `【前面几章发生了什么】\n${materials.recentChapters.join("\n")}` : ""]),
    materials.characters.length > 0 ? `【已有人物（身份、年龄见设定本，别用错人、别算错年代）】${materials.characters.join("、")}` : "",
    materials.foundation ?? "",
    materials.facts.length > 0 ? `【已确立事实（不能矛盾，做过的别再做）】\n${materials.facts.join("\n")}` : "",
    materials.recentTimes.length > 0 ? `【前几章的时间】\n${materials.recentTimes.join("\n")}` : "",
    materials.recurringPhrases.length > 0 ? `【近几章反复出现的描写（本章别再用）】${materials.recurringPhrases.join("、")}` : "",
    materials.recentBeats.length > 0 ? `【前几章用过的桥段】\n${materials.recentBeats.join("\n")}` : "",
    materials.entities.length > 0 ? `【已登记的物件/地点/设定】${materials.entities.join("、")}` : "",
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

// 不猜白名单开始：日期归一
const NEXT_DAY = /第二天|第二日|次日|翌日|隔天|隔日|转天/u;
const DAYS_LATER = /([一两二三四五六七八九十\d]+)\s*天(?:以)?后/u;
// 不猜白名单结束
const CJK_DIGITS: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// 不猜白名单：日期归一
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
export function reconcileStoryDay(plan: ChapterPlan, dayOffset: number | undefined, lastDay: number | "unknown" | undefined): ChapterPlan {
  if (lastDay === "unknown") {
    // 上一章是哪天不知道：章纲员给的天数没有依据，不留（留了写手会照它说「昨天、前天」）。
    const { storyDay: _unknown, ...rest } = plan;
    return rest;
  }
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
// 不猜白名单：日期归一
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

/**
 * 上一章结束时是故事第几天（章纲员路也要用：天数归一在拟和改两处都跑）。
 * 上一章定稿了但天数不知道（它或它前面有章账待记）→ "unknown"：不拿再前一章的天数顶（写作版本 P2b 设计 3.3）。
 */
export async function previousChapterEndDay(projectDir: string, chapter: number): Promise<number | "unknown" | undefined> {
  if (chapter > 1) {
    const views = await readStoryViews(projectDir).catch(() => undefined);
    if (views && unknownDayOf(views.timeline, chapter - 1)) return "unknown";
  }
  const last = (await readStoryClock(projectDir, chapter).catch(() => [])).at(-1);
  if (!last) return undefined;
  // 时间线记了章内换天（定稿时正文声明、原句核过）就用它；没记再按那章章纲的要点推。
  if (last.endDay !== undefined) return last.endDay;
  // 没记再按那章章纲的要点推章内换了几天；开场是第几天以时间线为准——定稿时按正文记过，
  // 旧章纲的天数可能早过时了（2026-10-28 第 32 章章纲第 125 天、正文「评估过去三天了」记成第 130 天，第 33 章章纲跟着旧的记成第 126 天）。
  const previous = await readChapterPlan(projectDir, last.chapter).catch(() => undefined);
  const planEnd = storyDayAtChapterEnd(previous);
  return planEnd !== undefined && previous?.storyDay ? last.storyDay + (planEnd - previous.storyDay) : last.storyDay;
}
