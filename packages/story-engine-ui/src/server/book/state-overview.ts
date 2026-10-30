import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTimelineLayers } from "./timeline-layers.js";
import type { TimelineLayerEvent, TimelineMacroBlock } from "./timeline-layers.js";
import { bigramSimilarity, DEFAULT_STALE_AFTER, idleChaptersBetween, LedgerNeedsUpgradeError, threadUnknownChapters, listChapterTexts, listLegacyRecoveryNotices, readBible, selectRelevant, type BibleView, type LegacyRecoveryNotice } from "@actalk/story-core";
import { describeErrorBriefly } from "./project-store.js";
import { readStoryViews } from "./story-views.js";
import type {
  ArcGoal,
  ArcGoalPool,
  NarrativeThread,
  StoryProject,
  ThreadPool,
  TimelineEvent,
} from "./types.js";

export interface BuildStateOverviewInput {
  readonly projectDir: string;
  readonly chapter?: number;
  readonly maxTimelineEvents?: number;
  /** 开书时没接上新核心的原因（ensureBookOnCore 失败）：账读不出来时照它说，不让作者「重新打开」一个开了也没用的书。 */
  readonly notOnCore?: string;
}

/**
 * 书概况：账（线索、目标、时间线，从投影现算）+ 设定本的几个数。设定卡本身走设定视图（core readBible / GET /api/bible），
 * 这里只带别处要用的：主角名、人物名单、目标字数（重构 P9）。
 */
export interface StateOverview {
  readonly project: {
    readonly title: string;
    /** 故事设定里「题材」那一栏（作者没写就是空串）。 */
    readonly genre: string;
    /** 故事设定里「一句话」那一栏（书架上的简介；作者没写就是空串）。 */
    readonly logline: string;
    readonly currentChapter: number | null;
  };
  readonly storyStatus: {
    readonly currentObjective?: string;
    readonly lastTimelineEvent?: string;
  };
  readonly threads: {
    readonly total: number;
    readonly open: number;
    readonly touched: number;
    readonly done: number;
    readonly openIntents: number;
    readonly cleanupVisibleCount: number;
    /** cleanup 候选（低价值/过期）里仍是未收口（open/touched）的条数——与 open+touched 同一集合，恒 ≤ open+touched。
     * 编辑部 R5.4·新发现 4：cleanupVisibleCount 把已收口（done/stale）的意图线索也算进去，入库回执曾写出
     * 「未收口的线索已积到 55 条，其中 78 条已经低价值或过期」。「其中 X 条」要用这个数。 */
    readonly cleanupVisibleUnresolvedCount: number;
    /** 可清理的线索全列（停得久的先，最多 MAX_CLEANUP_ITEMS 条）：跟界面「N 条线索好几章没动」同一批，对话 AI 照这个列给作者。 */
    readonly cleanupItems: readonly StateOverviewThreadItem[];
    readonly keyOpenItems: readonly StateOverviewThreadItem[];
  };
  readonly arcGoals: {
    readonly activeCount: number;
    readonly touchedCount: number;
    readonly completedCount: number;
    readonly activeItems: readonly StateOverviewArcGoalItem[];
  };
  readonly timeline: {
    readonly recentEvents: readonly StateOverviewTimelineEvent[];
    /** L2：中段每章紧凑摘要（chapter + summary + mainEvent）。旧书或章数不足时为空数组。 */
    readonly earlierSummary: readonly TimelineLayerEvent[];
    /** L3：远期每 5 章一块宏事件。旧书或章数不足时为空数组。 */
    readonly macroSummary: readonly TimelineMacroBlock[];
  };
  readonly characters: {
    /** 标了主角的人物卡名字。 */
    readonly protagonist?: string;
    /** 人物卡 + 账里出场过、还没建卡的人（主角在前）。 */
    readonly knownCharacters: readonly StateOverviewCharacterItem[];
  };
  readonly setting: StateOverviewSetting;
  /** 定稿时账没记上（pending）/ 没记全（partial）、还能「补记账」的章（导入的由通读记账补，不算）。没有就不带。 */
  readonly ledgerShort?: readonly { readonly chapter: number; readonly status: "pending" | "partial" }[];
  readonly uiHints: {
    readonly warnings: readonly string[];
  };
}

export interface StateOverviewSetting {
  /** 写作规则里的每章目标字数 / 最少字数（作者没定就没有）。 */
  readonly targetChapterWords?: number;
  readonly minChapterWords?: number;
  readonly cards: { readonly characters: number; readonly places: number; readonly items: number; readonly lore: number };
  /** 账里有、还没建卡的。 */
  readonly uncarded: number;
  /** 故事设定写了几栏。 */
  readonly storyFields: number;
}

export interface StateOverviewThreadItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly type?: string;
  readonly lastTouchedChapter?: number;
  readonly cleanupCandidateClass?: string;
  /** 被折叠进本条的近重复数量（展示层「+N 条相关」）。未折叠时缺省（undefined）。 */
  readonly relatedCount?: number;
  /** 作者标的分量：major=大伏笔、minor=小线索；普通的不带。 */
  readonly weight?: "major" | "minor";
  /** B5-2: 初次出现章号（透传自 NarrativeThread.firstSeenChapter）。读时投影，不写盘。 */
  readonly firstSeenChapter?: number;
}

export interface StateOverviewArcGoalItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly progress?: string;
  readonly lastTouchedChapter?: number;
}

export interface StateOverviewTimelineEvent {
  readonly chapter: number;
  readonly summary: string;
  readonly title?: string;
  readonly mainEvent?: string;
  readonly location?: string;
}


export interface StateOverviewCharacterItem {
  readonly name: string;
  /** 有人物卡；false = 账里出场过、还没建卡。 */
  readonly carded: boolean;
  readonly protagonist?: true;
  readonly chapterCount?: number;
  readonly lastSeenChapter?: number;
}

const DEFAULT_MAX_TIMELINE_EVENTS = 5;
const MAX_ITEMS = 12;
const MAX_CLEANUP_ITEMS = 20;
const MAX_TEXT = 160;
// 「题材」是建书和老书迁移时写进故事设定的栏名（自家格式），照栏名原样取，不猜意思。
const GENRE_LABEL = "题材";
const LOGLINE_LABEL = "一句话";


/**
 * 总览是读路径：不拿锁、不写盘（重构 P7）。老定稿链的事务残留在开书时收（界面服务端 ensureBookOnCore）。
 */
export async function buildStateOverview(input: BuildStateOverviewInput): Promise<StateOverview> {
  // 审计 Low：损坏台账（SyntaxError）回落空值时的留痕收集器——进 uiHints.warnings，面板显示「坏」而非「空」。
  const corruptLedgerFiles: string[] = [];
  const noteCorruptLedger = (relativePath: string): void => {
    corruptLedgerFiles.push(relativePath);
  };
  const degradedReads: string[] = [];
  const [
    project,
    views,
    bible,
    commitRecoveryNotices,
  ] = await Promise.all([
    readJsonSafe<StoryProject>(input.projectDir, "project.json", { id: "unknown", title: "Untitled", createdAt: "", updatedAt: "" }, noteCorruptLedger),
    // 账是真相：读不出来如实挂警告，概况照常出（读侧不堵）。
    readStoryViews(input.projectDir).catch((error: unknown) => {
      const why = error instanceof LedgerNeedsUpgradeError && input.notOnCore ? `账本升级没成：${input.notOnCore}` : describeErrorBriefly(error, input.projectDir);
      degradedReads.push(`账读不出来（${why}），线索和时间线按空显示。定稿等写入操作会如实报错。`);
      return undefined;
    }),
    // 设定卡是真相：读不出来如实挂警告，概况照常出（读侧不堵）。
    readBible(input.projectDir).then((read) => read.bible).catch((error: unknown) => {
      degradedReads.push(`设定卡读不出来（${describeErrorBriefly(error, input.projectDir)}），设定本按空显示。`);
      return undefined;
    }),
    // A3（P1-6 上浮）：开书时 recover 已跑完；仍挂着「recovered + recoveryIssues」的残留
    // =盘上「章文件在、资料已回滚」的分歧态。上浮进 uiHints.warnings 既有通道，绝不只写 manifest 静默。
    // 扫描失败不堵概览——概述是读侧，残留信号由下一次 recover/commit 继续兜。
    listLegacyRecoveryNotices(input.projectDir).catch(() => [] as const),
  ]);
  const threadPool: ThreadPool = views?.threads ?? { threads: [] };
  const arcGoalPool: ArcGoalPool = views?.goals ?? { goals: [] };
  const timelineEvents: readonly TimelineEvent[] = views?.events ?? [];

  // 账还没接上新核心的老书（书架上列着、还没打开过）：投影是空的，章数照盘上的定稿正文算，不报成零章；开书时导入。
  const textChapters = views?.projection.chapters.length ? [] : await listChapterTexts(input.projectDir).catch(() => [] as readonly number[]);
  const latestChapter = inferCurrentChapter(timelineEvents) ?? (textChapters.length > 0 ? Math.max(...textChapters) : null);
  const currentChapter = input.chapter ?? latestChapter;
  // 可清理的线索只按章数和作者标的轻重算，不按标题文字猜「泛泛的打算 / 低价值」（重构 P7「不猜」）。
  // 从最新定稿章算、不随作者正翻着的章变（长篇实跑：翻到下一章，界面说 5 条、AI 说 6 条）。
  const threadUnknown = threadUnknownChapters(views?.projection.chapters ?? []);
  const cleanupCandidates = threadPool.threads
    .filter((thread) => isCleanupCandidate(thread, latestChapter, threadUnknown))
    .sort((a, b) => (a.lastTouchedChapter ?? 0) - (b.lastTouchedChapter ?? 0));
  const cleanupCandidateIds = new Set(cleanupCandidates.map((thread) => thread.id));
  const cleanupVisibleCount = cleanupCandidateIds.size;
  const cleanupVisibleUnresolvedCount = cleanupVisibleCount;
  const recentEvents = timelineEvents
    .slice()
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-(input.maxTimelineEvents ?? DEFAULT_MAX_TIMELINE_EVENTS))
    .map(toTimelineOverview);
  // L2/L3 分层摘要——从全量 events 派生，保留早期内容，不破坏 recentEvents
  const timelineLayers = buildTimelineLayers(timelineEvents, currentChapter ?? 0);
  const lastEvent = recentEvents.at(-1);
  const ledgerShort = (views?.projection.chapters ?? []).flatMap((chapter) => (
    chapter.origin !== "import" && chapter.ledgerStatus !== "ready" ? [{ chapter: chapter.chapter, status: chapter.ledgerStatus }] : []
  ));

  return {
    project: {
      title: project.title,
      genre: storyField(bible, GENRE_LABEL),
      logline: storyField(bible, LOGLINE_LABEL),
      currentChapter,
    },
    storyStatus: {
      currentObjective: firstText([
        firstActiveGoal(arcGoalPool.goals)?.title,
        firstOpenThread(threadPool.threads)?.title,
      ]),
      lastTimelineEvent: lastEvent?.summary,
    },
    threads: {
      total: threadPool.threads.length,
      open: threadPool.threads.filter((thread) => thread.status === "open").length,
      touched: threadPool.threads.filter((thread) => thread.status === "touched").length,
      done: threadPool.threads.filter((thread) => thread.status === "done").length,
      openIntents: threadPool.threads.filter((thread) => thread.type === "intent" && thread.status === "open").length,
      cleanupVisibleCount,
      cleanupVisibleUnresolvedCount,
      cleanupItems: cleanupCandidates.slice(0, MAX_CLEANUP_ITEMS).map((thread) => toThreadOverview(thread, "stale_candidate")),
      keyOpenItems: (() => {
        const threadSelectChapter = currentChapter ?? Math.max(0, ...threadPool.threads.map((t) => t.firstSeenChapter ?? 0));
        const selected = selectRelevant({
          items: threadPool.threads.map((t) => ({ ...t, text: t.title ?? "" })),
          chapter: threadSelectChapter,
          closedStatuses: ["done", "stale"],
        }).selected;
        return clusterNearDuplicates(selected).slice(0, MAX_ITEMS).map(({ rep: thread, relatedCount }) =>
          toThreadOverview(thread, cleanupCandidateIds.has(thread.id) ? "stale_candidate" : undefined, relatedCount),
        );
      })(),
    },
    arcGoals: {
      activeCount: arcGoalPool.goals.filter((goal) => goal.status === "active").length,
      touchedCount: arcGoalPool.goals.filter((goal) => goal.status === "touched").length,
      completedCount: arcGoalPool.goals.filter((goal) => goal.status === "completed").length,
      activeItems: (() => {
        const arcSelectChapter = currentChapter ?? Math.max(0, ...arcGoalPool.goals.map((g) => g.firstSeenChapter ?? 0));
        return selectRelevant({
          items: arcGoalPool.goals.map((g) => ({ ...g, text: g.title ?? "" })),
          chapter: arcSelectChapter,
          closedStatuses: ["completed", "stale"],
        }).selected.slice(0, MAX_ITEMS).map(toArcGoalOverview);
      })(),
    },
    timeline: {
      recentEvents,
      earlierSummary: timelineLayers.l2,
      macroSummary: timelineLayers.l3,
    },
    characters: {
      ...(bible?.protagonist ? { protagonist: bible.protagonist } : {}),
      knownCharacters: bible ? knownCharactersOf(bible) : [],
    },
    setting: settingOf(bible),
    ...(ledgerShort.length > 0 ? { ledgerShort } : {}),
    uiHints: {
      warnings: [
        ...buildWarnings({ threadPool, arcGoalPool, cleanupVisibleCount }),
        ...commitRecoveryNotices.map(formatLegacyRecoveryNotice),
        // 审计 Low：损坏台账如实可见（绝不把「坏文件」显示成「没有资料」）。
        ...unique(corruptLedgerFiles.map((relativePath) =>
          `资料文件损坏，面板按空显示：${relativePath}。定稿等写入操作会如实报错，请先修复该文件。`)),
        ...unique(degradedReads),
      ],
    },
  };
}

/**
 * 一条老格式事务残留通知渲成中性文本（code 前缀 `transaction_recovered_partial` + 章号 + 计数）。
 * 绝不带绝对路径/error.message——细节证据在 `.story-engine-tx/<transactionId>/manifest.json`（相对路径）。
 */
export function formatLegacyRecoveryNotice(notice: LegacyRecoveryNotice): string {
  return `transaction_recovered_partial: 第 ${notice.chapter} 章的入库事务此前中断且未能完全回滚，已按原样放行（${notice.issueCount} 项残留记录在 ${notice.transactionId}/manifest.json）；该章文件可能与伏笔/时间线等资料不一致，建议重新提交第 ${notice.chapter} 章或人工核对。`;
}

function storyField(bible: BibleView | undefined, label: string): string {
  return bible?.story.find((field) => field.label === label)?.value.trim() ?? "";
}

function knownCharactersOf(bible: BibleView): readonly StateOverviewCharacterItem[] {
  return [
    ...bible.characters.map((entry) => ({
      name: entry.card.name,
      carded: true,
      ...(entry.card.protagonist ? { protagonist: true as const } : {}),
      ...(entry.appearances ? { chapterCount: entry.appearances.chapters.length, lastSeenChapter: entry.appearances.last } : {}),
    })),
    ...bible.uncarded.filter((entry) => entry.character).map((entry) => ({
      name: entry.name,
      carded: false,
      ...(entry.appearances ? { chapterCount: entry.appearances.chapters.length, lastSeenChapter: entry.appearances.last } : {}),
    })),
  ];
}

function settingOf(bible: BibleView | undefined): StateOverviewSetting {
  if (!bible) return { cards: { characters: 0, places: 0, items: 0, lore: 0 }, uncarded: 0, storyFields: 0 };
  return {
    ...(bible.rules.targetWords ? { targetChapterWords: bible.rules.targetWords.value } : {}),
    ...(bible.rules.minWords ? { minChapterWords: bible.rules.minWords.value } : {}),
    cards: { characters: bible.characters.length, places: bible.places.length, items: bible.items.length, lore: bible.lore.length },
    // 作者说过不用建卡的不算待建。
    uncarded: bible.uncarded.filter((entry) => !entry.skipped).length,
    storyFields: bible.story.length,
  };
}

export function clusterNearDuplicates<T extends { readonly id: string; readonly title: string }>(
  items: readonly T[],
  threshold = 0.5,
): Array<{ rep: T; relatedCount: number }> {
  const clusters: Array<{ rep: T; relatedCount: number }> = [];

  for (const item of items) {
    let merged = false;
    for (const cluster of clusters) {
      if (bigramSimilarity(item.title, cluster.rep.title) >= threshold) {
        cluster.relatedCount += 1;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ rep: item, relatedCount: 0 });
    }
  }

  return clusters;
}

/** 跟伏笔看板「停太久」同一把尺子（核心投影的 staleAfter、不数线索账没记全的章），只是大伏笔不劝清理。 */
function isCleanupCandidate(thread: NarrativeThread, latestChapter: number | null, threadUnknown: readonly number[]): boolean {
  if (thread.status !== "open" && thread.status !== "touched") return false;
  // 大伏笔本来就要埋很久（长篇实跑：第 1 章的「铁箱里是什么」标了大伏笔，第 6 章起天天被劝清理）；
  // 小线索是作者说过「停多久都不提醒」的。
  if (thread.weight === "major" || thread.weight === "minor") return false;
  if (latestChapter === null || typeof thread.lastTouchedChapter !== "number") return false;
  return idleChaptersBetween(thread.lastTouchedChapter, latestChapter, threadUnknown) >= DEFAULT_STALE_AFTER;
}

function toThreadOverview(thread: NarrativeThread, cleanupCandidateClass?: string, relatedCount?: number): StateOverviewThreadItem {
  return {
    id: thread.id,
    title: truncate(thread.title),
    status: thread.status,
    type: thread.type,
    lastTouchedChapter: thread.lastTouchedChapter,
    ...(cleanupCandidateClass && cleanupCandidateClass !== "none" ? { cleanupCandidateClass } : {}),
    ...(relatedCount !== undefined && relatedCount > 0 ? { relatedCount } : {}),
    // 只给作者标的分量。原来给按跨章数派生的「大 / 小」，对话 AI 当成作者标的，跟作者说「账上标的是小线索」（长篇实跑）。
    ...(thread.weight === "major" || thread.weight === "minor" ? { weight: thread.weight } : {}),
    firstSeenChapter: thread.firstSeenChapter,
  };
}

function toArcGoalOverview(goal: ArcGoal): StateOverviewArcGoalItem {
  return {
    id: goal.id,
    title: truncate(goal.title),
    status: goal.status,
    progress: goal.scope,
    lastTouchedChapter: goal.lastTouchedChapter,
  };
}

function toTimelineOverview(event: TimelineEvent): StateOverviewTimelineEvent {
  const semantic = readSemanticSummary(event);
  return {
    chapter: event.chapter,
    summary: truncate(event.summary),
    ...(typeof semantic?.chapterTitle === "string" ? { title: truncate(semantic.chapterTitle, 80) } : {}),
    ...(typeof semantic?.mainEvent === "string" ? { mainEvent: truncate(semantic.mainEvent) } : {}),
    ...(Array.isArray(semantic?.locations) && typeof semantic.locations[0] === "string" ? { location: truncate(semantic.locations[0], 80) } : {}),
  };
}


async function readJsonSafe<T>(
  projectDir: string,
  relativePath: string,
  fallback: T,
  onCorrupt?: (relativePath: string) => void,
): Promise<T> {
  try {
    return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as T;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return fallback;
    // 审计 Low：损坏 JSON 回落 fallback 保留（读侧不堵），但必须留痕——否则面板把「坏」显示成
    // 「空」，与写侧 fail-closed（commit 报「读取伏笔池失败」）跨视图矛盾，用户会被误导去补资料。
    if (error instanceof SyntaxError) {
      onCorrupt?.(relativePath);
      return fallback;
    }
    throw error;
  }
}

function inferCurrentChapter(events: readonly TimelineEvent[]): number | null {
  const chapters = events.map((event) => event.chapter).filter((chapter) => Number.isFinite(chapter));
  return chapters.length > 0 ? Math.max(...chapters) : null;
}

function firstActiveGoal(goals: readonly ArcGoal[]): ArcGoal | undefined {
  return goals.find((goal) => goal.status === "active" || goal.status === "touched");
}

function firstOpenThread(threads: readonly NarrativeThread[]): NarrativeThread | undefined {
  return threads.find((thread) => thread.status === "open" || thread.status === "touched");
}

function buildWarnings(input: {
  readonly threadPool: ThreadPool;
  readonly arcGoalPool: ArcGoalPool;
  readonly cleanupVisibleCount: number;
}): readonly string[] {
  const warnings: string[] = [];
  if (input.threadPool.threads.filter((thread) => thread.status === "open").length > 30) warnings.push("many_open_threads");
  if (input.cleanupVisibleCount > 0) warnings.push("cleanup_candidates_visible");
  if (!input.arcGoalPool.goals.some((goal) => goal.status === "active" || goal.status === "touched")) warnings.push("no_active_arc_goals");
  return warnings;
}

// 当前地点：取最近一章记账声明的地点（模型声明的 semanticSummary.locations），
// 优先登记在地点卡上的（地名或楼层 / 房间 / 出入口原样对得上）；对不上就取声明的第一个。

function readSemanticSummary(event: TimelineEvent): Record<string, unknown> | undefined {
  const effects = event.effects;
  if (typeof effects !== "object" || effects === null) return undefined;
  const semantic = effects.semanticSummary;
  return typeof semantic === "object" && semantic !== null ? semantic as Record<string, unknown> : undefined;
}

function firstText(values: readonly (string | undefined)[]): string | undefined {
  return values.find(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}


function truncate(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value : "";
  const trimmed = text.replace(/\s+/gu, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter(isNonEmptyString)));
}
