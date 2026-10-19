import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildChapterPlanSection, collectPlanEntityTerms, collectPlanRetrievalTerms, readStoryClock, type ChapterPlan } from "../book/chapter-plan.js";
import { findEarlierPassages, type EarlierPassage } from "./earlier-passages.js";
import { formatStaleGoalMessage, formatStaleHookMessage, formatStaleThreadMessage } from "./stale-messages.js";
import { chaptersSinceTouched, shouldRemindStaleAt } from "./stale-reminder-policy.js";
import {
  describeErrorBriefly,
  readArcGoalPool,
  readHookPool,
  readProject,
  readStoryCalendar,
  readThreadPool,
  readTimelineEvents,
} from "../book/project-store.js";
import { selectRelevant } from "@actalk/story-core";
import { estimateTokens } from "../../lib/estimate-tokens.js";
import { buildTimelineLayers } from "../book/timeline-layers.js";
import { buildWritingContextPack, type WritingContextPack } from "./writing-context-pack.js";
import { readBibleTolerant } from "./setting-pack.js";
import { resolveInSceneCharacters } from "./presence/in-scene-detector.js";

// token 估算前后端共用一份（src/lib/estimate-tokens.ts，纯函数）。
export { estimateTokens };
import type {
  ArcGoal,
  HookItem,
  NarrativeThread,
  TimelineEvent,
} from "../book/types.js";

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

export interface HookTrackingContext {
  readonly activeHooks: readonly HookTrackingContextItem[];
  readonly recentlyTouchedHooks: readonly HookTrackingContextItem[];
  readonly staleHookWarnings: readonly {
    readonly id: string;
    readonly title: string;
    readonly lastTouchedChapter: number;
    readonly chaptersSinceTouched: number;
    readonly message: string;
  }[];
  readonly hookCarryForwardInstruction: string;
}

export interface HookTrackingContextItem {
  readonly id: string;
  readonly title: string;
  readonly lastTouchedChapter?: number;
  readonly evidence: readonly string[];
  readonly nextActionHint?: string;
  readonly relatedLocations: readonly string[];
  readonly relatedCharacters: readonly string[];
}

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
    readonly selectedHooks: readonly string[];
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
  readonly selectedHookIds?: readonly string[];
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
}

export async function buildWriterContext(input: BuildWriterContextInput): Promise<WriterContextEnvelope> {
  const project = await readProject(input.projectDir);
  // P2 铁律④（永不静默）：损坏的 timeline/events.json 此前双重 catch 后静默降级为 [] ——
  // 模型拿到「空历史」却毫无知觉，会把已写过的章节当没发生过。降级仍要做（不能让一次坏读盘
  // 炸掉整次出稿），但失败原因必须进上下文，让模型知道并如实转达用户。
  const readFailures: string[] = [];
  const trackReadFailure = (label: string) => (error: unknown) => {
    // 只给 errno code/错误类型 + 项目内相对文件名——error.message 原文带本地绝对路径，不进上下文（路径泄漏纪律）。
    readFailures.push(`${label} 读取失败（${describeErrorBriefly(error, input.projectDir)}），已降级为空。`);
  };
  // 设定卡坏了按空设定降级 + 留痕（不炸掉整次出稿）。读一次、下游共用：坏了只记这一条，
  // 不让在场检测、上下文包各自再读一遍、把同一个原因记成三条。
  const read = await readBibleTolerant(input.projectDir);
  if (read.failure) readFailures.push(read.failure);
  const bible = read.projection ? { projection: read.projection, bible: read.bible } : undefined;
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
  const [calendar, hookPool, threadPool, arcGoalPool, allTimelineEvents, previousUncommittedDraft, previousChapter, existingChapterTitles] = await Promise.all([
    readStoryCalendar(input.projectDir),
    readHookPool(input.projectDir),
    readThreadPool(input.projectDir),
    readArcGoalPool(input.projectDir),
    // 全量 timeline 只读一次：近 N 段（selectRecentTimelineEvents）与早期分层（buildTimelineLayers）共用，避免重复读盘
    readTimelineEvents(input.projectDir)
      // 审计 Low：删掉「旧格式回退」第二跳——它与首读同一文件同一 JSON.parse，首读失败它必失败，
      // 永远不可能救回，只是把同一故障记两遍（且内层把权限错无痕吞成 []）。单跳：降级 + 留痕一次。
      .catch((error) => { trackReadFailure("时间线事件")(error); return [] as readonly TimelineEvent[]; }),
    readPreviousUncommittedDraftContext(input.projectDir, input.chapter),
    readPreviousChapterContext(input.projectDir, input.chapter)
      .catch((error) => { trackReadFailure("上一章正文")(error); return undefined; }),
    // 已有各章标题（R7.7·报告 5：拟标题防重名，第 7、9 章都叫「铁丝」）。读不到按空（不出段），不炸出稿。
    readExistingChapterTitles(input.projectDir, input.chapter)
      .catch(() => [] as readonly { chapter: number; title: string }[]),
  ]);
  const plan = input.chapterPlan;
  const storyClock = plan?.storyDay ? await readStoryClock(input.projectDir, input.chapter).catch(() => []) : [];
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
  const selectedHooks = selectHooks(hookPool.hooks, input.selectedHookIds);
  const hookTracking = buildHookTrackingContext(hookPool.hooks, input.chapter, input.chapterGoal, selectedCharacters);
  const arcGoals = buildArcGoalsContext(arcGoalPool.goals, input.chapter, input.chapterGoal, selectedCharacters);
  const storyThreads = buildStoryThreadsContext(threadPool.threads, input.chapter, storyContinuity, arcGoals, input.chapterGoal, selectedCharacters);
  const writingContextPack = await buildWritingContextPack({
    projectDir: input.projectDir,
    chapter: input.chapter,
    userDirection: input.chapterGoal,
    currentChapterGoal: input.chapterGoal,
    selectedCharacters,
    selectedHookIds: input.selectedHookIds,
    bible: bible ?? { bible: read.bible },
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
    ...(previousChapter ? [section("previous_chapter", previousChapter, "dynamic")] : []),
    ...(previousUncommittedDraft ? [section("previous_uncommitted_draft", previousUncommittedDraft, "dynamic")] : []),
    ...(earlierPassages.length > 0
      ? [section("earlier_passages", {
        instruction: "这些是前面章节里写到本章涉及的物件/地点时的原文。它们现在的样子、位置、上面写着什么，以原文为准；本章不要写出与之矛盾的说法，也不要把已经写过的发现再发现一遍。",
        passages: earlierPassages.map((item) => ({ chapter: item.chapter, about: item.term, text: item.text })),
      }, "dynamic")]
      : []),
    section("writing_context_pack", writingContextPack satisfies WritingContextPack, "dynamic"),
    section("story_calendar", calendar, "dynamic"),
    section("hook_pool", selectedHooks, "dynamic"),
    section("hook_tracking", hookTracking, "dynamic"),
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
      selectedHooks: selectedHooks.map((hook) => hook.id),
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

  const draftPath = join(projectDir, "drafts", "fast", `chapter-${padChapter(previousChapter)}.md`);
  const draftContent = await readFile(draftPath, "utf-8").catch(() => undefined);
  const body = stripMarkdownHeading(draftContent ?? "");
  if (!body.trim()) return undefined;
  const title = extractMarkdownTitle(draftContent);

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
  const body = stripMarkdownHeading(content);
  if (!body.trim()) return undefined;
  const title = extractMarkdownTitle(content);
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

/** 拟标题防重名时最多带多少章的已有标题（长书只看最近的，防上下文膨胀）。 */
const MAX_EXISTING_CHAPTER_TITLES = 60;

/**
 * 已有各章标题（2026-10-14 编辑部 R7.7·报告 5）：定稿章（chapters/000N.md）+ 工作稿（drafts/fast/chapter-NNNN.md），
 * 取章号最大的最近 MAX_EXISTING_CHAPTER_TITLES 章、不含本章（重写本章时不能把自己的标题当「重名」）。
 * 定稿标题优先（正稿为准），只有工作稿的章用工作稿标题；读不出标题的章跳过。纯读盘、题材中立。
 */
async function readExistingChapterTitles(
  projectDir: string,
  currentChapter: number,
): Promise<readonly { chapter: number; title: string }[]> {
  const chapters = new Set<number>();
  const [committedFiles, draftFiles] = await Promise.all([
    readdir(join(projectDir, "chapters")).catch(() => [] as string[]),
    readdir(join(projectDir, "drafts", "fast")).catch(() => [] as string[]),
  ]);
  for (const file of committedFiles) {
    const chapter = Number(/^(\d{4})\.md$/u.exec(file)?.[1]);
    if (Number.isInteger(chapter) && chapter > 0) chapters.add(chapter);
  }
  for (const file of draftFiles) {
    const chapter = Number(/^chapter-(\d{4})\.md$/u.exec(file)?.[1]);
    if (Number.isInteger(chapter) && chapter > 0) chapters.add(chapter);
  }
  const recent = [...chapters]
    .filter((chapter) => chapter !== currentChapter)
    .sort((a, b) => b - a)
    .slice(0, MAX_EXISTING_CHAPTER_TITLES);
  const withTitles = await Promise.all(recent.map(async (chapter) => {
    const [committedTitle, draftTitle] = await Promise.all([
      extractMarkdownTitle(await readFile(join(projectDir, "chapters", `${padChapter(chapter)}.md`), "utf-8").catch(() => undefined)),
      extractMarkdownTitle(await readFile(join(projectDir, "drafts", "fast", `chapter-${padChapter(chapter)}.md`), "utf-8").catch(() => undefined)),
    ]);
    const title = committedTitle ?? draftTitle;
    return title ? { chapter, title } : undefined;
  }));
  return withTitles
    .filter((item): item is { chapter: number; title: string } => item !== undefined)
    .sort((a, b) => a.chapter - b.chapter);
}

function extractMarkdownTitle(content: string | undefined): string | undefined {
  const line = content?.split(/\r?\n/u).find((item) => item.trim().startsWith("#"))?.trim();
  if (!line) return undefined;
  return line.replace(/^#+\s*/u, "").trim() || undefined;
}

function stripMarkdownHeading(content: string): string {
  return content.replace(/^#{1,6}\s+.*(?:\r?\n){1,2}/u, "").trim();
}

function section(name: string, content: unknown, cachePolicy: "stable" | "dynamic"): ContextSection {
  return {
    name,
    content,
    tokenEstimate: estimateTokens(content),
    cachePolicy,
  };
}

function selectHooks(hooks: readonly HookItem[], selectedHookIds?: readonly string[]): readonly HookItem[] {
  if (selectedHookIds && selectedHookIds.length > 0) {
    const selected = new Set(selectedHookIds);
    return hooks.filter((hook) => selected.has(hook.id));
  }
  return hooks.filter((hook) => hook.status === "seeded" || hook.status === "active");
}

function hookSearchText(hook: HookItem): string {
  return [hook.title, hook.description, ...(hook.evidence ?? []), ...(hook.relatedCharacters ?? []), ...(hook.relatedLocations ?? [])]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function buildHookTrackingContext(hooks: readonly HookItem[], chapter: number, chapterGoal?: string, relevantCharacterIds?: readonly string[]): HookTrackingContext {
  const activeHooks = selectRelevant({
    items: hooks
      .filter((hook) => hook.status === "active")
      .map((hook) => ({ ...hook, text: hookSearchText(hook) })),
    chapter,
    chapterGoal,
    relevantCharacterIds,
    closedStatuses: [],
  }).selected.slice(0, 8).map(compactHook);
  const recentlyTouchedHooks = hooks
    .filter((hook) => hook.lastTouchedChapter !== undefined)
    .sort(compareHookRecency)
    .slice(0, 5)
    .map(compactHook);
  // r7 里程碑制（镜像 hook-tracking.findStaleHookWarnings）：写手上下文同样不再每章重复灌同一批停滞告警。
  const staleHookWarnings = hooks
    .filter((hook) => hook.status === "active")
    .filter((hook) => hook.lastTouchedChapter !== undefined)
    .map((hook) => ({
      hook,
      chaptersSinceTouched: chaptersSinceTouched(hook.lastTouchedChapter, chapter),
    }))
    .filter((entry) => shouldRemindStaleAt(entry.chaptersSinceTouched, 3))
    .sort((left, right) => right.chaptersSinceTouched - left.chaptersSinceTouched)
    .slice(0, 5)
    .map(({ hook, chaptersSinceTouched }) => ({
      id: hook.id,
      title: hook.title,
      lastTouchedChapter: hook.lastTouchedChapter!,
      chaptersSinceTouched,
      message: formatStaleHookMessage({
        title: hook.title,
        lastTouchedChapter: hook.lastTouchedChapter!,
        chaptersSinceTouched,
      }),
    }));
  return {
    activeHooks,
    recentlyTouchedHooks,
    staleHookWarnings,
    hookCarryForwardInstruction: buildHookCarryForwardInstruction(activeHooks),
  };
}

function compareHookRecency(left: HookItem, right: HookItem): number {
  const leftChapter = left.lastTouchedChapter ?? left.firstSeenChapter ?? 0;
  const rightChapter = right.lastTouchedChapter ?? right.firstSeenChapter ?? 0;
  return rightChapter - leftChapter || left.id.localeCompare(right.id);
}

function compactHook(hook: HookItem): HookTrackingContextItem {
  return {
    id: hook.id,
    title: hook.title,
    ...(hook.lastTouchedChapter !== undefined ? { lastTouchedChapter: hook.lastTouchedChapter } : {}),
    evidence: limitText(hook.evidence ?? [hook.description], 2, 100),
    ...(hook.nextActionHint ? { nextActionHint: truncateText(hook.nextActionHint, 100) } : {}),
    relatedLocations: limitText(uniqueText(hook.relatedLocations ?? []), 5, 30),
    relatedCharacters: limitText(uniqueText(hook.relatedCharacters ?? []), 5, 30),
  };
}

function buildHookCarryForwardInstruction(activeHooks: readonly HookTrackingContextItem[]): string {
  if (activeHooks.length === 0) return "";
  const titles = activeHooks.slice(0, 5).map((hook) => hook.title).join("、");
  return truncateText(`下一章可优先自然推进这些伏笔，但不要一次性全部解开：${titles}。`, 120);
}

function buildStoryThreadsContext(
  threads: readonly NarrativeThread[],
  chapter: number,
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
      chaptersSinceTouched: chaptersSinceTouched(thread.lastTouchedChapter, chapter),
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

function buildArcGoalsContext(goals: readonly ArcGoal[], chapter: number, chapterGoal?: string, relevantCharacterIds?: readonly string[]): ArcGoalsContext {
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
      chaptersSinceTouched: chaptersSinceTouched(goal.lastTouchedChapter, chapter),
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
  const summaries = recentEvents.map((event) => {
    const semanticSummary = readSemanticSummary(event);
    return semanticSummary?.mainEvent ?? event.summary;
  });
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
    carryForwardInstruction: buildCarryForwardInstruction(continuity),
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

function buildCarryForwardInstruction(context: Omit<StoryContinuityContext, "carryForwardInstruction">): string {
  if (isEmptyContinuityContext(context)) {
    return "暂无前情承接要求。";
  }
  const lead = stripTerminalPunctuation(context.openLeads[0] ?? context.recentEvents[0] ?? "最近事件");
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
