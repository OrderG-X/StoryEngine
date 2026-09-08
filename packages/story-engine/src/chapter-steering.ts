import { buildStateOverview, type StateOverview } from "./state-overview.js";

export type ChapterSteeringSuggestionType = "hook" | "thread" | "arcGoal" | "character" | "location" | "risk";
export type ChapterSteeringAction = "include" | "skip" | "weaken" | "alternative";
export type ChapterSteeringIntensity = "light" | "medium" | "strong";
export type ChapterSteeringRisk = "low" | "medium" | "high";
export type ChapterSteeringPacing = "slow" | "medium" | "fast";
export type ChapterSteeringRevealLevel = "none" | "small" | "large";

export interface BuildChapterSteeringDraftInput {
  readonly projectDir: string;
  readonly userDirection: string;
  readonly chapter?: number;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly pacing?: ChapterSteeringPacing;
  readonly revealLevel?: ChapterSteeringRevealLevel;
  readonly maxSuggestions?: number;
}

export interface ChapterSteeringDraft {
  readonly userDirection: string;
  readonly chapter: number | null;
  readonly mustInclude: readonly string[];
  readonly mustAvoid: readonly string[];
  readonly pacing: ChapterSteeringPacing;
  readonly revealLevel: ChapterSteeringRevealLevel;
  readonly foundationContext: ChapterSteeringFoundationContext;
  readonly suggestions: readonly ChapterSteeringSuggestion[];
  readonly selectedInclusions: readonly string[];
  readonly generatedChapterGoalPreview: string;
  readonly safety: {
    readonly writesState: false;
    readonly requiresPreviewBeforeCommit: true;
    readonly disabledActions: readonly string[];
  };
}

export interface ChapterSteeringFoundationContext {
  readonly available: boolean;
  readonly summary: string;
  readonly storyBibleAvailable: boolean;
  readonly writingRulesAvailable: boolean;
  readonly characterBibleAvailable: boolean;
  readonly worldBibleAvailable: boolean;
  readonly locationBibleAvailable: boolean;
  readonly writingRuleReminders: readonly string[];
  readonly genreRuleReminders: readonly string[];
  readonly characterBoundaryReminders: readonly string[];
  readonly protagonistKnowledgeReminders: readonly string[];
  readonly forbiddenRevealReminders: readonly string[];
  readonly worldRuleReminders: readonly string[];
  readonly locationContinuityReminders: readonly string[];
  readonly locationRiskReminders: readonly string[];
  readonly setupAssetReminders: readonly string[];
}

export interface ChapterSteeringSuggestion {
  readonly id: string;
  readonly type: ChapterSteeringSuggestionType;
  readonly title: string;
  readonly reason: string;
  readonly suggestedMethod: string;
  readonly defaultAction: ChapterSteeringAction;
  readonly availableActions: readonly ["include", "skip", "weaken", "alternative"];
  readonly intensity: ChapterSteeringIntensity;
  readonly risk: ChapterSteeringRisk;
  readonly sourceId?: string;
  readonly sourceStatus?: string;
}

const DEFAULT_MAX_SUGGESTIONS = 6;
const MAX_SELECTED_INCLUSIONS = 3;
const AVAILABLE_ACTIONS = ["include", "skip", "weaken", "alternative"] as const;

export async function buildChapterSteeringDraft(input: BuildChapterSteeringDraftInput): Promise<ChapterSteeringDraft> {
  const overview = await buildStateOverview({
    projectDir: input.projectDir,
    chapter: input.chapter,
  });
  const mustInclude = normalizeList(input.mustInclude);
  const mustAvoid = normalizeList(input.mustAvoid);
  const pacing = input.pacing ?? "medium";
  const revealLevel = input.revealLevel ?? "small";
  const maxSuggestions = Math.max(3, input.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS);
  const foundationContext = buildFoundationContext(overview);
  const candidates = [
    ...hookSuggestions(overview, input.userDirection, mustInclude, mustAvoid),
    ...threadSuggestions(overview, input.userDirection, mustInclude, mustAvoid),
    ...arcGoalSuggestions(overview, input.userDirection, mustInclude, mustAvoid),
    ...characterSuggestions(overview, input.userDirection, mustInclude, mustAvoid),
    ...locationSuggestions(overview, input.userDirection, mustInclude, mustAvoid),
  ];
  const riskSuggestions = buildRiskSuggestions(overview, input.userDirection, mustAvoid);
  const ranked = rankSuggestions(candidates, mustInclude);
  const nonRiskLimit = Math.min(maxSuggestions, Math.max(3, maxSuggestions - riskSuggestions.length));
  const suggestions = uniqueSuggestions([
    ...selectWithTypeCoverage(ranked, nonRiskLimit, ["thread", "hook", "arcGoal"]),
    ...riskSuggestions,
  ]).slice(0, maxSuggestions);
  const selectedInclusions = suggestions
    .filter((item) => item.type !== "risk" && item.defaultAction === "include")
    .slice(0, MAX_SELECTED_INCLUSIONS)
    .map((item) => item.id);

  return {
    userDirection: input.userDirection,
    chapter: overview.project.currentChapter,
    mustInclude,
    mustAvoid,
    pacing,
    revealLevel,
    foundationContext,
    suggestions,
    selectedInclusions,
    generatedChapterGoalPreview: buildChapterGoalPreview({
      userDirection: input.userDirection,
      pacing,
      revealLevel,
      mustInclude,
      mustAvoid,
      foundationContext,
      inclusions: suggestions.filter((item) => selectedInclusions.includes(item.id)),
    }),
    safety: {
      writesState: false,
      requiresPreviewBeforeCommit: true,
      disabledActions: [
        "commit_draft",
        "apply_review_plan_confirm",
        "merge_threads_confirm",
        "drop_thread_confirm",
        "auto_cleanup",
        "auto_expire",
        "auto_mark_done",
      ],
    },
  };
}

function hookSuggestions(
  overview: StateOverview,
  direction: string,
  mustInclude: readonly string[],
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion[] {
  return overview.hooks.activeItems.slice(0, 3).map((hook, index) => withAvoidance({
    id: `steer-hook-${index + 1}`,
    type: "hook",
    title: hook.title,
    reason: `HookPool 中仍处于 ${hook.status}，适合轻量承接而不是强行解决。`,
    suggestedMethod: hook.risk === "high"
      ? "用一句异常、目击或物证提醒读者它仍在场。"
      : "作为背景细节轻轻带过，避免抢走本章方向。",
    defaultAction: matchesAny(hook.title, [...mustInclude, direction]) ? "include" : "weaken",
    availableActions: AVAILABLE_ACTIONS,
    intensity: hook.risk === "high" ? "medium" : "light",
    risk: hook.risk ?? "medium",
    sourceId: hook.id,
    sourceStatus: hook.status,
  }, mustAvoid));
}

function threadSuggestions(
  overview: StateOverview,
  direction: string,
  mustInclude: readonly string[],
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion[] {
  return overview.threads.keyOpenItems
    .filter((thread) => !isLowValueCleanupThread(thread.cleanupCandidateClass))
    .slice(0, 4)
    .map((thread, index) => withAvoidance({
      id: `steer-thread-${index + 1}`,
      type: "thread",
      title: thread.title,
      reason: `ThreadPool 中的 ${thread.type ?? "thread"} 仍为 ${thread.status}，可作为下一章具体行动或线索承接。`,
      suggestedMethod: thread.type === "intent"
        ? "让主角采取一个小行动推进它，不必一次完成。"
        : "让主角得到一个新证据或新判断，避免原地重复。",
      defaultAction: matchesAny(thread.title, [...mustInclude, direction]) ? "include" : "weaken",
      availableActions: AVAILABLE_ACTIONS,
      intensity: matchesAny(thread.title, direction) ? "strong" : "medium",
      risk: thread.cleanupCandidateClass ? "medium" : "low",
      sourceId: thread.id,
      sourceStatus: thread.status,
    }, mustAvoid));
}

/** 目标停滞压力信号阈值（r7）：idle>5 在 reason 里点名；idle>10 升级为默认收入本章（长跑防「目标挂着没人管」）。 */
const GOAL_IDLE_MENTION_CHAPTERS = 5;
const GOAL_IDLE_PRESSURE_CHAPTERS = 10;

function arcGoalSuggestions(
  overview: StateOverview,
  direction: string,
  mustInclude: readonly string[],
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion[] {
  const currentChapter = overview.project.currentChapter;
  return overview.arcGoals.activeItems.slice(0, 3).map((goal, index) => {
    const idleChapters = typeof currentChapter === "number" && typeof goal.lastTouchedChapter === "number"
      ? Math.max(0, currentChapter - goal.lastTouchedChapter)
      : 0;
    const idlePressure = idleChapters > GOAL_IDLE_PRESSURE_CHAPTERS;
    const isMainArc = goal.progress === "main_arc";
    return withAvoidance({
      id: `steer-arc-${index + 1}`,
      type: "arcGoal",
      title: goal.title,
      reason: idleChapters > GOAL_IDLE_MENTION_CHAPTERS
        ? `该目标已 ${idleChapters} 章未推进${isMainArc ? "（主线不该长期停摆）" : ""}，本章是推进或收口的好时机。`
        : `ArcGoal 仍处于 ${goal.status}，可帮助本章不偏离长线目标。`,
      suggestedMethod: idlePressure
        ? "安排一次实质推进（新信息/新障碍/代价），或明确交代搁置原因；不要在一章内完成整条长线。"
        : "安排一个小进展或代价，不要在一章内完成整条长线。",
      defaultAction: idlePressure || matchesAny(goal.title, [...mustInclude, direction]) ? "include" : "weaken",
      availableActions: AVAILABLE_ACTIONS,
      intensity: idlePressure && isMainArc ? "strong" : isMainArc || idlePressure ? "medium" : "light",
      risk: "low",
      sourceId: goal.id,
      sourceStatus: goal.status,
    }, mustAvoid);
  });
}

function characterSuggestions(
  overview: StateOverview,
  direction: string,
  mustInclude: readonly string[],
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion[] {
  const protagonist = overview.characters.protagonist
    ? overview.characters.knownCharacters.find((item) => item.name === overview.characters.protagonist)
    : overview.characters.knownCharacters[0];
  if (!protagonist) return [];
  const characterBoundary = overview.characterBible.keyCharacters
    .find((item) => item.id === protagonist.id || item.name === protagonist.name)?.desire;
  return [withAvoidance({
    id: "steer-character-1",
    type: "character",
    title: protagonist.name,
    reason: characterBoundary
      ? `下一章方向应继续绑定主角视角和当前行动动机；角色 Bible 目标：${characterBoundary}。`
      : "下一章方向应继续绑定主角视角和当前行动动机。",
    suggestedMethod: "让选择、犹豫或代价从主角当前状态自然生长出来；不要突破角色 Bible 边界。",
    defaultAction: matchesAny(protagonist.name, [...mustInclude, direction]) ? "include" : "weaken",
    availableActions: AVAILABLE_ACTIONS,
    intensity: "light",
    risk: "low",
    sourceId: protagonist.id,
    sourceStatus: protagonist.status,
  }, mustAvoid)];
}

function locationSuggestions(
  overview: StateOverview,
  direction: string,
  mustInclude: readonly string[],
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion[] {
  const locations = unique([
    ...overview.world.activeLocations,
    ...overview.locationBible.activeLocationNames,
    overview.storyStatus.currentLocation,
  ].filter(isNonEmpty));
  return locations.slice(0, 2).map((location, index) => withAvoidance({
    id: `steer-location-${index + 1}`,
    type: "location",
    title: location,
    reason: overview.locationBible.available
      ? "Location Bible 中的地点可帮助下一章保持空间连续，减少跳场感。"
      : "最近地点可帮助下一章保持空间连续，减少跳场感。",
    suggestedMethod: "用一个可感知的环境细节承接上一章位置，再进入新动作；地点规则只做提示，不写状态。",
    defaultAction: matchesAny(location, [...mustInclude, direction]) ? "include" : "weaken",
    availableActions: AVAILABLE_ACTIONS,
    intensity: "light",
    risk: "low",
  }, mustAvoid));
}

function buildRiskSuggestions(
  overview: StateOverview,
  direction: string,
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion[] {
  const warnings: Array<{
    readonly id: string;
    readonly title: string;
    readonly reason: string;
    readonly method: string;
    readonly risk: ChapterSteeringRisk;
  }> = [
    {
      id: "steer-risk1",
      title: "别在一章里同时推进太多伏笔和线索",
      reason: "建议数量控制在 3-6 个，避免下一章变成任务清单。",
      method: "优先选 1 条主行动、1 条轻量伏笔、1 个角色或地点承接。",
      risk: "medium" as const,
    },
  ];
  if (mustAvoid.some((item) => matchesAny(direction, item))) {
    warnings.push({
      id: "steer-risk2",
      title: "用户方向与 mustAvoid 存在冲突",
      reason: "当前方向文本命中了 mustAvoid，需要在 preview 阶段让用户确认。",
      method: "生成替代路线，保留方向情绪但避开禁用对象。",
      risk: "high" as const,
    });
  }
  if (overview.maintenance.cleanupVisibleCount > 0) {
    warnings.push({
      id: "steer-risk3",
      title: "线索池里有待清理的低价值线索",
      reason: "低价值或过期的线索不应默认带进下一章方向。",
      method: "只承接高价值线索、地点、资源或风险任务。",
      risk: "low" as const,
    });
  }
  const protectedSecrets = unique([
    ...overview.world.protectedSecrets,
    ...overview.storyBible.coreMysteries,
    ...overview.storyBible.protectedSecrets,
  ]);
  if (protectedSecrets.length > 0) {
    warnings.push({
      id: "steer-risk4",
      title: "不要提前揭开隐藏真相",
      reason: `当前基础设定保护了：${protectedSecrets.slice(0, 3).join("；")}。`,
      method: "只让主角接触现象、误导或局部证据，不直接给出幕后答案。",
      risk: "high" as const,
    });
  }
  return warnings.map((warning) => ({
    id: warning.id,
    type: "risk",
    title: warning.title,
    reason: warning.reason,
    suggestedMethod: warning.method,
    defaultAction: "include",
    availableActions: AVAILABLE_ACTIONS,
    intensity: warning.risk === "high" ? "strong" : "medium",
    risk: warning.risk,
  }));
}

function withAvoidance<T extends ChapterSteeringSuggestion>(
  suggestion: T,
  mustAvoid: readonly string[],
): ChapterSteeringSuggestion {
  if (!matchesAny(suggestion.title, mustAvoid)) return suggestion;
  return {
    ...suggestion,
    reason: `${suggestion.reason} 但它命中了 mustAvoid，需要避让或替代。`,
    suggestedMethod: "不要直接推进该项；改为替代线索、侧面影响或完全跳过。",
    defaultAction: "skip",
    intensity: "light",
    risk: "high",
  };
}

function rankSuggestions(
  suggestions: readonly ChapterSteeringSuggestion[],
  mustInclude: readonly string[],
): ChapterSteeringSuggestion[] {
  return suggestions.slice().sort((a, b) => scoreSuggestion(b, mustInclude) - scoreSuggestion(a, mustInclude));
}

function selectWithTypeCoverage(
  suggestions: readonly ChapterSteeringSuggestion[],
  limit: number,
  preferredTypes: readonly ChapterSteeringSuggestionType[],
): ChapterSteeringSuggestion[] {
  const selected: ChapterSteeringSuggestion[] = [];
  const selectedIds = new Set<string>();
  for (const type of preferredTypes) {
    const candidate = suggestions.find((suggestion) => suggestion.type === type && !selectedIds.has(suggestion.id));
    if (!candidate) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    if (selected.length >= limit) return selected;
  }
  for (const suggestion of suggestions) {
    if (selectedIds.has(suggestion.id)) continue;
    selected.push(suggestion);
    selectedIds.add(suggestion.id);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function scoreSuggestion(suggestion: ChapterSteeringSuggestion, mustInclude: readonly string[]): number {
  let score = 0;
  if (suggestion.defaultAction === "include") score += 5;
  if (suggestion.type === "thread") score += 4;
  if (suggestion.type === "arcGoal") score += 3;
  if (suggestion.type === "hook") score += 3;
  if (suggestion.type === "character") score += 1;
  if (suggestion.type === "location") score += 1;
  if (matchesAny(suggestion.title, mustInclude)) score += 10;
  if (suggestion.risk === "high") score -= 2;
  return score;
}

function buildChapterGoalPreview(input: {
  readonly userDirection: string;
  readonly pacing: ChapterSteeringPacing;
  readonly revealLevel: ChapterSteeringRevealLevel;
  readonly mustInclude: readonly string[];
  readonly mustAvoid: readonly string[];
  readonly foundationContext: ChapterSteeringFoundationContext;
  readonly inclusions: readonly ChapterSteeringSuggestion[];
}): string {
  const inclusions = input.inclusions
    .filter((item) => item.type !== "risk")
    .slice(0, MAX_SELECTED_INCLUSIONS)
    .map((item) => item.title);
  return [
    `下一章方向：${input.userDirection.trim()}`,
    `节奏：${input.pacing}`,
    `揭示程度：${input.revealLevel}`,
    inclusions.length > 0 ? `建议承接：${inclusions.join("；")}` : "建议承接：保留 1 条主行动和 1 条轻量伏笔即可。",
    input.mustInclude.length > 0 ? `必须包含：${input.mustInclude.join("；")}` : undefined,
    input.mustAvoid.length > 0 ? `必须避开：${input.mustAvoid.join("；")}` : undefined,
    input.foundationContext.available ? `基础设定：${input.foundationContext.summary}` : undefined,
    "注意：本 preview 只用于 draft 前预览，不写正式状态。",
  ].filter(isNonEmpty).join("。");
}

function buildFoundationContext(overview: StateOverview): ChapterSteeringFoundationContext {
  const protagonist = overview.characters.protagonist;
  const protagonistBible = overview.characterBible.keyCharacters.find((character) => character.name === protagonist)
    ?? overview.characterBible.keyCharacters[0];
  return {
    available: overview.storyFoundation.available,
    summary: overview.storyFoundation.summary,
    storyBibleAvailable: overview.storyBible.available,
    writingRulesAvailable: overview.writingRules.available,
    characterBibleAvailable: overview.characterBible.available,
    worldBibleAvailable: overview.worldBible.available,
    locationBibleAvailable: overview.locationBible.available,
    writingRuleReminders: unique([
      ...overview.writingRules.proseStyle,
      ...(overview.writingRules.pacing ? [`节奏：${overview.writingRules.pacing}`] : []),
      ...(overview.writingRules.revealPolicy ? [`揭示策略：${overview.writingRules.revealPolicy}`] : []),
      ...overview.writingRules.readerExperienceRules,
      ...overview.writingRules.doNotDo,
    ]).slice(0, 5),
    genreRuleReminders: unique([
      ...(overview.storyBible.genre ? [`类型：${overview.storyBible.genre}`] : []),
      ...overview.writingRules.genreRequirements,
      ...overview.storyBible.forbiddenChanges,
    ]).slice(0, 5),
    characterBoundaryReminders: overview.characterBible.keyCharacters
      .flatMap((character) => [
        character.desire ? `${character.name}目标：${character.desire}` : `${character.name}：${character.role}`,
        ...(character.weakness ? [`${character.name}短板：${character.weakness}`] : []),
        ...character.behaviorBoundaries.map((item) => `${character.name}边界：${item}`),
      ])
      .slice(0, 5),
    protagonistKnowledgeReminders: protagonistBible
      ? unique([
        ...protagonistBible.knowledgeKnown.map((item) => `已知：${item}`),
        ...protagonistBible.knowledgeUnknown.map((item) => `未知：${item}`),
      ]).slice(0, 5)
      : [],
    forbiddenRevealReminders: unique([
      ...overview.world.protectedSecrets,
      ...overview.storyBible.coreMysteries,
      ...overview.storyBible.protectedSecrets,
      ...overview.storyBible.forbiddenChanges,
    ]).slice(0, 5),
    worldRuleReminders: unique([
      ...overview.worldBible.keyRules,
      ...overview.storyBible.canonFacts,
      ...overview.storyBible.centralConflicts,
    ]).slice(0, 5),
    locationContinuityReminders: overview.locationBible.activeLocationNames.slice(0, 5),
    locationRiskReminders: overview.locationBible.keyRisks.slice(0, 5),
    setupAssetReminders: unique([
      ...(overview.storyBible.setupAssets?.initialAssets ?? []),
      ...(overview.storyBible.setupAssets?.keyItems ?? []),
      ...(overview.storyBible.setupAssets?.resourceLimits ?? []),
    ]).slice(0, 5),
  };
}

function uniqueSuggestions(suggestions: readonly ChapterSteeringSuggestion[]): ChapterSteeringSuggestion[] {
  const seen = new Set<string>();
  const result: ChapterSteeringSuggestion[] = [];
  for (const suggestion of suggestions) {
    const key = `${suggestion.type}:${suggestion.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(suggestion);
  }
  return result;
}

function normalizeList(values: readonly string[] | undefined): readonly string[] {
  return unique((values ?? []).map((item) => item.trim()).filter(isNonEmpty));
}

function isLowValueCleanupThread(cleanupCandidateClass: string | undefined): boolean {
  return cleanupCandidateClass === "cleanup_candidate"
    || cleanupCandidateClass === "manual_review_drop_candidate"
    || cleanupCandidateClass === "stale_low_value_candidate"
    || cleanupCandidateClass === "stale_generic_candidate";
}

function matchesAny(value: string, candidates: readonly string[] | string): boolean {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  const normalized = normalize(value);
  return values.some((candidate) => {
    const term = normalize(candidate);
    return term.length > 0 && (normalized.includes(term) || term.includes(normalized));
  });
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "");
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
