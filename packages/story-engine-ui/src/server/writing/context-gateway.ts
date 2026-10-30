import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildChapterPlanSection, collectPlanEntityTerms, collectPlanRetrievalTerms, type ChapterPlan } from "../book/chapter-plan.js";
import { planClock, previousPresentChapter, unknownDayWhy } from "../book/story-timeline.js";
import { findEarlierPassages, type EarlierPassage } from "./earlier-passages.js";
import { formatStaleGoalMessage, formatStaleThreadMessage } from "./stale-messages.js";
import { chaptersSinceTouched, shouldRemindStaleAt } from "./stale-reminder-policy.js";
import { describeErrorBriefly, readProject } from "../book/project-store.js";
import { shortChapters, shortChaptersText, type ShortChapter } from "../book/ledger-short.js";
import { readStoryViews, type StoryViews } from "../book/story-views.js";
import { daysText, parseDraftFile, readDraftState, selectRelevant, threadUnknownChapters, timelineTable, type BookProjection } from "@actalk/story-core";
import { readChapterTitles } from "../book/chapter-titles.js";
import { estimateTokens } from "../../lib/estimate-tokens.js";
import { buildTimelineLayers } from "../book/timeline-layers.js";
import { buildWritingContextPack, type WritingContextPack } from "./writing-context-pack.js";
import { resolveInSceneCharacters } from "./presence/in-scene-detector.js";

// token 估算前后端共用一份（src/lib/estimate-tokens.ts，纯函数）。
export { estimateTokens };
import type { ArcGoal, NarrativeThread, TimelineEvent } from "../book/types.js";

export interface ContextSection {
  readonly name: string;
  readonly content: unknown;
  readonly tokenEstimate: number;
  readonly cachePolicy: "stable" | "dynamic";
}

export interface StoryContinuityContext {
  readonly recentEvents: readonly string[];
  readonly openLeads: readonly string[];
  readonly activeConflicts: readonly string[];
  readonly discoveries: readonly string[];
  readonly recentLocations: readonly string[];
  readonly recentCharacters: readonly string[];
  readonly carryForwardInstruction: string;
}

export interface PreviousUncommittedDraftContext {
  readonly kind: "working_draft_context";
  readonly status: "previous_uncommitted_draft";
  readonly chapter: number;
  readonly title?: string;
  readonly excerpt: string;
  readonly continuityInstruction: string;
}

/**
 * 上一章（已定稿）正文原文（2026-10-08 写作主链重设计·阶段 1）。
 * 十章真机验收实锤：此前上一章一旦定稿，写手就只剩 3 条各 100 字的摘要——座钟被送回三次、补好的车胎
 * 第二天又瘪、同一个发现被重新发现。正文才是真值源：整章给（过长取结尾），并钉成受保护段。
 */
export interface PreviousChapterContext {
  readonly kind: "previous_chapter_text";
  readonly status: "committed";
  readonly chapter: number;
  readonly title?: string;
  readonly text: string;
  /** true = 章节过长，只给了结尾部分（开头以「（前略）」标出）。 */
  readonly truncated: boolean;
  readonly continuityInstruction: string;
}

/** 上一章正文给多少：整章不超过这个字符数就整章给，否则只给结尾 PREVIOUS_CHAPTER_TAIL_CHARS。 */
const PREVIOUS_CHAPTER_FULL_MAX_CHARS = 6000;
const PREVIOUS_CHAPTER_TAIL_CHARS = 5000;

export interface StoryThreadsContext {
  readonly openLeads: readonly StoryThreadContextItem[];
  readonly openIntents: readonly StoryThreadContextItem[];
  readonly recentlyTouchedThreads: readonly StoryThreadContextItem[];
  readonly staleThreadWarnings: readonly {
    readonly id: string;
    readonly type: "lead" | "intent";
    readonly title: string;
    readonly lastTouchedChapter: number;
    readonly chaptersSinceTouched: number;
    readonly message: string;
  }[];
  readonly threadCarryForwardInstruction: string;
}

export interface ArcGoalsContext {
  readonly activeGoals: readonly ArcGoalContextItem[];
  readonly recentlyTouchedGoals: readonly ArcGoalContextItem[];
  readonly staleGoalWarnings: readonly {
    readonly id: string;
    readonly title: string;
    readonly lastTouchedChapter: number;
    readonly chaptersSinceTouched: number;
    readonly message: string;
  }[];
  readonly arcCarryForwardInstruction: string;
}

export interface ArcGoalContextItem {
  readonly id: string;
  readonly title: string;
  readonly status: ArcGoal["status"];
  readonly scope: ArcGoal["scope"];
  readonly lastTouchedChapter: number;
  readonly evidence: readonly string[];
  readonly nextActionHint?: string;
  readonly relatedHooks: readonly string[];
  readonly relatedThreads: readonly string[];
  readonly relatedLocations: readonly string[];
  readonly relatedCharacters: readonly string[];
}

export interface StoryThreadContextItem {
  readonly id: string;
  readonly type: "lead" | "intent";
  readonly title: string;
  readonly status: NarrativeThread["status"];
  readonly lastTouchedChapter: number;
  readonly evidence: readonly string[];
  readonly nextActionHint?: string;
  readonly relatedLocations: readonly string[];
  readonly relatedCharacters: readonly string[];
}

export interface WriterContextEnvelope {
  readonly projectId: string;
  readonly chapter: number;
  readonly sections: readonly ContextSection[];
  readonly trace: {
    readonly sectionNames: readonly string[];
    readonly totalTokenEstimate: number;
    readonly stableTokenEstimate: number;
    readonly dynamicTokenEstimate: number;
    readonly selectedCharacters: readonly string[];
    readonly selectedTimelineEvents: readonly string[];
  };
}

export type { WritingContextPack } from "./writing-context-pack.js";

export interface BuildWriterContextInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal: string;
  /** 本章要带的人物（名字）；不给就按在场检测挑。 */
  readonly selectedCharacters?: readonly string[];
  /**
   * `timeline_events` 段（可裁段）取最近 N 条（默认 5）。
   * 注意 `writing_context_pack` 是受保护段，包内时间线摘要另有自限（≤3 条，
   * 见 BuildWritingContextPackInput.maxTimelineEvents）——这里传大值只放大可裁段，不会顶爆保护段。
   */
  readonly maxTimelineEvents?: number;
  readonly mustHitBeats?: readonly string[];
  /**
   * 本章章纲（阶段 2「先想后写」）。给了就：① 章纲进受保护段 chapter_plan；② 按它点名的物件/地点翻旧章原文
   * 进受保护段 earlier_passages；③ 按它的检索词挑旧事实；④ 它定的开场地点算本章地点。不给 = 旧行为。
   */
  readonly chapterPlan?: ChapterPlan;
  /**
   * 这一章上一稿核账核出的「确定」对不上（错在本章的）：重写时交给写手，别再照着写错
   * （长篇连写：章纲带着「三楼走廊」，重写沿用章纲又写了一遍）。
   */
  readonly lastDraftConflicts?: readonly LastDraftConflict[];
}

/** 上一稿的一处错：写成了 wrote，和 where 的 against 对不上（why）。 */
export interface LastDraftConflict {
  readonly wrote: string;
  readonly against: string;
  readonly where: string;
  readonly why: string;
}

export async function buildWriterContext(input: BuildWriterContextInput): Promise<WriterContextEnvelope> {
  const project = await readProject(input.projectDir);
  // P2 铁律④（永不静默）：账读坏了曾静默降级为 [] ——模型拿到「空历史」却毫无知觉，会把已写过的章节
  // 当没发生过。降级仍要做（不能让一次坏读盘炸掉整次出稿），但失败原因必须进上下文，让模型知道并如实转达用户。
  const readFailures: string[] = [];
  const trackReadFailure = (label: string) => (error: unknown) => {
    // 只给 errno code/错误类型 + 项目内相对文件名——error.message 原文带本地绝对路径，不进上下文（路径泄漏纪律）。
    readFailures.push(`${label}读取失败（${describeErrorBriefly(error, input.projectDir)}），已降级为空。`);
  };
  // 设定和账（线索、目标、各章事件、时间线）从同一份快照现算：读一次、下游共用；读坏了按空降级 + 留痕
  // （不炸掉整次出稿），只记这一条，不让在场检测、上下文包各自再读一遍、把同一个原因记成三条。
  const views = await readStoryViews(input.projectDir)
    .catch((error) => { trackReadFailure("设定本和账")(error); return undefined as StoryViews | undefined; });
  const bible = views ? { projection: views.projection, bible: views.bible } : undefined;
  const selectedCharacters = input.selectedCharacters && input.selectedCharacters.length > 0
    ? [...input.selectedCharacters]
    // 设定本没读出来：没有可挑的人（原因已在上面那条），不再去读第二遍。
    : bible
      ? [...(await resolveInSceneCharacters({
        projectDir: input.projectDir,
        chapter: input.chapter,
        chapterGoal: input.chapterGoal,
        bible,
      }).catch((error: unknown) => {
        trackReadFailure("本章在场人物")(error);
        return { selected: [] as readonly string[] };
      })).selected]
      : [];
  const [previousUncommittedDraft, previousChapter, existingChapterTitles] = await Promise.all([
    readPreviousUncommittedDraftContext(input.projectDir, input.chapter),
    readPreviousChapterContext(input.projectDir, input.chapter)
      .catch((error) => { trackReadFailure("上一章正文")(error); return undefined; }),
    // 已有各章标题（R7.7·报告 5：拟标题防重名，第 7、9 章都叫「铁丝」）。读不到按空（不出段），不炸出稿。
    readChapterTitles(input.projectDir, input.chapter)
      .catch(() => [] as readonly { chapter: number; title: string }[]),
  ]);
  const threadPool = views?.threads ?? { threads: [] };
  const arcGoalPool = views?.goals ?? { goals: [] };
  const allTimelineEvents = views?.events ?? [];
  // 前面账没记全的章（写作版本 P2b 设计 3.3）：如实告诉写手账里缺那几章。
  const shortBefore = shortChapters(views?.projection.chapters ?? [], input.chapter);
  const plan = input.chapterPlan;
  const storyClock = plan && views ? planClock(views.projection, input.chapter, { ...plan, ...(plan.scene.time ? { time: plan.scene.time } : {}) }) : undefined;
  const earlierPassages = plan
    ? await findEarlierPassages({
      projectDir: input.projectDir,
      chapter: input.chapter,
      terms: collectPlanEntityTerms(plan),
      // 上一章已整章给出，不重复翻。
      excludeChapters: [input.chapter - 1],
    }).catch((error) => { trackReadFailure("旧章原文")(error); return [] as readonly EarlierPassage[]; })
    : [];
  const timelineEvents = selectRecentTimelineEvents(allTimelineEvents, input.maxTimelineEvents);
  const storyContinuity = buildStoryContinuityContext(timelineEvents);
  // 线索账没记全的章不数进「多少章没动」（和核心投影同一把尺子）。
  const threadUnknown = threadUnknownChapters(views?.projection.chapters ?? []);
  const arcGoals = buildArcGoalsContext(arcGoalPool.goals, input.chapter, threadUnknown, input.chapterGoal, selectedCharacters);
  const storyThreads = buildStoryThreadsContext(threadPool.threads, input.chapter, threadUnknown, storyContinuity, arcGoals, input.chapterGoal, selectedCharacters);
  const writingContextPack = await buildWritingContextPack({
    projectDir: input.projectDir,
    chapter: input.chapter,
    userDirection: input.chapterGoal,
    currentChapterGoal: input.chapterGoal,
    selectedCharacters,
    views: views ?? null,
    maxTimelineEvents: input.maxTimelineEvents,
    ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
    ...(previousChapter?.text ?? previousUncommittedDraft?.excerpt
      ? { continuityText: previousChapter?.text ?? previousUncommittedDraft?.excerpt }
      : {}),
    ...(plan ? { retrievalTerms: collectPlanRetrievalTerms(plan) } : {}),
    ...(plan?.scene.location ? { plannedLocation: plan.scene.location } : {}),
  });
  // 包内台账读盘失败（损坏 JSON 降级）与本层失败同一通道上浮——都进 read_failures 段。
  readFailures.push(...writingContextPack.readFailures);
  // 早期宏事件分层摘要（L2 中段 + L3 远期），让出稿上下文能看见早期内容
  const timelineLayers = buildTimelineLayers(allTimelineEvents, input.chapter);
  const hasEarlierContent = timelineLayers.l2.length > 0 || timelineLayers.l3.length > 0;
  const sections = [
    section("chapter_goal", { chapter: input.chapter, goal: input.chapterGoal }, "dynamic"),
    ...(existingChapterTitles.length > 0 ? [section("chapter_titles", {
      instruction: "这些是本书已有各章的标题（含尚未定稿的工作稿）。给本章起标题时不要与它们重名。",
      titles: existingChapterTitles,
    }, "dynamic")] : []),
    ...(plan ? [section("chapter_plan", buildChapterPlanSection(plan, storyClock), "dynamic")] : []),
    ...(input.lastDraftConflicts && input.lastDraftConflicts.length > 0 ? [section("last_draft_conflicts", {
      instruction: "这一章上一稿核账核出这些和前文、设定对不上的写法。这次别再这样写，以前文和设定为准；章纲要点里的说法和它们冲突时，也以前文和设定为准。",
      conflicts: input.lastDraftConflicts,
    }, "dynamic")] : []),
    ...(previousChapter ? [section("previous_chapter", previousChapter, "dynamic")] : []),
    ...(previousUncommittedDraft ? [section("previous_uncommitted_draft", previousUncommittedDraft, "dynamic")] : []),
    ...(earlierPassages.length > 0
      ? [section("earlier_passages", {
        instruction: "这些是前面章节里写到本章涉及的物件/地点时的原文。它们现在的样子、位置、上面写着什么，以原文为准；本章不要写出与之矛盾的说法，也不要把已经写过的发现再发现一遍。",
        passages: earlierPassages.map((item) => ({ chapter: item.chapter, about: item.term, text: item.text })),
      }, "dynamic")]
      : []),
    section("writing_context_pack", writingContextPack satisfies WritingContextPack, "dynamic"),
    section("story_calendar", { currentStoryDay: currentStoryDayOf(views?.projection, input.chapter) }, "dynamic"),
    ...(shortBefore.length > 0
      ? [section("ledger_pending", {
        chapters: shortBefore.map((item) => item.chapter),
        note: `${shortChaptersText(shortBefore, Number.POSITIVE_INFINITY)}：那几章出了什么事、谁在场、线索怎么动的、是哪天，账里没有或不全；要接的地方以那几章正文为准，别当成什么都没发生。`,
      }, "dynamic")]
      : []),
    section("story_threads", storyThreads, "dynamic"),
    section("arc_goals", arcGoals, "dynamic"),
    section("story_continuity", storyContinuity, "dynamic"),
    section("timeline_events", timelineEvents.map(compactTimelineEventForWriter), "dynamic"),
    ...(hasEarlierContent ? [section("timeline_earlier_summary", { earlierSummary: timelineLayers.l2, macroSummary: timelineLayers.l3 }, "dynamic")] : []),
    // P2：坏读盘的降级原因要进上下文——模型拿到空历史时知道自己正盲写，并如实告知用户
    ...(readFailures.length > 0 ? [section("read_failures", { failures: readFailures }, "dynamic")] : []),
  ] as const;
  const totalTokenEstimate = sections.reduce((sum, item) => sum + item.tokenEstimate, 0);
  const stableTokenEstimate = sections
    .filter((item) => item.cachePolicy === "stable")
    .reduce((sum, item) => sum + item.tokenEstimate, 0);
  const dynamicTokenEstimate = totalTokenEstimate - stableTokenEstimate;

  return {
    projectId: project.id,
    chapter: input.chapter,
    sections,
    trace: {
      sectionNames: sections.map((item) => item.name),
      totalTokenEstimate,
      stableTokenEstimate,
      dynamicTokenEstimate,
      selectedCharacters,
      selectedTimelineEvents: timelineEvents.map((event) => event.id),
    },
  };
}

async function readPreviousUncommittedDraftContext(
  projectDir: string,
  chapter: number,
): Promise<PreviousUncommittedDraftContext | undefined> {
  if (chapter <= 1) return undefined;
  const previousChapter = chapter - 1;
  const committedPath = join(projectDir, "chapters", `${padChapter(previousChapter)}.md`);
  const committedContent = await readFile(committedPath, "utf-8").catch((error: unknown) => {
    // 审计 Low：只把「确实没有入库章」（ENOENT）当未入库——权限/IO 错误误判会向写手注入
    // 「上一章尚未正式入库、以工作稿为准」的错误前情指令。其它错误返回 null：同样跳过本段（不注入指令）。
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  });
  if (committedContent !== undefined) return undefined;

  // 前一章没定稿：它的工作稿当前情（不在真相依据里；换上前出稿服务按开写时拍的那份核，见 book/material-reads）。
  const draft = await readDraftState(projectDir, previousChapter).catch(() => undefined);
  if (!draft) return undefined;
  // 文件原文只经核心 parseDraftFile 拆一次（写作版本 P1 第 15 轮 AC2：自己写的正则会把正文开头的小节当章名吃掉）。
  const { title, body } = parseDraftFile(draft.file?.text ?? "");
  if (!body.trim()) return undefined;

  return {
    kind: "working_draft_context",
    status: "previous_uncommitted_draft",
    chapter: previousChapter,
    ...(title ? { title } : {}),
    // 接着写要的是上一章怎么收尾：过长时取结尾而不是开头（旧版取开头 1800 字，结尾场面恰恰看不见）。
    excerpt: previousChapterExcerpt(body).text,
    continuityInstruction: [
      `第 ${previousChapter} 章尚未正式入库，但它是当前写作区保存的上一章工作稿。`,
      "生成本章时必须把它当作直接前情依据：保持主角身份、称谓、人称、地点承接、已出现物件和未解决压力一致。",
      "不要因为正式 timeline 还没有该章而重启剧情或改写主角设定。",
    ].join(""),
  };
}

/**
 * 上一章已定稿时给它的正文原文（整章，过长取结尾）。没有上一章 / 上一章没定稿（ENOENT）→ undefined
 * （未定稿走 readPreviousUncommittedDraftContext）；其它读盘错误上抛，由调用方降级 + 进 read_failures。
 */
async function readPreviousChapterContext(
  projectDir: string,
  chapter: number,
): Promise<PreviousChapterContext | undefined> {
  if (chapter <= 1) return undefined;
  const previousChapter = chapter - 1;
  const committedPath = join(projectDir, "chapters", `${padChapter(previousChapter)}.md`);
  let content: string;
  try {
    content = await readFile(committedPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const { title, body } = parseDraftFile(content);
  if (!body.trim()) return undefined;
  const { text, truncated } = previousChapterExcerpt(body);
  return {
    kind: "previous_chapter_text",
    status: "committed",
    chapter: previousChapter,
    ...(title ? { title } : {}),
    text,
    truncated,
    continuityInstruction: [
      `这是第 ${previousChapter} 章（上一章，已定稿）的正文原文${truncated ? "（结尾部分）" : ""}。本章紧接着它往下写。`,
      "时间、地点、各人物此刻在哪、手里拿着什么、物件现在什么状态（修没修好、放在哪、上面写着什么）、谁已经知道了什么，一律以这段原文为准。",
      "上一章已经发现、说过、做完的事，本章不要再重新发现一遍或重做一遍；要往前推进新的事。",
    ].join(""),
  };
}

/** 整章不长就整章给；过长取结尾（从段落边界切），开头标「（前略）」。 */
function previousChapterExcerpt(body: string): { readonly text: string; readonly truncated: boolean } {
  const trimmed = body.trim();
  if (trimmed.length <= PREVIOUS_CHAPTER_FULL_MAX_CHARS) return { text: trimmed, truncated: false };
  const tail = trimmed.slice(-PREVIOUS_CHAPTER_TAIL_CHARS);
  const paragraphStart = tail.indexOf("\n");
  const fromParagraph = paragraphStart >= 0 && paragraphStart < 400 ? tail.slice(paragraphStart + 1) : tail;
  return { text: `（前略）\n${fromParagraph.trim()}`, truncated: true };
}

function padChapter(chapter: number): string {
  return String(chapter).padStart(4, "0");
}

function section(name: string, content: unknown, cachePolicy: "stable" | "dynamic"): ContextSection {
  return {
    name,
    content,
    tokenEstimate: estimateTokens(content),
    cachePolicy,
  };
}

function buildStoryThreadsContext(
  threads: readonly NarrativeThread[],
  chapter: number,
  threadUnknown: readonly number[],
  storyContinuity?: StoryContinuityContext,
  arcGoals?: ArcGoalsContext,
  chapterGoal?: string,
  relevantCharacterIds?: readonly string[],
): StoryThreadsContext {
  // Build relevanceGoal for continuity/arcGoal keyword matching
  const relevanceGoal = [
    chapterGoal,
    ...(storyContinuity ? [...storyContinuity.openLeads, ...storyContinuity.activeConflicts, ...storyContinuity.discoveries, ...storyContinuity.recentLocations] : []),
    ...(arcGoals ? arcGoals.activeGoals.flatMap((g) => [g.title, g.nextActionHint ?? "", ...g.relatedLocations]) : []),
  ].filter(Boolean).join(" ");

  const ranked = selectRelevant({
    items: threads.map((t) => ({ ...t, text: threadSearchText(t) })),
    chapter,
    chapterGoal: relevanceGoal,
    relevantCharacterIds,
    closedStatuses: ["done", "stale"],
  }).selected;

  const openLeads = ranked.filter((thread) => thread.type === "lead").slice(0, 8).map(compactThread);
  const openIntents = ranked.filter((thread) => thread.type === "intent").slice(0, 8).map(compactThread);
  // 最近碰过的：只给上面两组里没有的（原来直接取排名前 5，和 openLeads / openIntents 重复，整段多出一倍）。
  const listed = new Set([...openLeads, ...openIntents].map((thread) => thread.id));
  const recentlyTouchedThreads = ranked.filter((thread) => !listed.has(thread.id)).slice(0, 5).map(compactThread);
  // r7 里程碑制（镜像 lead-intent-tracking.findStaleThreadWarnings）：新停滞头两章提醒、长期停滞每 10 章重提。
  const staleThreadWarnings = ranked
    .map((thread) => ({
      thread,
      chaptersSinceTouched: chaptersSinceTouched(thread.lastTouchedChapter, chapter, threadUnknown),
    }))
    .filter((entry) => shouldRemindStaleAt(entry.chaptersSinceTouched, 3))
    .sort((left, right) => right.chaptersSinceTouched - left.chaptersSinceTouched)
    .slice(0, 5)
    .map(({ thread, chaptersSinceTouched }) => ({
      id: thread.id,
      type: thread.type,
      title: thread.title,
      lastTouchedChapter: thread.lastTouchedChapter,
      chaptersSinceTouched,
      message: formatStaleThreadMessage({
        type: thread.type,
        title: thread.title,
        lastTouchedChapter: thread.lastTouchedChapter,
        chaptersSinceTouched,
      }),
    }));
  return {
    openLeads,
    openIntents,
    recentlyTouchedThreads,
    staleThreadWarnings,
    threadCarryForwardInstruction: buildThreadCarryForwardInstruction(openLeads, openIntents),
  };
}

function threadSearchText(thread: NarrativeThread): string {
  return [thread.title, thread.nextActionHint, ...(thread.evidence ?? []), ...(thread.relatedLocations ?? [])]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function compactThread(thread: NarrativeThread): StoryThreadContextItem {
  return {
    id: thread.id,
    type: thread.type,
    title: thread.title,
    status: thread.status,
    lastTouchedChapter: thread.lastTouchedChapter,
    evidence: limitText(thread.evidence, 2, 100),
    ...(thread.nextActionHint ? { nextActionHint: truncateText(thread.nextActionHint, 100) } : {}),
    relatedLocations: limitText(uniqueText(thread.relatedLocations ?? []), 5, 30),
    relatedCharacters: limitText(uniqueText(thread.relatedCharacters ?? []), 5, 30),
  };
}

function buildThreadCarryForwardInstruction(
  openLeads: readonly StoryThreadContextItem[],
  openIntents: readonly StoryThreadContextItem[],
): string {
  const titles = [...openLeads, ...openIntents].slice(0, 5).map((thread) => thread.title);
  if (titles.length === 0) return "";
  return truncateText(`下一章优先处理未完成线索/意图：${titles.join("、")}。不要重新开局。`, 140);
}

function arcGoalSearchText(goal: ArcGoal): string {
  return [goal.title, goal.nextActionHint, ...(goal.evidence ?? []), ...(goal.relatedLocations ?? [])]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function buildArcGoalsContext(goals: readonly ArcGoal[], chapter: number, threadUnknown: readonly number[], chapterGoal?: string, relevantCharacterIds?: readonly string[]): ArcGoalsContext {
  const activeGoals = selectRelevant({
    items: goals
      .filter((goal) => goal.status === "active" || goal.status === "touched")
      .map((goal) => ({ ...goal, text: arcGoalSearchText(goal) })),
    chapter,
    chapterGoal,
    relevantCharacterIds,
    closedStatuses: [],
  }).selected.slice(0, 6).map(compactGoal);
  // 最近碰过的目标：只给 activeGoals 里没有的（多半是刚完成的）；原来和 activeGoals 是同一批，整段重复一遍。
  const activeIds = new Set(activeGoals.map((goal) => goal.id));
  const recentlyTouchedGoals = [...goals]
    .filter((goal) => !activeIds.has(goal.id))
    .sort(compareGoalRecency)
    .slice(0, 4)
    .map(compactGoal);
  // r7 里程碑制（镜像 arc-goal-tracking.findStaleGoalWarnings）：主线停滞用升级文案，写手每章都能看到最该救的目标。
  const staleGoalWarnings = goals
    .filter((goal) => goal.status === "active" || goal.status === "touched")
    .map((goal) => ({
      goal,
      chaptersSinceTouched: chaptersSinceTouched(goal.lastTouchedChapter, chapter, threadUnknown),
    }))
    .filter((entry) => shouldRemindStaleAt(entry.chaptersSinceTouched, 5))
    .sort((left, right) => right.chaptersSinceTouched - left.chaptersSinceTouched)
    .slice(0, 5)
    .map(({ goal, chaptersSinceTouched }) => ({
      id: goal.id,
      title: goal.title,
      lastTouchedChapter: goal.lastTouchedChapter,
      chaptersSinceTouched,
      message: formatStaleGoalMessage({
        title: goal.title,
        scope: goal.scope,
        lastTouchedChapter: goal.lastTouchedChapter,
        chaptersSinceTouched,
      }),
    }));
  return {
    activeGoals,
    recentlyTouchedGoals,
    staleGoalWarnings,
    arcCarryForwardInstruction: buildArcCarryForwardInstruction(activeGoals),
  };
}

function compareGoalRecency(left: ArcGoal, right: ArcGoal): number {
  return right.lastTouchedChapter - left.lastTouchedChapter || left.id.localeCompare(right.id);
}

function compactGoal(goal: ArcGoal): ArcGoalContextItem {
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    scope: goal.scope,
    lastTouchedChapter: goal.lastTouchedChapter,
    evidence: limitText(goal.evidence, 2, 100),
    ...(goal.nextActionHint ? { nextActionHint: truncateText(goal.nextActionHint, 100) } : {}),
    relatedHooks: limitText(uniqueText(goal.relatedHooks ?? []), 5, 30),
    relatedThreads: limitText(uniqueText(goal.relatedThreads ?? []), 5, 30),
    relatedLocations: limitText(uniqueText(goal.relatedLocations ?? []), 5, 30),
    relatedCharacters: limitText(uniqueText(goal.relatedCharacters ?? []), 5, 30),
  };
}

function buildArcCarryForwardInstruction(activeGoals: readonly ArcGoalContextItem[]): string {
  if (activeGoals.length === 0) return "";
  const titles = activeGoals.slice(0, 4).map((goal) => goal.title);
  return truncateText(`当前小卷目标：${titles.join("、")}。下一章应让剧情继续朝该目标推进，但不要跳过必要过程。`, 140);
}

// 从全量 timeline 在内存里挑近 N 段（出稿上下文用）。纯函数——全量已在 buildWriterContext 读过一次，避免重复读盘。
// 本段是可裁段（ranker 可整段裁掉），吃 maxTimelineEvents 全量；受保护的 writing_context_pack 内摘要
// 另自限 ≤3 条。两侧排序键同口径（章号→同章 id），选出的「最近 N 条」集合一致（2026-09-15 P1-7 对齐）。
/**
 * 给写手看的近几章事件：只留这章发生了什么（主事件、关键事件前三条、发现、决定、冲突、出场的人）。
 * 原来整条事件原样给，带着整份语义摘要（章节全文摘要、提到的伏笔 id……），一条 1 千多字，
 * 而上一章全文、前情承接段里已经有这些信息（2026-10-10 引擎升级第 4 期：《梧桐街九号》这一段 2.9K token）。
 */
function compactTimelineEventForWriter(event: TimelineEvent): Record<string, unknown> {
  const semantic = readSemanticSummary(event);
  const keyEvents = Array.isArray((semantic as { keyEvents?: unknown } | undefined)?.keyEvents)
    ? ((semantic as { keyEvents: unknown[] }).keyEvents).filter((item): item is string => typeof item === "string").slice(0, 3).map((item) => truncateText(item, 80))
    : [];
  const names = semantic?.mentionedCharacterNames;
  return {
    chapter: event.chapter,
    summary: truncateText(event.summary, 120),
    ...(semantic?.mainEvent && semantic.mainEvent !== event.summary ? { mainEvent: truncateText(semantic.mainEvent, 120) } : {}),
    ...(keyEvents.length > 0 ? { keyEvents } : {}),
    ...(semantic?.discovery ? { discovery: truncateText(semantic.discovery, 100) } : {}),
    ...(semantic?.decision ? { decision: truncateText(semantic.decision, 100) } : {}),
    ...(semantic?.conflict ? { conflict: truncateText(semantic.conflict, 100) } : {}),
    ...(Array.isArray(names) && names.length > 0 ? { characters: names.filter((name): name is string => typeof name === "string").slice(0, 8) } : {}),
  };
}

function selectRecentTimelineEvents(events: readonly TimelineEvent[], maxTimelineEvents: number | undefined): readonly TimelineEvent[] {
  const limit = Math.max(0, Math.trunc(maxTimelineEvents ?? 5));
  if (limit === 0) return [];
  return [...events]
    .sort((left, right) => right.chapter - left.chapter || right.id.localeCompare(left.id))
    .slice(0, limit)
    .reverse();
}

function buildStoryContinuityContext(timelineEvents: readonly TimelineEvent[]): StoryContinuityContext {
  const recentEvents = [...timelineEvents]
    .sort((left, right) => right.chapter - left.chapter || right.id.localeCompare(left.id))
    .slice(0, 3);
  // 账没记全的章带上章号（几章都没梗概时分得清是哪章），不当成什么都没发生。
  const summaries = recentEvents.map((event) => (event.ledgerShort ? `第 ${event.chapter} 章：${event.summary}` : readSemanticSummary(event)?.mainEvent ?? event.summary));
  const openLeads = recentEvents.map((event) => readSemanticSummary(event)?.nextLead);
  const activeConflicts = recentEvents.map((event) => readSemanticSummary(event)?.conflict);
  const discoveries = recentEvents.map((event) => readSemanticSummary(event)?.discovery);
  const recentLocations = recentEvents.flatMap((event) => readSemanticSummary(event)?.locations ?? []);
  const recentCharacters = recentEvents.flatMap((event) => readSemanticSummary(event)?.mentionedCharacterNames ?? []);

  const continuity: StoryContinuityContext = {
    recentEvents: limitText(uniqueText(summaries), 3, 100),
    openLeads: limitText(uniqueText(openLeads), 3, 100),
    activeConflicts: limitText(uniqueText(activeConflicts), 3, 100),
    discoveries: limitText(uniqueText(discoveries), 3, 100),
    recentLocations: limitText(uniqueText(recentLocations), 8, 30),
    recentCharacters: limitText(uniqueText(recentCharacters), 8, 30),
    carryForwardInstruction: "",
  };
  return {
    ...continuity,
    carryForwardInstruction: buildCarryForwardInstruction(continuity, recentEvents[0]?.ledgerShort ? { chapter: recentEvents[0].chapter, status: recentEvents[0].ledgerShort } : undefined),
  };
}

function readSemanticSummary(event: TimelineEvent): Partial<{
  readonly mainEvent: string;
  readonly conflict: string;
  readonly discovery: string;
  readonly decision: string;
  readonly nextLead: string;
  readonly locations: readonly string[];
  readonly mentionedCharacterNames: readonly string[];
}> | undefined {
  const candidate = event.effects?.semanticSummary;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as Partial<{
    readonly mainEvent: string;
    readonly conflict: string;
    readonly discovery: string;
    readonly decision: string;
    readonly nextLead: string;
    readonly locations: readonly string[];
    readonly mentionedCharacterNames: readonly string[];
  }>;
}

/** pendingNewest：最近那章的账还没记上（梗概、线索都给不出）：承接它的正文，不拿更早那章的事当「最近」。 */
function buildCarryForwardInstruction(context: Omit<StoryContinuityContext, "carryForwardInstruction">, shortNewest?: ShortChapter): string {
  if (isEmptyContinuityContext(context)) {
    return "暂无前情承接要求。";
  }
  const lead = shortNewest !== undefined
    ? `第 ${shortNewest.chapter} 章正文结尾接着的事（那章的账${shortNewest.status === "pending" ? "还没记上" : "没记全"}，以正文为准）`
    : stripTerminalPunctuation(context.openLeads[0] ?? context.recentEvents[0] ?? "最近事件");
  const conflict = stripTerminalPunctuation(context.activeConflicts[0] ?? context.discoveries[0] ?? "上一章后果");
  const locations = context.recentLocations.length > 0 ? context.recentLocations.join("、") : "暂无明确地点";
  const characters = context.recentCharacters.length > 0 ? context.recentCharacters.join("、") : "近期出场角色";
  return truncateText(
    `下一章必须承接最近未解决线索，不要重新开局。优先推进：${lead}。保持${characters}仍处于${conflict}的后续影响中。近期地点包括：${locations}。`,
    180,
  );
}

function isEmptyContinuityContext(context: Omit<StoryContinuityContext, "carryForwardInstruction">): boolean {
  return context.recentEvents.length === 0
    && context.openLeads.length === 0
    && context.activeConflicts.length === 0
    && context.discoveries.length === 0;
}

function limitText(values: readonly string[], limit: number, maxLength: number): readonly string[] {
  return values.slice(0, limit).map((value) => truncateText(value, maxLength));
}

function uniqueText(values: readonly (string | undefined)[]): readonly string[] {
  return unique(values
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0));
}

function truncateText(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`;
}

function stripTerminalPunctuation(value: string): string {
  // 不猜白名单：切句
  return value.replace(/[。！？!?；;，,、\s]+$/u, "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 故事现在到第几天：本章前面最近那个当下章的结尾（写作版本 P3a T6：不是全书最后一章——回头改前面的章、
 * 前一章整章是回忆时都不对）。不知道就如实说为什么，不按第 1 天给。
 */
function currentStoryDayOf(projection: BookProjection | undefined, chapter: number): string {
  if (!projection) return "不知道（账读不了）";
  const previous = previousPresentChapter(projection, chapter);
  if (previous === undefined) return "第 1 天（前面还没有当下线上的章）";
  if (previous === "unknown") {
    // 链断在最近那个没认出的章：说是哪章、为什么。
    const lost = timelineTable(projection, chapter - 1).filter((row) => row.presentLine === "unknown").at(-1);
    return lost ? `不知道（第 ${lost.chapter} 章：${unknownDayWhy(lost)}）` : "不知道";
  }
  if (previous.end) return `${daysText(previous.end)}（第 ${previous.chapter} 章结尾）`;
  if (previous.start) return `不知道（第 ${previous.chapter} 章从${daysText(previous.start)}开始，结尾是哪天说不准）`;
  return `不知道（第 ${previous.chapter} 章：${unknownDayWhy(previous)}）`;
}
