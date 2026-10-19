import { join } from "node:path";
import { selectEffectiveFacts } from "./fact-selection.js";
import { selectRelevant, type BibleView, type BookProjection } from "@actalk/story-core";
import {
  describeErrorBriefly,
  readArcGoalPool,
  readFactLedger,
  readHookPool,
  readThreadPool,
  readTimelineEvents,
} from "../book/project-store.js";
import type { ArcGoal, HookItem, NarrativeThread, TimelineEvent } from "../book/types.js";
import { buildSettingPack, mentionedIn, readBibleTolerant, type SettingPack } from "./setting-pack.js";

/**
 * 写这一章要的上下文（写手、审稿、改稿、质检共用）：本章任务 + 设定包（设定卡 + 账里现状，重构 P9）
 * + 接着写要扛住的线（伏笔、线索、长线目标、已确立事实）+ 本章硬约束。
 */
export interface WritingContextPack {
  readonly chapterTask: {
    readonly chapterNumber: number;
    readonly userDirection: string;
    readonly currentChapterGoal: string;
  };
  readonly setting: SettingPack;
  readonly continuityFocus: {
    readonly recentTimelineEvents: readonly string[];
    readonly mustCarryHooks: readonly string[];
    readonly mustCarryThreads: readonly string[];
    readonly arcGoalFocus: readonly string[];
    readonly establishedFacts: readonly string[];
  };
  readonly hardConstraints: readonly string[];
  /**
   * 构造期间被降级为空的读盘失败（相对文件名 + errno code/错误类型，绝不带 error.message 原文）。
   * 与 context-gateway 的 `read_failures` 段同口径——gateway 会把本列表并进该段渲染进上下文；
   * 直接消费 pack 的调用方（质量检查/修订/审阅）也应如实透出，绝不静默吞掉（审计 P1-5 真修）。
   */
  readonly readFailures: readonly string[];
}

/** 本包（受保护段）内保留的最近时间线事件条数上限。完整时间线走独立可裁的 timeline_events 段。 */
const PACK_TIMELINE_EXCERPT = 3;

export interface BuildWritingContextPackInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly userDirection: string;
  readonly currentChapterGoal?: string;
  /** 上一章正文（接着写的原文）。用于翻出与它相关的旧事实、点到名字的地点 / 物品 / 设定。 */
  readonly continuityText?: string;
  /** 章纲点名的检索词（物件/地点/人物）。用于翻相关旧事实。 */
  readonly retrievalTerms?: readonly string[];
  /** 章纲定的开场地点：设定本里有它就整张带上，并当本章地点。 */
  readonly plannedLocation?: string;
  /** 本章要带的人物（在场检测给的名字）；不给就只带主角。 */
  readonly selectedCharacters?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  /**
   * 本包内「最近时间线事件」摘要的请求条数。**注意：本包在 ranker 是受保护段（不可裁），
   * 包内自限最多 {@link PACK_TIMELINE_EXCERPT}=3 条——传更大值不会生效**；完整时间线走
   * context-gateway 里独立可裁的 `timeline_events` 段（吃 maxTimelineEvents 全量、超预算可整段裁掉）。
   */
  readonly maxTimelineEvents?: number;
  readonly mustHitBeats?: readonly string[];
  /** 已经读好的设定视图（调用方有就传，省一次读盘；读坏降级成空设定的也传，失败原因由调用方记）。 */
  readonly bible?: { readonly projection?: BookProjection; readonly bible: BibleView };
}

export async function buildWritingContextPack(input: BuildWritingContextPackInput): Promise<WritingContextPack> {
  // P1-5 真修（2026-09-15）：台账级文件损坏不再炸掉整个出稿、也不静默吞成空——降级照做，
  // 每条失败进 readFailures 上浮，由 context-gateway 的 read_failures 段渲染给模型。
  const readFailures: string[] = [];
  const trackReadFailure = <T>(label: string, file: string, fallback: T) => (error: unknown): T => {
    readFailures.push(`${label}读取失败（${file}，${describeErrorBriefly(error)}），已按空资料降级。`);
    return fallback;
  };
  const [read, hookPool, threadPool, arcGoalPool, timelineEvents, factLedger] = await Promise.all([
    input.bible ? Promise.resolve({ bible: input.bible.bible }) : readBibleTolerant(input.projectDir),
    readHookPool(input.projectDir),
    readThreadPool(input.projectDir),
    readArcGoalPool(input.projectDir),
    readTimelineEvents(input.projectDir).catch(trackReadFailure("时间线事件", join("timeline", "events.json"), [] as TimelineEvent[])),
    readFactLedger(input.projectDir).catch(trackReadFailure("事实账本", join("story", "fact-ledger.json"), null)),
  ]);
  if ("failure" in read && read.failure) readFailures.push(read.failure);
  const bible = read.bible;

  const chapterGoal = input.currentChapterGoal ?? input.userDirection;
  const setting = buildSettingPack(bible, {
    characters: input.selectedCharacters ?? [],
    texts: [chapterGoal, input.continuityText ?? "", ...(input.retrievalTerms ?? [])],
    ...(input.plannedLocation ? { plannedPlaces: [input.plannedLocation] } : {}),
  });
  const relevantNames = [setting.protagonist?.name, ...setting.cast.map((brief) => brief.name)]
    .filter((name): name is string => Boolean(name && name.trim()));
  const selectedHooks = selectHooks(hookPool.hooks, input.selectedHookIds).slice(0, 3);
  // 按"本章仍有效 + 相关性"四维召回，替代纯 lastTouchedChapter 近章截断；
  // 早期未收口线索/目标只要章号差 ≥ ancientThreshold 就获得加分，不被最近章淘汰（根治长篇早期记忆塌陷）。
  const selectedThreads = selectRelevant({
    items: threadPool.threads.map((t) => ({ ...t, text: t.title ?? "" })),
    chapter: input.chapter,
    relevantNames,
    chapterGoal,
    relevantCharacterIds: relevantNames,
    closedStatuses: ["done", "stale"],
  }).selected.slice(0, 8);
  const selectedGoals = selectRelevant({
    items: arcGoalPool.goals.map((g) => ({ ...g, text: g.title ?? "" })),
    chapter: input.chapter,
    relevantNames,
    chapterGoal,
    relevantCharacterIds: relevantNames,
    closedStatuses: ["completed", "stale"],
  }).selected.slice(0, 4);
  // 「最近时间线事件」按【章号】取最近 N 条，不按磁盘顺序（2026-09-15 审计 P1-7）；排序键与
  // context-gateway.selectRecentTimelineEvents 同口径。本包是受保护段，只留极小摘要。
  const recentTimelineEvents = [...timelineEvents]
    .sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id))
    .slice(-Math.max(1, Math.min(input.maxTimelineEvents ?? PACK_TIMELINE_EXCERPT, PACK_TIMELINE_EXCERPT)));
  const establishedFacts = selectEffectiveFacts({
    facts: factLedger?.facts ?? [],
    chapter: input.chapter,
    relevantNames,
    // 接本章方向：不含人名但与本章要写的内容相关的硬设定也优先（洞#9）。
    chapterGoal,
    ...(input.continuityText ? { continuityText: input.continuityText } : {}),
    ...(input.retrievalTerms && input.retrievalTerms.length > 0 ? { retrievalTerms: input.retrievalTerms } : {}),
  }).facts;
  // 本章地点：章纲定的、或作者方向里点到名字的地点卡（取最长的名字，防「南门」抢「南门菜场」）。
  const directedPlace = [...bible.places]
    .filter((entry) => (input.plannedLocation && [entry.card.name, ...entry.card.aliases].includes(input.plannedLocation))
      || mentionedIn([entry.card.name, ...entry.card.aliases], [chapterGoal]))
    .sort((a, b) => b.card.name.length - a.card.name.length)[0]?.card.name;

  return {
    chapterTask: {
      chapterNumber: input.chapter,
      userDirection: input.userDirection,
      currentChapterGoal: chapterGoal,
    },
    setting,
    continuityFocus: {
      recentTimelineEvents: recentTimelineEvents.map(formatTimelineEvent),
      mustCarryHooks: selectedHooks.map(formatHook),
      mustCarryThreads: selectedThreads.map(formatThread),
      arcGoalFocus: selectedGoals.map(formatArcGoal),
      establishedFacts,
    },
    hardConstraints: buildHardConstraints({
      isOpeningChapter: input.chapter <= 1,
      ...(directedPlace ? { location: directedPlace } : {}),
      bans: setting.rules.bans,
      establishedFacts,
      mustHitBeats: input.mustHitBeats ?? [],
    }),
    readFailures,
  };
}

function selectHooks(hooks: readonly HookItem[], selectedHookIds: readonly string[] | undefined): readonly HookItem[] {
  if (!selectedHookIds || selectedHookIds.length === 0) {
    return hooks
      .filter((hook) => hook.status === "seeded" || hook.status === "active")
      .sort((a, b) => (b.lastTouchedChapter ?? 0) - (a.lastTouchedChapter ?? 0));
  }
  const ids = new Set(selectedHookIds);
  return hooks.filter((hook) => ids.has(hook.id));
}

function formatTimelineEvent(event: TimelineEvent): string {
  return `第${event.chapter}章：${event.summary}`;
}

function formatHook(hook: HookItem): string {
  return [hook.title, hook.nextActionHint, ...(hook.evidence ?? []).slice(-1)].filter(Boolean).join(" / ");
}

function formatThread(thread: NarrativeThread): string {
  return [thread.title, thread.nextActionHint, ...thread.evidence.slice(-1)].filter(Boolean).join(" / ");
}

function formatArcGoal(goal: ArcGoal): string {
  return [goal.title, goal.nextActionHint, ...goal.evidence.slice(-1)].filter(Boolean).join(" / ");
}

function buildHardConstraints(input: {
  readonly isOpeningChapter: boolean;
  readonly location?: string;
  readonly bans: readonly string[];
  readonly establishedFacts: readonly string[];
  readonly mustHitBeats: readonly string[];
}): readonly string[] {
  const mustHit = input.mustHitBeats.map((beat) => beat.trim()).filter(Boolean);
  return unique([
    // 用户/agent 指定的本章必须命中要点——放硬约束首位、protocol 已令优先于文风遵守（Codex 复测：首稿跑偏）。
    mustHit.length > 0
      ? `必须在本章逐条落实这些要点，照写其中的具体名物 / 数字 / 编号，不得替换、合并或遗漏：${mustHit.join("；")}。`
      : undefined,
    input.location
      ? `本章地点：${input.location}${input.isOpeningChapter ? "" : "；从上一章结尾所在处过去要写出移动过程"}。`
      : input.isOpeningChapter
        ? "开场地点按故事设定和地点卡来，不要编造与设定冲突的地点。"
        : "本章从上一章结尾所在的地方接着写；换场要写出移动过程，不要编造与地点卡冲突的地点。",
    input.bans.length > 0 ? `一定不要写：${input.bans.join("；")}。` : undefined,
    "设定里写着还没揭开、不能说破的，本章不要揭开，也不要让不该知道的人知道。",
    input.establishedFacts.length > 0 ? `不得改写或否认以下已确立事实：${input.establishedFacts.slice(0, 12).join("；")}。` : undefined,
    "设定本里没有的人、地点、物件、组织，不要凭空写成要紧的；需要时模糊处理。",
    "不要让主角突然开挂。",
    "不要把世界规矩一次性写成设定说明书。",
  ].filter((item): item is string => Boolean(item)));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
