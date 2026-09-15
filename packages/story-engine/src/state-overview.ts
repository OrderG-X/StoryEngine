import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeIntentLifecycle } from "./intent-lifecycle-diagnostics.js";
import { buildTimelineLayers } from "./timeline-layers.js";
import type { TimelineLayerEvent, TimelineMacroBlock } from "./timeline-layers.js";
import { selectRelevant } from "./relevance-selection.js";
import { bigramSimilarity } from "./text-similarity.js";
import { recoverProjectCommitTransactions, withProjectCommitLock } from "./commit-engine.js";
import {
  resolveCharacterRole,
  resolveIdentity,
  resolveCurrentGoal,
  resolveMentalState,
  resolveCurrentLocation,
  resolveTrust,
  resolveRelationDescriptor,
  dedupeAppearanceAnchors,
} from "./canonical-resolvers.js";
import type {
  ArcGoal,
  ArcGoalPool,
  AssetLedger,
  CharacterBible,
  CharacterBibleEntry,
  CharacterMatrixLedger,
  CharacterProfile,
  CharacterState,
  HookItem,
  HookPool,
  LocationBible,
  LocationTravelRule,
  NarrativeThread,
  StoryBible,
  StoryCalendar,
  StoryCore,
  StoryProject,
  ThreadPool,
  TimelineEvent,
  WorldBible,
  WorldCore,
  WorldState,
  WritingRules,
} from "./types.js";

export interface BuildStateOverviewInput {
  readonly projectDir: string;
  readonly chapter?: number;
  readonly maxTimelineEvents?: number;
}

export interface StateOverview {
  readonly project: {
    readonly title: string;
    readonly genre: string;
    readonly currentChapter: number | null;
  };
  readonly storyStatus: {
    readonly currentStage?: string;
    readonly currentLocation?: string;
    readonly currentObjective?: string;
    readonly lastTimelineEvent?: string;
  };
  readonly hooks: {
    readonly activeCount: number;
    readonly touchedCount: number;
    readonly resolvedCount: number;
    readonly activeItems: readonly StateOverviewHookItem[];
  };
  readonly threads: {
    readonly total: number;
    readonly open: number;
    readonly touched: number;
    readonly done: number;
    readonly openIntents: number;
    readonly cleanupVisibleCount: number;
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
    readonly protagonist?: string;
    readonly knownCharacters: readonly StateOverviewCharacterItem[];
  };
  readonly world: {
    readonly summary?: string;
    readonly activeLocations: readonly string[];
    readonly importantFacts: readonly string[];
    readonly protectedSecrets: readonly string[];
  };
  readonly storyFoundation: {
    readonly available: boolean;
    readonly missingFiles: readonly string[];
    readonly summary: string;
  };
  readonly storyBible: StateOverviewStoryBibleSummary;
  readonly writingRules: StateOverviewWritingRulesSummary;
  readonly characterBible: StateOverviewCharacterBibleSummary;
  readonly characterMatrix: StateOverviewCharacterMatrix;
  readonly worldBible: StateOverviewWorldBibleSummary;
  readonly locationBible: StateOverviewLocationBibleSummary;
  readonly assetSummary: StateOverviewAssetSummary;
  readonly locationDetailSummary: StateOverviewLocationDetailSummary;
  readonly characterDetailSummary: StateOverviewCharacterDetailSummary;
  readonly foundationCompleteness: StateOverviewFoundationCompleteness;
  readonly maintenance: {
    readonly diagnosticsAvailable: boolean;
    readonly cleanupVisibleCount: number;
    readonly markDoneCandidateCount: number;
    readonly mergeDisabled: true;
    readonly dropDisabled: true;
    readonly confirmPolicy: {
      readonly markDone: "manual_only";
      readonly merge: "disabled";
      readonly drop: "disabled";
    };
  };
  readonly uiHints: {
    readonly recommendedNextPanels: readonly string[];
    readonly warnings: readonly string[];
    readonly disabledActions: readonly string[];
  };
}

export interface StateOverviewHookItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lastTouchedChapter?: number;
  readonly risk?: "low" | "medium" | "high";
  /** 热度读时派生：大伏笔 / 小线索。纯确定性、不写盘。 */
  readonly size?: "major" | "minor";
  /** B5-2: 初次埋入章号（透传自 HookItem.firstSeenChapter）。读时投影，不写盘。 */
  readonly firstSeenChapter?: number;
  /** B5-2: 回收章号（status=resolved 时填；透传自 HookItem.resolvedAtChapter）。读时投影，不写盘。 */
  readonly resolvedAtChapter?: number;
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
  /** 热度读时派生：大伏笔 / 小线索。纯确定性、不写盘。 */
  readonly size?: "major" | "minor";
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
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly status?: string;
  readonly mood?: string;
  readonly currentGoal?: string;
  readonly recentEvents?: readonly string[];
  readonly lastSeenChapter?: number;
}

export interface StateOverviewStoryBibleSummary {
  readonly available: boolean;
  readonly projectLogline?: string;
  readonly genre?: string;
  readonly readerPromise?: string;
  readonly longFormGoals: readonly string[];
  readonly centralConflicts: readonly string[];
  readonly coreMysteries: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly canonFacts: readonly string[];
  readonly openQuestions: readonly string[];
  readonly setupAssets?: {
    readonly initialAssets: readonly string[];
    readonly keyItems: readonly string[];
    readonly resourceLimits: readonly string[];
  };
  readonly firstChapterSetup?: {
    readonly goal?: string;
    readonly openingScene?: string;
    readonly hook?: string;
    readonly conflict?: string;
  };
  readonly protectedSecrets: readonly string[];
}

export interface StateOverviewWritingRulesSummary {
  readonly available: boolean;
  readonly narrativePerspective?: string;
  readonly proseStyle: readonly string[];
  readonly pacing?: string;
  readonly revealPolicy?: string;
  readonly targetChapterWords?: number;
  readonly genreRequirements: readonly string[];
  readonly forbiddenContent: readonly string[];
  readonly doNotDo: readonly string[];
  readonly readerExperienceRules: readonly string[];
  readonly antiAiPatterns: readonly string[];
  /** 用户自定义的全局写作规矩（自由 Markdown）；原样透出供面板展示，不 truncate。受控破例⑧。 */
  readonly customNotes?: string;
}

export interface StateOverviewCharacterBibleSummary {
  readonly available: boolean;
  readonly characterCount: number;
  readonly keyCharacters: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly desire?: string;
    readonly fear?: string;
    readonly weakness?: string;
    readonly appearanceAnchors: readonly string[];
    readonly contradiction?: string;
    readonly moralBoundary?: string;
    readonly privateMotive?: string;
    readonly relationshipToProtagonist?: string;
    readonly relationshipDynamics: readonly string[];
    readonly trustLevel?: string;
    readonly hiddenStance?: string;
    readonly behaviorBoundaries: readonly string[];
    readonly knowledgeKnown: readonly string[];
    readonly knowledgeUnknown: readonly string[];
    readonly cannotReveal: readonly string[];
    readonly speechRules: readonly string[];
    readonly speechStyle?: string;
    readonly speechSamples: readonly string[];
    readonly arcPromise?: string;
    readonly currentStateHint?: string;
  }[];
}

export interface StateOverviewCharacterMatrix {
  readonly available: boolean;
  readonly characters: readonly StateOverviewCharacterMatrixItem[];
  readonly relationships: readonly StateOverviewCharacterRelationship[];
  readonly riskReminders: readonly string[];
}

export interface StateOverviewCharacterMatrixItem {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly age?: string;
  readonly gender?: string;
  readonly identity?: string;
  readonly faction?: string;
  readonly desire?: string;
  readonly fear?: string;
  readonly weakness?: string;
  readonly appearanceAnchors: readonly string[];
  readonly contradiction?: string;
  readonly moralBoundary?: string;
  readonly privateMotive?: string;
  readonly relationshipDynamics: readonly string[];
  readonly trustLevel?: string;
  readonly hiddenStance?: string;
  readonly behaviorBoundaries: readonly string[];
  readonly cannotDo: readonly string[];
  readonly cannotReveal: readonly string[];
  readonly speechStyle?: string;
  readonly speechSamples: readonly string[];
  readonly knownFacts: readonly string[];
  readonly unknownTruths: readonly string[];
  readonly protectedSecrets: readonly string[];
  readonly forbiddenReveals: readonly string[];
  readonly currentLocation?: string;
  readonly mood?: string;
  readonly physicalState?: string;
  readonly mentalState?: string;
  readonly resourceState?: string;
  readonly currentGoal?: string;
  readonly recentEvents?: readonly string[];
  readonly lastSeenChapter?: number;
  readonly carriedAssets: readonly string[];
  readonly ownedAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
  readonly relationshipToProtagonist?: string;
  readonly relationships: readonly StateOverviewCharacterRelationship[];
  readonly riskReminders: readonly string[];
  readonly status?: "candidate" | "accepted" | "ignored" | "promoted";
  readonly roleHint?: string;
  readonly firstSeenChapter?: number;
  readonly evidence?: readonly string[];
  readonly appearanceRecords?: readonly {
    readonly chapter: number;
    readonly evidence: string;
    readonly location?: string;
  }[];
  readonly relationshipEvents?: readonly {
    readonly chapter: number;
    readonly relationToProtagonist?: string;
    readonly evidence: string;
  }[];
  /** 用户/AI 自定义的额外字段（与喂模型路 writing-context-pack 同源）；展示路透出供面板「自定义字段」section 渲染。受控破例⑦。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewCharacterRelationship {
  readonly targetCharacterId: string;
  readonly targetName: string;
  readonly relationType: string;
  readonly attitude?: string;
  readonly trustLevel?: "low" | "medium" | "high";
  /** 由 trustLevel 确定性派生（low=25/medium=55/high=85），仅供进度条显示；与档级永不矛盾。 */
  readonly trustPercent?: number;
  readonly conflict?: string;
  readonly secret?: string;
  readonly lastChangedChapter?: number;
}

export interface StateOverviewWorldBibleSummary {
  readonly available: boolean;
  readonly ruleCount: number;
  readonly factionCount: number;
  readonly systemCount: number;
  readonly keyRules: readonly string[];
  readonly keyFactions: readonly string[];
  readonly resourceRules: readonly string[];
  readonly authorityRules: readonly string[];
  readonly socialOrder: readonly string[];
  readonly conflictSources: readonly string[];
  readonly fixedFacts: readonly string[];
  readonly protectedSecrets: readonly string[];
  readonly publicFacts: readonly string[];
  readonly hiddenFacts: readonly string[];
  readonly forbiddenRuleBreaks: readonly string[];
  /** 世界观自定义额外字段（来自 world/state.json 的 extraFields）；展示路透出。受控破例⑦。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewLocationBibleSummary {
  readonly available: boolean;
  readonly locationCount: number;
  readonly activeLocationNames: readonly string[];
  readonly riskCount: number;
  readonly resourceCount: number;
  readonly keyRisks: readonly string[];
  readonly keyResources: readonly string[];
  readonly keyNarrativeFunctions: readonly string[];
}

export interface StateOverviewAssetSummary {
  readonly available: boolean;
  readonly carriedAssets: readonly string[];
  readonly ownedAssets: readonly string[];
  readonly unavailableAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
  readonly assetItems: readonly StateOverviewAssetItem[];
}

export interface StateOverviewAssetItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly owner?: string;
  readonly currentLocation?: string;
  readonly carriedBy?: string;
  readonly status: string;
  readonly isConsumable?: boolean;
  readonly isPlotCritical?: boolean;
  readonly rules: readonly string[];
  readonly usageRules: readonly string[];
  readonly lossRules: readonly string[];
  readonly notes: readonly string[];
  /** 资产自定义额外字段（来自 assets.json 每 asset 的 extraFields）；展示路透出。受控破例⑦。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewLocationDetailSummary {
  readonly locations: readonly StateOverviewLocationDetailItem[];
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly entrances: readonly string[];
  readonly exits: readonly string[];
  readonly travelRules: readonly string[];
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly fixedFacts: readonly string[];
}

export interface StateOverviewLocationDetailItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly parentLocation?: string;
  readonly currentKnownPosition?: string;
  readonly sensory: readonly string[];
  readonly narrativeFunction?: string;
  readonly possibleConflicts: readonly string[];
  readonly currentStatus?: string;
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly entrances: readonly string[];
  readonly exits: readonly string[];
  readonly travelRules: readonly string[];
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly fixedFacts: readonly string[];
  readonly hiddenFacts: readonly string[];
  /** 地点自定义额外字段（来自 location-bible.json 每 entry 的 extraFields）；展示路透出。受控破例⑦。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

export interface StateOverviewCharacterDetailSummary {
  readonly characters: readonly {
    readonly id: string;
    readonly name: string;
    readonly age?: string;
    readonly speechStyle?: string;
    readonly speechSamples: readonly string[];
    readonly mood?: string;
    readonly currentGoal?: string;
    readonly recentEvents?: readonly string[];
    readonly currentState?: string;
    readonly cannotDo: readonly string[];
  }[];
}

export interface StateOverviewFoundationCompleteness {
  readonly passed: boolean;
  readonly readinessLevel: "ready" | "warning" | "high_risk";
  readonly missingItems: readonly string[];
  readonly suggestions: readonly string[];
}

const DEFAULT_MAX_TIMELINE_EVENTS = 5;
const MAX_ITEMS = 12;
const MAX_TEXT = 160;
/** 只增不减的累积列表里，取追加序最新的若干条（老的留在盘上、不进概览） */
const MAX_RECENT_WORLD_ITEMS = 6;

function recentItems(values: readonly string[]): readonly string[] {
  return values.slice(-MAX_RECENT_WORLD_ITEMS);
}

export async function buildStateOverview(input: BuildStateOverviewInput): Promise<StateOverview> {
  return withProjectCommitLock(input.projectDir, async () => {
    await recoverProjectCommitTransactions(input.projectDir);
    return buildStateOverviewUnlocked(input);
  });
}

async function buildStateOverviewUnlocked(input: BuildStateOverviewInput): Promise<StateOverview> {
  const [
    project,
    worldCore,
    worldState,
    storyCore,
    storyBible,
    writingRules,
    characterBible,
    characterMatrixLedger,
    worldBible,
    locationBible,
    assetLedger,
    hookPool,
    threadPool,
    arcGoalPool,
    timelineEvents,
    calendar,
    characters,
  ] = await Promise.all([
    readJsonSafe<StoryProject>(input.projectDir, "project.json", { id: "unknown", title: "Untitled", createdAt: "", updatedAt: "" }),
    readJsonSafe<WorldCore>(input.projectDir, join("world", "core.json"), { genre: "unknown", premise: "", rules: [], mainConflict: "" }),
    readJsonSafe<WorldState>(input.projectDir, join("world", "state.json"), { currentPhase: "unknown", activeConflicts: [], activeHooks: [], knownSecrets: [] }),
    readJsonSafe<StoryCore>(input.projectDir, join("story", "core.json"), { readerPromise: "", tone: "", targetEmotion: "" }),
    readJsonSafe<StoryBible | null>(input.projectDir, join("story", "bible.json"), null),
    readJsonSafe<WritingRules | null>(input.projectDir, join("story", "writing-rules.json"), null),
    readJsonSafe<CharacterBible | null>(input.projectDir, join("story", "character-bible.json"), null),
    readJsonSafe<CharacterMatrixLedger>(input.projectDir, join("story", "character-matrix.json"), { version: "v0", entries: [] }),
    readJsonSafe<WorldBible | null>(input.projectDir, join("story", "world-bible.json"), null),
    readJsonSafe<LocationBible | null>(input.projectDir, join("story", "location-bible.json"), null),
    readJsonSafe<AssetLedger>(input.projectDir, join("story", "assets.json"), { version: "v0", assets: [], containers: [] }),
    readJsonSafe<HookPool>(input.projectDir, join("story", "hooks.json"), { hooks: [] }),
    readJsonSafe<ThreadPool>(input.projectDir, join("story", "threads.json"), { threads: [] }),
    readJsonSafe<ArcGoalPool>(input.projectDir, join("story", "arc-goals.json"), { goals: [] }),
    readJsonSafe<readonly TimelineEvent[]>(input.projectDir, join("timeline", "events.json"), []),
    readJsonSafe<StoryCalendar>(input.projectDir, join("time", "calendar.json"), { currentStoryDay: 1, currentTimeOfDay: "unknown" }),
    readCharacters(input.projectDir),
  ]);

  const currentChapter = input.chapter ?? inferCurrentChapter(timelineEvents);
  const intentDiagnostics = analyzeIntentLifecycle(threadPool, { currentChapter: currentChapter ?? undefined, sampleLimit: MAX_ITEMS });
  const cleanupVisibleCount = intentDiagnostics.totalIntents - intentDiagnostics.cleanupCandidateCounts.none;
  const diagnosticsByThread = new Map(intentDiagnostics.diagnostics.map((item) => [item.threadId, item]));
  const recentEvents = timelineEvents
    .slice()
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-(input.maxTimelineEvents ?? DEFAULT_MAX_TIMELINE_EVENTS))
    .map(toTimelineOverview);
  // L2/L3 分层摘要——从全量 events 派生，保留早期内容，不破坏 recentEvents
  const timelineLayers = buildTimelineLayers(timelineEvents, currentChapter ?? 0);
  const lastEvent = recentEvents.at(-1);
  const storyBibleSummary = toStoryBibleSummary(storyBible);
  const writingRulesSummary = toWritingRulesSummary(writingRules);
  const characterBibleSummary = toCharacterBibleSummary(characterBible);
  const worldBibleSummary = toWorldBibleSummary(worldBible, worldState);
  const locationBibleSummary = toLocationBibleSummary(locationBible);
  const spatialVocabulary = buildSpatialVocabulary(locationBible);
  const assetSummary = toAssetSummary(assetLedger);
  const locationDetailSummary = toLocationDetailSummary(locationBible);
  const characterDetailSummary = toCharacterDetailSummary(characterBible, characters);
  const characterMatrix = toCharacterMatrix({
    characterBible,
    characterMatrixLedger,
    characters,
    assetLedger,
    timelineEvents,
    storyBibleSummary,
    worldProtectedSecrets: worldState.knownSecrets,
  });
  const foundationCompleteness = toFoundationCompleteness({
    storyBible,
    writingRules,
    characterBible,
    worldBible,
    locationBible,
    assetLedger,
  });
  const missingFoundationFiles = [
    storyBible ? undefined : "story/bible.json",
    writingRules ? undefined : "story/writing-rules.json",
    characterBible ? undefined : "story/character-bible.json",
    worldBible ? undefined : "story/world-bible.json",
    locationBible ? undefined : "story/location-bible.json",
  ].filter(isNonEmptyString);

  return {
    project: {
      title: project.title,
      genre: worldCore.genre,
      currentChapter,
    },
    storyStatus: {
      currentStage: firstText([
        worldState.currentPhase,
      ]),
      currentLocation: firstText([
        lastSemanticLocation(timelineEvents, locationBibleSummary.activeLocationNames, spatialVocabulary),
        firstText(locationBibleSummary.activeLocationNames),
      ]),
      currentObjective: firstText([
        lastSemanticObjective(timelineEvents),
        firstActiveGoal(arcGoalPool.goals)?.title,
        firstOpenThread(threadPool.threads)?.title,
        storyCore.readerPromise,
      ]),
      lastTimelineEvent: lastEvent?.summary,
    },
    hooks: {
      activeCount: hookPool.hooks.filter((hook) => hook.status === "active" || hook.status === "seeded").length,
      touchedCount: hookPool.hooks.filter((hook) => hook.status === "active").length,
      resolvedCount: hookPool.hooks.filter((hook) => hook.status === "resolved").length,
      activeItems: (() => {
        const hookSelectChapter = currentChapter ?? Math.max(0, ...hookPool.hooks.map((h) => h.firstSeenChapter ?? 0));
        return selectRelevant({
          items: hookPool.hooks.map((h) => ({ ...h, text: h.title ?? "" })),
          chapter: hookSelectChapter,
          closedStatuses: ["resolved", "abandoned"],
        }).selected.slice(0, MAX_ITEMS).map(toHookOverview);
      })(),
    },
    threads: {
      total: threadPool.threads.length,
      open: threadPool.threads.filter((thread) => thread.status === "open").length,
      touched: threadPool.threads.filter((thread) => thread.status === "touched").length,
      done: threadPool.threads.filter((thread) => thread.status === "done").length,
      openIntents: threadPool.threads.filter((thread) => thread.type === "intent" && thread.status === "open").length,
      cleanupVisibleCount,
      keyOpenItems: (() => {
        const threadSelectChapter = currentChapter ?? Math.max(0, ...threadPool.threads.map((t) => t.firstSeenChapter ?? 0));
        const selected = selectRelevant({
          items: threadPool.threads.map((t) => ({ ...t, text: t.title ?? "" })),
          chapter: threadSelectChapter,
          closedStatuses: ["done", "stale"],
        }).selected;
        return clusterNearDuplicates(selected).slice(0, MAX_ITEMS).map(({ rep: thread, relatedCount }) =>
          toThreadOverview(thread, diagnosticsByThread.get(thread.id)?.cleanupCandidateClass, relatedCount),
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
      protagonist: characters.find((character) => character.profile.identity === "protagonist" || character.profile.tags?.includes("main-character"))?.profile.name,
      knownCharacters: characters.map(toCharacterOverview),
    },
    world: {
      summary: truncate(worldCore.premise),
      activeLocations: unique([
        ...recentEvents.map((event) => event.location).filter(isNonEmptyString),
        ...threadPool.threads.flatMap((thread) => thread.relatedLocations ?? []),
        ...arcGoalPool.goals.flatMap((goal) => goal.relatedLocations ?? []),
      ]).slice(0, MAX_ITEMS),
      // P2：activeConflicts/knownSecrets 按章追加、只增不减，老条目会无限堆积。用户的常设世界规则
      // 必须先占位（它们不会过期），冲突/隐情取最近若干条（slice(-N) 保留追加序最新的），
      // 否则写到第 50 章时「第 1 章的冲突」会把世界规则全线挤出概览。
      importantFacts: unique([
        ...worldCore.rules,
        ...recentItems(worldState.activeConflicts),
      ].map((item) => truncate(item))).slice(0, MAX_ITEMS),
      protectedSecrets: unique([
        ...storyBibleSummary.coreMysteries,
        ...storyBibleSummary.protectedSecrets,
        ...recentItems(worldState.knownSecrets),
      ].map((item) => truncate(item))).slice(0, MAX_ITEMS),
    },
    storyFoundation: {
      available: missingFoundationFiles.length === 0,
      missingFiles: missingFoundationFiles,
      summary: buildStoryFoundationSummary({
        storyBible: storyBibleSummary,
        writingRules: writingRulesSummary,
        characterBible: characterBibleSummary,
        worldBible: worldBibleSummary,
        locationBible: locationBibleSummary,
      }),
    },
    storyBible: storyBibleSummary,
    writingRules: writingRulesSummary,
    characterBible: characterBibleSummary,
    characterMatrix,
    worldBible: worldBibleSummary,
    locationBible: locationBibleSummary,
    assetSummary,
    locationDetailSummary,
    characterDetailSummary,
    foundationCompleteness,
    maintenance: {
      diagnosticsAvailable: true,
      cleanupVisibleCount,
      markDoneCandidateCount: intentDiagnostics.manualReviewMarkDoneCandidates.length + intentDiagnostics.markDoneCandidates.length,
      mergeDisabled: true,
      dropDisabled: true,
      confirmPolicy: {
        markDone: "manual_only",
        merge: "disabled",
        drop: "disabled",
      },
    },
    uiHints: {
      recommendedNextPanels: buildRecommendedPanels({ hookPool: hookPool, threadPool: threadPool, arcGoalPool: arcGoalPool, cleanupVisibleCount }),
      warnings: buildWarnings({ hookPool: hookPool, threadPool: threadPool, arcGoalPool: arcGoalPool, cleanupVisibleCount }),
      disabledActions: [
        "merge_threads_confirm",
        "drop_thread_confirm",
        "auto_cleanup",
        "auto_expire",
        "auto_mark_done",
        "auto_apply_review_plan_confirm",
      ],
    },
  };
}

/**
 * 展示读取层保守聚类：将近重复标题折叠成「代表条 + relatedCount」。
 *
 * 顺序扫描，每个 item 与已建 cluster 的代表项按 bigramSimilarity >= threshold
 * 比较；命中则并入（relatedCount++），否则自成新 cluster。
 * 代表项 = 该 cluster 第一个（保 selectRelevant 已排好的相关性序）。
 *
 * 阈值 0.5：只折叠真高重叠（近同句/精确重复），词面分散的不同伏笔不会被聚。
 */
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

/**
 * 按「跨章数 + 提及次数 + 牵连角色数」确定性派生伏笔/线索的大小级别。
 * 纯读时计算，不写盘，不调 LLM，题材中立。
 *
 * weight = (span >= 10 ? 2 : 0) + (evidenceCount >= 3 ? 1 : 0) + (relatedCharacterCount >= 2 ? 1 : 0)
 * weight >= 2 → "major"，否则 "minor"
 */
export function deriveSize(input: {
  firstSeenChapter?: number;
  lastTouchedChapter?: number;
  evidenceCount: number;
  relatedCharacterCount: number;
}): "major" | "minor" {
  const span = (input.lastTouchedChapter ?? 0) - (input.firstSeenChapter ?? 0);
  const weight =
    (span >= 10 ? 2 : 0) +
    (input.evidenceCount >= 3 ? 1 : 0) +
    (input.relatedCharacterCount >= 2 ? 1 : 0);
  return weight >= 2 ? "major" : "minor";
}

function toHookOverview(hook: HookItem): StateOverviewHookItem {
  return {
    id: hook.id,
    title: truncate(hook.title),
    status: hook.status,
    ...(hook.lastTouchedChapter !== undefined ? { lastTouchedChapter: hook.lastTouchedChapter } : {}),
    risk: hookRisk(hook),
    size: deriveSize({
      firstSeenChapter: hook.firstSeenChapter,
      lastTouchedChapter: hook.lastTouchedChapter,
      evidenceCount: hook.evidence?.length ?? 0,
      relatedCharacterCount: hook.relatedCharacters?.length ?? 0,
    }),
    ...(hook.firstSeenChapter !== undefined ? { firstSeenChapter: hook.firstSeenChapter } : {}),
    ...(hook.resolvedAtChapter !== undefined ? { resolvedAtChapter: hook.resolvedAtChapter } : {}),
  };
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
    size: deriveSize({
      firstSeenChapter: thread.firstSeenChapter,
      lastTouchedChapter: thread.lastTouchedChapter,
      evidenceCount: thread.evidence?.length ?? 0,
      relatedCharacterCount: thread.relatedCharacters?.length ?? 0,
    }),
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

function toCharacterOverview(item: { readonly profile: CharacterProfile; readonly state?: CharacterState }): StateOverviewCharacterItem {
  const mood = firstText([item.state?.mood, item.state?.emotion]);
  const currentGoal = firstText([item.state?.currentGoal, item.state?.goal]);
  const recentEvents = safeStringArray(item.state?.recentEvents).map((event) => truncate(event)).slice(0, MAX_ITEMS);
  return {
    id: item.profile.id,
    name: item.profile.name,
    role: toReadableCharacterRole(item.profile.identity),
    ...(mood ? { status: truncate(mood, 80), mood: truncate(mood, 80) } : {}),
    ...(currentGoal ? { currentGoal: truncate(currentGoal) } : {}),
    ...(recentEvents.length ? { recentEvents } : {}),
    ...(typeof item.state?.lastUpdatedChapter === "number" ? { lastSeenChapter: item.state.lastUpdatedChapter } : {}),
  };
}

function toReadableCharacterRole(role: string | undefined): string | undefined {
  if (!role) return undefined;
  const labels: Record<string, string> = {
    protagonist: "主角",
  };
  return labels[role] ?? role;
}

function toStoryBibleSummary(bible: StoryBible | null): StateOverviewStoryBibleSummary {
  if (!bible) {
    return {
      available: false,
      longFormGoals: [],
      centralConflicts: [],
      coreMysteries: [],
      forbiddenChanges: [],
      canonFacts: [],
      openQuestions: [],
      protectedSecrets: [],
    };
  }
  const longFormGoals = safeStringArray(bible.longFormGoals);
  const centralConflicts = safeStringArray(bible.centralConflicts);
  const coreMysteries = safeStringArray(bible.coreMysteries);
  const forbiddenChanges = safeStringArray(bible.forbiddenChanges);
  const canonFacts = safeStringArray(bible.canonFacts);
  const openQuestions = safeStringArray(bible.openQuestions);
  const protectedSecrets = safeStringArray(bible.protectedSecrets);
  return {
    available: true,
    projectLogline: truncate(bible.projectLogline),
    genre: bible.genre,
    readerPromise: truncate(bible.readerPromise),
    longFormGoals: longFormGoals.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    centralConflicts: centralConflicts.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    coreMysteries: coreMysteries.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    forbiddenChanges: forbiddenChanges.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    canonFacts: canonFacts.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    openQuestions: openQuestions.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    ...(bible.setupAssets ? {
      setupAssets: {
        initialAssets: safeStringArray(bible.setupAssets.initialAssets).map((item) => truncate(item)).slice(0, MAX_ITEMS),
        keyItems: safeStringArray(bible.setupAssets.keyItems).map((item) => truncate(item)).slice(0, MAX_ITEMS),
        resourceLimits: safeStringArray(bible.setupAssets.resourceLimits).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      },
    } : {}),
    ...(bible.firstChapterSetup ? {
      firstChapterSetup: {
        ...(bible.firstChapterSetup.goal ? { goal: truncate(bible.firstChapterSetup.goal) } : {}),
        ...(bible.firstChapterSetup.openingScene ? { openingScene: truncate(bible.firstChapterSetup.openingScene) } : {}),
        ...(bible.firstChapterSetup.hook ? { hook: truncate(bible.firstChapterSetup.hook) } : {}),
        ...(bible.firstChapterSetup.conflict ? { conflict: truncate(bible.firstChapterSetup.conflict) } : {}),
      },
    } : {}),
    protectedSecrets: protectedSecrets.map((item) => truncate(item)).slice(0, MAX_ITEMS),
  };
}

function toWritingRulesSummary(rules: WritingRules | null): StateOverviewWritingRulesSummary {
  if (!rules) {
    return {
      available: false,
      proseStyle: [],
      genreRequirements: [],
      forbiddenContent: [],
      doNotDo: [],
      readerExperienceRules: [],
      antiAiPatterns: [],
    };
  }
  return {
    available: true,
    narrativePerspective: rules.narrativePerspective,
    proseStyle: safeStringArray(rules.proseStyle).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    pacing: rules.pacing,
    revealPolicy: rules.revealPolicy,
    targetChapterWords: rules.chapterLength?.targetWords,
    genreRequirements: safeStringArray(rules.genreRequirements).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    forbiddenContent: safeStringArray(rules.forbiddenContent).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    doNotDo: safeStringArray(rules.doNotDo).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    readerExperienceRules: safeStringArray(rules.readerExperienceRules).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    antiAiPatterns: safeStringArray(rules.antiAiPatterns).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    ...(rules.customNotes ? { customNotes: rules.customNotes } : {}),
  };
}

function toCharacterBibleSummary(bible: CharacterBible | null): StateOverviewCharacterBibleSummary {
  if (!bible) {
    return {
      available: false,
      characterCount: 0,
      keyCharacters: [],
    };
  }
  const characters = safeArray<CharacterBibleEntry>(bible.characters);
  return {
    available: true,
    characterCount: characters.length,
    keyCharacters: characters.slice(0, MAX_ITEMS).map((character) => ({
      id: character.id,
      name: character.name,
      role: character.role,
      ...(character.desire ? { desire: truncate(character.desire) } : {}),
      ...(character.fear ? { fear: truncate(character.fear) } : {}),
      ...(character.weakness ? { weakness: truncate(character.weakness) } : {}),
      appearanceAnchors: (character.appearanceAnchors ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(character.contradiction ? { contradiction: truncate(character.contradiction) } : {}),
      ...(character.moralBoundary ? { moralBoundary: truncate(character.moralBoundary) } : {}),
      ...(character.privateMotive ? { privateMotive: truncate(character.privateMotive) } : {}),
      ...(character.relationshipToProtagonist ? { relationshipToProtagonist: truncate(character.relationshipToProtagonist) } : {}),
      relationshipDynamics: (character.relationshipDynamics ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(character.trustLevel ? { trustLevel: character.trustLevel } : {}),
      ...(character.hiddenStance ? { hiddenStance: truncate(character.hiddenStance) } : {}),
      behaviorBoundaries: (character.behaviorBoundaries ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      knowledgeKnown: (character.knowledgeKnown ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      knowledgeUnknown: (character.knowledgeUnknown ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      cannotReveal: (character.cannotReveal ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      speechRules: (character.speechRules ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(character.speechStyle ? { speechStyle: truncate(character.speechStyle, 100) } : {}),
      speechSamples: (character.speechSamples ?? []).map((item) => truncate(item, 120)).slice(0, MAX_ITEMS),
      ...(character.arcPromise ? { arcPromise: truncate(character.arcPromise) } : {}),
      ...(character.currentStateHint ? { currentStateHint: truncate(character.currentStateHint) } : {}),
    })),
  };
}

function toWorldBibleSummary(bible: WorldBible | null, worldState?: WorldState | null): StateOverviewWorldBibleSummary {
  // 世界观 extraFields 存在 world/state.json（worldState），与 bible 相互独立——bible 缺失时也照常透出。
  const worldExtraFields = worldState?.extraFields ? { extraFields: worldState.extraFields } : {};
  if (!bible) {
    return {
      available: false,
      ruleCount: 0,
      factionCount: 0,
      systemCount: 0,
      keyRules: [],
      keyFactions: [],
      resourceRules: [],
      authorityRules: [],
      socialOrder: [],
      conflictSources: [],
      fixedFacts: [],
      protectedSecrets: [],
      publicFacts: [],
      hiddenFacts: [],
      forbiddenRuleBreaks: [],
      ...worldExtraFields,
    };
  }
  const rules = safeStringArray(bible.rules);
  const powerOrSurvivalSystems = safeStringArray(bible.powerOrSurvivalSystems);
  const factions = safeArray<WorldBible["factions"][number] | string>(bible.factions);
  const systems = powerOrSurvivalSystems.map((item) => truncate(item)).slice(0, MAX_ITEMS);
  return {
    available: true,
    ruleCount: rules.length,
    factionCount: factions.length,
    systemCount: powerOrSurvivalSystems.length,
    keyRules: rules.map((item) => truncate(item)).slice(0, MAX_ITEMS),
    keyFactions: factions.map((faction) => truncate(typeof faction === "string" ? faction : faction.name, 80)).slice(0, MAX_ITEMS),
    resourceRules: (safeStringArray(bible.resourceRules).length ? safeStringArray(bible.resourceRules) : systems).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    authorityRules: safeStringArray(bible.authorityRules).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    socialOrder: safeStringArray(bible.socialOrder).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    conflictSources: safeStringArray(bible.conflictSources).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    fixedFacts: [...safeStringArray(bible.fixedFacts), ...safeStringArray(bible.historyFacts)].map((item) => truncate(item)).slice(0, MAX_ITEMS),
    protectedSecrets: safeStringArray(bible.protectedSecrets).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    publicFacts: safeStringArray(bible.publicFacts).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    hiddenFacts: safeStringArray(bible.hiddenFacts).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    forbiddenRuleBreaks: safeStringArray(bible.forbiddenRuleBreaks).map((item) => truncate(item)).slice(0, MAX_ITEMS),
    ...worldExtraFields,
  };
}

function toLocationBibleSummary(bible: LocationBible | null): StateOverviewLocationBibleSummary {
  if (!bible) {
    return {
      available: false,
      locationCount: 0,
      activeLocationNames: [],
      riskCount: 0,
      resourceCount: 0,
      keyRisks: [],
      keyResources: [],
      keyNarrativeFunctions: [],
    };
  }
  const locations = safeArray<LocationBible["locations"][number]>(bible.locations);
  return {
    available: true,
    locationCount: locations.length,
    activeLocationNames: locations.map((location) => truncate(location.name, 80)).slice(0, MAX_ITEMS),
    riskCount: locations.reduce((sum, location) => sum + safeStringArray(location.risks).length, 0),
    resourceCount: locations.reduce((sum, location) => sum + safeStringArray(location.resources).length, 0),
    keyRisks: unique(locations.flatMap((location) => safeStringArray(location.risks).map((risk) => `${location.name}：${risk}`)))
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
    keyResources: unique(locations.flatMap((location) => safeStringArray(location.resources).map((resource) => `${location.name}：${resource}`)))
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
    keyNarrativeFunctions: locations
      .flatMap((location) => location.narrativeFunction ? [`${location.name}：${location.narrativeFunction}`] : [])
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
  };
}

function toAssetSummary(ledger: AssetLedger): StateOverviewAssetSummary {
  const assets = ledger.assets ?? [];
  return {
    available: assets.length > 0,
    carriedAssets: assets
      .filter((asset) => Boolean(asset.carriedByCharacterId))
      .map(formatAsset)
      .slice(0, MAX_ITEMS),
    ownedAssets: assets
      .filter((asset) => Boolean(asset.ownerCharacterId || asset.ownerName))
      .map(formatAsset)
      .slice(0, MAX_ITEMS),
    unavailableAssets: assets
      .filter((asset) => asset.status !== "available")
      .map(formatAsset)
      .slice(0, MAX_ITEMS),
    plotCriticalAssets: assets
      .filter((asset) => asset.isPlotCritical === true)
      .map(formatAsset)
      .slice(0, MAX_ITEMS),
    assetItems: assets.slice(0, MAX_ITEMS).map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      ...(asset.ownerName ?? asset.ownerCharacterId ? { owner: asset.ownerName ?? asset.ownerCharacterId } : {}),
      ...(asset.currentLocationName ?? asset.currentLocationId ? { currentLocation: asset.currentLocationName ?? asset.currentLocationId } : {}),
      ...(asset.carriedByCharacterId ? { carriedBy: asset.carriedByCharacterId } : {}),
      status: asset.status,
      ...(asset.isConsumable !== undefined ? { isConsumable: asset.isConsumable } : {}),
      ...(asset.isPlotCritical !== undefined ? { isPlotCritical: asset.isPlotCritical } : {}),
      // 防御：磁盘上若有 rules/usageRules/lossRules/notes 不是数组（旧数据或模型畸形），
      // safeStringArray 兜成空/过滤非字符串，绝不在字符串上 .map 把整个概览构建炸掉。
      rules: safeStringArray(asset.rules).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      usageRules: safeStringArray(asset.usageRules).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      lossRules: safeStringArray(asset.lossRules).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      notes: safeStringArray(asset.notes).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(asset.extraFields ? { extraFields: asset.extraFields } : {}),
    })),
  };
}

function toLocationDetailSummary(bible: LocationBible | null): StateOverviewLocationDetailSummary {
  const locations = safeArray<LocationBible["locations"][number]>(bible?.locations);
  return {
    locations: locations.slice(0, MAX_ITEMS).map((location) => ({
      id: location.id,
      name: location.name,
      type: location.type,
      ...(location.parentLocation ?? location.parentId ? { parentLocation: location.parentLocation ?? location.parentId } : {}),
      ...(location.currentKnownPosition ? { currentKnownPosition: truncate(location.currentKnownPosition, 80) } : {}),
      sensory: formatLocationSensory(location.sensoryDetails),
      ...(location.narrativeFunction ? { narrativeFunction: truncate(location.narrativeFunction) } : {}),
      possibleConflicts: safeStringArray(location.possibleConflicts).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(location.currentStatus ? { currentStatus: truncate(location.currentStatus, 80) } : {}),
      floors: safeStringArray(location.spatialStructure?.floors).map((item) => truncate(item, 80)).slice(0, MAX_ITEMS),
      rooms: safeStringArray(location.spatialStructure?.rooms).map((item) => truncate(item, 80)).slice(0, MAX_ITEMS),
      entrances: safeStringArray(location.spatialStructure?.entrances).map((item) => truncate(item, 80)).slice(0, MAX_ITEMS),
      exits: safeStringArray(location.spatialStructure?.exits).map((item) => truncate(item, 80)).slice(0, MAX_ITEMS),
      travelRules: safeArray<LocationTravelRule>(location.travelRules).map((rule) => truncate(formatTravelRule(location.name, rule))).slice(0, MAX_ITEMS),
      risks: safeStringArray(location.risks).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      resources: safeStringArray(location.resources).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      fixedFacts: safeStringArray(location.fixedFacts).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      hiddenFacts: safeStringArray(location.hiddenFacts).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(location.extraFields ? { extraFields: location.extraFields } : {}),
    })),
    floors: unique(locations.flatMap((location) => safeStringArray(location.spatialStructure?.floors)))
      .map((item) => truncate(item, 80))
      .slice(0, MAX_ITEMS),
    rooms: unique(locations.flatMap((location) => safeStringArray(location.spatialStructure?.rooms)))
      .map((item) => truncate(item, 80))
      .slice(0, MAX_ITEMS),
    entrances: unique(locations.flatMap((location) => safeStringArray(location.spatialStructure?.entrances)))
      .map((item) => truncate(item, 80))
      .slice(0, MAX_ITEMS),
    exits: unique(locations.flatMap((location) => safeStringArray(location.spatialStructure?.exits)))
      .map((item) => truncate(item, 80))
      .slice(0, MAX_ITEMS),
    travelRules: unique(locations.flatMap((location) => safeArray<LocationTravelRule>(location.travelRules).map((rule) => formatTravelRule(location.name, rule))))
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
    risks: unique(locations.flatMap((location) => safeStringArray(location.risks).map((risk) => `${location.name}：${risk}`)))
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
    resources: unique(locations.flatMap((location) => safeStringArray(location.resources).map((resource) => `${location.name}：${resource}`)))
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
    fixedFacts: unique(locations.flatMap((location) => safeStringArray(location.fixedFacts).map((fact) => `${location.name}：${fact}`)))
      .map((item) => truncate(item))
      .slice(0, MAX_ITEMS),
  };
}

function toCharacterDetailSummary(
  bible: CharacterBible | null,
  characters: readonly { readonly profile: CharacterProfile; readonly state?: CharacterState }[],
): StateOverviewCharacterDetailSummary {
  const byId = new Map(characters.map((item) => [item.profile.id, item]));
  const byName = new Map(characters.map((item) => [item.profile.name, item]));
  return {
    characters: mergeCharacterBibleEntries(bible, characters).slice(0, MAX_ITEMS).map((character) => {
      const runtime = byId.get(character.id) ?? byName.get(character.name);
      const mood = firstText([
        runtime?.state?.mood,
        runtime?.state?.emotion,
      ]);
      const currentGoal = firstText([
        runtime?.state?.currentGoal,
        runtime?.state?.goal,
      ]);
      const recentEvents = safeStringArray(runtime?.state?.recentEvents).map((event) => truncate(event)).slice(0, MAX_ITEMS);
      const currentState = firstText([
        runtime?.state?.currentPhysicalState,
        runtime?.state?.currentMentalState,
        mood,
      ]);
      return {
        id: character.id,
        name: character.name,
        ...(character.age ?? runtime?.profile.age ? { age: character.age ?? runtime?.profile.age } : {}),
        ...(character.speechStyle ? { speechStyle: truncate(character.speechStyle, 80) } : {}),
        speechSamples: (character.speechSamples ?? []).map((item) => truncate(item, 100)).slice(0, MAX_ITEMS),
        ...(mood ? { mood: truncate(mood, 80) } : {}),
        ...(currentGoal ? { currentGoal: truncate(currentGoal) } : {}),
        ...(recentEvents.length ? { recentEvents } : {}),
        ...(currentState ? { currentState: truncate(currentState, 80) } : {}),
        cannotDo: (character.cannotDo ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      };
    }),
  };
}

function toCharacterMatrix(input: {
  readonly characterBible: CharacterBible | null;
  readonly characterMatrixLedger: CharacterMatrixLedger;
  readonly characters: readonly { readonly profile: CharacterProfile; readonly state?: CharacterState }[];
  readonly assetLedger: AssetLedger;
  readonly timelineEvents: readonly TimelineEvent[];
  readonly storyBibleSummary: StateOverviewStoryBibleSummary;
  readonly worldProtectedSecrets: readonly string[];
}): StateOverviewCharacterMatrix {
  const runtimeById = new Map(input.characters.map((item) => [item.profile.id, item]));
  const runtimeByName = new Map(input.characters.map((item) => [item.profile.name, item]));
  const mergedCharacters = mergeCharacterBibleEntries(input.characterBible, input.characters);
  const protagonist = mergedCharacters.find(isProtagonistCharacter) ?? mergedCharacters[0];
  const relationshipsByCharacter = new Map<string, StateOverviewCharacterRelationship[]>();

  for (const character of mergedCharacters) {
    if (!protagonist || character.id === protagonist.id || !character.relationshipToProtagonist) continue;
    const relationToProtagonist = toCharacterRelationship(protagonist, character, character.relationshipToProtagonist);
    relationshipsByCharacter.set(character.id, [
      ...(relationshipsByCharacter.get(character.id) ?? []),
      relationToProtagonist,
    ]);
    relationshipsByCharacter.set(protagonist.id, [
      ...(relationshipsByCharacter.get(protagonist.id) ?? []),
      {
        targetCharacterId: character.id,
        targetName: character.name,
        relationType: relationToProtagonist.relationType,
        ...(relationToProtagonist.attitude ? { attitude: relationToProtagonist.attitude } : {}),
        ...(relationToProtagonist.trustLevel ? { trustLevel: relationToProtagonist.trustLevel } : {}),
        ...(relationToProtagonist.trustPercent ? { trustPercent: relationToProtagonist.trustPercent } : {}),
        ...(relationToProtagonist.conflict ? { conflict: relationToProtagonist.conflict } : {}),
        ...(relationToProtagonist.secret ? { secret: relationToProtagonist.secret } : {}),
        ...(relationToProtagonist.lastChangedChapter ? { lastChangedChapter: relationToProtagonist.lastChangedChapter } : {}),
      },
    ]);
  }

  const protectedSecrets = unique([
    ...input.storyBibleSummary.protectedSecrets,
    ...input.storyBibleSummary.coreMysteries,
    ...input.worldProtectedSecrets,
  ].map((item) => truncate(item))).slice(0, MAX_ITEMS);
  const forbiddenReveals = unique([
    ...input.storyBibleSummary.forbiddenChanges,
    ...input.storyBibleSummary.coreMysteries,
    ...input.storyBibleSummary.protectedSecrets,
  ].map((item) => truncate(item))).slice(0, MAX_ITEMS);

  const matrixCharacters = mergedCharacters.slice(0, MAX_ITEMS).map((character) => {
    const runtime = runtimeById.get(character.id) ?? runtimeByName.get(character.name);
    const assets = assetsForCharacter(input.assetLedger, character);
    const currentLocation = lastLocationForCharacter(input.timelineEvents, character.name, character.id);
    const lastSeenChapter = lastChapterForCharacter(input.timelineEvents, character.name, character.id)
      ?? runtime?.state?.lastUpdatedChapter
      ?? null;
    const relationships = relationshipsByCharacter.get(character.id) ?? [];
    const knownFacts = unique([...(character.knowledgeKnown ?? [])].map((item) => truncate(item))).slice(0, MAX_ITEMS);
    const unknownTruths = unique([...(character.knowledgeUnknown ?? [])].map((item) => truncate(item))).slice(0, MAX_ITEMS);
    const cannotDo = unique([...(character.cannotDo ?? [])].map((item) => truncate(item))).slice(0, MAX_ITEMS);
    const cannotReveal = unique([...(character.cannotReveal ?? [])].map((item) => truncate(item))).slice(0, MAX_ITEMS);
    const riskReminders = buildCharacterRiskReminders({
      character,
      knownFacts,
      unknownTruths,
      cannotDo,
      cannotReveal,
      protectedSecrets,
      forbiddenReveals,
      relationships,
    });

    // canonical 真值源（受控破例④·确定性）：职能三名合一、身份单源、位置/精神/目标收敛。
    const narrativeRoleField = character.extraFields?.["叙事岗位"];
    const narrativeRole = typeof narrativeRoleField === "string"
      ? narrativeRoleField
      : Array.isArray(narrativeRoleField) ? narrativeRoleField.join("、") : undefined;
    const canonicalRole = resolveCharacterRole({
      narrativeRole,
      bibleRole: toReadableCharacterRole(character.role) ?? character.role,
    });
    const canonicalIdentity = resolveIdentity({
      bibleIdentity: character.identity,
      runtimeIdentity: runtime?.profile.identity,
    });
    const canonicalLocation = resolveCurrentLocation({
      runtimeLocationName: runtime?.state?.currentLocationName,
      timelineLocation: currentLocation,
    });
    const canonicalMentalState = resolveMentalState(runtime?.state);
    const canonicalGoal = resolveCurrentGoal(runtime?.state);

    return {
      id: character.id,
      name: character.name,
      role: canonicalRole ?? character.role,
      ...(character.age ?? runtime?.profile.age ? { age: character.age ?? runtime?.profile.age } : {}),
      ...(character.gender ?? runtime?.profile.gender ? { gender: character.gender ?? runtime?.profile.gender } : {}),
      ...(canonicalIdentity ? { identity: toReadableCharacterRole(canonicalIdentity) ?? canonicalIdentity } : {}),
      ...(character.privateMotive ? { faction: truncate(character.privateMotive, 80) } : {}),
      ...(character.desire ?? character.longTermDesire ? { desire: truncate(character.desire ?? character.longTermDesire ?? "") } : {}),
      ...(character.fear ? { fear: truncate(character.fear) } : {}),
      ...(character.weakness ? { weakness: truncate(character.weakness) } : {}),
      appearanceAnchors: dedupeAppearanceAnchors((character.appearanceAnchors ?? runtime?.profile.appearanceAnchors ?? []).map((item) => truncate(item, 80))).slice(0, MAX_ITEMS),
      ...(character.contradiction ? { contradiction: truncate(character.contradiction) } : {}),
      ...(character.moralBoundary ? { moralBoundary: truncate(character.moralBoundary) } : {}),
      ...(character.privateMotive ? { privateMotive: truncate(character.privateMotive, 100) } : {}),
      relationshipDynamics: (character.relationshipDynamics ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      ...(character.trustLevel ? { trustLevel: character.trustLevel } : {}),
      ...(character.hiddenStance ? { hiddenStance: truncate(character.hiddenStance) } : {}),
      behaviorBoundaries: (character.behaviorBoundaries ?? []).map((item) => truncate(item)).slice(0, MAX_ITEMS),
      cannotDo,
      cannotReveal,
      ...(character.speechStyle ? { speechStyle: truncate(character.speechStyle, 100) } : {}),
      speechSamples: (character.speechSamples ?? []).map((item) => truncate(item, 120)).slice(0, MAX_ITEMS),
      knownFacts,
      unknownTruths,
      protectedSecrets,
      forbiddenReveals,
      ...(canonicalLocation ? { currentLocation: canonicalLocation } : {}),
      ...(runtime?.state?.mood ?? runtime?.state?.emotion ? { mood: truncate(runtime?.state?.mood ?? runtime?.state?.emotion ?? "", 80) } : {}),
      ...(runtime?.state?.currentPhysicalState ? { physicalState: truncate(runtime.state.currentPhysicalState, 80) } : {}),
      ...(canonicalMentalState ? { mentalState: truncate(canonicalMentalState, 80) } : {}),
      ...(runtime?.state?.currentResourceState ? { resourceState: truncate(runtime.state.currentResourceState, 80) } : {}),
      ...(canonicalGoal ? { currentGoal: truncate(canonicalGoal) } : {}),
      ...(runtime?.state?.recentEvents?.length ? { recentEvents: safeStringArray(runtime.state.recentEvents).map((event) => truncate(event)).slice(0, MAX_ITEMS) } : {}),
      ...(lastSeenChapter ? { lastSeenChapter } : {}),
      carriedAssets: assets.carriedAssets,
      ownedAssets: assets.ownedAssets,
      plotCriticalAssets: assets.plotCriticalAssets,
      ...(character.relationshipToProtagonist ? { relationshipToProtagonist: truncate(character.relationshipToProtagonist, 80) } : {}),
      relationships,
      riskReminders,
      ...(character.extraFields ? { extraFields: character.extraFields } : {}),
    };
  });
  const formalNames = new Set(mergedCharacters.flatMap((character) => [character.id, character.name]));
  const matrixCandidateCharacters = (input.characterMatrixLedger.entries ?? [])
    .filter((entry) => entry.status !== "ignored")
    .filter((entry) => !formalNames.has(entry.id) && !formalNames.has(entry.name))
    .slice(0, Math.max(0, MAX_ITEMS - matrixCharacters.length))
    .map((entry): StateOverviewCharacterMatrixItem => {
      const relationships = protagonist && entry.relationToProtagonist
        ? [buildCanonicalRelationship({
          targetCharacterId: protagonist.id,
          targetName: protagonist.name,
          relationshipText: entry.relationToProtagonist,
          ...(entry.lastSeenChapter ? { lastChangedChapter: entry.lastSeenChapter } : {}),
        })]
        : [];
      return {
        id: entry.id,
        name: entry.name,
        role: entry.roleHint ?? "候选人物",
        appearanceAnchors: [],
        relationshipDynamics: [],
        behaviorBoundaries: [],
        cannotDo: [],
        cannotReveal: [],
        speechSamples: [],
        knownFacts: entry.evidence.map((item) => truncate(item)).slice(0, MAX_ITEMS),
        unknownTruths: [entry.riskHint ?? "身份、立场、关系待补全"].filter(isNonEmptyString),
        protectedSecrets,
        forbiddenReveals,
        ...(entry.appearances[0]?.location ? { currentLocation: truncate(entry.appearances[0].location, 80) } : {}),
        ...(entry.lastSeenChapter ? { lastSeenChapter: entry.lastSeenChapter } : {}),
        carriedAssets: [],
        ownedAssets: [],
        plotCriticalAssets: [],
        ...(entry.relationToProtagonist ? { relationshipToProtagonist: truncate(entry.relationToProtagonist, 80) } : {}),
        relationships,
        riskReminders: [entry.riskHint ?? "候选人物未升级角色档案"].filter(isNonEmptyString),
        status: entry.status,
        ...(entry.roleHint ? { roleHint: entry.roleHint } : {}),
        ...(entry.firstSeenChapter ? { firstSeenChapter: entry.firstSeenChapter } : {}),
        evidence: entry.evidence,
        appearanceRecords: entry.appearances,
        relationshipEvents: entry.relationshipEvents,
      };
    });
  const allMatrixCharacters = [...matrixCharacters, ...matrixCandidateCharacters];
  // 候选边并进 matrix 顶层时必须与正式边同构：正式边是「主角→对方」(target=对方)，
  // 而候选节点自身的 .relationships 是「候选→主角」(target=主角)——若直接 flatten 进来，
  // characterGraph 的 from(默认主角)→to(主角) 会成自环被跳过 → 关系网画不出候选边。
  // 这里为每个【带 relationToProtagonist 的】候选单独生成主角视角边(target=候选)，
  // 候选节点自身的 .relationships 保持不动(供候选节点自身视角/账本用)。
  const candidateRelationships = protagonist
    ? matrixCandidateCharacters
        .filter((character) => isNonEmptyString(character.relationshipToProtagonist))
        .map((character) => buildCanonicalRelationship({
          targetCharacterId: character.id,
          targetName: character.name,
          relationshipText: character.relationshipToProtagonist ?? "",
          ...(character.lastSeenChapter ? { lastChangedChapter: character.lastSeenChapter } : {}),
        }))
    : [];

  return {
    available: allMatrixCharacters.length > 0,
    characters: allMatrixCharacters,
    relationships: [
      ...[...relationshipsByCharacter.entries()]
        .flatMap(([sourceId, relationships]) => relationships.map((relationship) => ({ sourceId, relationship })))
        .filter((item) => protagonist ? item.sourceId === protagonist.id : true)
        .map((item) => item.relationship)
        .slice(0, MAX_ITEMS),
      ...candidateRelationships,
    ].slice(0, MAX_ITEMS),
    riskReminders: unique(allMatrixCharacters.flatMap((character) => character.riskReminders)).slice(0, MAX_ITEMS),
  };
}

/**
 * 从关系文本构建 canonical 关系（受控破例④·确定性、题材中立）：
 * relationType + 去重 attitude（resolveRelationDescriptor，attitude===relationType 时丢弃）
 * + 三档信任及派生 trustPercent（resolveTrust）+ conflict/secret。所有关系边的唯一构建入口。
 */
function buildCanonicalRelationship(input: {
  readonly targetCharacterId: string;
  readonly targetName: string;
  readonly relationshipText: string;
  readonly lastChangedChapter?: number;
}): StateOverviewCharacterRelationship {
  const text = input.relationshipText;
  const descriptor = resolveRelationDescriptor(text, {
    relationType: inferRelationType,
    attitude: inferAttitude,
  });
  const trust = resolveTrust(inferTrustLevel(text));
  const conflict = /敌|压制|怀疑|冲突|对手|反派|忌惮/u.test(text) ? truncate(text) : undefined;
  const secret = /隐藏|秘密|未知|伪装/u.test(text) ? truncate(text) : undefined;
  return {
    targetCharacterId: input.targetCharacterId,
    targetName: input.targetName,
    relationType: descriptor.relationType,
    ...(descriptor.attitude ? { attitude: descriptor.attitude } : {}),
    ...(trust ? { trustLevel: trust.level, trustPercent: trust.percent } : {}),
    ...(conflict ? { conflict } : {}),
    ...(secret ? { secret } : {}),
    ...(input.lastChangedChapter ? { lastChangedChapter: input.lastChangedChapter } : {}),
  };
}

function mergeCharacterBibleEntries(
  bible: CharacterBible | null,
  characters: readonly { readonly profile: CharacterProfile; readonly state?: CharacterState }[],
): readonly CharacterBibleEntry[] {
  const merged: CharacterBibleEntry[] = [...safeArray<CharacterBibleEntry>(bible?.characters)];
  for (const item of characters) {
    const runtimeEntry = toRuntimeCharacterBibleEntry(item);
    const existingIndex = merged.findIndex((character) => sameCharacterEntry(character, runtimeEntry));
    if (existingIndex < 0) {
      merged.push(runtimeEntry);
      continue;
    }

    const existing = merged[existingIndex] as CharacterBibleEntry;
    merged[existingIndex] = {
      ...runtimeEntry,
      ...existing,
      age: existing.age ?? runtimeEntry.age,
      gender: existing.gender ?? runtimeEntry.gender,
      identity: existing.identity ?? runtimeEntry.identity,
    };
  }
  return merged;
}

function toRuntimeCharacterBibleEntry(item: { readonly profile: CharacterProfile }): CharacterBibleEntry {
  return {
    id: item.profile.id,
    name: item.profile.name,
    role: item.profile.identity ?? "配角",
    age: item.profile.age,
    gender: item.profile.gender,
    identity: item.profile.identity,
    behaviorBoundaries: [],
    knowledgeKnown: [],
    knowledgeUnknown: [],
    speechRules: [],
    speechSamples: [],
    cannotDo: [],
  };
}

function sameCharacterEntry(left: CharacterBibleEntry, right: CharacterBibleEntry): boolean {
  return left.id === right.id || left.name === right.name;
}

function isProtagonistCharacter(character: CharacterBible["characters"][number]): boolean {
  return character.role === "protagonist" || character.role === "主角";
}

function toCharacterRelationship(
  protagonist: CharacterBible["characters"][number],
  _character: CharacterBible["characters"][number],
  relationshipText: string,
): StateOverviewCharacterRelationship {
  return buildCanonicalRelationship({
    targetCharacterId: protagonist.id,
    targetName: protagonist.name,
    relationshipText,
  });
}

function inferRelationType(text: string): string {
  if (/亲|父|母|兄|弟|姐|妹|家人/u.test(text)) return "亲人";
  if (/友|伙伴|盟友/u.test(text)) return "朋友";
  if (/敌|反派|对手/u.test(text)) return "敌人";
  if (/上级|下属|主管|老板/u.test(text)) return "上下级";
  if (/暧昧|恋/u.test(text)) return "暧昧";
  if (/合作|同盟/u.test(text)) return "合作";
  if (/怀疑|试探/u.test(text)) return "怀疑";
  if (/隐藏|秘密/u.test(text)) return "隐藏关系";
  return truncate(text, 40);
}

function inferAttitude(text: string): string | undefined {
  if (/信任|相信/u.test(text)) return "信任";
  if (/怀疑/u.test(text)) return "怀疑";
  if (/敌意|敌对|压制/u.test(text)) return "敌意";
  if (/依赖/u.test(text)) return "依赖";
  if (/试探/u.test(text)) return "试探";
  if (/忌惮/u.test(text)) return "忌惮";
  return undefined;
}

function inferTrustLevel(text: string): "low" | "medium" | "high" | undefined {
  if (/不信|怀疑|敌|压制|忌惮/u.test(text)) return "low";
  if (/信任|亲密|盟友/u.test(text)) return "high";
  if (text.trim()) return "medium";
  return undefined;
}

function assetsForCharacter(ledger: AssetLedger, character: CharacterBible["characters"][number]): {
  readonly carriedAssets: readonly string[];
  readonly ownedAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
} {
  const assets = ledger.assets ?? [];
  const belongsToCharacter = (asset: AssetLedger["assets"][number]) =>
    asset.ownerCharacterId === character.id
    || asset.carriedByCharacterId === character.id
    || asset.ownerName === character.name;
  return {
    carriedAssets: assets.filter((asset) => asset.carriedByCharacterId === character.id || (asset.ownerName === character.name && Boolean(asset.carriedByCharacterId))).map(formatAsset).slice(0, MAX_ITEMS),
    ownedAssets: assets.filter(belongsToCharacter).map(formatAsset).slice(0, MAX_ITEMS),
    plotCriticalAssets: assets.filter((asset) => belongsToCharacter(asset) && asset.isPlotCritical === true).map(formatAsset).slice(0, MAX_ITEMS),
  };
}

function lastLocationForCharacter(timelineEvents: readonly TimelineEvent[], name: string, id: string): string | undefined {
  const event = [...timelineEvents].reverse().find((item) => item.participants.includes(id) || item.participants.includes(name));
  const semantic = event ? readSemanticSummary(event) : undefined;
  const locations = semantic?.locations;
  const location = bestSemanticLocation(Array.isArray(locations) ? locations : []);
  return location ? truncate(location, 80) : undefined;
}

function lastChapterForCharacter(timelineEvents: readonly TimelineEvent[], name: string, id: string): number | undefined {
  return [...timelineEvents].reverse().find((item) => item.participants.includes(id) || item.participants.includes(name))?.chapter;
}

function buildCharacterRiskReminders(input: {
  readonly character: CharacterBible["characters"][number];
  readonly knownFacts: readonly string[];
  readonly unknownTruths: readonly string[];
  readonly cannotDo: readonly string[];
  readonly cannotReveal: readonly string[];
  readonly protectedSecrets: readonly string[];
  readonly forbiddenReveals: readonly string[];
  readonly relationships: readonly StateOverviewCharacterRelationship[];
}): string[] {
  return unique([
    ...input.unknownTruths.map((item) => `${input.character.name} 不知道：${item}`),
    ...input.cannotReveal.map((item) => `${input.character.name} 不能提前透露：${item}`),
    ...input.protectedSecrets.map((item) => `不要让 ${input.character.name} 提前知道：${item}`),
    ...input.forbiddenReveals.map((item) => `禁止提前揭开：${item}`),
    ...input.cannotDo.map((item) => `${input.character.name} 不能做：${item}`),
    ...input.relationships
      .filter((relationship) => relationship.secret || relationship.conflict)
      .map((relationship) => `${input.character.name} 与 ${relationship.targetName} 的关系风险：${relationship.secret ?? relationship.conflict}`),
  ]).slice(0, MAX_ITEMS);
}

function toFoundationCompleteness(input: {
  readonly storyBible: StoryBible | null;
  readonly writingRules: WritingRules | null;
  readonly characterBible: CharacterBible | null;
  readonly worldBible: WorldBible | null;
  readonly locationBible: LocationBible | null;
  readonly assetLedger: AssetLedger;
}): StateOverviewFoundationCompleteness {
  const missing: string[] = [];
  const characters = safeArray<CharacterBibleEntry>(input.characterBible?.characters);
  const locations = safeArray<LocationBible["locations"][number]>(input.locationBible?.locations);
  const protagonist = characters.find((character) => character.role === "主角" || character.role === "protagonist")
    ?? characters[0];
  const initialLocation = locations[0];

  if (!protagonist?.age) missing.push("主角年龄");
  if (!protagonist?.identity && !protagonist?.role) missing.push("主角身份");
  if (!protagonist?.desire && !protagonist?.longTermDesire) missing.push("主角目标");
  if ((protagonist?.behaviorBoundaries ?? []).length === 0) missing.push("主角边界");
  if (!protagonist?.speechStyle && (protagonist?.speechSamples ?? []).length === 0) missing.push("主角说话风格样本");
  if ((protagonist?.knowledgeKnown ?? []).length === 0 || (protagonist?.knowledgeUnknown ?? []).length === 0) missing.push("主角知道/不知道");
  if (!initialLocation?.spatialStructure || ((initialLocation.spatialStructure.floors ?? []).length === 0 && (initialLocation.spatialStructure.rooms ?? []).length === 0)) missing.push("初始地点空间结构");
  if ((initialLocation?.travelRules ?? []).length === 0) missing.push("初始地点移动规则");
  if ((input.assetLedger.assets ?? []).length === 0) missing.push("资产账本");
  if (safeStringArray(input.storyBible?.protectedSecrets).length === 0 && safeStringArray(input.storyBible?.coreMysteries).length === 0) missing.push("禁止提前揭开");
  if (!input.storyBible?.firstChapterSetup?.goal) missing.push("第一章方向");
  if (!input.writingRules?.narrativePerspective || safeStringArray(input.writingRules.proseStyle).length === 0) missing.push("写作规则");
  if (safeStringArray(input.worldBible?.rules).length === 0 || safeStringArray(input.storyBible?.centralConflicts).length === 0) missing.push("世界核心规则和冲突来源");

  const readinessLevel = missing.length === 0 ? "ready" : missing.length <= 3 ? "warning" : "high_risk";
  return {
    passed: missing.length === 0,
    readinessLevel,
    missingItems: missing,
    suggestions: missing.map((item) => `建议补充：${item}`),
  };
}

function formatAsset(asset: AssetLedger["assets"][number]): string {
  return [asset.name, asset.status !== "available" ? asset.status : undefined, asset.conditionNote].filter(isNonEmptyString).join(" · ");
}

function formatTravelRule(sourceLocation: string, rule: { readonly from?: string; readonly targetLocation: string; readonly method: string; readonly durationMinutes?: number; readonly constraint?: string }): string {
  return [
    `${rule.from ?? sourceLocation} -> ${rule.targetLocation}`,
    rule.method,
    typeof rule.durationMinutes === "number" ? `${rule.durationMinutes}分钟` : undefined,
    rule.constraint,
  ].filter(isNonEmptyString).join(" · ");
}

function formatLocationSensory(details: LocationBible["locations"][number]["sensoryDetails"]): readonly string[] {
  if (!details) return [];
  return [
    ...((details.visual ?? []).map((item) => `视觉：${item}`)),
    ...((details.sound ?? []).map((item) => `声音：${item}`)),
    ...((details.smell ?? []).map((item) => `气味：${item}`)),
    ...((details.touch ?? []).map((item) => `触感：${item}`)),
  ].map((item) => truncate(item)).slice(0, MAX_ITEMS);
}

function buildStoryFoundationSummary(input: {
  readonly storyBible: StateOverviewStoryBibleSummary;
  readonly writingRules: StateOverviewWritingRulesSummary;
  readonly characterBible: StateOverviewCharacterBibleSummary;
  readonly worldBible: StateOverviewWorldBibleSummary;
  readonly locationBible: StateOverviewLocationBibleSummary;
}): string {
  const available = [
    input.storyBible.available ? "story bible" : undefined,
    input.writingRules.available ? "writing rules" : undefined,
    input.characterBible.available ? `${input.characterBible.characterCount} character bible entries` : undefined,
    input.worldBible.available ? `${input.worldBible.ruleCount} world rules` : undefined,
    input.locationBible.available ? `${input.locationBible.locationCount} locations` : undefined,
  ].filter(isNonEmptyString);
  if (available.length === 0) return "Story foundation files are missing; overview is using empty foundation summaries.";
  return truncate(`Foundation available: ${available.join(", ")}.`);
}

async function readCharacters(projectDir: string): Promise<readonly { readonly profile: CharacterProfile; readonly state?: CharacterState }[]> {
  const charactersDir = join(projectDir, "characters");
  const entries = await readdir(charactersDir, { withFileTypes: true }).catch(() => []);
  const result = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const profile = await readJsonSafe<CharacterProfile | null>(projectDir, join("characters", entry.name, "profile.json"), null);
      if (!profile) return undefined;
      const state = await readJsonSafe<CharacterState | undefined>(projectDir, join("characters", entry.name, "state.json"), undefined);
      return {
        profile,
        ...(state !== undefined ? { state } : {}),
      };
    }));
  return result.filter((item): item is { readonly profile: CharacterProfile; readonly state?: CharacterState } => item !== undefined);
}

async function readJsonSafe<T>(projectDir: string, relativePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as T;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) return fallback;
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

function hookRisk(hook: HookItem): "low" | "medium" | "high" {
  const evidenceCount = hook.evidence?.length ?? 0;
  if (hook.nextActionHint) return "high";
  if (evidenceCount > 1 || hook.status === "active") return "medium";
  return "low";
}

function buildRecommendedPanels(input: {
  readonly hookPool: HookPool;
  readonly threadPool: ThreadPool;
  readonly arcGoalPool: ArcGoalPool;
  readonly cleanupVisibleCount: number;
}): readonly string[] {
  const panels = ["chapter_preview", "state_overview"];
  if (input.threadPool.threads.some((thread) => thread.status === "open" || thread.status === "touched")) panels.push("thread_pool");
  if (input.hookPool.hooks.some((hook) => hook.status === "active" || hook.status === "seeded")) panels.push("hook_pool");
  if (input.arcGoalPool.goals.some((goal) => goal.status === "active" || goal.status === "touched")) panels.push("arc_goals");
  if (input.cleanupVisibleCount > 0) panels.push("maintenance_diagnostics");
  return panels;
}

function buildWarnings(input: {
  readonly hookPool: HookPool;
  readonly threadPool: ThreadPool;
  readonly arcGoalPool: ArcGoalPool;
  readonly cleanupVisibleCount: number;
}): readonly string[] {
  const warnings: string[] = [];
  if (input.threadPool.threads.filter((thread) => thread.status === "open").length > 30) warnings.push("many_open_threads");
  if (input.cleanupVisibleCount > 0) warnings.push("cleanup_candidates_visible");
  if (!input.arcGoalPool.goals.some((goal) => goal.status === "active" || goal.status === "touched")) warnings.push("no_active_arc_goals");
  if (!input.hookPool.hooks.some((hook) => hook.status === "active" || hook.status === "seeded")) warnings.push("no_active_hooks");
  return warnings;
}

function lastSemanticObjective(events: readonly TimelineEvent[]): string | undefined {
  for (const event of events.slice().reverse()) {
    const semantic = readSemanticSummary(event);
    for (const key of ["decision", "nextLead", "discovery"] as const) {
      const value = semantic?.[key];
      if (typeof value !== "string") continue;
      const objective = cleanObjectiveText(value);
      if (objective) return objective;
    }
  }
  return undefined;
}

function cleanObjectiveText(value: string): string | undefined {
  const text = truncate(value.trim(), 80);
  if (!text || isOrdinaryActionObjective(text)) return undefined;
  if (/(?:查清|追查|确认|找到|前往|询问|验证|调查|弄清|搞清|继续|线索|异常|申请|检测|记录)/u.test(text)) return text;
  return undefined;
}

function isOrdinaryActionObjective(value: string): boolean {
  const text = value.trim();
  if (/(?:查清|追查|确认|找到|前往|询问|验证|调查|弄清|搞清|继续|线索|异常|申请|检测|记录)/u.test(text)) return false;
  return /(?:把|将).{0,24}(?:抽回|抽回来|折好|塞回|收起|放回|拿起|放下|拉上|关掉|打开|站起来|坐下|转身|看了看|扫了一眼|准备走)|(?:抽回|抽回来|折好|塞回|收起|放回|站起来|坐下|转身离开|看了一眼|准备走)|(?:没打算|不打算|不想|没有说话|没说话|觉得不对劲|感觉不对劲|不想再等|不愿再等)/u.test(text);
}

// 题材中立的「具体地点」结构后缀：纯空间构词成分（厅/口/室/楼/层/站/区…），
// 不含任何题材专名（旧版写死的若干题材特定地名表已删，改读 bible）。
// 用于在没有 bible 命中时判断一个语义地点是否足够具体（影响选当前位置的打分排序）。
const STRUCTURAL_LOCATION_SUFFIX = /(?:楼梯间|窗口|大厅|站台|街口|正门|门口|入口|出口|通道|大殿|公寓|建筑|广场|庭院|店面|柜台|前厅|后院|仓库|厅|室|楼|层|站|台|区|间|殿|阁|院|峰|巷|坊|府|苑|库|仓|场|园|塔|桥|门|口)$/u;

// 题材中立的「楼层/序数」归一化：把「一楼/二楼/三楼…十楼」与「1楼/2楼/3楼…」互通，
// 让 semanticSummary 里的口语楼层能匹配 bible 里登记的数字楼层（反之亦然），不写死具体楼层名。
const FLOOR_DIGIT_BY_CHINESE: Readonly<Record<string, string>> = {
  零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5",
  六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
};

function normalizeFloorTokens(value: string): string {
  // 「一楼」→「1楼」「2楼」→既保留也补出「二楼」形式，统一成数字，便于子串互查。
  return value.replace(/[零〇一二两三四五六七八九十]+(?=楼|层)/gu, (run) => {
    if (run === "十") return "10";
    const mapped = Array.from(run).map((ch) => FLOOR_DIGIT_BY_CHINESE[ch] ?? ch).join("");
    return mapped;
  });
}

// 从 location-bible 抽出的题材中立空间词表：登记的地名 + 各地点的楼层/房间/出入口/相连地点。
// 用它替代写死的专名映射，做「语义地点 ↔ 已登记地点」的具体度判定与别名匹配。
interface SpatialVocabulary {
  // 已登记地点名（顶层 name）。
  readonly names: readonly string[];
  // 所有已登记的空间子部件 token（floors/rooms/entrances/exits/connectedLocations）。
  readonly parts: readonly string[];
}

const EMPTY_SPATIAL_VOCABULARY: SpatialVocabulary = { names: [], parts: [] };

function buildSpatialVocabulary(bible: LocationBible | null): SpatialVocabulary {
  const locations = safeArray<LocationBible["locations"][number]>(bible?.locations);
  const names = unique(locations.map((location) => location.name).filter(isNonEmptyString));
  const parts = unique(locations.flatMap((location) => [
    ...safeStringArray(location.spatialStructure?.floors),
    ...safeStringArray(location.spatialStructure?.rooms),
    ...safeStringArray(location.spatialStructure?.entrances),
    ...safeStringArray(location.spatialStructure?.exits),
    ...safeStringArray(location.connectedLocations),
  ]));
  return { names, parts };
}

function isRegisteredSpatialPart(location: string, vocabulary: SpatialVocabulary): boolean {
  const normalized = normalizeFloorTokens(location);
  return vocabulary.parts.some((part) => {
    if (part === location || part.includes(location) || location.includes(part)) return true;
    const normalizedPart = normalizeFloorTokens(part);
    return normalizedPart === normalized || normalizedPart.includes(normalized) || normalized.includes(normalizedPart);
  });
}

function lastSemanticLocation(events: readonly TimelineEvent[], knownLocations: readonly string[], vocabulary: SpatialVocabulary): string | undefined {
  for (const event of events.slice().reverse()) {
    const semantic = readSemanticSummary(event);
    if (Array.isArray(semantic?.locations)) {
      const location = bestSemanticLocation(semantic.locations.filter((item): item is string => typeof item === "string"
        && item.trim().length > 0
        && (knownLocations.length === 0
          || knownLocations.some((known) => semanticLocationMatchesKnown(item, known))
          || isSpecificSemanticLocation(item, vocabulary))), vocabulary);
      if (location) return truncate(location, 80);
    }
  }
  return undefined;
}

function bestSemanticLocation(locations: readonly unknown[], vocabulary: SpatialVocabulary = EMPTY_SPATIAL_VOCABULARY): string | undefined {
  return locations
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .filter((location) => isSpecificSemanticLocation(location, vocabulary) || !isPseudoLocation(location))
    .sort((left, right) => locationSpecificity(right, vocabulary) - locationSpecificity(left, vocabulary) || right.length - left.length)[0];
}

// 具体语义地点 = 命中 bible 登记的空间部件，或带题材中立的结构后缀（厅/口/楼梯间…），且不是泛指语。
function isSpecificSemanticLocation(location: string, vocabulary: SpatialVocabulary): boolean {
  if (isPseudoLocation(location)) return false;
  return isRegisteredSpatialPart(location, vocabulary) || STRUCTURAL_LOCATION_SUFFIX.test(location);
}

function isPseudoLocation(location: string): boolean {
  return /^(?:路上|外面|全市|前台|那台|他站在台)$/u.test(location);
}

// 打分排序（不报错、不进正文）：bible 登记的空间部件最具体(3) > 带结构后缀(2) > 其它(1)。
function locationSpecificity(location: string, vocabulary: SpatialVocabulary = EMPTY_SPATIAL_VOCABULARY): number {
  if (isRegisteredSpatialPart(location, vocabulary)) return 3;
  if (STRUCTURAL_LOCATION_SUFFIX.test(location)) return 2;
  return 1;
}

// 语义地点 ↔ 已登记地点：先做通用子串互查，再用题材中立的楼层/序数归一化兜底，
// 让口语楼层（中文序数）匹配 bible 里登记的数字楼层等差异，不再写死具体地名映射。
function semanticLocationMatchesKnown(location: string, known: string): boolean {
  if (location === known || location.includes(known) || known.includes(location)) return true;
  const normalizedLocation = normalizeFloorTokens(location);
  const normalizedKnown = normalizeFloorTokens(known);
  return normalizedLocation === normalizedKnown
    || normalizedLocation.includes(normalizedKnown)
    || normalizedKnown.includes(normalizedLocation);
}

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

function safeArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function safeStringArray(value: readonly unknown[] | null | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function truncate(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value : "";
  const trimmed = text.replace(/\s+/gu, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter(isNonEmptyString)));
}
