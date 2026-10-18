import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applyFoundationWriteSuggestion,
  classifyFoundationWriteSuggestion,
  targetFilesForFoundationWriteSuggestion,
} from "./foundation-write-gateway.js";
import type { FoundationWriteRecord, FoundationWriteResult, FoundationWriteRisk, FoundationWriteSkipReason } from "./foundation-write-gateway.js";
import {
  readArcGoalPool,
  readAssetLedger,
  readCharacterBible,
  readHookPool,
  readLocationBible,
  readStoryBible,
  readThreadPool,
  readTimelineEvents,
  readWorldBible,
  readWorldCore,
  readWorldState,
  readWritingRules,
  describeErrorBriefly,
  toSafeCharacterId,
  writeFileAtomic,
} from "./project-store.js";
import { buildStateOverview, type StateOverview } from "./state-overview.js";
import type {
  ArcGoalPool,
  AssetItem,
  AssetLedger,
  CharacterBible,
  CharacterBibleEntry,
  HookPool,
  LocationBible,
  LocationBibleEntry,
  LocationSensoryDetails,
  LocationTravelRule,
  StoryBible,
  ThreadPool,
  TimelineEvent,
  WorldBible,
  WorldCore,
  WorldState,
  WritingRules,
} from "./types.js";

export type FoundationGapCategory =
  | "story"
  | "world"
  | "writingRules"
  | "characters"
  | "characterRelationships"
  | "locations"
  | "assets"
  | "hooks"
  | "threads"
  | "arcGoals"
  | "timeline"
  | "knowledgeBoundary";

export type FoundationGapSeverity = "info" | "warning" | "high";
export type FoundationReadinessLevel = "ready" | "warning" | "high_risk";

export interface FoundationGapItem {
  readonly id: string;
  readonly category: FoundationGapCategory;
  readonly severity: FoundationGapSeverity;
  readonly title: string;
  readonly description: string;
  readonly missingFields: readonly string[];
  readonly affectedWritingRisk: string;
  readonly suggestedFix: string;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly targetId?: string;
  readonly requiresUserConfirm: true;
}

export interface FoundationConflictItem {
  readonly id: string;
  readonly category: FoundationGapCategory;
  readonly title: string;
  readonly description: string;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly existingValue: unknown;
  readonly suggestedValue: unknown;
  readonly resolutionOptions: readonly ["keep_existing", "replace", "merge", "defer"];
}

export interface FoundationGapReport {
  readonly passed: boolean;
  readonly readinessLevel: FoundationReadinessLevel;
  readonly missingItems: readonly FoundationGapItem[];
  readonly riskyItems: readonly FoundationGapItem[];
  readonly conflictItems: readonly FoundationConflictItem[];
  readonly suggestions: readonly FoundationGapSuggestion[];
  readonly byCategory: Readonly<Record<FoundationGapCategory, readonly FoundationGapItem[]>>;
}

export type FoundationGapActionType =
  | "fill_missing_field"
  | "create_character"
  | "rename_character"
  | "update_character_detail"
  | "create_location"
  | "create_asset"
  | "update_world_rule"
  | "update_writing_rule"
  | "update_character_boundary"
  | "update_location_detail"
  | "update_asset_status"
  | "create_relationship"
  | "update_knowledge_boundary"
  | "delete_foundation_entry"
  | "defer";

export interface FoundationGapSuggestion {
  readonly id: string;
  readonly gapId: string;
  readonly category: FoundationGapCategory;
  readonly actionType: FoundationGapActionType;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly targetId?: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly rationale: string;
  readonly risk: FoundationGapSeverity;
  readonly requiresUserConfirm: true;
  readonly sourceUserMessage?: string;
  readonly extractedEntityName?: string;
  readonly extractedEntityType?: string;
  readonly sourceEvidence?: string;
  readonly preservationWarnings?: readonly string[];
  readonly writeMode?: "merge" | "replace";
  readonly confirmedByUser?: boolean;
}

export interface FoundationGapDecision {
  readonly suggestionId: string;
  readonly decision: "accept" | "reject" | "defer" | "edit";
  readonly editedAfter?: unknown;
}

export interface FoundationGapApplyPlan {
  readonly acceptedSuggestions: readonly FoundationGapSuggestion[];
  readonly rejectedSuggestionIds: readonly string[];
  readonly deferredSuggestionIds: readonly string[];
  readonly skippedConflicts: readonly FoundationConflictItem[];
  readonly fileChanges: readonly FoundationGapFileChange[];
}

export interface FoundationGapFileChange {
  readonly targetFile: string;
  readonly summary: string;
  readonly suggestionIds: readonly string[];
}

/** 因目标缺失被跳过的写入（修2）：携带是哪条 suggestion、为什么、给用户看的说明。 */
export interface FoundationGapSkippedWrite {
  readonly suggestionId: string;
  readonly reason: FoundationWriteSkipReason;
  readonly action: string;
  readonly targetName?: string;
  readonly summary: string;
}

export interface FoundationGapApplyResult {
  readonly applied: boolean;
  readonly plan: FoundationGapApplyPlan;
  readonly overview: StateOverview;
  readonly writes: readonly FoundationWriteRecord[];
  /** 被跳过的写入（修2）：有值即代表「这些没写成」是明确状态，让 UI 可以诚实回报原因。 */
  readonly skippedWrites?: readonly FoundationGapSkippedWrite[];
}

type SourceBundle = {
  readonly storyBible: StoryBible | null;
  readonly worldCore: WorldCore;
  readonly worldState: WorldState;
  readonly worldBible: WorldBible | null;
  readonly writingRules: WritingRules | null;
  readonly characterBible: CharacterBible | null;
  readonly locationBible: LocationBible | null;
  readonly assetLedger: AssetLedger;
  readonly hooks: HookPool;
  readonly threads: ThreadPool;
  readonly arcGoals: ArcGoalPool;
  readonly timelineEvents: readonly TimelineEvent[];
};

const CATEGORIES: readonly FoundationGapCategory[] = [
  "story",
  "world",
  "writingRules",
  "characters",
  "characterRelationships",
  "locations",
  "assets",
  "hooks",
  "threads",
  "arcGoals",
  "timeline",
  "knowledgeBoundary",
];

export async function buildFoundationGapReport(projectDir: string): Promise<FoundationGapReport> {
  const sources = await readSources(projectDir);
  const gaps: FoundationGapItem[] = [];
  const conflicts: FoundationConflictItem[] = [];

  collectStoryGaps(sources, gaps);
  collectWorldGaps(sources, gaps);
  collectWritingRuleGaps(sources, gaps);
  collectCharacterGaps(sources, gaps);
  collectRelationshipGaps(sources, gaps);
  collectLocationGaps(sources, gaps);
  collectAssetGaps(sources, gaps);
  collectContinuityGaps(sources, gaps);
  collectTimelineGaps(sources, gaps);
  collectKnowledgeBoundaryGaps(sources, gaps);
  collectConflicts(sources, conflicts);

  const riskyItems = gaps.filter((item) => item.severity === "high" || item.severity === "warning");
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, gaps.filter((item) => item.category === category)])) as Record<FoundationGapCategory, FoundationGapItem[]>;
  const readinessLevel: FoundationReadinessLevel = gaps.some((item) => item.severity === "high")
    ? "high_risk"
    : gaps.some((item) => item.severity === "warning")
      ? "warning"
      : "ready";

  return {
    passed: gaps.length === 0 && conflicts.length === 0,
    readinessLevel,
    missingItems: gaps,
    riskyItems,
    conflictItems: conflicts,
    suggestions: buildSuggestionsFromGaps(gaps, sources),
    byCategory,
  };
}

export async function buildFoundationGapSuggestions(projectDir: string, report?: FoundationGapReport): Promise<readonly FoundationGapSuggestion[]> {
  return (report ?? await buildFoundationGapReport(projectDir)).suggestions;
}

export async function buildFoundationGapApplyPlan(
  projectDir: string,
  decisions: readonly FoundationGapDecision[],
  extraSuggestions: readonly FoundationGapSuggestion[] = [],
): Promise<FoundationGapApplyPlan> {
  const report = await buildFoundationGapReport(projectDir);
  const suggestions = new Map([
    ...report.suggestions.map((suggestion) => [suggestion.id, suggestion] as const),
    ...extraSuggestions.map((suggestion) => [suggestion.id, suggestion] as const),
  ]);
  const acceptedSuggestions: FoundationGapSuggestion[] = [];
  const rejectedSuggestionIds: string[] = [];
  const deferredSuggestionIds: string[] = [];
  const skippedConflicts: FoundationConflictItem[] = [];

  for (const decision of decisions) {
    const suggestion = suggestions.get(decision.suggestionId);
    if (!suggestion) continue;
    if (decision.decision === "reject") {
      rejectedSuggestionIds.push(decision.suggestionId);
      continue;
    }
    if (decision.decision === "defer") {
      deferredSuggestionIds.push(decision.suggestionId);
      continue;
    }
    if (decision.decision === "accept" && suggestion.preservationWarnings && suggestion.preservationWarnings.length > 0) {
      skippedConflicts.push({
        id: `${suggestion.id}:preservation-warning`,
        category: suggestion.category,
        title: "资料草案与用户原话不一致",
        description: suggestion.preservationWarnings.join("；"),
        existingValue: suggestion.extractedEntityName ?? suggestion.sourceUserMessage,
        suggestedValue: suggestion.after,
        targetFile: suggestion.targetFile,
        targetPath: suggestion.targetPath,
        resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
      });
      continue;
    }
    const nextSuggestion = decision.decision === "edit"
      ? { ...suggestion, after: decision.editedAfter ?? suggestion.after }
      : suggestion;
    const writeRisk = await classifyFoundationWriteSuggestion({ projectDir, suggestion: nextSuggestion });
    if (writeRisk.level !== "safe") {
      skippedConflicts.push(conflictFromWriteRisk(nextSuggestion, writeRisk));
      continue;
    }
    const conflict = nextSuggestion.actionType === "delete_foundation_entry"
      ? undefined
      : report.conflictItems.find((item) => item.targetFile === nextSuggestion.targetFile && item.targetPath === targetPathForSuggestion(nextSuggestion))
        ?? await findSuggestionConflict(projectDir, nextSuggestion);
    if (conflict) {
      skippedConflicts.push(conflict);
      continue;
    }
    acceptedSuggestions.push(nextSuggestion);
  }

  const byFile = new Map<string, string[]>();
  for (const suggestion of acceptedSuggestions) {
    for (const targetFile of targetFilesForSuggestion(suggestion)) {
      byFile.set(targetFile, [...(byFile.get(targetFile) ?? []), suggestion.id]);
    }
  }

  return {
    acceptedSuggestions,
    rejectedSuggestionIds,
    deferredSuggestionIds,
    skippedConflicts,
    fileChanges: [...byFile.entries()].map(([targetFile, suggestionIds]) => ({
      targetFile,
      summary: `将写入 ${suggestionIds.length} 条资料补全建议`,
      suggestionIds,
    })),
  };
}

function targetFilesForSuggestion(suggestion: FoundationGapSuggestion): readonly string[] {
  return targetFilesForFoundationWriteSuggestion(suggestion);
}

function conflictFromWriteRisk(suggestion: FoundationGapSuggestion, risk: FoundationWriteRisk): FoundationConflictItem {
  return {
    id: `${suggestion.id}:write-risk`,
    category: suggestion.category,
    title: risk.level === "blocked" ? "写入被保护策略拦截" : "写入需要明确覆盖确认",
    description: risk.reason,
    targetFile: risk.targetFile,
    targetPath: risk.targetPath,
    existingValue: risk.existingValue,
    suggestedValue: risk.suggestedValue,
    resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
  };
}

export async function applyFoundationGapDecisions(
  projectDir: string,
  decisions: readonly FoundationGapDecision[],
  extraSuggestions: readonly FoundationGapSuggestion[] = [],
): Promise<FoundationGapApplyResult> {
  const plan = await buildFoundationGapApplyPlan(projectDir, decisions, extraSuggestions);

  const writes: FoundationWriteRecord[] = [];
  const skippedWrites: FoundationGapSkippedWrite[] = [];
  for (const suggestion of plan.acceptedSuggestions) {
    // 逐条隔离（韧性）：先快照这一条要碰的文件【当前】内容（含前面已成功写入的改动）。
    // 这条若在写入期抛错（如模型给的某条形状残缺、磁盘上某文件损坏），就只把它自己碰过的文件回滚回
    // 这条执行前的样子、记成 apply_failed 跳过、继续写其余——一条畸形建议不再把整批拖垮成全有或全无的
    // HTTP 500。关键：用「当前」而非「批前」快照，否则回滚会把同一文件上前面已成功写入的改动一起抹掉。
    const snapshot = await snapshotFiles(projectDir, targetFilesForSuggestion(suggestion));
    try {
      const result = await applySuggestion(projectDir, suggestion);
      writes.push(...result.writes);
      for (const skip of result.skipped ?? []) {
        skippedWrites.push({
          suggestionId: suggestion.id,
          reason: skip.reason,
          action: skip.action,
          ...(skip.targetName ? { targetName: skip.targetName } : {}),
          summary: skip.summary,
        });
      }
    } catch (error) {
      await restoreFiles(projectDir, snapshot);
      const targetName = suggestionDisplayName(suggestion);
      skippedWrites.push({
        suggestionId: suggestion.id,
        reason: "apply_failed",
        action: suggestion.actionType ?? "unknown",
        ...(targetName ? { targetName } : {}),
        summary: `${targetName ? `「${targetName}」` : "这条资料"}未写入：写入时出错（${describeErrorBriefly(error, projectDir)}），已跳过，其余资料照常写入。`,
      });
    }
  }
  const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
  return {
    applied: writes.length > 0,
    plan,
    overview,
    writes,
    ...(skippedWrites.length > 0 ? { skippedWrites } : {}),
  };
}

/** 读取一组文件的当前内容快照（ENOENT → undefined，表示该文件本不存在）。 */
async function snapshotFiles(projectDir: string, relativePaths: readonly string[]): Promise<Map<string, string | undefined>> {
  const snapshot = new Map<string, string | undefined>();
  for (const relativePath of relativePaths) {
    if (snapshot.has(relativePath)) continue;
    const absolutePath = join(projectDir, relativePath);
    const existing = await readFile(absolutePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    snapshot.set(relativePath, existing);
  }
  return snapshot;
}

/** 把快照里的文件恢复成原始字节（undefined → 删除）。写原始字节、不重新 parse，损坏文件也能精确还原。 */
async function restoreFiles(projectDir: string, snapshot: ReadonlyMap<string, string | undefined>): Promise<void> {
  await Promise.all([...snapshot.entries()].map(async ([relativePath, content]) => {
    const absolutePath = join(projectDir, relativePath);
    if (content === undefined) {
      await rm(absolutePath, { force: true }).catch(() => undefined);
      return;
    }
    await writeFileAtomic(absolutePath, content);
  }));
}

/** 取建议的展示名：优先抽取出的实体名，其次 before.name。供 apply_failed 跳过文案用。 */
function suggestionDisplayName(suggestion: FoundationGapSuggestion): string | undefined {
  if (suggestion.extractedEntityName) return suggestion.extractedEntityName;
  const before = suggestion.before;
  if (isRecord(before) && typeof before.name === "string" && before.name.trim()) return before.name.trim();
  return undefined;
}

/** ENOENT-only 兜底：缺文件回落 fallback（老书合法缺台账），其余错误（损坏 JSON 等）原样上抛。 */
function enoentOnly<T>(fallback: () => T): (error: unknown) => T {
  return (error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return fallback();
    }
    throw error;
  };
}

async function readSources(projectDir: string): Promise<SourceBundle> {
  const [storyBible, worldCore, worldState, worldBible, writingRules, characterBible, locationBible, assetLedger, hooks, threads, arcGoals, timelineEvents] = await Promise.all([
    readStoryBible(projectDir),
    readWorldCore(projectDir),
    readWorldState(projectDir),
    readWorldBible(projectDir),
    readWritingRules(projectDir),
    readCharacterBible(projectDir),
    readLocationBible(projectDir),
    readAssetLedger(projectDir),
    // 审计 Low：readXxxPool 只兜 ENOENT（老书合法缺文件）、损坏 JSON 会 rethrow——这里的裸 catch
    // 把损坏也吞成空池，gap 报告按「资料缺失」给误导性建议。改为 ENOENT-only：损坏如实上抛
    // （调用方 500 报错，用户知道要先修文件），与 project-store「坏文件绝不当空池」口径一致。
    readHookPool(projectDir).catch(enoentOnly(() => ({ hooks: [] }))),
    readThreadPool(projectDir).catch(enoentOnly(() => ({ threads: [] }))),
    readArcGoalPool(projectDir).catch(enoentOnly(() => ({ goals: [] }))),
    readTimelineEvents(projectDir).catch(enoentOnly(() => [] as never[])),
  ]);
  return { storyBible, worldCore, worldState, worldBible, writingRules, characterBible, locationBible, assetLedger, hooks, threads, arcGoals, timelineEvents };
}

function collectStoryGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const bible = sources.storyBible;
  if (!bible) {
    addGap(gaps, "story", "high", "缺少故事设定文件", "缺少整本书的基础设定，后续写作会缺少世界和主线锚点。", ["story/bible.json"], "写作模型可能只能临场编故事。", "创建故事设定基础文件。", "story/bible.json", "$");
    return;
  }
  if (!text(bible.projectLogline) && !text(bible.premise)) addGap(gaps, "story", "high", "缺少一句话故事", "没有一句话故事，章节方向容易发散。", ["projectLogline"], "章节目标难以稳定。", "补充一句话故事。", "story/bible.json", "projectLogline");
  if (!text(bible.genre)) addGap(gaps, "story", "warning", "缺少类型", "没有故事类型，类型约束和进展规则无法判断。", ["genre"], "容易混入错误题材规则。", "补充故事类型。", "story/bible.json", "genre");
  if (!text(bible.readerPromise)) addGap(gaps, "story", "warning", "缺少读者期待", "读者追读动力没有被明确记录。", ["readerPromise"], "章节会只推进事件，缺少长期吸引力。", "补充读者期待。", "story/bible.json", "readerPromise");
  if (bible.longFormGoals.length === 0) addGap(gaps, "story", "warning", "缺少长篇目标", "缺少长期目标，后续章节难以围绕主线推进。", ["longFormGoals"], "长篇容易变成短事件串联。", "补充长篇目标或第一卷目标。", "story/bible.json", "longFormGoals");
  if (!bible.firstChapterSetup?.goal) addGap(gaps, "story", "warning", "缺少第一章方向", "第一章开场没有明确目标。", ["firstChapterSetup.goal"], "开篇容易不知道从哪里开始。", "补充第一章方向。", "story/bible.json", "firstChapterSetup.goal");
  if (bible.coreMysteries.length === 0 && (bible.protectedSecrets ?? []).length === 0) addGap(gaps, "story", "high", "缺少隐藏真相", "没有记录禁止提前揭开的真相。", ["coreMysteries", "protectedSecrets"], "模型可能过早揭开核心秘密。", "补充隐藏真相和保护秘密。", "story/bible.json", "protectedSecrets");
  if (bible.openQuestions.length === 0) addGap(gaps, "story", "info", "缺少开放问题", "开放问题为空，后续章节的悬念牵引较弱。", ["openQuestions"], "伏笔推进缺少方向。", "补充开放问题。", "story/bible.json", "openQuestions");
}

function collectWorldGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const bible = sources.worldBible;
  if (!text(sources.worldCore.premise)) addGap(gaps, "world", "warning", "缺少世界背景", "世界背景为空。", ["world/core.json.premise"], "场景和社会秩序容易被模型自创。", "补充世界背景。", "world/core.json", "premise");
  if (!bible || bible.rules.length === 0) addGap(gaps, "world", "high", "缺少核心世界规则", "没有世界核心规则。", ["rules"], "剧情能力、阶层或物资规则容易漂移。", "补充核心世界规则。", "story/world-bible.json", "rules");
  if (!bible || bible.powerOrSurvivalSystems.length === 0) addGap(gaps, "world", "warning", "缺少资源规则", "没有记录能力、资源或生存系统。", ["powerOrSurvivalSystems"], "关键资源使用容易随意。", "补充资源规则。", "story/world-bible.json", "powerOrSurvivalSystems");
  if (!bible || bible.socialOrder.length === 0) addGap(gaps, "world", "warning", "缺少社会结构", "社会结构为空。", ["socialOrder"], "角色阶层和组织关系容易前后矛盾。", "补充社会结构。", "story/world-bible.json", "socialOrder");
  if (!bible || bible.factions.length === 0) addGap(gaps, "world", "info", "缺少势力 / 阵营", "没有记录势力或阵营。", ["factions"], "群像和冲突来源不够清晰。", "补充主要势力。", "story/world-bible.json", "factions");
  if (sources.storyBible?.centralConflicts.length === 0 && !text(sources.worldCore.mainConflict)) addGap(gaps, "world", "high", "缺少冲突来源", "没有明确核心冲突。", ["centralConflicts", "world/core.json.mainConflict"], "章节会缺少推进压力。", "补充冲突来源。", "story/bible.json", "centralConflicts");
}

function collectWritingRuleGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const rules = sources.writingRules;
  if (!rules) {
    addGap(gaps, "writingRules", "high", "缺少写作规则文件", "缺少整本书的写作约束。", ["story/writing-rules.json"], "文风、节奏和信息揭示会不稳定。", "创建写作规则。", "story/writing-rules.json", "$");
    return;
  }
  if (!text(rules.narrativePerspective)) addGap(gaps, "writingRules", "warning", "缺少叙事视角", "没有记录叙事视角。", ["narrativePerspective"], "视角可能漂移。", "补充叙事视角。", "story/writing-rules.json", "narrativePerspective");
  if (rules.proseStyle.length === 0) addGap(gaps, "writingRules", "warning", "缺少文风", "没有记录文风关键词。", ["proseStyle"], "章节语言风格容易漂移。", "补充文风。", "story/writing-rules.json", "proseStyle");
  if (!text(rules.pacing)) addGap(gaps, "writingRules", "info", "缺少节奏", "没有记录推进节奏。", ["pacing"], "章节快慢不稳定。", "补充节奏。", "story/writing-rules.json", "pacing");
  if (!rules.chapterLength?.targetWords) addGap(gaps, "writingRules", "info", "缺少章节字数", "没有目标章节字数。", ["chapterLength.targetWords"], "章节长度不稳定。", "补充目标章节字数。", "story/writing-rules.json", "chapterLength.targetWords");
  if (!text(rules.revealPolicy)) addGap(gaps, "writingRules", "warning", "缺少揭示策略", "没有记录信息揭示策略。", ["revealPolicy"], "秘密可能提前暴露。", "补充揭示策略。", "story/writing-rules.json", "revealPolicy");
  if (rules.forbiddenContent.length === 0 && rules.doNotDo.length === 0) addGap(gaps, "writingRules", "warning", "缺少禁止事项", "没有记录不要写成什么样。", ["forbiddenContent", "doNotDo"], "写作边界不清晰。", "补充禁止事项。", "story/writing-rules.json", "doNotDo");
  if (rules.readerExperienceRules.length === 0) addGap(gaps, "writingRules", "info", "缺少读者体验目标", "没有记录读者应该获得什么体验。", ["readerExperienceRules"], "章节爽点或悬念可能不稳定。", "补充读者体验目标。", "story/writing-rules.json", "readerExperienceRules");
}

function collectCharacterGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const characters = sources.characterBible?.characters ?? [];
  if (characters.length === 0) {
    addGap(gaps, "characters", "high", "缺少角色", "角色设定为空。", ["characters"], "主角和配角会被模型临场创造。", "创建主角角色卡。", "story/character-bible.json", "characters");
    return;
  }
  for (const character of characters) {
    const prefix = `角色「${character.name}」`;
    if (!text(character.age)) addGap(gaps, "characters", "high", `${prefix}缺少年龄`, "年龄未固定，长篇后续容易年龄漂移。", ["age"], "年龄漂移会破坏人物可信度。", "补充年龄。", "story/character-bible.json", `characters.${character.id}.age`, character.id);
    if (!text(character.gender)) addGap(gaps, "characters", "info", `${prefix}缺少性别`, "性别未记录。", ["gender"], "人物画像不完整。", "补充性别。", "story/character-bible.json", `characters.${character.id}.gender`, character.id);
    if (!text(character.identity)) addGap(gaps, "characters", "warning", `${prefix}缺少身份`, "身份未记录。", ["identity"], "角色行为动机会变弱。", "补充身份。", "story/character-bible.json", `characters.${character.id}.identity`, character.id);
    if (!text(character.desire) && !text(character.longTermDesire)) addGap(gaps, "characters", "warning", `${prefix}缺少欲望 / 目标`, "长期欲望未记录。", ["desire"], "角色行动缺少内驱力。", "补充角色欲望。", "story/character-bible.json", `characters.${character.id}.desire`, character.id);
    if (!text(character.fear)) addGap(gaps, "characters", "info", `${prefix}缺少恐惧`, "恐惧未记录。", ["fear"], "角色弱点和压力不足。", "补充角色恐惧。", "story/character-bible.json", `characters.${character.id}.fear`, character.id);
    if (!text(character.weakness)) addGap(gaps, "characters", "warning", `${prefix}缺少短板`, "短板未记录。", ["weakness"], "角色容易突然开挂。", "补充短板。", "story/character-bible.json", `characters.${character.id}.weakness`, character.id);
    if (!text(character.moralBoundary)) addGap(gaps, "characters", "info", `${prefix}缺少道德底线`, "道德底线未记录。", ["moralBoundary"], "角色选择边界不稳定。", "补充道德底线。", "story/character-bible.json", `characters.${character.id}.moralBoundary`, character.id);
    if ((character.behaviorBoundaries ?? []).length === 0) addGap(gaps, "characters", "high", `${prefix}缺少行为边界`, "没有记录角色不能突然做到的事。", ["behaviorBoundaries"], "角色能力容易漂移。", "补充行为边界。", "story/character-bible.json", `characters.${character.id}.behaviorBoundaries`, character.id);
    if (!text(character.speechStyle) && (character.speechSamples ?? []).length === 0) addGap(gaps, "characters", "high", `${prefix}缺少说话风格`, "没有说话风格或样本。", ["speechStyle", "speechSamples"], "角色台词容易变声。", "补充说话风格和样本。", "story/character-bible.json", `characters.${character.id}.speechSamples`, character.id);
    if ((character.knowledgeKnown ?? []).length === 0 || (character.knowledgeUnknown ?? []).length === 0) addGap(gaps, "characters", "high", `${prefix}缺少知识边界`, "没有记录知道什么 / 不知道什么。", ["knowledgeKnown", "knowledgeUnknown"], "角色可能知道不该知道的信息。", "补充知识边界。", "story/character-bible.json", `characters.${character.id}.knowledgeKnown`, character.id);
    if ((character.cannotDo ?? []).length === 0) addGap(gaps, "characters", "warning", `${prefix}缺少不能做什么`, "没有记录不可做事项。", ["cannotDo"], "角色行为边界不够硬。", "补充不能做什么。", "story/character-bible.json", `characters.${character.id}.cannotDo`, character.id);
  }
}

function collectRelationshipGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const characters = sources.characterBible?.characters ?? [];
  const protagonist = characters.find((character) => character.role === "主角" || character.role === "protagonist") ?? characters[0];
  if (characters.length <= 1) {
    addGap(gaps, "characterRelationships", "info", "缺少角色关系", "目前只有一个角色或没有配角。", ["relationships"], "群像推进时关系网络不够清楚。", "需要时创建重要配角和关系。", "story/character-bible.json", "characters");
    return;
  }
  for (const character of characters) {
    if (protagonist && character.id === protagonist.id) continue;
    if (!text(character.relationshipToProtagonist)) {
      addGap(gaps, "characterRelationships", "warning", `缺少「${character.name}」与主角关系`, "配角与主角关系未记录。", ["relationshipToProtagonist"], "互动立场和关系变化容易矛盾。", "补充与主角关系。", "story/character-bible.json", `characters.${character.id}.relationshipToProtagonist`, character.id);
    }
  }
}

function collectLocationGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const locations = sources.locationBible?.locations ?? [];
  if (locations.length === 0) {
    addGap(gaps, "locations", "high", "缺少地点", "地点设定为空。", ["locations"], "模型会临场编城市、楼层和路线。", "创建初始地点。", "story/location-bible.json", "locations");
    return;
  }
  for (const location of locations) {
    const prefix = `地点「${location.name}」`;
    if (!text(location.type) && !text(location.locationType)) addGap(gaps, "locations", "info", `${prefix}缺少地点类型`, "地点类型未记录。", ["type"], "地点用途不清楚。", "补充地点类型。", "story/location-bible.json", `locations.${location.id}.type`, location.id);
    if (!location.spatialStructure || (location.spatialStructure.floors ?? []).length === 0 || (location.spatialStructure.rooms ?? []).length === 0) addGap(gaps, "locations", "high", `${prefix}缺少空间结构`, "楼层或房间未记录。", ["spatialStructure"], "楼层、房间容易穿帮。", "补充楼层、房间、入口出口。", "story/location-bible.json", `locations.${location.id}.spatialStructure`, location.id);
    if ((location.travelRules ?? []).length === 0) addGap(gaps, "locations", "high", `${prefix}缺少移动规则`, "移动规则未记录。", ["travelRules"], "跨地点移动时间和方式容易漂移。", "补充移动规则。", "story/location-bible.json", `locations.${location.id}.travelRules`, location.id);
    if (location.risks.length === 0) addGap(gaps, "locations", "warning", `${prefix}缺少风险`, "地点风险为空。", ["risks"], "场景缺少压力和约束。", "补充地点风险。", "story/location-bible.json", `locations.${location.id}.risks`, location.id);
    if (location.resources.length === 0) addGap(gaps, "locations", "warning", `${prefix}缺少资源`, "地点资源为空。", ["resources"], "主角能获得什么不清楚。", "补充地点资源。", "story/location-bible.json", `locations.${location.id}.resources`, location.id);
    if ((location.fixedFacts ?? []).length === 0) addGap(gaps, "locations", "info", `${prefix}缺少固定事实`, "地点不可改变事实为空。", ["fixedFacts"], "地点状态容易变动。", "补充固定事实。", "story/location-bible.json", `locations.${location.id}.fixedFacts`, location.id);
  }
}

function collectAssetGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const assets = sources.assetLedger.assets ?? [];
  if (assets.length === 0) {
    addGap(gaps, "assets", "high", "缺少资产账本", "资产账本为空。", ["assets"], "手机、车辆、现金、关键物品容易凭空出现或消失。", "创建初始资产账本。", "story/assets.json", "assets");
    return;
  }
  for (const asset of assets) {
    const prefix = `资产「${asset.name}」`;
    if (!text(asset.ownerCharacterId) && !text(asset.ownerName)) addGap(gaps, "assets", "warning", `${prefix}缺少归属人`, "资产归属未记录。", ["ownerCharacterId", "ownerName"], "资产归属会混乱。", "补充归属人。", "story/assets.json", `assets.${asset.id}.owner`, asset.id);
    if (!text(asset.currentLocationName) && !text(asset.currentLocationId) && !text(asset.carriedByCharacterId)) addGap(gaps, "assets", "warning", `${prefix}缺少当前位置`, "资产位置未记录。", ["currentLocationName", "carriedByCharacterId"], "资产可能随意出现在角色身上。", "补充资产位置。", "story/assets.json", `assets.${asset.id}.currentLocationName`, asset.id);
    if (!text(asset.status)) addGap(gaps, "assets", "warning", `${prefix}缺少状态`, "资产状态未记录。", ["status"], "可用、损坏、锁定等状态会漂移。", "补充资产状态。", "story/assets.json", `assets.${asset.id}.status`, asset.id);
    if ((asset.rules ?? []).length === 0 && asset.isPlotCritical) addGap(gaps, "assets", "high", `${prefix}缺少硬规则`, "剧情关键资产没有硬规则。", ["rules"], "关键道具容易被模型随意改动。", "补充资产硬规则。", "story/assets.json", `assets.${asset.id}.rules`, asset.id);
  }
}

function collectContinuityGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  for (const hook of sources.hooks.hooks) {
    if (!text(hook.description) || !text(hook.nextActionHint)) addGap(gaps, "hooks", "info", `伏笔「${hook.title}」缺少后续说明`, "伏笔缺少说明或下一步方向。", ["description", "nextActionHint"], "伏笔可能被遗忘或误解。", "补充伏笔说明和后续方向。", "story/hooks.json", `hooks.${hook.id}`, hook.id);
  }
  for (const thread of sources.threads.threads) {
    if ((thread.evidence ?? []).length === 0 || !text(thread.nextActionHint)) addGap(gaps, "threads", "info", `线索「${thread.title}」缺少证据或方向`, "线索缺少证据或下一步方向。", ["evidence", "nextActionHint"], "线索推进容易断。", "补充线索证据和后续方向。", "story/threads.json", `threads.${thread.id}`, thread.id);
  }
  for (const goal of sources.arcGoals.goals) {
    if ((goal.evidence ?? []).length === 0 || !text(goal.nextActionHint)) addGap(gaps, "arcGoals", "info", `主线目标「${goal.title}」缺少进展依据`, "主线目标缺少证据或下一步方向。", ["evidence", "nextActionHint"], "主线推进会变模糊。", "补充目标进展依据。", "story/arc-goals.json", `goals.${goal.id}`, goal.id);
  }
}

function collectTimelineGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  if (sources.timelineEvents.length === 0) {
    addGap(gaps, "timeline", "info", "缺少时间线事件", "当前还没有时间线事件。", ["timeline/events.json"], "多章后难以追踪发生过什么。", "提交章节后补充时间线。", "timeline/events.json", "$");
    return;
  }
  for (const event of sources.timelineEvents.slice(-5)) {
    if (!text(event.summary)) addGap(gaps, "timeline", "warning", `第${event.chapter}章事件缺少摘要`, "事件摘要为空。", ["summary"], "后续承接会缺少依据。", "补充事件摘要。", "timeline/events.json", `events.${event.id}.summary`, event.id);
    const effects = typeof event.effects === "object" && event.effects !== null ? event.effects : {};
    if (!("semanticSummary" in effects)) addGap(gaps, "timeline", "info", `第${event.chapter}章缺少事件后果`, "事件后果未结构化记录。", ["effects.semanticSummary"], "状态承接会变弱。", "补充事件后果摘要。", "timeline/events.json", `events.${event.id}.effects.semanticSummary`, event.id);
  }
}

function collectKnowledgeBoundaryGaps(sources: SourceBundle, gaps: FoundationGapItem[]): void {
  const protectedSecrets = [...(sources.storyBible?.protectedSecrets ?? []), ...(sources.storyBible?.coreMysteries ?? []), ...sources.worldState.knownSecrets];
  if (protectedSecrets.length === 0) {
    addGap(gaps, "knowledgeBoundary", "high", "缺少保护秘密", "没有区分作者知道但暂时不能写的内容。", ["protectedSecrets", "coreMysteries"], "隐藏真相可能提前泄露。", "补充保护秘密。", "story/bible.json", "protectedSecrets");
  }
  const protagonist = sources.characterBible?.characters.find((character) => character.role === "主角" || character.role === "protagonist") ?? sources.characterBible?.characters[0];
  if (protagonist && ((protagonist.knowledgeKnown ?? []).length === 0 || (protagonist.knowledgeUnknown ?? []).length === 0)) {
    addGap(gaps, "knowledgeBoundary", "high", "主角知识边界不完整", "主角知道什么 / 不知道什么没有记录完整。", ["knowledgeKnown", "knowledgeUnknown"], "主角可能知道不该知道的信息。", "补充主角知识边界。", "story/character-bible.json", `characters.${protagonist.id}.knowledgeKnown`, protagonist.id);
  }
}

function collectConflicts(sources: SourceBundle, conflicts: FoundationConflictItem[]): void {
  const projectGenre = sources.storyBible?.genre;
  if (projectGenre && sources.worldCore.genre && projectGenre !== sources.worldCore.genre) {
    conflicts.push({
      id: "conflict-story-genre-world-core",
      category: "story",
      title: "故事类型与世界类型不一致",
      description: "story/bible.json 与 world/core.json 中的类型不同，后续类型规则可能判断错误。",
      targetFile: "story/bible.json",
      targetPath: "genre",
      existingValue: projectGenre,
      suggestedValue: sources.worldCore.genre,
      resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
    });
  }
}

function buildSuggestionsFromGaps(gaps: readonly FoundationGapItem[], sources: SourceBundle): readonly FoundationGapSuggestion[] {
  return gaps.map((gap) => suggestionForGap(gap, sources));
}

function suggestionForGap(gap: FoundationGapItem, sources: SourceBundle): FoundationGapSuggestion {
  const base = {
    id: `suggestion-${gap.id}`,
    gapId: gap.id,
    category: gap.category,
    targetFile: gap.targetFile,
    targetPath: gap.targetPath,
    before: readBeforeForGap(gap, sources),
    rationale: gap.affectedWritingRisk,
    risk: gap.severity,
    requiresUserConfirm: true as const,
  };

  if (gap.category === "characters" && gap.targetPath === "characters") {
    const name = "新角色";
    const id = toSafeCharacterId(name);
    return { ...base, actionType: "create_character", targetId: id, after: defaultCharacter(id, name) };
  }
  if (gap.category === "locations" && gap.targetPath === "locations") {
    const name = "新地点";
    const id = stableId(name, "loc");
    return { ...base, actionType: "create_location", targetId: id, after: defaultLocation(id, name) };
  }
  if (gap.category === "assets" && gap.targetPath === "assets") {
    const character = sources.characterBible?.characters[0];
    const name = "待登记关键资产";
    const id = stableId(name, "asset");
    return { ...base, actionType: "create_asset", targetId: id, after: defaultAsset(id, name, character) };
  }
  if (gap.category === "characterRelationships") {
    return { ...base, actionType: "create_relationship", targetId: gap.targetId, after: "与主角关系待确认" };
  }
  if (gap.category === "world") return { ...base, actionType: "update_world_rule", targetId: gap.targetId, after: defaultAfterValue(gap) };
  if (gap.category === "writingRules") return { ...base, actionType: "update_writing_rule", targetId: gap.targetId, after: defaultAfterValue(gap) };
  if (gap.category === "locations") return { ...base, actionType: "update_location_detail", targetId: gap.targetId, after: defaultAfterValue(gap) };
  if (gap.category === "assets") return { ...base, actionType: "update_asset_status", targetId: gap.targetId, after: defaultAfterValue(gap) };
  if (gap.category === "knowledgeBoundary") return { ...base, actionType: "update_knowledge_boundary", targetId: gap.targetId, after: defaultAfterValue(gap) };
  if (gap.category === "characters") return { ...base, actionType: "update_character_boundary", targetId: gap.targetId, after: defaultAfterValue(gap) };
  return { ...base, actionType: "fill_missing_field", targetId: gap.targetId, after: defaultAfterValue(gap) };
}

function defaultAfterValue(gap: FoundationGapItem): unknown {
  const path = gap.targetPath;
  if (path.endsWith("age")) return "待确认年龄";
  if (path.endsWith("gender")) return "待确认性别";
  if (path.endsWith("identity")) return "待确认身份";
  if (path.endsWith("desire")) return "待确认目标";
  if (path.endsWith("fear")) return "待确认恐惧";
  if (path.endsWith("weakness")) return "待确认短板";
  if (path.endsWith("moralBoundary")) return "待确认道德底线";
  if (path.endsWith("speechSamples")) return ["请在这里填写一句该角色典型台词。"];
  if (path.endsWith("behaviorBoundaries")) return ["不要让角色突然获得未铺垫能力。"];
  if (path.endsWith("knowledgeKnown")) return ["当前已知信息待确认。"];
  if (path.endsWith("knowledgeUnknown")) return ["当前未知真相待确认。"];
  if (path.endsWith("cannotDo")) return ["不能违背已建立的人设和能力边界。"];
  if (path.endsWith("spatialStructure")) return { floors: ["待确认楼层"], rooms: ["待确认房间"], entrances: ["待确认入口"], exits: ["待确认出口"] };
  if (path.endsWith("travelRules")) return [{ targetLocation: "待确认目标地点", method: "walk", durationMinutes: 5, constraint: "移动方式和耗时需要用户确认。" }];
  if (path.endsWith("risks")) return ["待确认地点风险"];
  if (path.endsWith("resources")) return ["待确认地点资源"];
  if (path.endsWith("fixedFacts")) return ["待确认固定事实"];
  if (path.endsWith("rules")) return ["待确认核心规则"];
  if (path.endsWith("powerOrSurvivalSystems")) return ["待确认资源规则"];
  if (path.endsWith("socialOrder")) return ["待确认社会结构"];
  if (path.endsWith("factions")) return [{ id: "faction-pending", name: "待确认势力", goal: "待确认目标", resources: [] }];
  if (path.endsWith("centralConflicts")) return ["待确认核心冲突"];
  if (path.endsWith("proseStyle")) return ["待确认文风"];
  if (path.endsWith("doNotDo")) return ["不要违背已确认设定。"];
  if (path.endsWith("forbiddenContent")) return ["不要提前揭开隐藏真相。"];
  if (path.endsWith("readerExperienceRules")) return ["保持读者对下一章的期待。"];
  if (path.endsWith("targetWords")) return 1800;
  if (path.endsWith("narrativePerspective")) return "第三人称有限视角";
  if (path.endsWith("pacing")) return "中等";
  if (path.endsWith("revealPolicy")) return "逐步揭示，不提前解释核心秘密。";
  if (path.endsWith("protectedSecrets")) return ["待确认保护秘密"];
  if (path.endsWith("openQuestions")) return ["待确认开放问题"];
  if (path.endsWith("longFormGoals")) return ["待确认长篇目标"];
  if (path.endsWith("firstChapterSetup.goal")) return "待确认第一章方向";
  if (path.endsWith("readerPromise")) return "待确认读者期待";
  if (path.endsWith("genre")) return "待确认类型";
  if (path.endsWith("projectLogline")) return "待确认一句话故事";
  if (path.endsWith("status")) return "available";
  if (path.endsWith("owner")) return "待确认归属人";
  if (path.endsWith("currentLocationName")) return "待确认位置";
  return gap.suggestedFix;
}

function readBeforeForGap(gap: FoundationGapItem, sources: SourceBundle): unknown {
  if (gap.targetFile === "story/bible.json") return readPath(sources.storyBible, gap.targetPath);
  if (gap.targetFile === "story/world-bible.json") return readPath(sources.worldBible, gap.targetPath);
  if (gap.targetFile === "story/writing-rules.json") return readPath(sources.writingRules, gap.targetPath);
  if (gap.targetFile === "story/character-bible.json") return readPath(sources.characterBible, gap.targetPath);
  if (gap.targetFile === "story/location-bible.json") return readPath(sources.locationBible, gap.targetPath);
  if (gap.targetFile === "story/assets.json") return readPath(sources.assetLedger, gap.targetPath);
  if (gap.targetFile === "world/core.json") return readPath(sources.worldCore, gap.targetPath);
  return undefined;
}

async function applySuggestion(projectDir: string, suggestion: FoundationGapSuggestion): Promise<FoundationWriteResult> {
  return applyFoundationWriteSuggestion({ projectDir, suggestion });
}

function mergeRecordsPreferExisting(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = mergeValuePreferExisting(next[key], value);
  }
  return next;
}

function mergeValuePreferExisting(existing: unknown, patch: unknown): unknown {
  if (Array.isArray(existing) || Array.isArray(patch)) {
    return mergeUnknownArrays(existing, patch);
  }
  if (isRecord(existing) && isRecord(patch)) {
    return mergeRecordsPreferExisting(existing, patch);
  }
  if (hasStrongConcreteValue(existing)) return existing;
  return patch;
}

const UNFILLED_VALUES = new Set(["待确认", "尚未配置", "未知", "unknown"]);

function hasStrongConcreteValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && !UNFILLED_VALUES.has(trimmed.toLowerCase());
  }
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function mergeStringArrays(...lists: readonly (readonly string[] | undefined)[]): string[] {
  return unique(lists.flatMap((list) => list ?? []).map((item) => item.trim()).filter(Boolean));
}

function mergeUnknownArrays(existing: unknown, patch: unknown): unknown[] {
  const values = [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(patch) ? patch : patch !== undefined ? [patch] : []),
  ];
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    const key = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

async function findSuggestionConflict(projectDir: string, suggestion: FoundationGapSuggestion): Promise<FoundationConflictItem | undefined> {
  if (suggestion.category !== "locations" || (suggestion.actionType !== "create_location" && suggestion.actionType !== "update_location_detail")) return undefined;
  const bible = await readJson<LocationBible>(join(projectDir, "story", "location-bible.json"), { version: "v0", locations: [] });
  const patch = normalizeLocationPatch(suggestion);
  const existing = bible.locations.find((item) => item.id === patch.id || item.name === patch.name);
  if (!existing) return undefined;
  const conflict = findTravelRuleConflict(existing, patch);
  if (!conflict) return undefined;
  return {
    id: `${suggestion.id}:travel-rule-conflict`,
    category: "locations",
    title: "地点移动规则冲突",
    description: `地点「${existing.name}」已有到「${conflict.targetLocation}」的移动规则，新建议与已有方式或耗时不一致。`,
    targetFile: "story/location-bible.json",
    targetPath: `locations.${existing.id}.travelRules`,
    existingValue: conflict.existing,
    suggestedValue: conflict.suggested,
    resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
  };
}

function findTravelRuleConflict(
  existing: LocationBibleEntry,
  patch: LocationBibleEntry,
): { readonly targetLocation: string; readonly existing: LocationTravelRule; readonly suggested: LocationTravelRule } | undefined {
  for (const suggested of patch.travelRules ?? []) {
    const found = (existing.travelRules ?? []).find((rule) => sameTravelRoute(rule, suggested));
    if (!found) continue;
    if ((found.method !== suggested.method) || ((found.durationMinutes ?? 0) !== (suggested.durationMinutes ?? 0))) {
      return { targetLocation: suggested.targetLocation, existing: found, suggested };
    }
  }
  return undefined;
}

function sameTravelRoute(left: LocationTravelRule, right: LocationTravelRule): boolean {
  return normalizedText(left.from) === normalizedText(right.from)
    && normalizedText(left.targetLocation) === normalizedText(right.targetLocation);
}

function normalizeLocationPatch(suggestion: FoundationGapSuggestion): LocationBibleEntry {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const name = readString(source.name) ?? readString(source.locationName) ?? suggestion.targetId ?? "待确认地点";
  const id = readString(source.id) ?? suggestion.targetId ?? stableId(name, "loc");
  const spatial = isRecord(source.spatialStructure) ? source.spatialStructure : {};
  const sensoryDetails = readLocationSensoryDetails(source.sensoryDetails, source.sensory);
  const floors = cleanSpatialItems(readStringList(source.floors).length ? readStringList(source.floors) : readStringList(spatial.floors));
  const rooms = cleanSpatialItems(readStringList(source.rooms).length ? readStringList(source.rooms) : readStringList(spatial.rooms));
  const entrances = readStringList(source.entrances).length ? readStringList(source.entrances) : readStringList(spatial.entrances);
  const exits = readStringList(source.exits).length ? readStringList(source.exits) : readStringList(spatial.exits);
  return {
    id,
    name,
    type: readString(source.type) ?? readString(source.locationType) ?? "地点",
    ...(readString(source.parentLocation) ? { parentLocation: readString(source.parentLocation) } : {}),
    ...(readString(source.locationType) ? { locationType: readString(source.locationType) } : {}),
    spatialStructure: { floors, rooms, entrances, exits },
    ...(sensoryDetails ? { sensoryDetails } : {}),
    ...(readString(source.currentKnownPosition) ? { currentKnownPosition: readString(source.currentKnownPosition) } : {}),
    connectedLocations: readStringList(source.connectedLocations),
    knownFeatures: readStringList(source.knownFeatures),
    risks: readStringList(source.risks),
    resources: readStringList(source.resources),
    ...(readString(source.narrativeFunction) ? { narrativeFunction: readString(source.narrativeFunction) } : {}),
    possibleConflicts: readStringList(source.possibleConflicts),
    ...(readString(source.currentStatus) ? { currentStatus: readString(source.currentStatus) } : {}),
    hiddenFacts: readStringList(source.hiddenFacts),
    travelRules: readTravelRules(source.travelRules),
    secrets: readStringList(source.secrets),
    fixedFacts: cleanFixedFacts(readStringList(source.fixedFacts)),
    ...(typeof source.lastSeenChapter === "number" ? { lastSeenChapter: source.lastSeenChapter } : {}),
    ...(readString(source.lastKnownState) ? { lastKnownState: readString(source.lastKnownState) } : {}),
  };
}

function cleanSpatialItems(items: readonly string[]): readonly string[] {
  return unique(items
    .map((item) => item.trim())
    .filter((item) => item.length > 0));
}

function cleanFixedFacts(items: readonly string[]): readonly string[] {
  return unique(items
    .map((item) => item.trim())
    .filter((item) => item.length > 0));
}

function readLocationSensoryDetails(...values: readonly unknown[]): LocationSensoryDetails | undefined {
  const records = values.filter(isRecord);
  if (records.length === 0) return undefined;
  const details: LocationSensoryDetails = {
    visual: mergeStringArrays(...records.map((record) => readStringList(record.visual))),
    sound: mergeStringArrays(...records.map((record) => readStringList(record.sound))),
    smell: mergeStringArrays(...records.map((record) => readStringList(record.smell))),
    touch: mergeStringArrays(...records.map((record) => readStringList(record.touch))),
  };
  return Object.values(details).some((value) => value.length > 0) ? details : undefined;
}

function readTravelRules(value: unknown): LocationTravelRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => {
    const targetLocation = readString(item.targetLocation) ?? readString(item.to) ?? readString(item.target);
    if (!targetLocation) return undefined;
    return {
      ...(readString(item.from) ? { from: readString(item.from) } : {}),
      targetLocation,
      method: readString(item.method) ?? "walk",
      ...(readNumber(item.durationMinutes) !== undefined ? { durationMinutes: readNumber(item.durationMinutes) } : {}),
      ...(readString(item.constraint) ? { constraint: readString(item.constraint) } : {}),
    };
  }).filter((item): item is LocationTravelRule => item !== undefined);
}

function targetPathForSuggestion(suggestion: FoundationGapSuggestion): string {
  const gapPath = suggestion.targetPath;
  if (suggestion.category === "characters" || suggestion.category === "characterRelationships") {
    const id = suggestion.targetId;
    return id ? `characters.${id}.${lastPathSegment(gapPath)}` : gapPath;
  }
  if (suggestion.category === "locations") {
    const id = suggestion.targetId;
    return id ? `locations.${id}.${lastPathSegment(gapPath)}` : gapPath;
  }
  if (suggestion.category === "assets") {
    const id = suggestion.targetId;
    return id ? `assets.${id}.${lastPathSegment(gapPath)}` : gapPath;
  }
  return gapPath || "$";
}

function addGap(
  gaps: FoundationGapItem[],
  category: FoundationGapCategory,
  severity: FoundationGapSeverity,
  title: string,
  description: string,
  missingFields: readonly string[],
  affectedWritingRisk: string,
  suggestedFix: string,
  targetFile: string,
  targetPath: string,
  targetId?: string,
): void {
  gaps.push({
    id: gapId(category, targetPath, title),
    category,
    severity,
    title,
    description,
    missingFields,
    affectedWritingRisk,
    suggestedFix,
    targetFile,
    targetPath,
    requiresUserConfirm: true,
    ...(targetId ? { targetId } : {}),
  });
}

function gapId(category: FoundationGapCategory, targetPath: string, title: string): string {
  return `gap-${category}-${targetPath.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/gu, "-")}-${shortHash(title)}`;
}

function defaultCharacter(id: string, name: string): unknown {
  return {
    bibleEntry: {
      id,
      name,
      role: "重要角色",
      identity: "待确认身份",
      behaviorBoundaries: [],
      knowledgeKnown: [],
      knowledgeUnknown: [],
      speechSamples: [],
      cannotDo: [],
    },
    profile: { id, name, identity: "重要角色", tags: [] },
    core: { characterId: id, personality: [], speechStyle: "待确认", taboos: [] },
    state: { characterId: id, emotion: "待确认", goal: "待确认", lastUpdatedChapter: null },
  };
}

function defaultLocation(id: string, name: string): LocationBibleEntry {
  return {
    id,
    name,
    type: "待确认地点",
    spatialStructure: { floors: [], rooms: [], entrances: [], exits: [] },
    knownFeatures: [],
    risks: [],
    resources: [],
    travelRules: [],
  };
}

function defaultAsset(id: string, name: string, character: CharacterBibleEntry | undefined): AssetItem {
  return {
    id,
    name,
    type: "keyItem",
    ownerCharacterId: character?.id,
    ownerName: character?.name,
    carriedByCharacterId: character?.id,
    status: "unknown",
    isPlotCritical: true,
    canAiModify: false,
    rules: ["需要用户确认后才能改变状态。"],
  };
}

function readPath(source: unknown, path: string): unknown {
  if (path === "$") return source;
  const parts = path.split(".");
  let current = source;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (Array.isArray(current)) {
      current = current.find((item) => typeof item === "object" && item !== null && ("id" in item) && (item as { id?: unknown }).id === part);
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readFile(path, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return text === undefined ? fallback : JSON.parse(text) as T;
}

function lastPathSegment(path: string): string {
  return path.split(".").at(-1) ?? path;
}

function text(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? text(value) : undefined;
}

function readStringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|[；;]/u)
      : [];
  return items.map(readString).filter((item): item is string => Boolean(item));
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[^\d.]+/gu, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, "").trim();
}

function stableId(value: string, prefix: string): string {
  const safe = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return safe || `${prefix}-${shortHash(value)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((item) => item.trim().length > 0)));
}
