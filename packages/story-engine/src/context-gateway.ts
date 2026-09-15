import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatStaleGoalMessage } from "./arc-goal-tracking.js";
import { formatStaleHookMessage } from "./hook-tracking.js";
import { formatStaleThreadMessage } from "./lead-intent-tracking.js";
import { chaptersSinceTouched, shouldRemindStaleAt } from "./stale-reminder-policy.js";
import {
  readCharacterCore,
  readCharacterProfile,
  readCharacterState,
  readArcGoalPool,
  readHookPool,
  readProject,
  readStoryCalendar,
  readStoryCore,
  readThreadPool,
  readTimelineEvents,
  readWorldCore,
  readWorldState,
  toSafeCharacterId,
} from "./project-store.js";
import { selectRelevant } from "./relevance-selection.js";
import { buildTimelineLayers } from "./timeline-layers.js";
import { buildWritingContextPack, type WritingContextPack } from "./writing-context-pack.js";
import type {
  CharacterCore,
  CharacterProfile,
  CharacterState,
  ArcGoal,
  HookItem,
  NarrativeThread,
  TimelineEvent,
} from "./types.js";

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
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly mustHitBeats?: readonly string[];
}

export async function buildWriterContext(input: BuildWriterContextInput): Promise<WriterContextEnvelope> {
  const project = await readProject(input.projectDir);
  const characterIds = await resolveSelectedCharacterIds(input);
  // P2 铁律④（永不静默）：损坏的 timeline/events.json 此前双重 catch 后静默降级为 [] ——
  // 模型拿到「空历史」却毫无知觉，会把已写过的章节当没发生过。降级仍要做（不能让一次坏读盘
  // 炸掉整次出稿），但失败原因必须进上下文，让模型知道并如实转达用户。
  const readFailures: string[] = [];
  const trackReadFailure = (label: string) => (error: unknown) => {
    readFailures.push(`${label} 读取失败，已降级为空：${error instanceof Error ? error.message : String(error)}`);
  };
  const [storyCore, worldCore, profiles, cores, calendar, hookPool, threadPool, arcGoalPool, states, worldState, allTimelineEvents, previousUncommittedDraft] = await Promise.all([
    readStoryCore(input.projectDir),
    readWorldCore(input.projectDir),
    readCharacterProfiles(input.projectDir, characterIds),
    readCharacterCores(input.projectDir, characterIds),
    readStoryCalendar(input.projectDir),
    readHookPool(input.projectDir),
    readThreadPool(input.projectDir),
    readArcGoalPool(input.projectDir),
    readCharacterStates(input.projectDir, characterIds),
    readWorldState(input.projectDir),
    // 全量 timeline 只读一次：近 N 段（selectRecentTimelineEvents）与早期分层（buildTimelineLayers）共用，避免重复读盘
    readTimelineEvents(input.projectDir)
      .catch((error) => { trackReadFailure("时间线事件")(error); return readTimelineEventsFallback(input.projectDir); })
      .catch((error) => { trackReadFailure("时间线事件（含旧格式回退）")(error); return [] as readonly TimelineEvent[]; }),
    readPreviousUncommittedDraftContext(input.projectDir, input.chapter),
  ]);
  const timelineEvents = selectRecentTimelineEvents(allTimelineEvents, input.maxTimelineEvents);
  const storyContinuity = buildStoryContinuityContext(timelineEvents);
  const selectedHooks = selectHooks(hookPool.hooks, input.selectedHookIds);
  const hookTracking = buildHookTrackingContext(hookPool.hooks, input.chapter, input.chapterGoal, characterIds);
  const arcGoals = buildArcGoalsContext(arcGoalPool.goals, input.chapter, input.chapterGoal, characterIds);
  const storyThreads = buildStoryThreadsContext(threadPool.threads, input.chapter, storyContinuity, arcGoals, input.chapterGoal, characterIds);
  const writingContextPack = await buildWritingContextPack({
    projectDir: input.projectDir,
    chapter: input.chapter,
    userDirection: input.chapterGoal,
    currentChapterGoal: input.chapterGoal,
    selectedCharacterIds: characterIds,
    selectedHookIds: input.selectedHookIds,
    maxTimelineEvents: input.maxTimelineEvents,
    ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
  });
  // 早期宏事件分层摘要（L2 中段 + L3 远期），让出稿上下文能看见早期内容
  const timelineLayers = buildTimelineLayers(allTimelineEvents, input.chapter);
  const hasEarlierContent = timelineLayers.l2.length > 0 || timelineLayers.l3.length > 0;
  const sections = [
    section("story_core", storyCore, "stable"),
    section("world_core", worldCore, "stable"),
    section("character_profile", profiles, "stable"),
    section("character_core", cores, "stable"),
    section("chapter_goal", { chapter: input.chapter, goal: input.chapterGoal }, "dynamic"),
    ...(previousUncommittedDraft ? [section("previous_uncommitted_draft", previousUncommittedDraft, "dynamic")] : []),
    section("writing_context_pack", writingContextPack satisfies WritingContextPack, "dynamic"),
    section("story_calendar", calendar, "dynamic"),
    section("hook_pool", selectedHooks, "dynamic"),
    section("hook_tracking", hookTracking, "dynamic"),
    section("story_threads", storyThreads, "dynamic"),
    section("arc_goals", arcGoals, "dynamic"),
    section("character_state", states, "dynamic"),
    section("world_state", worldState, "dynamic"),
    section("story_continuity", storyContinuity, "dynamic"),
    section("timeline_events", timelineEvents, "dynamic"),
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
      selectedCharacters: characterIds,
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
  const committedContent = await readFile(committedPath, "utf-8").catch(() => undefined);
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
    excerpt: truncateText(body, 1800),
    continuityInstruction: [
      `第 ${previousChapter} 章尚未正式入库，但它是当前写作区保存的上一章工作稿。`,
      "生成本章时必须把它当作直接前情依据：保持主角身份、称谓、人称、地点承接、已出现物件和未解决压力一致。",
      "不要因为正式 timeline 还没有该章而重启剧情或改写主角设定。",
    ].join(""),
  };
}

function padChapter(chapter: number): string {
  return String(chapter).padStart(4, "0");
}

function extractMarkdownTitle(content: string | undefined): string | undefined {
  const line = content?.split(/\r?\n/u).find((item) => item.trim().startsWith("#"))?.trim();
  if (!line) return undefined;
  return line.replace(/^#+\s*/u, "").trim() || undefined;
}

function stripMarkdownHeading(content: string): string {
  return content.replace(/^#{1,6}\s+.*(?:\r?\n){1,2}/u, "").trim();
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 1;
  let count = 0;
  // Use Array.from to iterate by code points (handles surrogate pairs)
  const codePoints = Array.from(text);
  for (const char of codePoints) {
    const cp = char.codePointAt(0)!;
    if (
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x20000 && cp <= 0x323AF)
    ) {
      count += 0.67; // ~1.5 chars per token for CJK
    } else if (cp <= 0x7F) {
      count += 0.25; // ~4 chars per token for ASCII
    } else {
      count += 0.35; // ~3 chars per token for other Unicode
    }
  }
  return Math.max(1, Math.ceil(count));
}

function section(name: string, content: unknown, cachePolicy: "stable" | "dynamic"): ContextSection {
  return {
    name,
    content,
    tokenEstimate: estimateTokens(content),
    cachePolicy,
  };
}

async function resolveSelectedCharacterIds(input: BuildWriterContextInput): Promise<string[]> {
  if (input.selectedCharacterIds && input.selectedCharacterIds.length > 0) {
    return unique(input.selectedCharacterIds.map(toSafeCharacterId));
  }
  const entries = await readdir(join(input.projectDir, "characters"), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => toSafeCharacterId(entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function readCharacterProfiles(projectDir: string, characterIds: readonly string[]): Promise<readonly CharacterProfile[]> {
  return Promise.all(characterIds.map((id) => readCharacterProfile(projectDir, id)));
}

async function readCharacterCores(projectDir: string, characterIds: readonly string[]): Promise<readonly CharacterCore[]> {
  return Promise.all(characterIds.map((id) => readCharacterCore(projectDir, id)));
}

async function readCharacterStates(projectDir: string, characterIds: readonly string[]): Promise<readonly CharacterState[]> {
  return Promise.all(characterIds.map((id) => readCharacterState(projectDir, id)));
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
  const recentlyTouchedThreads = ranked.slice(0, 5).map(compactThread);
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
  const recentlyTouchedGoals = [...goals]
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
  return value.replace(/[。！？!?；;，,、\s]+$/u, "");
}

async function readTimelineEventsFallback(projectDir: string): Promise<readonly TimelineEvent[]> {
  const raw = await readFile(join(projectDir, "timeline", "events.json"), "utf-8").catch(() => "[]");
  return JSON.parse(raw) as TimelineEvent[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
