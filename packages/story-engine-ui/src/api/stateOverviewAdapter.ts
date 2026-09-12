import type { StateOverview } from "./types.js";
import { cleanUiText } from "../utils/textUtils.js";
import { worldbuildingFromWorldBible } from "./worldbuildingFromOverview.js";
import {
  filterPlaceholderUiValues,
  filterSystemStoryMeta,
  isPlaceholderUiValue,
} from "../shared/sparse-panel-honesty.js";
import type {
  ChapterNavItem,
  ChapterWorkspaceData,
  RiskWarning,
  SidebarData,
} from "../types.js";

type UiChapterFileState = NonNullable<StateOverview["uiChapterFiles"]>[number];

/**
 * 选定工作区当前章：写类工具（generate_draft/revise_draft/commit_apply）回传的 chapter 是「这次实际操作的章」，
 * 它是权威——必须盖过 store 里用户停留的旧章号，否则 UI 停在旧章、autosave 把新章正文写回旧章草稿文件（跨章污染）。
 * 只读刷新不带 toolChapter → 退回 store 旧章，不把用户从正在看的章弹走。两者都缺/退化值 → undefined 交给 overview 推导。
 * 模型无关：toolChapter 即便被传成 0 / 负数 / 小数等退化值也安全忽略。
 */
export function pickPreferredChapter(storeChapter?: number, toolChapter?: number): number | undefined {
  if (Number.isInteger(toolChapter) && (toolChapter as number) > 0) return toolChapter;
  return storeChapter;
}

/**
 * 真实章数（R2#4）：buildChapters 会无条件多塞一章「当前章+1」的占位『下一章』供导航/续写用，
 * 但它不该计入「共 N 章」。真实章 = 有已入库章 / 有草稿文件 / 章号≤当前章；尾随的纯占位章被排除。
 */
export function countRealChapters(chapters: readonly ChapterNavItem[], currentChapterNumber: number): number {
  return chapters.filter(
    (chapter) =>
      chapter.hasCommittedChapter === true ||
      chapter.hasDraftFile === true ||
      chapter.chapterNumber <= currentChapterNumber,
  ).length;
}

export function workspaceFromStateOverview(
  overview: StateOverview,
  // 调用方可传「用户当前停留章」优先用之，避免 applyOverviewToWorkspace 用引擎旧章号(overview.project.currentChapter
  // 仅在 commit 时推进)把 UI 当前章静默覆盖回去（自我强化错章循环）。缺省/非正整数时退化到 overview 推导。
  preferredCurrentChapter?: number,
): ChapterWorkspaceData {
  const currentChapterNumber = Number.isInteger(preferredCurrentChapter) && (preferredCurrentChapter as number) > 0
    ? (preferredCurrentChapter as number)
    : overview.project.currentChapter ?? lastKnownChapter(overview) ?? 1;
  const chapters = buildChapters(overview, currentChapterNumber);
  const currentChapter = chapters.find((chapter) => chapter.chapterNumber === currentChapterNumber) ?? chapters[0] ?? {
    id: "ch-1",
    chapterNumber: 1,
    title: "第1章",
    status: "current",
  };
  const protagonistName = overview.characters.protagonist ?? overview.characters.knownCharacters[0]?.name ?? "主角";
  const protagonistProfile = overview.characters.knownCharacters.find((character) => character.name === protagonistName);
  const protagonistBible = findBibleCharacter(overview, protagonistName);
  const protagonistDetail = findCharacterDetail(overview, protagonistName);
  const protagonistDetailSummary = overview.characterDetailSummary?.characters.find((character) => character.name === protagonistName);
  // 地点名不用「尚未配置…」占位顶上去——占位会计入地点统计、面板当真实条目（审计 #地点）。
  const rawCurrentLocation = overview.storyStatus.currentLocation ?? overview.world.activeLocations[0];
  const currentLocation = rawCurrentLocation && !isPlaceholderUiValue(rawCurrentLocation) ? rawCurrentLocation : "";
  const currentObjective = overview.storyStatus.currentObjective ?? overview.arcGoals.activeItems[0]?.title ?? overview.storyBible?.longFormGoals[0] ?? "尚未配置当前目标";
  const timelineLines = overview.timeline.recentEvents.map((event) => `第${event.chapter}章：${event.mainEvent ?? event.summary}`);
  const lastEvent = overview.timeline.recentEvents.at(-1);
  const warnings = overview.uiHints.warnings.map(toReadableWarning);
  const storyBible = overview.storyBible;
  const writingRules = overview.writingRules;
  const worldBible = overview.worldBible;
  const locationBible = overview.locationBible;
  const locationDetail = overview.locationDetailSummary;
  const assetSummary = overview.assetSummary;
  const knownFacts = unique([
    ...(protagonistBible?.knowledgeKnown ?? []),
    ...(storyBible?.canonFacts ?? []),
    ...overview.world.importantFacts,
    ...(worldBible?.keyRules ?? []),
    overview.world.summary,
  ]);
  const unknownTruths = unique([
    ...(protagonistBible?.knowledgeUnknown ?? []),
    ...overview.threads.keyOpenItems.map((thread) => thread.title),
    ...(storyBible?.coreMysteries ?? []),
    ...(storyBible?.openQuestions ?? []),
  ]);
  const forbiddenReveals = filterSystemStoryMeta(unique([
    ...(storyBible?.forbiddenChanges ?? []),
    ...(writingRules?.forbiddenContent ?? []),
    ...(storyBible?.coreMysteries ?? []),
    ...(storyBible?.protectedSecrets ?? []),
    ...(overview.world.protectedSecrets ?? []),
  ]));
  const locationRisks = locationBible?.available && (locationBible.keyRisks?.length ?? 0) > 0
    ? locationBible.keyRisks ?? []
    : [];
  const locationResources = locationBible?.available && (locationBible.keyResources?.length ?? 0) > 0
    ? locationBible.keyResources ?? []
    : [];
  const setupAssets = storyBible?.setupAssets;
  const setupAssetLines = unique([
    ...(setupAssets?.initialAssets ?? []).map((item) => `初始物品：${item}`),
    ...(setupAssets?.keyItems ?? []).map((item) => `关键物品：${item}`),
    ...(setupAssets?.resourceLimits ?? []).map((item) => `资源限制：${item}`),
  ]);
  const activeLocations = unique([
    ...overview.world.activeLocations,
    ...(locationBible?.activeLocationNames ?? []),
  ]);
  const hardConstraints = buildHardConstraints(overview);
  const uncommittedDraftChapters = chapters
    .filter((chapter) => chapter.hasDraftFile === true && chapter.hasCommittedChapter !== true)
    .map((chapter) => chapter.chapterNumber);
  const latestUncommittedDraftChapter = maxNumber(uncommittedDraftChapters);

  return {
    projectName: overview.project.title,
    currentChapter,
    chapters,
    flowStatus: inferFlowStatus(overview),
    hasUncommittedDrafts: uncommittedDraftChapters.length > 0,
    workingDraftChain: uncommittedDraftChapters.length > 0,
    previousUncommittedDraftContext: chapters.some((chapter) => (
      chapter.chapterNumber === currentChapter.chapterNumber - 1
      && chapter.hasDraftFile === true
      && chapter.hasCommittedChapter !== true
    )),
    ...(latestUncommittedDraftChapter !== undefined ? { latestUncommittedDraftChapter } : {}),
    draft: {
      chapterNumber: currentChapter.chapterNumber,
      title: currentChapter.title,
      status: "draft",
      content: buildStateBackedDraftPlaceholder(overview),
      savedContent: buildStateBackedDraftPlaceholder(overview),
    },
    messages: [
      {
        id: "state-overview-connected",
        role: "assistant",
        content: [
          `已进入《${overview.project.title}》的章节工作区。`,
          `当前目标：${currentObjective}`,
          `当前地点：${currentLocation}`,
          warnings.length > 0 ? `风险提醒：${warnings.slice(0, 2).join("；")}` : "风险提醒：当前后端未返回风险",
        ].join("\n"),
      },
    ],
    characterMatrix: overview.characterMatrix,
    worldbuildingFallback: worldbuildingFromWorldBible(worldBible),
    protagonist: {
      name: protagonistName,
      age: protagonistDetail?.age ?? protagonistDetailSummary?.age,
      identity: displayRole(protagonistDetail?.identity ?? protagonistProfile?.role),
      currentGoal: currentObjective,
      physicalState: withFallback(compact([
        protagonistDetail?.currentPhysicalState,
        protagonistProfile?.status,
      ]), "尚未配置身体状态"),
      mentalState: withFallback(compact([
        protagonistDetail?.currentMentalState,
        protagonistProfile?.status,
      ]), "尚未配置精神状态"),
      resourceState: withFallback(compact([
        protagonistDetail?.currentResourceState,
        ...(setupAssets?.resourceLimits ?? []),
      ]), "尚未配置当前资源状态"),
      currentSituation: toReadableStage(overview.storyStatus.currentStage) ?? overview.storyStatus.lastTimelineEvent ?? "尚未配置当前阶段",
      boundaries: withFallback(compact([
        protagonistBible?.desire ? `角色目标：${protagonistBible.desire}` : undefined,
        protagonistBible?.weakness ? `短板：${protagonistBible.weakness}` : undefined,
        protagonistDetail?.moralBoundary ? `道德底线：${protagonistDetail.moralBoundary}` : undefined,
        ...(protagonistBible?.behaviorBoundaries ?? []).map((item) => `行为边界：${item}`),
        ...(protagonistDetail?.behaviorBoundaries ?? []).map((item) => `行为边界：${item}`),
        ...(protagonistBible?.knowledgeKnown ?? []).map((item) => `主角知道：${item}`),
        ...(protagonistDetail?.knowledgeKnown ?? []).map((item) => `主角知道：${item}`),
        ...(protagonistBible?.knowledgeUnknown ?? []).map((item) => `主角不知道：${item}`),
        ...(protagonistDetail?.knowledgeUnknown ?? []).map((item) => `主角不知道：${item}`),
        ...warnings,
      ]), "尚未配置角色边界"),
      cannotDo: withFallback(protagonistDetailSummary?.cannotDo ?? protagonistDetail?.cannotDo ?? [], "尚未配置不能做什么"),
      speechStyle: protagonistDetailSummary?.speechStyle ?? protagonistDetail?.speechStyle,
      speechSamples: withFallback(protagonistDetailSummary?.speechSamples ?? protagonistDetail?.speechSamples ?? [], "尚未配置说话样本"),
    },
    location: {
      currentLocation,
      currentPosition: firstKnown([
        overview.locationDetailSummary?.rooms[0],
        overview.locationDetailSummary?.floors[0],
      ]),
      previousLocation: overview.timeline.recentEvents.at(-2)?.location,
      transitionStatus: overview.timeline.recentEvents.at(-1)?.location ? "unknown" : "unknown",
      locations: overview.locationDetailSummary?.locations?.map((location) => ({
        id: location.id,
        name: location.name,
        type: location.type,
        parentLocation: location.parentLocation,
        currentKnownPosition: location.currentKnownPosition,
        // 面板统计与列表同源：空字段保持空数组，不再灌「尚未配置…」假条目。
        sensory: realList(location.sensory),
        narrativeFunction: location.narrativeFunction,
        possibleConflicts: realList(location.possibleConflicts),
        currentStatus: location.currentStatus,
        floors: realList(location.floors),
        rooms: realList(location.rooms),
        entrances: realList(location.entrances),
        exits: realList(location.exits),
        nearbyLocations: realList(unique([
          ...(overview.world.activeLocations ?? []),
          ...(locationBible?.activeLocationNames ?? []),
        ]).filter((name) => name !== location.name)),
        travelRules: realList(location.travelRules),
        risks: realList(location.risks),
        resources: realList(location.resources),
        fixedFacts: realList(location.fixedFacts),
        hiddenFacts: realList(location.hiddenFacts),
        ...(location.extraFields ? { extraFields: location.extraFields } : {}),
      })),
      floors: realList(locationDetail?.floors ?? []),
      rooms: realList(locationDetail?.rooms ?? []),
      entrances: realList(locationDetail?.entrances ?? extractLabeledItems(locationDetail?.rooms ?? [], "入口")),
      exits: realList(locationDetail?.exits ?? extractLabeledItems(locationDetail?.rooms ?? [], "出口")),
      resources: realList(locationDetail?.resources ?? locationResources),
      fixedFacts: realList(locationDetail?.fixedFacts ?? [
        ...(locationDetail?.floors ?? []).map((item) => `已登记楼层：${item}`),
        ...(locationDetail?.rooms ?? []).map((item) => `已登记空间：${item}`),
      ]),
      risks: realList(locationDetail?.risks ?? locationRisks),
      nearbyLocations: realList(unique(activeLocations)),
      travelRules: realList(locationDetail?.travelRules ?? []),
    },
    time: {
      currentStoryDay: overview.calendar ? `第 ${overview.calendar.currentStoryDay} 天` : "尚未配置",
      currentTimeOfDay: toReadableTimeOfDay(overview.calendar),
      latestChapter: lastEvent ? `第 ${lastEvent.chapter} 章` : "暂无时间线",
      latestEvent: lastEvent?.summary ?? "暂无最近事件",
    },
    knowledge: {
      knownFacts: withFallback(knownFacts, "尚未配置已知事实"),
      unknownTruths: withFallback(unknownTruths, "尚未配置未知真相 / 未闭合线索"),
      forbiddenReveals: withFallback(forbiddenReveals, "尚未配置禁止揭示信息"),
    },
    assets: {
      items: assetSummary?.assetItems?.map((asset) => ({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        owner: asset.owner,
        currentLocation: asset.currentLocation,
        carriedBy: asset.carriedBy,
        status: asset.status,
        isConsumable: asset.isConsumable,
        isPlotCritical: asset.isPlotCritical,
        rules: asset.rules,
        usageRules: asset.usageRules,
        lossRules: asset.lossRules,
        notes: asset.notes,
        ...(asset.extraFields ? { extraFields: asset.extraFields } : {}),
      })),
      carriedItems: realList(assetSummary?.carriedAssets ?? setupAssets?.initialAssets ?? []),
      availableAssets: realList(assetSummary?.ownedAssets ?? []),
      unavailableAssets: realList(assetSummary?.unavailableAssets ?? []),
      resources: realList(setupAssets?.resourceLimits ?? []),
      properties: [],
      containers: [],
      plotCriticalItems: realList(assetSummary?.plotCriticalAssets ?? setupAssets?.keyItems ?? []),
      assetRules: realList(unique([
        ...(setupAssets?.resourceLimits ?? []),
        ...(assetSummary?.unavailableAssets ?? []).map((item) => `${item} 不可随意使用`),
        ...(assetSummary?.plotCriticalAssets ?? []).map((item) => `${item} 是剧情关键物品，变更必须走定稿预览`),
      ])),
    },
    memory: {
      activeForeshadowing: withFallback(overview.hooks.activeItems.map((hook) => hook.title), "暂无活跃伏笔"),
      openThreads: withFallback(overview.threads.keyOpenItems.map((thread) => thread.title), "暂无未闭合线索"),
      arcGoals: withFallback(overview.arcGoals.activeItems.map((goal) => goal.title), "暂无主线目标"),
      recentTimeline: withFallback(timelineLines, "暂无最近时间线"),
    },
    risks: buildRisks(overview),
    hardConstraints,
    foundationCompleteness: overview.foundationCompleteness,
  };
}

export function sidebarFromStateOverview(overview: StateOverview): SidebarData {
  return {
    storySettings: buildStorySettings(overview),
    writingRules: buildWritingRules(overview),
    ...(overview.writingRules?.customNotes ? { writingRulesCustomNotes: overview.writingRules.customNotes } : {}),
    characters: buildCharacterSettings(overview),
    locations: buildLocationSettings(overview),
    assets: buildAssetSettings(overview),
    hooks: withFallback([
      ...overview.hooks.activeItems.map((hook) => hook.title),
      ...overview.threads.keyOpenItems.map((thread) => thread.title),
    ], "暂无伏笔线索"),
    arcGoals: withFallback(overview.arcGoals.activeItems.map((goal) => compact([goal.title, goal.progress]).join(" · ")), "暂无主线目标"),
  };
}

function buildSetupAssetLines(storyBible: StateOverview["storyBible"] | undefined): string[] {
  const setupAssets = storyBible?.setupAssets;
  return unique([
    ...(setupAssets?.initialAssets ?? []).map((item) => `初始物品：${item}`),
    ...(setupAssets?.keyItems ?? []).map((item) => `关键物品：${item}`),
    ...(setupAssets?.resourceLimits ?? []).map((item) => `资源限制：${item}`),
  ]);
}

function buildAssetSettings(overview: StateOverview): string[] {
  const setupLines = buildSetupAssetLines(overview.storyBible).map((line) => `开书设定资产预留：${line}`);
  const itemLines = (overview.assetSummary?.assetItems ?? []).map((asset) => compact([
    asset.name,
    asset.type ? `类型：${asset.type}` : undefined,
    asset.owner ? `归属：${asset.owner}` : undefined,
    asset.currentLocation ? `位置：${asset.currentLocation}` : undefined,
    asset.carriedBy ? `携带者：${asset.carriedBy}` : undefined,
    asset.status ? `状态：${asset.status}` : undefined,
    asset.isPlotCritical ? "剧情关键" : undefined,
    asset.rules.length ? `规则：${asset.rules.join("；")}` : undefined,
    asset.usageRules.length ? `使用：${asset.usageRules.join("；")}` : undefined,
    asset.lossRules.length ? `遗失：${asset.lossRules.join("；")}` : undefined,
  ]).join("｜"));
  return withFallback([...itemLines, ...setupLines], "道具与资源：尚未配置");
}

function buildStorySettings(overview: StateOverview): string[] {
  const storyBible = overview.storyBible;
  const worldBible = overview.worldBible;
  const logline = storyBible?.projectLogline ?? cleanStorySummary(overview.world.summary);
  const longFormGoals = storyBible?.longFormGoals ?? [];
  const firstVolumeGoal = longFormGoals[0];
  const futureLongFormGoals = longFormGoals.slice(1);
  const centralConflicts = storyBible?.centralConflicts ?? [];
  const coreMysteries = storyBible?.coreMysteries ?? [];
  const firstChapterSetup = storyBible?.firstChapterSetup;
  const protagonistDetail = overview.characterDetails?.[0] ?? overview.characterBible?.keyCharacters[0];
  const protectedSecrets = [
    ...(storyBible?.protectedSecrets ?? []),
    ...(overview.world.protectedSecrets ?? []),
  ];
  const worldRules = [
    ...(worldBible?.keyRules ?? []),
    ...overview.world.importantFacts,
  ];

  return [
    `书名：${overview.project.title || "尚未配置"}`,
    `类型：${storyBible?.genre ?? overview.project.genre ?? "尚未配置"}`,
    `一句话故事：${logline ?? "尚未配置"}`,
    `当前阶段：${toReadableStage(overview.storyStatus.currentStage) ?? "尚未配置"}`,
    `长篇目标：${formatList(longFormGoals, "尚未配置")}`,
    `世界背景：${cleanStorySummary(overview.world.summary) ?? storyBible?.readerPromise ?? "尚未配置"}`,
    `核心世界规则：${formatList(unique(worldRules), "尚未配置")}`,
    `社会结构 / 世界规则：${formatList(worldBible?.socialOrder ?? worldBible?.keyFactions ?? [], "尚未配置")}`,
    `势力 / 阵营：${formatList(worldBible?.keyFactions ?? [], "尚未配置")}`,
    `资源规则：${formatList(worldBible?.resourceRules ?? [], "尚未配置")}`,
    `权力规则：${formatList(worldBible?.authorityRules ?? [], "尚未配置")}`,
    `冲突来源：${formatList(unique([...(worldBible?.conflictSources ?? []), ...centralConflicts]), "尚未配置")}`,
    `重要事实：${formatList(unique([...(worldBible?.fixedFacts ?? []), ...overview.world.importantFacts]), "尚未配置")}`,
    `第一章方向：${formatList(compact([
      firstChapterSetup?.goal ? `目标：${firstChapterSetup.goal}` : undefined,
      firstChapterSetup?.openingScene ? `开场：${firstChapterSetup.openingScene}` : undefined,
      firstChapterSetup?.hook ? `钩子：${firstChapterSetup.hook}` : undefined,
      firstChapterSetup?.conflict ? `冲突：${firstChapterSetup.conflict}` : undefined,
    ]), "尚未配置")}`,
    `当前主线：${formatList([
      ...overview.arcGoals.activeItems.map((goal) => goal.title),
      overview.storyStatus.currentObjective,
    ], "尚未配置")}`,
    `第一卷目标：${firstVolumeGoal ?? "尚未配置"}`,
    `长期目标：${formatList(futureLongFormGoals, "尚未配置")}`,
    `禁止提前揭开：${formatList(unique([...(storyBible?.forbiddenChanges ?? []), ...coreMysteries]), "尚未配置")}`,
    `保护秘密：${formatList(unique([...protectedSecrets, ...(worldBible?.protectedSecrets ?? [])]), "尚未配置")}`,
    `主角未知真相：${formatList(protagonistDetail?.knowledgeUnknown ?? [], "尚未配置")}`,
  ];
}

function buildCharacterSettings(overview: StateOverview): string[] {
  // P2 canonical：职能/身份/当前目标的权威是矩阵 canonical（resolveCharacterRole 等），
  // adapter 不再各自 ?? 合并，优先读它，保证「AI 看到的设定」与面板/写作 prompt 同口径。
  const matrixCharacters = overview.characterMatrix?.characters ?? [];
  const matrixOf = (id: string, name: string) =>
    matrixCharacters.find((character) => character.id === id || character.name === name);

  if (overview.characterDetails?.length) {
    return overview.characterDetails.map((character) => {
      const canonical = matrixOf(character.id, character.name);
      return JSON.stringify({
      type: "character-detail",
      id: character.id,
      name: character.name,
      role: displayRole(canonical?.role ?? character.role ?? character.identity),
      identity: displayRole(canonical?.identity ?? character.identity),
      age: character.age,
      gender: character.gender,
      height: character.height,
      weight: character.weight,
      distinctiveTraits: character.distinctiveTraits,
      bodyTraits: character.bodyTraits,
      privateBodyTraits: character.privateBodyTraits,
      intimacyBoundaries: character.intimacyBoundaries,
      tags: character.tags,
      appearance: character.appearance,
      emotion: character.emotion,
      goal: character.goal,
      mood: character.mood ?? character.emotion,
      currentGoal: canonical?.currentGoal ?? character.currentGoal ?? character.goal,
      recentEvents: character.recentEvents,
      relationshipToUser: character.relationshipToUser,
      currentArc: character.currentArc,
      lastUpdatedChapter: character.lastUpdatedChapter,
      personality: character.personality,
      speechStyle: character.speechStyle,
      taboos: character.taboos,
      worldview: character.worldview,
      desire: character.desire,
      fear: character.fear,
      weakness: character.weakness,
      privateMotive: character.privateMotive,
      relationshipToProtagonist: character.relationshipToProtagonist,
      relationshipDynamics: character.relationshipDynamics,
      trustLevel: character.trustLevel,
      hiddenStance: character.hiddenStance,
      speechRules: character.speechRules,
      behaviorBoundaries: character.behaviorBoundaries,
      knowledgeKnown: character.knowledgeKnown,
      knowledgeUnknown: character.knowledgeUnknown,
      cannotReveal: character.cannotReveal,
      cannotDo: character.cannotDo,
      arcPromise: character.arcPromise,
      currentLocation: character.currentLocationName,
      currentStateHint: character.currentStateHint,
      });
    });
  }

  const protagonist = overview.characters.protagonist ?? overview.characterBible?.keyCharacters[0]?.name;
  const liveCharacters = overview.characters.knownCharacters;
  const bibleCharacters = overview.characterBible?.keyCharacters ?? [];
  const detailCharacters = overview.characterDetailSummary?.characters ?? [];
  const characterNames = unique([
    protagonist,
    ...bibleCharacters.map((character) => character.name),
    ...detailCharacters.map((character) => character.name),
    ...liveCharacters.map((character) => character.name),
    ...matrixCharacters.map((character) => character.name),
  ]);

  return withFallback(characterNames.map((name) => {
    const live = liveCharacters.find((character) => character.name === name);
    const bible = bibleCharacters.find((character) => character.name === name);
    const detail = detailCharacters.find((character) => character.name === name);
    const matrix = matrixCharacters.find((character) => character.name === name);
    const role = displayRole(matrix?.role ?? live?.role ?? bible?.role ?? (name === protagonist ? "主角" : undefined));
    return compact([
      name,
      role,
      detail?.age ?? matrix?.age ? `年龄：${detail?.age ?? matrix?.age}` : undefined,
      bible?.desire ?? matrix?.desire ? `目标：${bible?.desire ?? matrix?.desire}` : undefined,
      bible?.fear ?? matrix?.fear ? `恐惧：${bible?.fear ?? matrix?.fear}` : undefined,
      bible?.weakness ?? matrix?.weakness ? `短板：${bible?.weakness ?? matrix?.weakness}` : undefined,
      bible?.contradiction ?? matrix?.contradiction ? `反差：${bible?.contradiction ?? matrix?.contradiction}` : undefined,
      live?.status ? `状态：${live.status}` : undefined,
      detail?.speechStyle ?? matrix?.speechStyle ? `说话风格：${detail?.speechStyle ?? matrix?.speechStyle}` : undefined,
      (detail?.cannotDo?.length ?? matrix?.cannotDo.length ?? 0) > 0 ? `不能做：${(detail?.cannotDo ?? matrix?.cannotDo ?? []).join("；")}` : undefined,
      live?.lastSeenChapter ? `最近出现：第${live.lastSeenChapter}章` : undefined,
    ]).join("｜");
  }), "尚未配置｜尚未配置定位");
}

function buildLocationSettings(overview: StateOverview): string[] {
  const locationBible = overview.locationBible;
  const activeLocations = unique([
    overview.storyStatus.currentLocation,
    ...overview.world.activeLocations,
    ...(locationBible?.activeLocationNames ?? []),
  ]);

  return [
    `当前地点：${overview.storyStatus.currentLocation ?? "尚未配置"}`,
    `重要地点：${formatList(activeLocations, "尚未配置")}`,
    `地点数量：${locationBible?.available ? String(locationBible.locationCount) : "尚未配置"}`,
    `地点规则 / 风险：${formatList(locationBible?.keyRisks ?? [], "尚未配置")}`,
    `地点资源：${formatList(locationBible?.keyResources ?? [], "尚未配置")}`,
    `叙事功能：${formatList(locationBible?.keyNarrativeFunctions ?? [], "尚未配置")}`,
    `楼层结构：${formatList(overview.locationDetailSummary?.floors ?? [], "尚未配置")}`,
    `房间 / 空间：${formatList(overview.locationDetailSummary?.rooms ?? [], "尚未配置")}`,
    `感官细节：${formatList((overview.locationDetailSummary?.locations ?? []).flatMap((location) => location.sensory.map((item) => `${location.name}：${item}`)), "尚未配置")}`,
    `移动规则：${formatList(overview.locationDetailSummary?.travelRules ?? [], "尚未配置")}`,
  ];
}

function toReadableTimeOfDay(calendar: StateOverview["calendar"] | undefined): string {
  switch (calendar?.currentTimeOfDay) {
    case "morning":
      return "上午";
    case "noon":
      return "中午";
    case "afternoon":
      return "下午";
    case "evening":
      return "傍晚";
    case "night":
      return "夜晚";
    case "late_night":
      return "深夜";
    case "unknown":
      return "未知时段";
    default:
      return "尚未配置";
  }
}

function toReadableStage(stage: string | undefined): string | undefined {
  if (!stage?.trim()) return undefined;
  const match = stage.match(/^chapter_(\d+)_committed$/u);
  if (match?.[1]) return `第${match[1]}章已定稿`;
  const labels: Record<string, string> = {
    opening: "开篇",
    idle: "未开始",
    draft_ready: "工作稿已生成",
    quality_checked: "已质检",
    committed: "已定稿",
    ready_for_next: "可进入下一章",
  };
  return labels[stage] ?? sanitizeStageLabel(stage);
}

function toReadableReadiness(level: string): string {
  const labels: Record<string, string> = {
    ready: "可开写",
    warning: "建议补充",
    high_risk: "高风险缺项",
  };
  return labels[level] ?? level;
}

function inferFlowStatus(overview: StateOverview): ChapterWorkspaceData["flowStatus"] {
  const chapterNumber = overview.project.currentChapter ?? overview.timeline.recentEvents.at(-1)?.chapter ?? 1;
  const stage = overview.storyStatus.currentStage;
  const stageMap: Record<string, ChapterWorkspaceData["flowStatus"]> = {
    idle: "idle",
    steering_ready: "steering_ready",
    draft_generating: "draft_generating",
    draft_ready: "draft_ready",
    quality_checked: "quality_checked",
    commit_preview_ready: "commit_preview_ready",
    waiting_commit_confirmation: "waiting_commit_confirmation",
    committed: "committed",
    ready_for_next: "ready_for_next",
  };
  if (stage && stageMap[stage]) {
    return stageMap[stage];
  }
  const hasDraft = overview.timeline.recentEvents.some((event) => event.chapter === chapterNumber);
  if (hasDraft) return "draft_ready";
  return "idle";
}

function buildChapters(overview: StateOverview, currentChapterNumber: number): ChapterNavItem[] {
  const byChapter = new Map<number, ChapterNavItem>();
  const fileStates = new Map((overview.uiChapterFiles ?? []).map((state) => [state.chapter, state]));

  for (const event of overview.timeline.recentEvents) {
    const fileState = fileStates.get(event.chapter);
    byChapter.set(event.chapter, {
      id: `ch-${event.chapter}`,
      chapterNumber: event.chapter,
      title: fileState?.committedTitle ?? fileState?.draftTitle ?? fileState?.workspaceTitle ?? event.title ?? titleFromSummary(event.mainEvent ?? event.summary, event.chapter),
      status: chapterStatusFromFileState(event.chapter, currentChapterNumber, fileState, event.chapter < currentChapterNumber ? "committed" : "planned"),
      ...(fileState ? {
        hasDraftFile: fileState.hasDraftFile,
        hasCommittedChapter: fileState.hasCommittedChapter,
        ...(fileState.hasWorkspaceSnapshot !== undefined ? { hasWorkspaceSnapshot: fileState.hasWorkspaceSnapshot } : {}),
      } : {}),
    });
  }

  for (const fileState of fileStates.values()) {
    const existing = byChapter.get(fileState.chapter);
    byChapter.set(fileState.chapter, {
      id: existing?.id ?? `ch-${fileState.chapter}`,
      chapterNumber: fileState.chapter,
      title: fileState.committedTitle ?? fileState.draftTitle ?? fileState.workspaceTitle ?? existing?.title ?? `第${fileState.chapter}章`,
      status: chapterStatusFromFileState(fileState.chapter, currentChapterNumber, fileState, existing?.status ?? "planned"),
      hasDraftFile: fileState.hasDraftFile,
      hasCommittedChapter: fileState.hasCommittedChapter,
      ...(fileState.hasWorkspaceSnapshot !== undefined ? { hasWorkspaceSnapshot: fileState.hasWorkspaceSnapshot } : {}),
    });
  }

  if (!byChapter.has(currentChapterNumber)) {
    const fileState = fileStates.get(currentChapterNumber);
    byChapter.set(currentChapterNumber, {
      id: `ch-${currentChapterNumber}`,
      chapterNumber: currentChapterNumber,
      title: fileState?.committedTitle ?? fileState?.draftTitle ?? fileState?.workspaceTitle ?? (overview.storyStatus.lastTimelineEvent ? titleFromSummary(overview.storyStatus.lastTimelineEvent, currentChapterNumber) : `第${currentChapterNumber}章`),
      status: "current",
      ...(fileState ? {
        hasDraftFile: fileState.hasDraftFile,
        hasCommittedChapter: fileState.hasCommittedChapter,
        ...(fileState.hasWorkspaceSnapshot !== undefined ? { hasWorkspaceSnapshot: fileState.hasWorkspaceSnapshot } : {}),
      } : {}),
    });
  }

  if (!byChapter.has(currentChapterNumber + 1)) {
    const fileState = fileStates.get(currentChapterNumber + 1);
    byChapter.set(currentChapterNumber + 1, {
      id: `ch-${currentChapterNumber + 1}`,
      chapterNumber: currentChapterNumber + 1,
      title: fileState?.committedTitle ?? fileState?.draftTitle ?? fileState?.workspaceTitle ?? "下一章",
      status: chapterStatusFromFileState(currentChapterNumber + 1, currentChapterNumber, fileState, "planned"),
      ...(fileState ? {
        hasDraftFile: fileState.hasDraftFile,
        hasCommittedChapter: fileState.hasCommittedChapter,
        ...(fileState.hasWorkspaceSnapshot !== undefined ? { hasWorkspaceSnapshot: fileState.hasWorkspaceSnapshot } : {}),
      } : {}),
    });
  }

  return [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function chapterStatusFromFileState(
  chapter: number,
  currentChapterNumber: number,
  fileState: UiChapterFileState | undefined,
  fallback: ChapterNavItem["status"],
): ChapterNavItem["status"] {
  if (chapter === currentChapterNumber) return "current";
  if (fileState?.hasCommittedChapter) return "committed";
  if (fileState?.hasDraftFile) return "draft";
  // 光「开过」(hasWorkspaceSnapshot) 不算有草稿；只有 workspace 里有真草稿才标 draft（与 agent 状态口径一致）。
  if (fileState?.hasWorkspaceDraft) return "draft";
  return fallback === "current" ? "draft" : fallback;
}

function maxNumber(values: readonly number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}

function buildWritingRules(overview: StateOverview): string[] {
  const rules = overview.writingRules;
  if (!rules?.available) {
    return ["写作规则：尚未配置"];
  }
  const forbiddenRules = unique([
    ...rules.forbiddenContent,
    ...rules.doNotDo,
  ]);

  return withFallback(compact([
    rules.narrativePerspective ? `叙事视角：${displayRuleValue(rules.narrativePerspective)}` : undefined,
    rules.narrativePerspective ? `人称：${inferNarrativePerson(rules.narrativePerspective)}` : undefined,
    rules.narrativePerspective ? `视角限制：${inferPerspectiveLimit(rules.narrativePerspective)}` : undefined,
    // 用 `；` 分隔每条文风规则（面板 splitRuleList 按 `；;\n` 切分还原成独立 chip）。
    // 旧版用 `、` 拼接，而单条规则内部本就常含 `、`（如「注重视觉、触觉、嗅觉」），
    // 面板无法区分「规则间分隔」与「规则内顿号」，致全部 proseStyle 塌成一个巨型 chip、新增规则被埋没看不见。
    rules.proseStyle.length > 0 ? `文风：${rules.proseStyle.map(displayRuleValue).join("；")}` : undefined,
    rules.proseStyle.length > 0 ? `文风关键词：${rules.proseStyle.map(displayRuleValue).join("；")}` : undefined,
    rules.readerExperienceRules.length > 0 ? `读者体验规则：${rules.readerExperienceRules.join("；")}` : undefined,
    rules.genreRequirements.length > 0 ? `语言风格：${rules.genreRequirements.join("；")}` : undefined,
    (rules.antiAiPatterns?.length ?? 0) > 0 ? `反AI腔：${rules.antiAiPatterns?.join("；")}` : undefined,
    rules.pacing ? `节奏：${displayRuleValue(rules.pacing)}` : undefined,
    rules.pacing ? `段落节奏：${displayRuleValue(rules.pacing)}` : undefined,
    rules.revealPolicy ? `信息揭示：${displayRuleValue(rules.revealPolicy)}` : undefined,
    rules.revealPolicy ? `揭示策略：${displayRuleValue(rules.revealPolicy)}` : undefined,
    rules.revealPolicy ? `伏笔处理：${displayRuleValue(rules.revealPolicy)}` : undefined,
    rules.targetChapterWords ? `目标字数：约 ${rules.targetChapterWords} 字 / 章` : undefined,
    `禁止事项：${formatList(forbiddenRules, "尚未配置")}`,
  ]), "写作规则：尚未配置");
}

function inferNarrativePerson(value: string): string {
  if (/first/i.test(value)) return "第一人称";
  if (/third/i.test(value)) return "第三人称";
  if (/第一人称/u.test(value)) return "第一人称";
  if (/第三人称/u.test(value)) return "第三人称";
  return displayRuleValue(value);
}

function inferPerspectiveLimit(value: string): string {
  if (/limited/i.test(value)) return "有限视角，只写视角角色能看到和知道的内容";
  if (/omniscient/i.test(value)) return "全知视角";
  if (/贴近主角|有限视角|主角视角/u.test(value)) return "只写主角能看到、知道和推断的内容";
  if (/全知/u.test(value)) return "全知视角";
  return "尚未配置";
}

function displayRuleValue(value: string): string {
  const labels: Record<string, string> = {
    third_limited: "第三人称有限视角",
    first_person: "第一人称",
    immersive: "沉浸",
    "state-aware": "状态感知",
    medium: "中等",
    balanced: "均衡",
  };
  return labels[value] ?? value;
}

function buildStateBackedDraftPlaceholder(overview: StateOverview): string {
  const recent = overview.timeline.recentEvents.at(-1);
  if (!recent && overview.project.currentChapter === null) {
    return compact([
      "还没有工作稿正文。",
      "你可以在右侧章节对话里输入第 1 章方向，先整理本章方案，再生成工作稿。",
      cleanStorySummary(overview.world.summary) ? `故事简介：${cleanStorySummary(overview.world.summary)}` : undefined,
      overview.storyStatus.currentObjective ? `当前目标：${overview.storyStatus.currentObjective}` : undefined,
    ]).join("\n\n");
  }

  return compact([
    "还没有载入本章工作稿正文。",
    overview.storyStatus.currentObjective ? `当前目标：${overview.storyStatus.currentObjective}` : undefined,
    overview.storyStatus.currentLocation ? `当前位置：${overview.storyStatus.currentLocation}` : undefined,
    recent ? `最近时间线：第${recent.chapter}章，${recent.summary}` : undefined,
    overview.hooks.activeItems.length > 0 ? `活跃伏笔：${overview.hooks.activeItems.map((hook) => hook.title).join("；")}` : undefined,
    overview.threads.keyOpenItems.length > 0 ? `未闭合线索：${overview.threads.keyOpenItems.map((thread) => thread.title).join("；")}` : undefined,
  ]).join("\n\n");
}

function buildRisks(overview: StateOverview): RiskWarning[] {
  const fromWarnings = overview.uiHints.warnings.map((text, index) => ({
    id: `warning-${index}`,
    level: "medium" as const,
    text: toReadableWarning(text),
  }));
  const fromHooks = overview.hooks.activeItems
    .filter((hook) => hook.risk === "high" || hook.risk === "medium")
    .map((hook) => ({
      id: `hook-risk-${hook.id}`,
      level: hook.risk ?? "medium",
      text: `伏笔风险：${hook.title}`,
    }));

  const risks = [...fromWarnings, ...fromHooks].slice(0, 8);
  return risks.length > 0 ? risks : [{ id: "risk-empty", level: "low", text: "暂无风险提醒" }];
}

function lastKnownChapter(overview: StateOverview): number | undefined {
  return overview.timeline.recentEvents.at(-1)?.chapter;
}

function titleFromSummary(summary: string, chapter: number): string {
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return `第${chapter}章`;
  return cleaned.length > 12 ? `${cleaned.slice(0, 12)}…` : cleaned;
}

function compact(values: readonly (string | undefined | null)[]): string[] {
  return values.map((value) => cleanUiText(value?.trim())).filter((value): value is string => Boolean(value));
}

function withFallback(values: readonly string[], fallback: string): string[] {
  const cleaned = values.map((value) => cleanUiText(value.trim())).filter((value): value is string => Boolean(value));
  return cleaned.length > 0 ? cleaned : [cleanUiText(fallback) ?? "尚未配置"];
}

/** 面板列表用：只保留真实条目，空则 []——绝不灌「尚未配置」占位（审计 T1）。 */
function realList(values: readonly string[]): string[] {
  return filterPlaceholderUiValues(
    values.map((value) => cleanUiText(value.trim())).filter((value): value is string => Boolean(value)),
  );
}

function formatList(values: readonly (string | undefined | null)[], fallback: string): string {
  const cleaned = unique(values);
  return cleaned.length > 0 ? cleaned.join("；") : cleanUiText(fallback) ?? "尚未配置";
}

function unique(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.map((value) => cleanUiText(value?.trim())).filter((value): value is string => Boolean(value)))];
}

function sanitizeStageLabel(stage: string): string {
  if (stage === "unknown") return "尚未配置";
  const match = stage.match(/^chapter_(\d+)_committed$/u);
  if (match) return `第${match[1]}章已定稿`;
  const labels: Record<string, string> = {
    idle: "待开始",
    steering_ready: "方案已定",
    draft_generating: "工作稿生成中",
    draft_ready: "工作稿已生成",
    quality_checked: "质检通过",
    commit_preview_ready: "待定稿预览",
    waiting_commit_confirmation: "待确认定稿",
    committed: "已定稿",
    ready_for_next: "可进入下一章",
  };
  return labels[stage] ?? cleanUiText(stage) ?? stage;
}

function toReadableWarning(text: string): string {
  const labels: Record<string, string> = {
    many_open_threads: "未闭合线索较多",
    cleanup_candidates_visible: "存在需要人工观察的旧线索",
    mark_done_candidates_visible: "存在待人工确认的完成候选",
    no_active_arc_goals: "暂未设置主线目标",
    no_active_hooks: "暂未设置伏笔",
  };
  return labels[text] ?? text;
}

function displayRole(role: string | undefined): string {
  if (!role?.trim()) return "暂无身份状态";
  const labels: Record<string, string> = {
    protagonist: "主角",
    "main-character": "主角",
  };
  return labels[role] ?? role;
}

function findBibleCharacter(overview: StateOverview, name: string): NonNullable<StateOverview["characterBible"]>["keyCharacters"][number] | undefined {
  return overview.characterBible?.keyCharacters.find((character) => character.name === name);
}

function findCharacterDetail(overview: StateOverview, name: string): NonNullable<StateOverview["characterDetails"]>[number] | undefined {
  return overview.characterDetails?.find((character) => character.name === name);
}

function firstKnown(values: readonly (string | undefined | null)[]): string | undefined {
  return values.find((value): value is string => Boolean(value?.trim()));
}

function extractLabeledItems(values: readonly string[], label: string): string[] {
  const pattern = new RegExp(label, "u");
  return values.filter((value) => pattern.test(value));
}

function buildHardConstraints(overview: StateOverview): string[] {
  const storyBible = overview.storyBible;
  const writingRules = overview.writingRules;
  const locationDetail = overview.locationDetailSummary;
  const assetSummary = overview.assetSummary;
  const characterDetail = overview.characterDetailSummary?.characters[0];
  return withFallback(unique([
    "不要编造新城市名",
    ...(locationDetail?.floors?.length ? ["不要改变已登记楼层结构"] : []),
    ...(locationDetail?.travelRules?.length ? ["不要违反已登记移动规则"] : []),
    ...(assetSummary?.available ? ["不要使用未登记道具；道具变更必须进入定稿预览"] : []),
    ...(assetSummary?.unavailableAssets ?? []).map((item) => `不可用道具不能突然可用：${item}`),
    ...(assetSummary?.plotCriticalAssets ?? []).map((item) => `剧情关键物品不能凭空改变：${item}`),
    ...(characterDetail?.cannotDo ?? []).map((item) => `主角不能做：${item}`),
    ...(storyBible?.protectedSecrets ?? []).map((item) => `不要提前揭开：${item}`),
    ...(storyBible?.coreMysteries ?? []).map((item) => `不要提前揭开：${item}`),
    ...(writingRules?.forbiddenContent ?? []).map((item) => `禁止事项：${item}`),
    ...(writingRules?.doNotDo ?? []).map((item) => `不要：${item}`),
  ]), "尚未配置本章硬约束");
}

function cleanStorySummary(summary: string | undefined): string | undefined {
  if (!summary?.trim()) return undefined;
  return summary
    .replace(/\s*\/\s*The protagonist meets the first visible resistance of the premise\.\s*/gu, "")
    .replace(/\s*\/\s*opening\s*$/u, "")
    .trim();
}
