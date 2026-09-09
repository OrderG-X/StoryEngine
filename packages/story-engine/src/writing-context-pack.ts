import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { selectEffectiveFacts } from "./fact-selection.js";
import { selectRelevant } from "./relevance-selection.js";
import { buildStyleExemplarPromptItems, normalizeStyleExemplars } from "./style-exemplars.js";
import type { StyleExemplarPromptItem } from "./style-exemplars.js";
import {
  readArcGoalPool,
  readAssetLedger,
  readCharacterBible,
  readCharacterProfile,
  readCharacterState,
  readFactLedger,
  readHookPool,
  readLocationBible,
  readStoryBible,
  readThreadPool,
  readTimelineEvents,
  readWorldBible,
  readWorldCore,
  readWorldState,
  readWritingRules,
  toSafeCharacterId,
} from "./project-store.js";
import type {
  ArcGoal,
  AssetItem,
  CharacterBibleEntry,
  CharacterProfile,
  CharacterState,
  HookItem,
  LocationBibleEntry,
  NarrativeThread,
  TimelineEvent,
  WorldBibleFaction,
} from "./types.js";

export type WritingContextSource =
  | "storyBible"
  | "writingRules"
  | "characterBible"
  | "worldBible"
  | "locationBible"
  | "characterState"
  | "worldState"
  | "timeline"
  | "hooks"
  | "threads"
  | "arcGoals"
  | "factLedger"
  | "chapterSteering";

export interface WritingContextSourceTrace {
  readonly path: string;
  readonly source: WritingContextSource;
}

export interface WritingContextPack {
  readonly chapterTask: {
    readonly chapterNumber: number;
    readonly userDirection: string;
    readonly currentChapterGoal: string;
    readonly firstChapterGoal?: string;
    readonly openingScene?: string;
    readonly firstHook?: string;
    readonly firstConflict?: string;
  };
  readonly protagonistContext: {
    readonly name: string;
    readonly identity?: string;
    readonly currentGoal?: string;
    readonly weakness?: string;
    readonly behaviorBoundaries: readonly string[];
    readonly knownFacts: readonly string[];
    readonly unknownTruths: readonly string[];
    readonly forbiddenReveals: readonly string[];
    readonly physicalState?: string;
    readonly mentalState?: string;
    readonly resourcesLimit: readonly string[];
    readonly age?: string;
    readonly speechStyle?: string;
    readonly speechSamples: readonly string[];
    readonly cannotDo: readonly string[];
    readonly extraFields: readonly string[];
  };
  readonly supportingCast: readonly {
    readonly name: string;
    readonly role?: string;
    readonly relationToProtagonist?: string;
    readonly trustLevel?: string;
    readonly relationshipDynamics: readonly string[];
    readonly traits: readonly string[];
  }[];
  readonly locationContext: {
    readonly requiredCurrentLocation?: string;
    readonly openingLocation?: string;
    readonly spatialStructure?: {
      readonly floors: readonly string[];
      readonly rooms: readonly string[];
      readonly entrances: readonly string[];
      readonly exits: readonly string[];
    };
    readonly travelRules: readonly {
      readonly targetLocation: string;
      readonly method: string;
      readonly durationMinutes?: number;
      readonly constraint?: string;
    }[];
    readonly fixedFacts: readonly string[];
    readonly locationRisks: readonly string[];
    readonly locationResources: readonly string[];
    readonly nearbyLocations: readonly string[];
    readonly extraFields: readonly string[];
    readonly locationDoNotInventRule: string;
  };
  readonly worldRulesContext: {
    readonly coreRules: readonly string[];
    readonly resourceRules: readonly string[];
    readonly socialOrder: readonly string[];
    readonly factions: readonly {
      readonly name: string;
      readonly goal: string;
      readonly resources: readonly string[];
    }[];
    readonly conflictSources: readonly string[];
    readonly hiddenTruths: readonly string[];
    readonly protectedSecrets: readonly string[];
  };
  readonly assetContext: {
    readonly initialAssets: readonly string[];
    readonly keyItems: readonly string[];
    readonly resourceLimits: readonly string[];
    readonly importantCarriedItems: readonly string[];
    readonly carriedAssets: readonly string[];
    readonly ownedAssets: readonly string[];
    readonly usableAssets: readonly string[];
    readonly unavailableAssets: readonly string[];
    readonly plotCriticalAssets: readonly string[];
    readonly assetHardRules: readonly string[];
    readonly extraFields: readonly string[];
    readonly assetDoNotInventRule: string;
  };
  readonly continuityFocus: {
    readonly recentTimelineEvents: readonly string[];
    readonly mustCarryHooks: readonly string[];
    readonly mustCarryThreads: readonly string[];
    readonly arcGoalFocus: readonly string[];
    readonly establishedFacts: readonly string[];
  };
  readonly writingRulesContext: {
    readonly narrativePerspective?: string;
    readonly proseStyle: readonly string[];
    readonly pacing?: string;
    readonly revealPolicy?: string;
    readonly targetChapterWords?: number;
    readonly forbiddenContent: readonly string[];
    readonly doNotDo: readonly string[];
    readonly readerExperienceRules: readonly string[];
    /** 用户自定义的全局写作规矩（自由 Markdown）；每次生成正文都喂进 prompt。受控破例⑧。 */
    readonly customNotes?: string;
    /** 作者文风样本（正向锚）：已按注入预算截断（单条/总量），渲染进正文 prompt；id/时间戳不喂模型。 */
    readonly styleExemplars: readonly StyleExemplarPromptItem[];
  };
  readonly hardConstraints: readonly string[];
  readonly sourceTrace: readonly WritingContextSourceTrace[];
}

export interface BuildWritingContextPackInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly userDirection: string;
  readonly currentChapterGoal?: string;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly mustHitBeats?: readonly string[];
}

export async function buildWritingContextPack(input: BuildWritingContextPackInput): Promise<WritingContextPack> {
  const characterIds = await resolveSelectedCharacterIds(input.projectDir, input.selectedCharacterIds);
  const [
    storyBible,
    writingRules,
    characterBible,
    worldBible,
    locationBible,
    assetLedger,
    worldCore,
    worldState,
    hookPool,
    threadPool,
    arcGoalPool,
    timelineEvents,
    profiles,
    states,
  ] = await Promise.all([
    readStoryBible(input.projectDir),
    readWritingRules(input.projectDir),
    readCharacterBible(input.projectDir),
    readWorldBible(input.projectDir),
    readLocationBible(input.projectDir),
    readAssetLedger(input.projectDir),
    readWorldCore(input.projectDir),
    readWorldState(input.projectDir),
    readHookPool(input.projectDir),
    readThreadPool(input.projectDir),
    readArcGoalPool(input.projectDir),
    readTimelineEvents(input.projectDir).catch(() => [] as TimelineEvent[]),
    Promise.all(characterIds.map((id) => readCharacterProfile(input.projectDir, id).catch(() => undefined))),
    Promise.all(characterIds.map((id) => readCharacterState(input.projectDir, id).catch(() => undefined))),
  ]);

  const profile = profiles.find((item): item is CharacterProfile => item !== undefined && isMainCharacter(item)) ?? profiles.find((item): item is CharacterProfile => item !== undefined);
  const profileId = profile?.id ? toSafeCharacterId(profile.id) : undefined;
  const state = states.find((item, index): item is CharacterState => {
    if (!item || !profileId) return false;
    const stateId = readStateCharacterId(item) ?? characterIds[index];
    return stateId ? toSafeCharacterId(stateId) === profileId : false;
  }) ?? states.find((item): item is CharacterState => item !== undefined);
  const bibleCharacter = findBibleCharacter(characterBible?.characters ?? [], profile);
  const firstChapterSetup = storyBible?.firstChapterSetup;
  const setupAssets = storyBible?.setupAssets;
  const mainLocation = selectMainLocation(locationBible?.locations ?? [], firstChapterSetup?.openingScene);
  const assetView = buildAssetContextView(assetLedger.assets);
  const selectedHooks = selectHooks(hookPool.hooks, input.selectedHookIds).slice(0, 3);
  // 按"本章仍有效 + 相关性"四维召回，替代纯 lastTouchedChapter 近章截断；
  // 早期未收口线索/目标只要章号差 ≥ ancientThreshold 就获得加分，不被最近章淘汰（根治长篇早期记忆塌陷）。
  // 此计算需在 thread/goal/fact 三处共用，提前到此处。
  const relevantFactNames = unique([
    bibleCharacter?.name,
    ...(characterBible?.characters ?? [])
      .filter((character) => characterIds.includes(character.id))
      .map((character) => character.name),
  ].filter((name): name is string => Boolean(name && name.trim())));
  const selectedThreads = selectRelevant({
    items: threadPool.threads.map((t) => ({ ...t, text: t.title ?? "" })),
    chapter: input.chapter,
    relevantNames: relevantFactNames,
    chapterGoal: input.currentChapterGoal ?? input.userDirection,
    relevantCharacterIds: input.selectedCharacterIds,
    closedStatuses: ["done", "stale"],
  }).selected.slice(0, 8); // token 宽松，名额放宽到 8（原为 3）
  const selectedGoals = selectRelevant({
    items: arcGoalPool.goals.map((g) => ({ ...g, text: g.title ?? "" })),
    chapter: input.chapter,
    relevantNames: relevantFactNames,
    chapterGoal: input.currentChapterGoal ?? input.userDirection,
    relevantCharacterIds: input.selectedCharacterIds,
    closedStatuses: ["completed", "stale"],
  }).selected.slice(0, 4); // 原为 2
  const recentTimelineEvents = timelineEvents.slice(-Math.max(1, input.maxTimelineEvents ?? 3)).slice(-3);
  const protectedSecrets = unique([
    ...(storyBible?.protectedSecrets ?? []),
    ...(storyBible?.coreMysteries ?? []),
    ...worldState.knownSecrets,
  ]);
  const forbiddenReveals = unique([
    ...(storyBible?.forbiddenChanges ?? []),
    ...(writingRules?.forbiddenContent ?? []),
    ...protectedSecrets,
  ]);
  const resourceLimits = setupAssets?.resourceLimits ?? [];
  const protagonistExtraFields = renderExtraFieldLines({
    ...(profile?.extraFields ?? {}),
    ...(bibleCharacter?.extraFields ?? {}),
  }).slice(0, 12);
  const supportingCast = buildSupportingCast(characterBible?.characters ?? [], bibleCharacter);
  const factLedger = await readFactLedger(input.projectDir).catch(() => null);
  // relevantFactNames 已在上面计算（线索/目标/事实选取共用）。
  const establishedFacts = selectEffectiveFacts({
    facts: factLedger?.facts ?? [],
    chapter: input.chapter,
    relevantNames: relevantFactNames,
    // 接本章方向：不含人名但与本章要写的内容相关的硬设定（遗产3亿/密道在城西）也优先（洞#9）。
    chapterGoal: input.currentChapterGoal ?? input.userDirection,
  }).facts;
  const trace: WritingContextSourceTrace[] = [];
  const addTrace = (path: string, source: WritingContextSource) => {
    trace.push({ path, source });
  };

  if (storyBible) addTrace("chapterTask.firstChapterSetup", "storyBible");
  if (storyBible) addTrace("assetContext.setupAssets", "storyBible");
  if (assetLedger.assets.length > 0) addTrace("assetContext.assetLedger", "storyBible");
  if (writingRules) addTrace("writingRulesContext", "writingRules");
  if (characterBible) addTrace("protagonistContext.boundary", "characterBible");
  if (worldBible) addTrace("worldRulesContext", "worldBible");
  if (locationBible) addTrace("locationContext", "locationBible");
  if (state) addTrace("protagonistContext.currentState", "characterState");
  if (supportingCast.length > 0) addTrace("supportingCast", "characterBible");
  if (establishedFacts.length > 0) addTrace("continuityFocus.establishedFacts", "factLedger");
  addTrace("worldRulesContext.conflictSources", "worldState");
  if (recentTimelineEvents.length > 0) addTrace("continuityFocus.recentTimelineEvents", "timeline");
  if (selectedHooks.length > 0) addTrace("continuityFocus.mustCarryHooks", "hooks");
  if (selectedThreads.length > 0) addTrace("continuityFocus.mustCarryThreads", "threads");
  if (selectedGoals.length > 0) addTrace("continuityFocus.arcGoalFocus", "arcGoals");
  addTrace("chapterTask.userDirection", "chapterSteering");

  const pack: WritingContextPack = {
    chapterTask: {
      chapterNumber: input.chapter,
      userDirection: input.userDirection,
      currentChapterGoal: input.currentChapterGoal ?? input.userDirection,
      ...(firstChapterSetup?.goal ? { firstChapterGoal: firstChapterSetup.goal } : {}),
      ...(firstChapterSetup?.openingScene ? { openingScene: firstChapterSetup.openingScene } : {}),
      ...(firstChapterSetup?.hook ? { firstHook: firstChapterSetup.hook } : {}),
      ...(firstChapterSetup?.conflict ? { firstConflict: firstChapterSetup.conflict } : {}),
    },
    protagonistContext: {
      name: profile?.name ?? bibleCharacter?.name ?? "主角",
      ...(profile?.identity ?? bibleCharacter?.role ? { identity: profile?.identity ?? bibleCharacter?.role } : {}),
      ...(state?.goal ?? bibleCharacter?.desire ? { currentGoal: state?.goal ?? bibleCharacter?.desire } : {}),
      ...(bibleCharacter?.weakness ? { weakness: bibleCharacter.weakness } : {}),
      behaviorBoundaries: unique(bibleCharacter?.behaviorBoundaries ?? []),
      knownFacts: unique(bibleCharacter?.knowledgeKnown ?? []),
      unknownTruths: unique([...(bibleCharacter?.knowledgeUnknown ?? []), ...protectedSecrets]),
      forbiddenReveals,
      ...(state?.currentPhysicalState ?? state?.relationshipToUser ? { physicalState: state?.currentPhysicalState ?? state.relationshipToUser } : {}),
      ...(state?.currentMentalState ?? state?.emotion ? { mentalState: state?.currentMentalState ?? state.emotion } : {}),
      resourcesLimit: resourceLimits,
      ...(bibleCharacter?.age ?? profile?.age ? { age: bibleCharacter?.age ?? profile?.age } : {}),
      ...(bibleCharacter?.speechStyle ?? bibleCharacter?.speechRules?.[0] ? { speechStyle: bibleCharacter?.speechStyle ?? bibleCharacter?.speechRules?.[0] } : {}),
      speechSamples: bibleCharacter?.speechSamples ?? [],
      cannotDo: unique([...(bibleCharacter?.cannotDo ?? []), ...(bibleCharacter?.behaviorBoundaries ?? [])]),
      extraFields: protagonistExtraFields,
    },
    supportingCast,
    locationContext: {
      ...(mainLocation?.name ? { requiredCurrentLocation: mainLocation.name } : {}),
      ...(firstChapterSetup?.openingScene ?? mainLocation?.name ? { openingLocation: firstChapterSetup?.openingScene ?? mainLocation?.name } : {}),
      ...(mainLocation?.spatialStructure ? {
        spatialStructure: {
          floors: mainLocation.spatialStructure.floors ?? [],
          rooms: mainLocation.spatialStructure.rooms ?? [],
          entrances: mainLocation.spatialStructure.entrances ?? [],
          exits: mainLocation.spatialStructure.exits ?? [],
        },
      } : {}),
      travelRules: mainLocation?.travelRules ?? [],
      fixedFacts: mainLocation?.fixedFacts ?? [],
      locationRisks: mainLocation?.risks ?? [],
      locationResources: mainLocation?.resources ?? [],
      nearbyLocations: unique([
        ...(locationBible?.locations.map((location) => location.name) ?? []),
        ...(mainLocation?.connectedLocations ?? []),
      ]).slice(0, 8),
      extraFields: renderExtraFieldLines(mainLocation?.extraFields),
      locationDoNotInventRule: "不要编造新的城市名；开场地点必须优先使用 Location Bible / firstChapterSetup 中的地点。",
    },
    worldRulesContext: {
      coreRules: unique([...(worldBible?.rules ?? []), ...worldCore.rules]),
      resourceRules: writingRules?.genreRequirements ?? [],
      socialOrder: worldBible?.socialOrder ?? [],
      factions: (worldBible?.factions ?? []).map(formatFaction),
      conflictSources: unique([...worldState.activeConflicts, worldCore.mainConflict, ...(storyBible?.centralConflicts ?? [])]),
      hiddenTruths: unique([...(storyBible?.coreMysteries ?? []), ...worldState.knownSecrets]),
      protectedSecrets,
    },
    assetContext: {
      initialAssets: setupAssets?.initialAssets ?? [],
      keyItems: setupAssets?.keyItems ?? [],
      resourceLimits,
      importantCarriedItems: unique([...(setupAssets?.initialAssets ?? []), ...(setupAssets?.keyItems ?? [])]),
      carriedAssets: assetView.carriedAssets,
      ownedAssets: assetView.ownedAssets,
      usableAssets: assetView.usableAssets,
      unavailableAssets: assetView.unavailableAssets,
      plotCriticalAssets: assetView.plotCriticalAssets,
      assetHardRules: assetView.assetHardRules,
      extraFields: assetView.extraFields,
      assetDoNotInventRule: "不要凭空增加关键资产；只能自然使用开书资产或正文中明确获得的普通小物件。",
    },
    continuityFocus: {
      recentTimelineEvents: recentTimelineEvents.map(formatTimelineEvent),
      mustCarryHooks: selectedHooks.map(formatHook),
      mustCarryThreads: selectedThreads.map(formatThread),
      arcGoalFocus: selectedGoals.map(formatArcGoal),
      establishedFacts,
    },
    writingRulesContext: {
      ...(writingRules?.narrativePerspective ? { narrativePerspective: writingRules.narrativePerspective } : {}),
      proseStyle: writingRules?.proseStyle ?? [],
      ...(writingRules?.pacing ? { pacing: writingRules.pacing } : {}),
      ...(writingRules?.revealPolicy ? { revealPolicy: writingRules.revealPolicy } : {}),
      ...(writingRules?.chapterLength?.targetWords ? { targetChapterWords: writingRules.chapterLength.targetWords } : {}),
      forbiddenContent: writingRules?.forbiddenContent ?? [],
      doNotDo: writingRules?.doNotDo ?? [],
      readerExperienceRules: writingRules?.readerExperienceRules ?? [],
      ...(writingRules?.customNotes ? { customNotes: writingRules.customNotes } : {}),
      styleExemplars: buildStyleExemplarPromptItems(normalizeStyleExemplars(writingRules?.styleExemplars).exemplars),
    },
    hardConstraints: buildHardConstraints({
      location: mainLocation?.name,
      openingScene: firstChapterSetup?.openingScene,
      unknownTruths: unique([...(bibleCharacter?.knowledgeUnknown ?? []), ...protectedSecrets]),
      forbiddenReveals,
      assets: unique([...(setupAssets?.initialAssets ?? []), ...(setupAssets?.keyItems ?? [])]),
      assetHardRules: assetView.assetHardRules,
      travelRules: mainLocation?.travelRules ?? [],
      floors: mainLocation?.spatialStructure?.floors ?? [],
      age: bibleCharacter?.age ?? profile?.age,
      speechSamples: bibleCharacter?.speechSamples ?? [],
      establishedFacts,
      mustHitBeats: input.mustHitBeats ?? [],
    }),
    sourceTrace: trace,
  };

  return pack;
}

async function resolveSelectedCharacterIds(projectDir: string, selectedCharacterIds?: readonly string[]): Promise<string[]> {
  if (selectedCharacterIds && selectedCharacterIds.length > 0) {
    return [...unique(selectedCharacterIds.map(toSafeCharacterId))];
  }
  const entries = await readdir(join(projectDir, "characters"), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => toSafeCharacterId(entry.name)).sort((a, b) => a.localeCompare(b));
}

function findBibleCharacter(characters: readonly CharacterBibleEntry[], profile: CharacterProfile | undefined): CharacterBibleEntry | undefined {
  if (!profile) return characters[0];
  return characters.find((character) => toSafeCharacterId(character.id) === toSafeCharacterId(profile.id) || character.name === profile.name)
    ?? characters.find((character) => character.role === "主角")
    ?? characters[0];
}

function isMainCharacter(profile: CharacterProfile): boolean {
  return profile.identity === "protagonist" || profile.tags?.includes("main-character") === true;
}

/**
 * 汇出配角名单：主角之外、带「关系/做厚特征」的角色，供写正文时 AI 知道配角是谁、与主角什么关系、什么调性。
 * 数据全来自已读进的 character-bible（关系字段由 foundation-write 写，做厚特征由 character-enrichment 并入 extraFields）。
 * 只收带真实信号（关系/动态/信任度/做厚特征）的条目，避免把空壳角色塞进 prompt；最多 6 个，逐项裁剪防膨胀。
 */
function buildSupportingCast(
  characters: readonly CharacterBibleEntry[],
  protagonist: CharacterBibleEntry | undefined,
): WritingContextPack["supportingCast"] {
  const protagonistId = protagonist?.id ? toSafeCharacterId(protagonist.id) : undefined;
  const protagonistName = protagonist?.name?.trim();
  const cast: Array<{
    readonly name: string;
    readonly role?: string;
    readonly relationToProtagonist?: string;
    readonly trustLevel?: string;
    readonly relationshipDynamics: readonly string[];
    readonly traits: readonly string[];
  }> = [];
  for (const entry of characters) {
    const name = entry?.name?.trim();
    if (!name) continue;
    const sameId = protagonistId !== undefined && toSafeCharacterId(entry.id) === protagonistId;
    const sameName = protagonistName !== undefined && name === protagonistName;
    if (sameId || sameName) continue;
    const relationToProtagonist = entry.relationshipToProtagonist?.trim();
    const relationshipDynamics = unique(entry.relationshipDynamics ?? []).slice(0, 3);
    const trustLevel = entry.trustLevel ? `${entry.trustLevel}`.trim() : undefined;
    const traits = renderExtraFieldLines(entry.extraFields).slice(0, 6);
    const hasSignal = Boolean(relationToProtagonist) || relationshipDynamics.length > 0 || Boolean(trustLevel) || traits.length > 0;
    if (!hasSignal) continue;
    const role = entry.role?.trim();
    cast.push({
      name,
      ...(role ? { role } : {}),
      ...(relationToProtagonist ? { relationToProtagonist } : {}),
      ...(trustLevel ? { trustLevel } : {}),
      relationshipDynamics,
      traits,
    });
    if (cast.length >= 6) break;
  }
  return cast;
}

function selectMainLocation(locations: readonly LocationBibleEntry[], openingScene: string | undefined): LocationBibleEntry | undefined {
  if (locations.length === 0) return undefined;
  if (openingScene) {
    const byOpening = locations.find((location) => openingScene.includes(location.name) || location.name.includes(openingScene));
    if (byOpening) return byOpening;
  }
  return locations[0];
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

function formatFaction(faction: WorldBibleFaction): { readonly name: string; readonly goal: string; readonly resources: readonly string[] } {
  return {
    name: faction.name,
    goal: faction.goal,
    resources: faction.resources ?? [],
  };
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

function buildAssetContextView(assets: readonly AssetItem[]): {
  readonly carriedAssets: readonly string[];
  readonly ownedAssets: readonly string[];
  readonly usableAssets: readonly string[];
  readonly unavailableAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
  readonly assetHardRules: readonly string[];
  readonly extraFields: readonly string[];
} {
  const carriedAssets = assets.filter((asset) => Boolean(asset.carriedByCharacterId)).map(formatAssetItem);
  const ownedAssets = assets.filter((asset) => Boolean(asset.ownerCharacterId || asset.ownerName)).map(formatAssetItem);
  const usableAssets = assets.filter((asset) => asset.status === "available").map(formatAssetItem);
  const unavailableAssets = assets.filter((asset) => asset.status !== "available").map(formatAssetItem);
  const plotCriticalAssets = assets.filter((asset) => asset.isPlotCritical === true).map(formatAssetItem);
  const assetHardRules = unique([
    ...assets.flatMap((asset) => asset.rules ?? []),
    ...assets
      .filter((asset) => asset.status !== "available")
      .map((asset) => `${asset.name} 当前不可用（${asset.status}），不能写成可正常使用。`),
    assets.every((asset) => asset.type !== "vehicle") ? "没有登记车辆时，AI 不能默认主角有车。" : undefined,
    assets.every((asset) => asset.type !== "money") ? "没有现金/打车条件时，AI 不能随便写打车。" : undefined,
  ].filter((item): item is string => Boolean(item)));
  const extraFields = assets.flatMap((asset) =>
    renderExtraFieldLines(asset.extraFields).map((line) => `${asset.name} · ${line}`),
  ).slice(0, 24);
  return {
    carriedAssets: carriedAssets.slice(0, 12),
    ownedAssets: ownedAssets.slice(0, 12),
    usableAssets: usableAssets.slice(0, 12),
    unavailableAssets: unavailableAssets.slice(0, 12),
    plotCriticalAssets: plotCriticalAssets.slice(0, 12),
    assetHardRules,
    extraFields,
  };
}

/**
 * 把资料卡的自定义字段渲染成可读行（如「境界：金丹期」）。
 * 字符串值直接拼，数组值用顿号连接（如「守卫：石傀儡、雷符阵」）。
 * 这让地点 / 资产卡归档的 extraFields 也能进写作 prompt，不再静默不可见。
 */
function renderExtraFieldLines(extraFields: Record<string, string | readonly string[]> | undefined): readonly string[] {
  if (!extraFields) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(extraFields)) {
    const label = key.trim();
    if (!label) continue;
    const rendered = Array.isArray(value)
      ? value.map((item) => `${item}`.trim()).filter((item) => item.length > 0).join("、")
      : `${value}`.trim();
    if (!rendered) continue;
    lines.push(`${label}：${rendered}`);
  }
  return lines;
}

function formatAssetItem(asset: AssetItem): string {
  return [asset.name, asset.status !== "available" ? asset.status : undefined, asset.conditionNote].filter(Boolean).join(" · ");
}

function readStateCharacterId(state: CharacterState): string | undefined {
  const value = (state as { readonly characterId?: unknown }).characterId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildHardConstraints(input: {
  readonly location?: string;
  readonly openingScene?: string;
  readonly unknownTruths: readonly string[];
  readonly forbiddenReveals: readonly string[];
  readonly assets: readonly string[];
  readonly assetHardRules: readonly string[];
  readonly travelRules: readonly { readonly targetLocation: string; readonly method: string; readonly durationMinutes?: number; readonly constraint?: string }[];
  readonly floors: readonly string[];
  readonly age?: string;
  readonly speechSamples: readonly string[];
  readonly establishedFacts: readonly string[];
  readonly mustHitBeats?: readonly string[];
}): readonly string[] {
  const mustHit = (input.mustHitBeats ?? []).map((beat) => beat.trim()).filter(Boolean);
  return unique([
    // 用户/agent 指定的本章必须命中要点——放硬约束首位、protocol 已令优先于文风遵守（Codex 复测：首稿跑偏）。
    mustHit.length > 0
      ? `必须在本章逐条落实这些要点，照写其中的具体名物 / 数字 / 编号，不得替换、合并或遗漏：${mustHit.join("；")}。`
      : undefined,
    "不要编造新的城市名。",
    input.location ? `不要编造与 Location Bible 冲突的开场地点；开场优先使用：${input.location}。` : "不要编造与 Location Bible 冲突的开场地点。",
    input.openingScene ? `第一章开场强参考：${input.openingScene}。` : undefined,
    input.floors.length > 0 ? `不要改变已登记楼层结构：${input.floors.join("；")}。` : undefined,
    input.travelRules.length > 0 ? `不要违反移动规则：${input.travelRules.map(formatTravelRule).join("；")}。` : undefined,
    input.unknownTruths.length > 0 ? `不要让主角知道这些未知真相：${input.unknownTruths.join("；")}。` : undefined,
    input.forbiddenReveals.length > 0 ? `不要提前揭开：${input.forbiddenReveals.join("；")}。` : undefined,
    "不要让主角突然开挂。",
    input.assets.length > 0 ? `不要凭空增加关键资产；可自然使用至少一个已有资产：${input.assets.join("；")}。` : "不要凭空增加关键资产。",
    ...input.assetHardRules,
    "不要编造未登记学校、组织、公司、车辆、住所等身份细节；没有底层信息就模糊处理。",
    input.age ? `不要让角色年龄漂移；当前年龄：${input.age}。` : undefined,
    input.speechSamples.length > 0 ? `不要让角色说话风格明显偏离样本：${input.speechSamples.slice(0, 3).join(" / ")}。` : undefined,
    input.establishedFacts.length > 0 ? `不得改写或否认以下已确立事实：${input.establishedFacts.slice(0, 8).join("；")}。` : undefined,
    "不要让角色使用未登记资产。",
    "不要凭空创建车辆 / 住所 / 大额现金。",
    "不要把世界规则一次性说明成设定说明书。",
  ].filter((item): item is string => Boolean(item)));
}

function formatTravelRule(rule: { readonly targetLocation: string; readonly method: string; readonly durationMinutes?: number; readonly constraint?: string }): string {
  return [rule.targetLocation, rule.method, typeof rule.durationMinutes === "number" ? `${rule.durationMinutes}分钟` : undefined, rule.constraint].filter(Boolean).join(" ");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
