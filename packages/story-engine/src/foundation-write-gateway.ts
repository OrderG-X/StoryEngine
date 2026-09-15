import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { dedupeStringList } from "./canonical-resolvers.js";
import { isSentinelEntityId, readProject, toSafeCharacterId } from "./project-store.js";
import type {
  AssetItem,
  AssetLedger,
  CharacterArcProfile,
  CharacterBible,
  CharacterBibleEntry,
  CharacterMatrixLedger,
  CharacterCore,
  CharacterProfile,
  CharacterState,
  CharacterVoiceProfile,
  LocationBible,
  LocationBibleEntry,
  LocationSensoryDetails,
  LocationTravelRule,
  WorldBible,
  WorldBibleFaction,
  WritingRules,
} from "./types.js";

export type FoundationWriteDomain = "character" | "location" | "world" | "writingRules" | "asset" | "field";

export interface FoundationWriteSuggestionLike {
  readonly actionType: string;
  readonly category?: string;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly targetId?: string;
  readonly before?: unknown;
  readonly confirmedByUser?: boolean;
  readonly after: unknown;
  readonly extractedEntityName?: string;
  readonly sourceUserMessage?: string;
  readonly writeMode?: "merge" | "replace";
}

export interface FoundationWriteRecord {
  readonly domain: FoundationWriteDomain;
  readonly action: string;
  readonly targetFile: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly summary: string;
  /** 本次写入新建（卡上原本没有）的自定义字段键名，供 UI 结果卡回报。 */
  readonly newExtraFields?: readonly string[];
}

type ExtraFields = Record<string, string | readonly string[]>;

/**
 * 从归档 after 里读取并规整 extraFields 袋：
 * 丢弃空键、非字符串/非字符串数组的值、空字符串、空数组。
 */
function readExtraFields(source: unknown): ExtraFields | undefined {
  if (!isRecord(source)) return undefined;
  const raw = source.extraFields;
  if (!isRecord(raw)) return undefined;
  const result: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) result[trimmedKey] = trimmed;
      continue;
    }
    if (Array.isArray(value)) {
      const list = readStringList(value);
      if (list.length > 0) result[trimmedKey] = list;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 加法式浅合并：保留旧键，同名键以新值覆盖。 */
function mergeExtraFields(
  existing: ExtraFields | undefined,
  incoming: ExtraFields | undefined,
): ExtraFields | undefined {
  if (!existing && !incoming) return undefined;
  const merged: Record<string, string | readonly string[]> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 本次新建（卡上原本没有）的自定义字段键名。 */
function newExtraFieldKeys(
  existing: ExtraFields | undefined,
  incoming: ExtraFields | undefined,
): readonly string[] {
  if (!incoming) return [];
  const existingKeys = new Set(Object.keys(existing ?? {}));
  return Object.keys(incoming).filter((key) => !existingKeys.has(key));
}

/** 为 record 附加 extraFields 明细（仅在有写入时附加，保持 record 干净）。 */
function withExtraFieldsReport(
  record: FoundationWriteRecord,
  incoming: ExtraFields | undefined,
  newKeys: readonly string[],
): FoundationWriteRecord {
  if (!incoming || Object.keys(incoming).length === 0) return record;
  return {
    ...record,
    ...(newKeys.length > 0 ? { newExtraFields: newKeys } : {}),
  };
}

/**
 * 写入被跳过的显式信号（修2）：当更新类建议无法定位到目标卡片时，
 * 不再静默返回空写入，而是带 reason 上报，让上层 applied 能区分「没写成因目标缺失」。
 */
export type FoundationWriteSkipReason = "missing_target_id" | "target_not_found" | "apply_failed" | "no_recognized_fields" | "correction_target_not_found" | "missing_name" | "name_change_requires_rename";

export interface FoundationWriteSkip {
  readonly reason: FoundationWriteSkipReason;
  readonly action: string;
  readonly targetName?: string;
  readonly summary: string;
}

/** 单条建议写入的内部产物：写入记录 + 可选的跳过信号。 */
interface FoundationWriteOutcome {
  readonly writes: readonly FoundationWriteRecord[];
  readonly skip?: FoundationWriteSkip;
}

export interface FoundationWriteResult {
  readonly applied: boolean;
  readonly projectDir: string;
  readonly writes: readonly FoundationWriteRecord[];
  readonly writtenFiles: readonly string[];
  readonly refreshRequired: boolean;
  readonly userSummaryLines: readonly string[];
  readonly blockedWrites?: readonly FoundationWriteRisk[];
  /** 因目标缺失而被跳过的写入（修2）。有值即代表「这条没写成」是明确状态，而非「啥也没要写」。 */
  readonly skipped?: readonly FoundationWriteSkip[];
}

export type FoundationWriteRiskLevel = "safe" | "needs_confirmation" | "blocked";

export interface FoundationWriteRisk {
  readonly level: FoundationWriteRiskLevel;
  readonly reason: string;
  readonly targetFile: string;
  readonly targetPath: string;
  readonly existingValue?: unknown;
  readonly suggestedValue?: unknown;
}

const GENERIC_FOUNDATION_WRITE_TARGET_FILES = new Set([
  "project.json",
  "story/bible.json",
  "story/character-bible.json",
  "story/location-bible.json",
  "story/assets.json",
  "story/world-bible.json",
  "story/writing-rules.json",
  "world/core.json",
  "world/state.json",
]);

export async function applyFoundationWriteSuggestion(input: {
  readonly projectDir: string;
  readonly suggestion: FoundationWriteSuggestionLike;
}): Promise<FoundationWriteResult> {
  await assertProjectDir(input.projectDir);
  if (input.suggestion.actionType === "defer") {
    return result(input.projectDir, []);
  }

  const risk = await classifyFoundationWriteSuggestion(input);
  if (risk.level !== "safe") {
    return result(input.projectDir, [], { blockedWrites: [risk] });
  }

  const outcome = await applySuggestion(input.projectDir, input.suggestion);
  return result(input.projectDir, outcome.writes, { skipped: outcome.skip ? [outcome.skip] : undefined });
}

export async function classifyFoundationWriteSuggestion(input: {
  readonly projectDir: string;
  readonly suggestion: FoundationWriteSuggestionLike;
}): Promise<FoundationWriteRisk> {
  const targetPath = targetPathForSuggestion(input.suggestion);
  const targetFileRisk = classifyFoundationTargetFileRisk(input.suggestion, targetPath);
  if (targetFileRisk) return targetFileRisk;
  const safe = (reason = "非破坏性写入。"): FoundationWriteRisk => ({
    level: "safe",
    reason,
    targetFile: input.suggestion.targetFile,
    targetPath,
    suggestedValue: input.suggestion.after,
  });

  if (input.suggestion.actionType === "delete_foundation_entry") {
    return classifyDeleteFoundationEntry(input.projectDir, input.suggestion, targetPath);
  }
  if (input.suggestion.actionType === "update_asset_status") {
    const risk = await classifyAssetWriteRisk(input.projectDir, input.suggestion, targetPath);
    if (risk) return risk;
  }
  if (input.suggestion.actionType === "update_world_rule") {
    const risk = await classifyStructuredScalarRisk(input.projectDir, input.suggestion, targetPath, "story/world-bible.json", ["worldPremise"]);
    if (risk) return risk;
  }
  if (input.suggestion.actionType === "update_writing_rule") {
    const risk = await classifyStructuredScalarRisk(input.projectDir, input.suggestion, targetPath, "story/writing-rules.json", ["narrativePerspective", "pacing", "revealPolicy"]);
    if (risk) return risk;
  }
  if (input.suggestion.actionType === "update_character_detail") {
    // E2：typed 标量（age/gender）强值冲突不静默覆盖——走 needs_confirmation 阻断（守铁律④）。
    const risk = await classifyCharacterScalarRisk(input.projectDir, input.suggestion);
    if (risk) return risk;
    return safe("更新已存在角色资料。");
  }
  if (input.suggestion.actionType === "create_character" || input.suggestion.actionType === "create_location" || input.suggestion.actionType === "create_asset") {
    return safe("新增或补充资料。");
  }

  const record = await readJson<Record<string, unknown>>(join(input.projectDir, input.suggestion.targetFile), defaultDocument(input.suggestion.targetFile));
  const existingValue = readPathValue(record, targetPath, input.suggestion.targetId);
  return classifyValueWriteRisk({
    suggestion: input.suggestion,
    targetPath,
    existingValue,
    suggestedValue: input.suggestion.after,
  }) ?? safe();
}

function classifyFoundationTargetFileRisk(
  suggestion: FoundationWriteSuggestionLike,
  targetPath: string,
): FoundationWriteRisk | undefined {
  const normalizedTargetFile = normalizeFoundationTargetFile(suggestion.targetFile);
  const blocked = (reason: string): FoundationWriteRisk => ({
    level: "blocked",
    reason,
    targetFile: suggestion.targetFile,
    targetPath,
    suggestedValue: suggestion.after,
  });
  if (!normalizedTargetFile) {
    return blocked("unsafe_foundation_target_file");
  }
  const expected = expectedInputTargetFileForFoundationAction(suggestion.actionType, suggestion.category);
  if (expected) {
    return normalizedTargetFile === expected ? undefined : blocked(`target_file_mismatch:${expected}`);
  }
  if (!GENERIC_FOUNDATION_WRITE_TARGET_FILES.has(normalizedTargetFile)) {
    return blocked(`unsupported_foundation_target_file:${normalizedTargetFile}`);
  }
  return undefined;
}

function normalizeFoundationTargetFile(targetFile: string): string | undefined {
  const normalized = targetFile.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  if (
    !normalized
    || normalized.includes("\0")
    || isAbsolute(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || !normalized.endsWith(".json")
  ) {
    return undefined;
  }
  return normalized;
}

const WORLD_BIBLE_TEXT_ARRAY_KEYS = ["rules", "powerOrSurvivalSystems", "historyFacts", "socialOrder"] as const;
const WRITING_RULES_TEXT_ARRAY_KEYS = [
  "proseStyle",
  "genreRequirements",
  "suspenseRules",
  "payoffRules",
  "reversalRules",
  "readerExperienceRules",
  "forbiddenContent",
  "doNotDo",
] as const;

async function classifyDeleteFoundationEntry(
  projectDir: string,
  suggestion: FoundationWriteSuggestionLike,
  targetPath: string,
): Promise<FoundationWriteRisk> {
  const risk = (level: FoundationWriteRiskLevel, reason: string): FoundationWriteRisk => ({
    level,
    reason,
    targetFile: suggestion.targetFile,
    targetPath,
    suggestedValue: suggestion.after,
  });
  const category = suggestion.category;
  if (category === "characters") {
    const bible = await readJson<CharacterBible>(join(projectDir, "story", "character-bible.json"), { version: "v0", characters: [] });
    const entry = suggestion.targetId ? bible.characters.find((item) => item.id === suggestion.targetId) : undefined;
    if (!entry) return risk("blocked", "delete_target_not_found");
    if (isProtagonistRole(entry.role)) return risk("blocked", "cannot_delete_protagonist");
    if (suggestion.confirmedByUser !== true) {
      const matrix = await readJson<CharacterMatrixLedger>(join(projectDir, "story", "character-matrix.json"), { version: "v0", entries: [] });
      const matrixEntry = matrix.entries.find((item) => item.id === entry.id || item.promotedCharacterId === entry.id || item.name === entry.name);
      const chapters = unique((matrixEntry?.appearances ?? []).map((appearance) => `第${appearance.chapter}章`));
      if (matrixEntry && (chapters.length > 0 || matrixEntry.status === "promoted")) {
        return risk("needs_confirmation", `delete_needs_explicit_confirm:${chapters.length > 0 ? chapters.join("、") : "已晋升为正式角色"}`);
      }
    }
    return risk("safe", "删除资料条目。");
  }
  if (category === "characterRelationships") {
    const bible = await readJson<CharacterBible>(join(projectDir, "story", "character-bible.json"), { version: "v0", characters: [] });
    const entry = suggestion.targetId ? bible.characters.find((item) => item.id === suggestion.targetId) : undefined;
    const beforeText = deleteBeforeText(suggestion);
    if (!entry || !beforeText || !(entry.relationshipDynamics ?? []).includes(beforeText)) {
      return risk("blocked", "delete_target_not_found");
    }
    return risk("safe", "删除资料条目。");
  }
  if (category === "locations") {
    const bible = await readJson<LocationBible>(join(projectDir, "story", "location-bible.json"), { version: "v0", locations: [] });
    return findEntryByIdOrName(bible.locations, suggestion)
      ? risk("safe", "删除资料条目。")
      : risk("blocked", "delete_target_not_found");
  }
  if (category === "assets") {
    const ledger = await readJson<AssetLedger>(join(projectDir, "story", "assets.json"), { version: "v0", assets: [], containers: [] });
    return findEntryByIdOrName(ledger.assets, suggestion)
      ? risk("safe", "删除资料条目。")
      : risk("blocked", "delete_target_not_found");
  }
  if (category === "world" || category === "writingRules") {
    const targetFile = category === "world" ? "story/world-bible.json" : "story/writing-rules.json";
    const keys = category === "world" ? WORLD_BIBLE_TEXT_ARRAY_KEYS : WRITING_RULES_TEXT_ARRAY_KEYS;
    const record = await readJson<Record<string, unknown>>(join(projectDir, targetFile), defaultDocument(targetFile));
    const beforeText = deleteBeforeText(suggestion);
    if (!beforeText || !findTextEntryField(record, keys, beforeText)) {
      return risk("blocked", "delete_target_not_found");
    }
    return risk("safe", "删除资料条目。");
  }
  return risk("blocked", `unsupported_delete_category:${category ?? "unknown"}`);
}

function isProtagonistRole(role: string | undefined): boolean {
  if (!role) return false;
  return role === "protagonist" || role.includes("主角");
}

/**
 * role 是「短标签」（主角/宠妃/翰林院典籍官），不是人物简介。模型常把整段描述同时塞进 role 与 identity
 * （或 role 缺失回落到长 identity）。归一：明显是整句/整段时取首个短语当标签；完整描述已在 identity 里、零丢失。
 * 题材中立、纯确定性：只按句末标点/长度判断，不嗅探任何题材词。短 role（职衔含单个逗号）保持原样、不过度收窄。
 */
function toRoleLabel(role: string): string {
  const trimmed = role.trim();
  // 只在明显是整句/整段时收窄：含句末标点(。！？.!?) 或过长(>24)。短 role 原样保留。
  if (!/[。！？.!?]/u.test(trimmed) && trimmed.length <= 24) return trimmed;
  const firstPhrase = trimmed.split(/[。！？.!?，、；;,]/u)[0]?.trim() ?? "";
  return firstPhrase || trimmed.slice(0, 24);
}

function deleteBeforeText(suggestion: FoundationWriteSuggestionLike): string {
  return typeof suggestion.before === "string" ? suggestion.before.trim() : "";
}

function findEntryByIdOrName<T extends { readonly id: string; readonly name: string }>(
  entries: readonly T[],
  suggestion: FoundationWriteSuggestionLike,
): T | undefined {
  const byId = suggestion.targetId ? entries.find((item) => item.id === suggestion.targetId) : undefined;
  if (byId) return byId;
  const name = suggestion.extractedEntityName?.trim();
  return name ? entries.find((item) => item.name === name) : undefined;
}

function findTextEntryField(
  record: Record<string, unknown>,
  keys: readonly string[],
  beforeText: string,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim() === beforeText)) {
      return key;
    }
  }
  return undefined;
}

function expectedInputTargetFileForFoundationAction(actionType: string, category?: string): string | undefined {
  if (actionType === "delete_foundation_entry") {
    if (category === "locations") return "story/location-bible.json";
    if (category === "assets") return "story/assets.json";
    if (category === "world") return "story/world-bible.json";
    if (category === "writingRules") return "story/writing-rules.json";
    return "story/character-bible.json";
  }
  if (
    actionType === "create_character"
    || actionType === "rename_character"
    || actionType === "update_character_detail"
    || actionType === "update_character_boundary"
    || actionType === "create_relationship"
    || actionType === "update_knowledge_boundary"
  ) {
    return "story/character-bible.json";
  }
  if (actionType === "create_location" || actionType === "update_location_detail") return "story/location-bible.json";
  if (actionType === "create_asset" || actionType === "update_asset_status") return "story/assets.json";
  if (actionType === "update_world_rule") return "story/world-bible.json";
  if (actionType === "update_writing_rule") return "story/writing-rules.json";
  return undefined;
}

export function targetFilesForFoundationWriteSuggestion(suggestion: FoundationWriteSuggestionLike): readonly string[] {
  if (suggestion.actionType === "delete_foundation_entry") {
    if (suggestion.category === "characters") {
      return suggestion.targetId
        ? [
          "story/character-bible.json",
          "story/character-matrix.json",
          `characters/${suggestion.targetId}/profile.json`,
          `characters/${suggestion.targetId}/core.json`,
          `characters/${suggestion.targetId}/state.json`,
        ]
        : ["story/character-bible.json", "story/character-matrix.json"];
    }
    if (suggestion.category === "characterRelationships") return ["story/character-bible.json"];
    if (suggestion.category === "locations") return ["story/location-bible.json"];
    if (suggestion.category === "assets") return ["story/assets.json"];
    if (suggestion.category === "world") return ["story/world-bible.json"];
    if (suggestion.category === "writingRules") return ["story/writing-rules.json"];
    return [suggestion.targetFile];
  }
  if (suggestion.actionType === "create_character") {
    const patch = normalizeCharacterPatch(suggestion);
    return [
      "story/character-bible.json",
      `characters/${patch.bibleEntry.id}/profile.json`,
      `characters/${patch.bibleEntry.id}/core.json`,
      `characters/${patch.bibleEntry.id}/state.json`,
    ];
  }
  if (suggestion.actionType === "rename_character") {
    return suggestion.targetId
      ? ["story/character-bible.json", `characters/${suggestion.targetId}/profile.json`]
      : ["story/character-bible.json"];
  }
  if (
    suggestion.actionType === "update_character_boundary"
    || suggestion.actionType === "create_relationship"
    || suggestion.actionType === "update_knowledge_boundary"
  ) {
    return ["story/character-bible.json"];
  }
  if (suggestion.actionType === "update_character_detail") {
    return suggestion.targetId
      ? [
        "story/character-bible.json",
        `characters/${suggestion.targetId}/profile.json`,
        `characters/${suggestion.targetId}/core.json`,
        `characters/${suggestion.targetId}/state.json`,
      ]
      : ["story/character-bible.json"];
  }
  if (suggestion.actionType === "create_location" || suggestion.actionType === "update_location_detail") {
    return ["story/location-bible.json"];
  }
  if (suggestion.actionType === "create_asset" || suggestion.actionType === "update_asset_status") {
    return ["story/assets.json"];
  }
  if (suggestion.actionType === "update_world_rule") {
    // world-rule 写入会把 after.extraFields 落到 world/state.json（见 applyWorldRuleSuggestion），
    // 所以回滚备份集必须包含它，否则同批后续写入失败回滚时会残留孤儿 extraFields。
    return ["story/world-bible.json", "world/state.json"];
  }
  return [suggestion.targetFile];
}

async function assertProjectDir(projectDir: string): Promise<void> {
  await readProject(projectDir);
}

async function applySuggestion(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  if (suggestion.actionType === "delete_foundation_entry") {
    return { writes: await applyDeleteFoundationEntry(projectDir, suggestion) };
  }
  if (suggestion.actionType === "create_character") {
    return applyCreateCharacter(projectDir, suggestion);
  }
  if (suggestion.actionType === "rename_character") {
    return { writes: await applyRenameCharacter(projectDir, suggestion) };
  }
  if (suggestion.actionType === "update_character_detail") {
    // 唯一会因目标缺失而静默返回空的路径——改为带 skip 的显式信号（修2）。
    return applyUpdateCharacterDetail(projectDir, suggestion);
  }
  if (suggestion.actionType === "create_location") {
    return applyCreateLocation(projectDir, suggestion);
  }
  if (suggestion.actionType === "update_location_detail") {
    return { writes: await applyLocationSuggestion(projectDir, suggestion) };
  }
  if (suggestion.actionType === "create_asset") {
    return applyCreateAsset(projectDir, suggestion);
  }
  if (suggestion.actionType === "update_asset_status") {
    return { writes: await applyAssetSuggestion(projectDir, suggestion) };
  }
  if (suggestion.actionType === "update_world_rule") {
    return applyWorldRuleSuggestion(projectDir, suggestion);
  }
  if (suggestion.actionType === "update_writing_rule") {
    return applyWritingRuleSuggestion(projectDir, suggestion);
  }
  return { writes: await applyFieldSuggestion(projectDir, suggestion) };
}

async function applyDeleteFoundationEntry(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  if (suggestion.category === "characters") return applyDeleteCharacter(projectDir, suggestion);
  if (suggestion.category === "characterRelationships") return applyDeleteRelationshipEntry(projectDir, suggestion);
  if (suggestion.category === "locations") return applyDeleteLocation(projectDir, suggestion);
  if (suggestion.category === "assets") return applyDeleteAsset(projectDir, suggestion);
  if (suggestion.category === "world") return applyDeleteTextEntry(projectDir, suggestion, "story/world-bible.json", WORLD_BIBLE_TEXT_ARRAY_KEYS, "world");
  if (suggestion.category === "writingRules") return applyDeleteTextEntry(projectDir, suggestion, "story/writing-rules.json", WRITING_RULES_TEXT_ARRAY_KEYS, "writingRules");
  throw new Error(`unsupported_delete_category:${suggestion.category ?? "unknown"}`);
}

async function applyDeleteCharacter(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const biblePath = join(projectDir, "story", "character-bible.json");
  const bible = await readJson<CharacterBible>(biblePath, { version: "v0", characters: [] });
  const entry = suggestion.targetId ? bible.characters.find((item) => item.id === suggestion.targetId) : undefined;
  if (!entry) throw new Error("delete_target_not_found");
  const writes: FoundationWriteRecord[] = [];
  const remaining = bible.characters
    .filter((item) => item.id !== entry.id)
    .map((item) => withoutRelationshipRefs(item, entry.name));
  await writeJson(biblePath, { ...bible, characters: remaining });
  writes.push({
    domain: "character",
    action: "delete_foundation_entry",
    targetFile: "story/character-bible.json",
    targetId: entry.id,
    targetName: entry.name,
    summary: `已删除角色「${entry.name}」`,
  });

  const matrixPath = join(projectDir, "story", "character-matrix.json");
  const matrix = await readJson<CharacterMatrixLedger>(matrixPath, { version: "v0", entries: [] });
  const nextEntries = matrix.entries.filter((item) => item.id !== entry.id && item.promotedCharacterId !== entry.id && item.name !== entry.name);
  await writeJson(matrixPath, { ...matrix, entries: nextEntries });
  writes.push({
    domain: "character",
    action: "delete_character_matrix_entry",
    targetFile: "story/character-matrix.json",
    targetId: entry.id,
    targetName: entry.name,
    summary: "已移除对应的角色矩阵条目",
  });

  for (const fileName of ["profile.json", "core.json", "state.json"]) {
    const relativePath = `characters/${entry.id}/${fileName}`;
    await rm(join(projectDir, relativePath), { force: true });
    writes.push({
      domain: "character",
      action: "delete_character_file",
      targetFile: relativePath,
      targetId: entry.id,
      targetName: entry.name,
      summary: `已删除 ${relativePath}`,
    });
  }
  return writes;
}

function withoutRelationshipRefs(entry: CharacterBibleEntry, deletedName: string): CharacterBibleEntry {
  if (!deletedName) return entry;
  const dynamics = entry.relationshipDynamics ?? [];
  const cleaned = dynamics.filter((item) => !item.includes(deletedName));
  if (cleaned.length === dynamics.length) return entry;
  return { ...entry, relationshipDynamics: cleaned };
}

async function applyDeleteRelationshipEntry(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const biblePath = join(projectDir, "story", "character-bible.json");
  const bible = await readJson<CharacterBible>(biblePath, { version: "v0", characters: [] });
  const entry = suggestion.targetId ? bible.characters.find((item) => item.id === suggestion.targetId) : undefined;
  const beforeText = deleteBeforeText(suggestion);
  if (!entry || !beforeText) throw new Error("delete_target_not_found");
  const characters = bible.characters.map((item) => (
    item.id === entry.id
      ? { ...item, relationshipDynamics: (item.relationshipDynamics ?? []).filter((line) => line.trim() !== beforeText) }
      : item
  ));
  await writeJson(biblePath, { ...bible, characters });
  return [{
    domain: "character",
    action: "delete_foundation_entry",
    targetFile: "story/character-bible.json",
    targetId: entry.id,
    targetName: entry.name,
    summary: `已删除「${entry.name}」的关系条目`,
  }];
}

async function applyDeleteLocation(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const biblePath = join(projectDir, "story", "location-bible.json");
  const bible = await readJson<LocationBible>(biblePath, { version: "v0", locations: [] });
  const entry = findEntryByIdOrName(bible.locations, suggestion);
  if (!entry) throw new Error("delete_target_not_found");
  await writeJson(biblePath, { ...bible, locations: bible.locations.filter((item) => item.id !== entry.id) });
  return [{
    domain: "location",
    action: "delete_foundation_entry",
    targetFile: "story/location-bible.json",
    targetId: entry.id,
    targetName: entry.name,
    summary: `已删除地点「${entry.name}」`,
  }];
}

async function applyDeleteAsset(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const ledgerPath = join(projectDir, "story", "assets.json");
  const ledger = await readJson<AssetLedger>(ledgerPath, { version: "v0", assets: [], containers: [] });
  const entry = findEntryByIdOrName(ledger.assets, suggestion);
  if (!entry) throw new Error("delete_target_not_found");
  await writeJson(ledgerPath, { ...ledger, assets: ledger.assets.filter((item) => item.id !== entry.id) });
  return [{
    domain: "asset",
    action: "delete_foundation_entry",
    targetFile: "story/assets.json",
    targetId: entry.id,
    targetName: entry.name,
    summary: `已删除资产「${entry.name}」`,
  }];
}

async function applyDeleteTextEntry(
  projectDir: string,
  suggestion: FoundationWriteSuggestionLike,
  targetFile: string,
  keys: readonly string[],
  domain: FoundationWriteDomain,
): Promise<readonly FoundationWriteRecord[]> {
  const absolutePath = join(projectDir, targetFile);
  const record = await readJson<Record<string, unknown>>(absolutePath, defaultDocument(targetFile));
  const beforeText = deleteBeforeText(suggestion);
  const field = beforeText ? findTextEntryField(record, keys, beforeText) : undefined;
  if (!field) throw new Error("delete_target_not_found");
  const current = record[field] as readonly unknown[];
  record[field] = current.filter((item) => !(typeof item === "string" && item.trim() === beforeText));
  await writeJson(absolutePath, record);
  return [{
    domain,
    action: "delete_foundation_entry",
    targetFile,
    summary: `已从 ${targetFile} 的 ${field} 中删除一条规则`,
  }];
}

async function applyFieldSuggestion(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const relativePath = suggestion.targetFile;
  const absolutePath = join(projectDir, relativePath);
  const record = await readJson(absolutePath, defaultDocument(relativePath));
  if (suggestion.writeMode === "replace") {
    replacePath(record, targetPathForSuggestion(suggestion), suggestion.after, suggestion.targetId);
  } else {
    writePath(record, targetPathForSuggestion(suggestion), suggestion.after, suggestion.targetId);
  }
  await writeJson(absolutePath, record);
  return [{
    domain: "field",
    action: suggestion.actionType,
    targetFile: relativePath,
    ...(suggestion.targetId ? { targetId: suggestion.targetId } : {}),
    summary: `已更新 ${relativePath}`,
  }];
}

async function applyCreateCharacter(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  // 模型无关·诚实失败：create 真缺 name（after.name / source.name / extractedEntityName 都没给）→ 显式跳过，
  // 不造一张名为「待确认角色」的占位垃圾卡还报成功（违铁律④；长篇里反复累积污染矩阵/关系网）。
  if (!resolveCreateCharacterName(suggestion)) {
    return {
      writes: [],
      skip: {
        reason: "missing_name",
        action: "create_character",
        summary: "没给新角色名字，没建卡——请说清要建的角色叫什么（如「建个叫沈茂行的角色」），避免建出「待确认角色」占位卡。",
      },
    };
  }
  const patch = normalizeCharacterPatch(suggestion);
  const biblePath = join(projectDir, "story", "character-bible.json");
  const bible = await readJson<CharacterBible>(biblePath, { version: "v0", characters: [] });
  const index = bible.characters.findIndex((item) => item.id === patch.bibleEntry.id || item.name === patch.bibleEntry.name);
  const characters = [...bible.characters];
  if (index < 0) {
    characters.push(patch.bibleEntry);
  } else {
    characters[index] = mergeCharacterBibleEntry(characters[index] as CharacterBibleEntry, patch.bibleEntry);
  }
  await writeJson(biblePath, { ...bible, characters });

  const characterDir = join(projectDir, "characters", patch.bibleEntry.id);
  await mkdir(characterDir, { recursive: true });
  await writeMergedCharacterFile(join(characterDir, "profile.json"), patch.profile);
  await writeMergedCharacterFile(join(characterDir, "core.json"), patch.core);
  const statePath = join(characterDir, "state.json");
  const stateReport = await writeCharacterStateWithExtraFields(statePath, patch.state, readExtraFields(patch.state));

  const writes: readonly FoundationWriteRecord[] = [
    {
      domain: "character",
      action: "create_or_update_character",
      targetFile: "story/character-bible.json",
      targetId: patch.bibleEntry.id,
      targetName: patch.bibleEntry.name,
      summary: `已同步角色 ${patch.bibleEntry.name} 到角色圣经`,
    },
    {
      domain: "character",
      action: "create_or_update_character_files",
      targetFile: `characters/${patch.bibleEntry.id}/profile.json`,
      targetId: patch.bibleEntry.id,
      targetName: patch.bibleEntry.name,
      summary: `已写入角色档案 ${patch.bibleEntry.name}`,
    },
    {
      domain: "character",
      action: "create_or_update_character_files",
      targetFile: `characters/${patch.bibleEntry.id}/core.json`,
      targetId: patch.bibleEntry.id,
      targetName: patch.bibleEntry.name,
      summary: `已写入角色核心 ${patch.bibleEntry.name}`,
    },
    withExtraFieldsReport(
      {
        domain: "character",
        action: "create_or_update_character_files",
        targetFile: `characters/${patch.bibleEntry.id}/state.json`,
        targetId: patch.bibleEntry.id,
        targetName: patch.bibleEntry.name,
        summary: extraFieldsSummary(`已写入角色状态 ${patch.bibleEntry.name}`, patch.bibleEntry.name, stateReport.newKeys),
      },
      stateReport.merged,
      stateReport.newKeys,
    ),
  ];
  return { writes };
}

/**
 * 把角色 state 写入磁盘，并对 extraFields 做加法式浅合并（新值覆盖同名旧键）。
 * 返回合并后的 extraFields 与本次新建的键名。
 */
async function writeCharacterStateWithExtraFields(
  statePath: string,
  patchState: CharacterState | (Partial<CharacterState> & { readonly characterId?: string }),
  incoming: ExtraFields | undefined,
  strategy: "preferExisting" | "preferPatch" = "preferExisting",
  // 受控破例⑤：要删除的 extraFields 自定义键（在加法式合并后再移除，纠正写错的字段键）。
  removeExtraFieldKeys: readonly string[] = [],
): Promise<{ readonly merged: ExtraFields | undefined; readonly newKeys: readonly string[]; readonly changed: boolean }> {
  const existingRaw = await readJson<Record<string, unknown>>(statePath, {});
  const existing = readExtraFields(existingRaw);
  let merged = mergeExtraFields(existing, incoming);
  if (removeExtraFieldKeys.length > 0) {
    // 在合并后的 extraFields（或既有）上删除指定键；删空后写 {} 而非保留旧键。
    const base: ExtraFields = { ...(merged ?? existing ?? {}) };
    for (const key of removeExtraFieldKeys) delete base[key];
    merged = base;
  }
  const newKeys = newExtraFieldKeys(existing, incoming);
  // 用既有合并策略写其它内置字段，再以合并后的 extraFields 覆盖该键。
  const { extraFields: _ignored, ...patchWithoutExtra } = patchState as Record<string, unknown>;
  const baseMerged = strategy === "preferPatch"
    ? mergeRecordsPreferPatch(existingRaw, patchWithoutExtra)
    : mergeRecordsPreferExisting(existingRaw, patchWithoutExtra);
  const next = merged ? { ...baseMerged, extraFields: merged } : baseMerged;
  const changed = JSON.stringify(next) !== JSON.stringify(existingRaw);
  await writeJson(statePath, next);
  return { merged, newKeys, changed };
}

function extraFieldsSummary(base: string, targetName: string | undefined, newKeys: readonly string[]): string {
  if (newKeys.length === 0) return base;
  const label = targetName ? `「${targetName}」` : "";
  return `${base}（为${label}新增自定义字段：${newKeys.join("、")}）`;
}

async function applyRenameCharacter(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const newName = readRenameCharacterName(suggestion);
  if (!newName || !suggestion.targetId) return [];
  const biblePath = join(projectDir, "story", "character-bible.json");
  const bible = await readJson<CharacterBible>(biblePath, { version: "v0", characters: [] });
  const index = bible.characters.findIndex((character) => character.id === suggestion.targetId);
  if (index < 0) return [];
  const existing = bible.characters[index] as CharacterBibleEntry;
  const nextCharacters = [...bible.characters];
  nextCharacters[index] = { ...existing, name: newName };
  await writeJson(biblePath, { ...bible, characters: nextCharacters });

  const profilePath = join(projectDir, "characters", suggestion.targetId, "profile.json");
  const profile = await readJson<CharacterProfile>(profilePath, { id: suggestion.targetId, name: existing.name, identity: existing.identity ?? existing.role ?? "protagonist", appearance: {}, tags: [] });
  await writeJson(profilePath, { ...profile, id: suggestion.targetId, name: newName });

  return [
    {
      domain: "character",
      action: "rename_character",
      targetFile: "story/character-bible.json",
      targetId: suggestion.targetId,
      targetName: newName,
      summary: `已把角色名改为 ${newName}`,
    },
    {
      domain: "character",
      action: "rename_character_profile",
      targetFile: `characters/${suggestion.targetId}/profile.json`,
      targetId: suggestion.targetId,
      targetName: newName,
      summary: `已同步角色档案名 ${newName}`,
    },
  ];
}

async function applyUpdateCharacterDetail(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  const intendedName = isRecord(suggestion.after)
    ? readString(suggestion.after.name) ?? readString(suggestion.after.newName)
    : undefined;
  const beforeName = isRecord(suggestion.before) ? readString(suggestion.before.name) : undefined;
  const skipName = intendedName ?? beforeName ?? suggestion.extractedEntityName;
  // 修2：缺 targetId → 显式跳过，而非静默返回空（让上层知道「这条没写成因为没定位到目标」）。
  if (!suggestion.targetId) {
    return {
      writes: [],
      skip: {
        reason: "missing_target_id",
        action: "update_character_detail",
        ...(skipName ? { targetName: skipName } : {}),
        summary: skipName
          ? `没能定位到「${skipName}」对应的角色卡片，本次未写入任何内容。`
          : "没能定位到这条资料对应的角色卡片，本次未写入任何内容。",
      },
    };
  }
  const patch = normalizeCharacterDetailPatch(suggestion);
  const biblePath = join(projectDir, "story", "character-bible.json");
  const bible = await readJson<CharacterBible>(biblePath, { version: "v0", characters: [] });
  const index = bible.characters.findIndex((character) => character.id === suggestion.targetId);
  // 修2：targetId 在角色册里找不到 → 同样显式跳过。
  if (index < 0) {
    return {
      writes: [],
      skip: {
        reason: "target_not_found",
        action: "update_character_detail",
        ...(skipName ? { targetName: skipName } : {}),
        summary: skipName
          ? `没能在角色资料里找到「${skipName}」，本次未写入任何内容。`
          : "没能在角色资料里找到对应角色，本次未写入任何内容。",
      },
    };
  }

  const existing = bible.characters[index] as CharacterBibleEntry;
  // Bug2（模型无关 + 铁律④）：模型常把「改名」混进 update_character_detail（after.name 与现名不同）。
  // 过去这里彻底丢弃 after.name 只写其它字段却报成功 = 谎报。现在分两种确定性安全的处理：
  //   · 现名是开书占位（如默认「主角」）→ 给占位主角起真名，认领改名、真落盘（一步到位，修封测场景）；
  //   · 现名已是真名 → 绝不静默改名（长篇里 after.name 偶发漂移会把既定角色改崩），但也绝不谎报：
  //     `nameChangeRefused` 置真 → 下方诚实回报「名字没改，改名请单独说『把X改名为Y』」，其它字段照写。
  const wantsRename = Boolean(intendedName && intendedName !== existing.name);
  const renameTo = wantsRename && isPlaceholderName(existing.name) ? intendedName : undefined;
  const nameChangeRefused = wantsRename && !renameTo;
  const name = renameTo ?? existing.name;
  // 已是真名却被要求改名 + after 没有别的可写字段 → 纯改名误投：诚实回报名字没改、指路 rename_character（绝不谎报成功）。
  const refuseRenameSkip = {
    reason: "name_change_requires_rename" as const,
    action: "update_character_detail",
    targetName: existing.name,
    summary: `「${existing.name}」的名字没有改：给已有名字的角色改名是独立操作，请单独说「把${existing.name}改名为${intendedName}」。`,
  };

  // 修3：targetId 有效、角色存在，但 after 里没有任何引擎认得的可写字段（agent 把 180cm/scars/下棋
  // 等乱填在顶层，既不是内置字段也没放进 extraFields）→ normalize 把这些键全丢了。此前仍无条件回 4 条
  // write 记录 → applied=true 谎报。改为显式跳过：不写文件、不返回 write 记录，让上层如实报「没写入」。
  // 注意：renameTo（占位改名）即便没有其它字段也要继续往下写改名，不能被这道守卫拦掉。
  if (!renameTo && !characterDetailPatchHasRecognizedFields(patch)) {
    if (nameChangeRefused) {
      return { writes: [], skip: refuseRenameSkip };
    }
    return {
      writes: [],
      skip: {
        reason: "no_recognized_fields",
        action: "update_character_detail",
        targetName: name,
        summary: `「${name}」这条没写入：after 里没有引擎认得的字段（没有专用字段的内容请放进 extraFields）。`,
      },
    };
  }

  const mergedEntry = mergeCharacterBibleEntryWithPatch(existing, patch.bibleEntry, patch.corrections);

  // 受控破例⑤·诚实回报（铁律④）：逐条核对 removeFromArrays/removeExtraFieldKeys 的目标是否真命中现存项，
  // **无论是否同时有追加字段**。『删旧 + 加新 = 改某条』是头号用例，绝不能因为有 add 就跳过「没删到」的核对——
  // 否则原文差一个字没删成、新条仍追加 → 两条矛盾并存却报成功（正是本功能要根治的痛点）。
  // replaceArrays 是整列重写、无所谓命中，不计。
  const correctionsRequested =
    Object.keys(patch.corrections.removeFromArrays).length > 0 ||
    Object.keys(patch.corrections.replaceArrays).length > 0 ||
    patch.corrections.removeExtraFieldKeys.length > 0;
  const hasAdditive =
    Object.keys(patch.bibleEntry).length > 0 ||
    Object.keys(patch.profile).length > 0 ||
    Object.keys(patch.core).length > 0 ||
    Object.keys(patch.state).length > 0;
  const characterDir = join(projectDir, "characters", suggestion.targetId);

  // 逐条找出「要删但现存里没有」的目标（removeFromArrays 各字段 + removeExtraFieldKeys 键），按归一化文本精确匹配。
  const unmatchedTargets: string[] = [];
  for (const [field, targets] of Object.entries(patch.corrections.removeFromArrays)) {
    const present = new Set(
      ((existing[field as keyof CharacterBibleEntry] as readonly string[] | undefined) ?? []).map(normalizedText),
    );
    for (const target of targets) {
      if (!present.has(normalizedText(target))) unmatchedTargets.push(`「${target}」`);
    }
  }
  let existingExtra: Record<string, unknown> = {};
  if (patch.corrections.removeExtraFieldKeys.length > 0) {
    const existingState = await readJson<Record<string, unknown>>(join(characterDir, "state.json"), {});
    existingExtra = readExtraFields(existingState) ?? {};
    for (const key of patch.corrections.removeExtraFieldKeys) {
      if (!(key in existingExtra)) unmatchedTargets.push(`字段键「${key}」`);
    }
  }
  const bibleArrayChanged = CHARACTER_BIBLE_ARRAY_FIELDS.some(
    (f) => JSON.stringify((mergedEntry[f] as unknown) ?? []) !== JSON.stringify((existing[f] as unknown) ?? []),
  );
  const extraKeyHit = patch.corrections.removeExtraFieldKeys.some((k) => k in existingExtra);

  // 纯纠错（无追加）且一条都没改动到、且确有「要删的目标没命中」→ 整条没找到，如实跳过、绝不谎报成功。
  // 仅当 unmatchedTargets 非空才报『没找到』：纯 replaceArrays 的幂等无操作（如把已空字段再清空、
  // 整列重写成与现状相同的值）不是「没找到」，应放行写一遍（幂等、无害），避免出现「没找到（）」空括号（修#7）。
  // renameTo（占位改名）必须落盘，不能被「纠错目标没命中」的早退吞掉。
  if (!renameTo && correctionsRequested && !hasAdditive && !bibleArrayChanged && !extraKeyHit && unmatchedTargets.length > 0) {
    return {
      writes: [],
      skip: {
        reason: "correction_target_not_found",
        action: "update_character_detail",
        targetName: name,
        summary: `「${name}」这条没改动：要删/改的内容在资料里没找到（${unmatchedTargets.join("、")}）——删除/替换的原文需与现有条目逐字一致，可先读一下现有内容再试。`,
      },
    };
  }

  // 占位改名：把认领的新名写进 bible 条目（mergeCharacterBibleEntryWithPatch 会把 name 钉回 existing.name，故其后覆盖）。
  const finalEntry = renameTo ? { ...mergedEntry, name: renameTo } : mergedEntry;
  // 非 name 字段是否变（用 mergedEntry 比对，它的 name 仍是旧名）——决定要不要回「已更新角色资料」记录，纯改名时不重复报。
  const otherFieldsChanged = JSON.stringify(mergedEntry) !== JSON.stringify(existing);
  const characters = [...bible.characters];
  characters[index] = finalEntry;
  await writeJson(biblePath, { ...bible, characters });

  await mkdir(characterDir, { recursive: true });
  const profileChanged = await writePatchedCharacterFile(join(characterDir, "profile.json"), {
    id: suggestion.targetId,
    name,
    ...patch.profile,
  });
  const coreChanged = await writePatchedCharacterFile(join(characterDir, "core.json"), {
    characterId: suggestion.targetId,
    ...patch.core,
  });
  const stateReport = await writeCharacterStateWithExtraFields(
    join(characterDir, "state.json"),
    { characterId: suggestion.targetId, ...patch.state },
    readExtraFields(patch.state),
    "preferPatch",
    patch.corrections.removeExtraFieldKeys,
  );

  // 诚实明细（铁律④）：只记录实际变了的文件，绝不无条件报 profile/core/state（治「写入明细过报」E2E）。
  // 文件照常写（幂等无变=不产生 git diff），只是 writes[] 不把没变的算进来。
  return {
    writes: [
      // 占位改名：如实记一条 rename_character，让 summary 诚实说「改名成功」（applied=true 名副其实，不再谎报）。
      ...(renameTo ? [{
        domain: "character" as const,
        action: "rename_character" as const,
        targetFile: "story/character-bible.json",
        targetId: suggestion.targetId,
        targetName: renameTo,
        summary: `已把角色名从「${existing.name}」改为「${renameTo}」`,
      }] : []),
      ...(otherFieldsChanged ? [{
        domain: "character" as const,
        action: "update_character_detail" as const,
        targetFile: "story/character-bible.json",
        targetId: suggestion.targetId,
        targetName: name,
        summary: `已更新角色资料 ${name}`,
      }] : []),
      ...(profileChanged ? [{
        domain: "character" as const,
        action: "update_character_profile" as const,
        targetFile: `characters/${suggestion.targetId}/profile.json`,
        targetId: suggestion.targetId,
        targetName: name,
        summary: `已同步角色档案 ${name}`,
      }] : []),
      ...(coreChanged ? [{
        domain: "character" as const,
        action: "update_character_core" as const,
        targetFile: `characters/${suggestion.targetId}/core.json`,
        targetId: suggestion.targetId,
        targetName: name,
        summary: `已同步角色核心 ${name}`,
      }] : []),
      ...(stateReport.changed ? [withExtraFieldsReport(
        {
          domain: "character" as const,
          action: "update_character_state" as const,
          targetFile: `characters/${suggestion.targetId}/state.json`,
          targetId: suggestion.targetId,
          targetName: name,
          summary: extraFieldsSummary(`已同步角色状态 ${name}`, name, stateReport.newKeys),
        },
        stateReport.merged,
        stateReport.newKeys,
      )] : []),
    ],
    // 诚实回报（铁律④）。优先级：①想给「已有真名」角色改名却被拒（写了其它字段、名字没改）→ 明说名字没改、指路 rename；
    // ②受控破例⑤：写入成功但有 removeFromArrays/删键目标没命中（『改某条』旧原文差字没删成）→ 点名没删到的，避免新旧两条并存。
    ...(nameChangeRefused
      ? {
          skip: {
            reason: "name_change_requires_rename" as const,
            action: "update_character_detail",
            targetName: existing.name,
            summary: `已写入其它字段，但「${existing.name}」的名字没有改：给已有名字的角色改名是独立操作，请单独说「把${existing.name}改名为${intendedName}」。`,
          },
        }
      : unmatchedTargets.length > 0
        ? {
            skip: {
              reason: "correction_target_not_found" as const,
              action: "update_character_detail",
              targetName: name,
              summary: `要删/改的这些没找到、未删：${unmatchedTargets.join("、")}（原文需与现有条目逐字一致）——其余已处理；请核对，避免新旧两条并存。`,
            },
          }
        : {}),
  };
}

/**
 * 现名是否为「开书占位名」——给占位主角起真名是确定性安全的改名场景，可在 update_character_detail 里直接认领；
 * 而对已是真名的角色，after.name 偶发漂移不得静默改名（长篇放大律），只诚实回报、指路 rename_character。
 * 默认主角名取自 createStoryProject 的 mainCharacterName，UI 未填时落为「主角」(books.ts)。
 */
const PLACEHOLDER_CHARACTER_NAMES = new Set(["主角", "主人公", "待确认角色", "未命名"]);
function isPlaceholderName(name: string | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return trimmed.length === 0 || PLACEHOLDER_CHARACTER_NAMES.has(trimmed);
}

function readRenameCharacterName(suggestion: FoundationWriteSuggestionLike): string | undefined {
  if (isRecord(suggestion.after)) return readString(suggestion.after.name) ?? readString(suggestion.after.newName) ?? suggestion.extractedEntityName;
  return readString(suggestion.after) ?? suggestion.extractedEntityName;
}

/**
 * 受控破例⑤（2026-06-23 用户批准·资料字段纠错）：把对话里说的「删某条/改某条/整列重写/删字段键」
 * 解析成 corrections，让 update_character_detail 能纠正写错的角色数组字段（治纯追加删不掉改不了）。
 * 复用已有原语 mergeStringArrayField + readRemovalMap；纯确定性、题材中立、不调 LLM；
 * 不带这些指令的旧书逐字节向后兼容（仍纯追加）。
 */
interface CharacterDetailCorrections {
  readonly removeFromArrays: Record<string, readonly string[]>;
  readonly replaceArrays: Record<string, readonly string[]>;
  readonly removeExtraFieldKeys: readonly string[];
}

function normalizeCharacterDetailPatch(suggestion: FoundationWriteSuggestionLike): {
  readonly bibleEntry: Partial<CharacterBibleEntry>;
  readonly profile: Partial<CharacterProfile>;
  readonly core: Partial<CharacterCore>;
  readonly state: Partial<CharacterState>;
  readonly corrections: CharacterDetailCorrections;
} {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const stateSource = isRecord(source.state) ? source.state : {};
  const bibleEntry: Partial<CharacterBibleEntry> = {
    ...(readString(source.age) ? { age: readString(source.age) } : {}),
    ...(readString(source.gender) ? { gender: readString(source.gender) } : {}),
    ...(readString(source.identity) ? { identity: readString(source.identity) } : {}),
    ...(readString(source.desire) ? { desire: readString(source.desire) } : {}),
    ...(readString(source.fear) ? { fear: readString(source.fear) } : {}),
    ...(readString(source.weakness) ? { weakness: readString(source.weakness) } : {}),
    ...(readString(source.contradiction) ? { contradiction: readString(source.contradiction) } : {}),
    ...(readString(source.moralBoundary) ? { moralBoundary: readString(source.moralBoundary) } : {}),
    ...(readString(source.privateMotive) ? { privateMotive: readString(source.privateMotive) } : {}),
    ...(readString(source.relationshipToProtagonist) ? { relationshipToProtagonist: readString(source.relationshipToProtagonist) } : {}),
    ...(readString(source.trustLevel) ? { trustLevel: readString(source.trustLevel) } : {}),
    ...(readString(source.hiddenStance) ? { hiddenStance: readString(source.hiddenStance) } : {}),
    ...(readString(source.speechStyle) ? { speechStyle: readString(source.speechStyle) } : {}),
    ...(readString(source.currentStateHint) ? { currentStateHint: readString(source.currentStateHint) } : {}),
    ...(readStringList(source.appearanceAnchors).length ? { appearanceAnchors: readStringList(source.appearanceAnchors) } : {}),
    ...(readStringList(source.relationshipDynamics).length ? { relationshipDynamics: readStringList(source.relationshipDynamics) } : {}),
    ...(readStringList(source.speechSamples).length ? { speechSamples: readStringList(source.speechSamples) } : {}),
    ...(readStringList(source.personalityBaseline).length ? { personalityBaseline: readStringList(source.personalityBaseline) } : {}),
    ...(readStringList(source.behaviorBoundaries).length ? { behaviorBoundaries: readStringList(source.behaviorBoundaries) } : {}),
    ...(readStringList(source.knowledgeKnown).length ? { knowledgeKnown: readStringList(source.knowledgeKnown) } : {}),
    ...(readStringList(source.knowledgeUnknown).length ? { knowledgeUnknown: readStringList(source.knowledgeUnknown) } : {}),
    ...(readStringList(source.cannotReveal).length ? { cannotReveal: readStringList(source.cannotReveal) } : {}),
    ...(readStringList(source.cannotDo).length ? { cannotDo: readStringList(source.cannotDo) } : {}),
  };
  const profile: Partial<CharacterProfile> = {
    ...(readString(source.age) ? { age: readString(source.age) } : {}),
    ...(readString(source.gender) ? { gender: readString(source.gender) } : {}),
    ...(readString(source.identity) ? { identity: readString(source.identity) } : {}),
    ...(readStringList(source.appearanceAnchors).length ? { appearanceAnchors: readStringList(source.appearanceAnchors) } : {}),
  };
  const core: Partial<CharacterCore> = {
    ...(readString(source.speechStyle) ? { speechStyle: readString(source.speechStyle) } : {}),
    ...(readString(source.desire) ? { desire: readString(source.desire) } : {}),
    ...(readString(source.fear) ? { fear: readString(source.fear) } : {}),
    ...(readString(source.contradiction) ? { contradiction: readString(source.contradiction) } : {}),
    ...(readString(source.moralBoundary) ? { moralBoundary: readString(source.moralBoundary) } : {}),
    ...(readStringList(source.personalityBaseline).length ? { personality: readStringList(source.personalityBaseline) } : {}),
  };
  const currentGoal = readString(stateSource.currentGoal) ?? readString(source.currentGoal);
  const mood = readString(stateSource.mood) ?? readString(source.mood);
  const recentEvents = readStringList(stateSource.recentEvents).length ? readStringList(stateSource.recentEvents) : readStringList(source.recentEvents);
  const extra = readExtraFields(stateSource) ?? readExtraFields(source);
  const state: Partial<CharacterState> = {
    ...(mood ? { mood, emotion: mood } : {}),
    ...(currentGoal ? { currentGoal, goal: currentGoal } : {}),
    ...(recentEvents.length ? { recentEvents } : {}),
    ...(readString(stateSource.relationshipToUser) ?? readString(source.relationshipToUser) ? { relationshipToUser: readString(stateSource.relationshipToUser) ?? readString(source.relationshipToUser) } : {}),
    ...(readString(stateSource.currentLocationName) ?? readString(source.currentLocation) ? { currentLocationName: readString(stateSource.currentLocationName) ?? readString(source.currentLocation) } : {}),
    ...(readStringList(source.knowledgeKnown).length ? { knowledgeKnown: readStringList(source.knowledgeKnown) } : {}),
    ...(readStringList(source.knowledgeUnknown).length ? { knowledgeUnknown: readStringList(source.knowledgeUnknown) } : {}),
    ...(readStringList(source.cannotReveal).length ? { cannotReveal: readStringList(source.cannotReveal) } : {}),
    ...(extra ? { extraFields: extra } : {}),
  };
  const corrections: CharacterDetailCorrections = {
    removeFromArrays: readRemovalMap(source.removeFromArrays),
    replaceArrays: readRemovalMap(source.replaceArrays),
    removeExtraFieldKeys: readStringList(source.removeExtraFieldKeys),
  };
  return { bibleEntry, profile, core, state, corrections };
}

/**
 * 修3：归一化后的角色资料 patch 是否含任一引擎认得的可写字段。
 * normalize 已把不认得的键全部丢弃，所以这里只要四个桶里还有任意键，即代表本次有真东西可写；
 * 全空则说明 agent 填的字段引擎一个都不认得，应跳过而非谎报写入成功。
 * 注意：state 桶里仅含 extraFields 也算认得（兜底自定义字段是合法写入）。
 */
function characterDetailPatchHasRecognizedFields(patch: {
  readonly bibleEntry: Partial<CharacterBibleEntry>;
  readonly profile: Partial<CharacterProfile>;
  readonly core: Partial<CharacterCore>;
  readonly state: Partial<CharacterState>;
  readonly corrections: CharacterDetailCorrections;
}): boolean {
  return (
    Object.keys(patch.bibleEntry).length > 0 ||
    Object.keys(patch.profile).length > 0 ||
    Object.keys(patch.core).length > 0 ||
    Object.keys(patch.state).length > 0 ||
    // 受控破例⑤：纯纠错操作（只有删/改/整列重写/删字段键、无任何追加字段）也算「有真东西可做」，
    // 否则纯删会被误判「没有引擎认得的字段」而跳过、谎报。
    Object.keys(patch.corrections.removeFromArrays).length > 0 ||
    Object.keys(patch.corrections.replaceArrays).length > 0 ||
    patch.corrections.removeExtraFieldKeys.length > 0
  );
}

/** 受控破例⑤：角色 bible 数组字段统一经此并——支持纠错（removeFromArrays / replaceArrays）。 */
const CHARACTER_BIBLE_ARRAY_FIELDS = [
  "appearanceAnchors", "relationshipDynamics", "speechSamples", "personalityBaseline",
  "behaviorBoundaries", "knowledgeKnown", "knowledgeUnknown", "cannotReveal", "cannotDo",
] as const;

function mergeCharacterBibleEntryWithPatch(
  existing: CharacterBibleEntry,
  patch: Partial<CharacterBibleEntry>,
  corrections?: CharacterDetailCorrections,
): CharacterBibleEntry {
  const removals = corrections?.removeFromArrays ?? {};
  const replacements = corrections?.replaceArrays ?? {};
  const mergedArrays: Record<string, string[]> = {};
  for (const field of CHARACTER_BIBLE_ARRAY_FIELDS) {
    const current = (existing[field] as readonly string[] | undefined) ?? [];
    const additions = (patch[field] as readonly string[] | undefined) ?? [];
    // replacement 给值→整列重写（[] 清空）；否则按 removals 精确移除后再追加 additions（mergeStringArrayField 原语）。
    mergedArrays[field] = mergeStringArrayField(current, additions, removals[field], replacements[field]);
  }
  return {
    ...existing,
    ...patch,
    id: existing.id,
    name: existing.name,
    appearanceAnchors: mergedArrays.appearanceAnchors,
    relationshipDynamics: mergedArrays.relationshipDynamics,
    speechSamples: mergedArrays.speechSamples,
    personalityBaseline: mergedArrays.personalityBaseline,
    behaviorBoundaries: mergedArrays.behaviorBoundaries,
    knowledgeKnown: mergedArrays.knowledgeKnown,
    knowledgeUnknown: mergedArrays.knowledgeUnknown,
    cannotReveal: mergedArrays.cannotReveal,
    cannotDo: mergedArrays.cannotDo,
  };
}

/** create_character 的真实角色名（after.name / source.name / extractedEntityName），都没给则 undefined（不兜「待确认角色」）。 */
function resolveCreateCharacterName(suggestion: FoundationWriteSuggestionLike): string | undefined {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const bibleSource = isRecord(source.bibleEntry) ? source.bibleEntry : source;
  return readString(bibleSource.name) ?? readString(source.name) ?? readString(suggestion.extractedEntityName);
}

function normalizeCharacterPatch(suggestion: FoundationWriteSuggestionLike): {
  readonly bibleEntry: CharacterBibleEntry;
  readonly profile: CharacterProfile;
  readonly core: CharacterCore;
  readonly state: CharacterState;
} {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const bibleSource = isRecord(source.bibleEntry) ? source.bibleEntry : source;
  const name = resolveCreateCharacterName(suggestion) ?? "待确认角色";
  // 模型无关：模型给的 id 若是哨兵占位词（"none"/"null"…）→ 跳过、回落用 name 生成 id（有意义、不同角色不碰撞）。
  // 治真书里角色 id 字面量="none"：用 name 生成 char-<hash(name)> 而非两个不同角色都撞 "none"。
  const idCandidate = readString(bibleSource.id) ?? readString(source.id) ?? suggestion.targetId;
  const rawId = idCandidate && !isSentinelEntityId(idCandidate) ? idCandidate : name;
  const id = toSafeCharacterId(rawId);
  const role = toRoleLabel(readString(bibleSource.role) ?? readString(source.role) ?? readString(source.identity) ?? "重要角色");
  const speechStyle = readString(bibleSource.speechStyle) ?? readString(source.speechStyle);
  const voice = readCharacterVoiceProfile(bibleSource.voice, source.voice);
  const arc = readCharacterArcProfile(bibleSource.arc, source.arc);
  const bibleEntry: CharacterBibleEntry = {
    id,
    name,
    role,
    ...(readString(bibleSource.age) ?? readString(source.age) ? { age: readString(bibleSource.age) ?? readString(source.age) } : {}),
    ...(readString(bibleSource.gender) ?? readString(source.gender) ? { gender: readString(bibleSource.gender) ?? readString(source.gender) } : {}),
    ...(readString(bibleSource.identity) ?? readString(source.identity) ? { identity: readString(bibleSource.identity) ?? readString(source.identity) } : {}),
    ...(readStringList(bibleSource.appearanceAnchors).length || readStringList(source.appearanceAnchors).length ? { appearanceAnchors: mergeStringArrays(readStringList(bibleSource.appearanceAnchors), readStringList(source.appearanceAnchors)) } : {}),
    ...(readString(bibleSource.desire) ?? readString(source.desire) ? { desire: readString(bibleSource.desire) ?? readString(source.desire) } : {}),
    ...(readString(bibleSource.fear) ?? readString(source.fear) ? { fear: readString(bibleSource.fear) ?? readString(source.fear) } : {}),
    ...(readString(bibleSource.weakness) ?? readString(source.weakness) ? { weakness: readString(bibleSource.weakness) ?? readString(source.weakness) } : {}),
    ...(readString(bibleSource.contradiction) ?? readString(source.contradiction) ? { contradiction: readString(bibleSource.contradiction) ?? readString(source.contradiction) } : {}),
    ...(readString(bibleSource.moralBoundary) ?? readString(source.moralBoundary) ? { moralBoundary: readString(bibleSource.moralBoundary) ?? readString(source.moralBoundary) } : {}),
    ...(readString(bibleSource.privateMotive) ?? readString(source.privateMotive) ? { privateMotive: readString(bibleSource.privateMotive) ?? readString(source.privateMotive) } : {}),
    ...(readString(bibleSource.relationshipToProtagonist) ?? readString(source.relationshipToProtagonist) ? { relationshipToProtagonist: readString(bibleSource.relationshipToProtagonist) ?? readString(source.relationshipToProtagonist) } : {}),
    ...(readStringList(bibleSource.relationshipDynamics).length || readStringList(source.relationshipDynamics).length ? { relationshipDynamics: mergeStringArrays(readStringList(bibleSource.relationshipDynamics), readStringList(source.relationshipDynamics)) } : {}),
    ...(readString(bibleSource.trustLevel) ?? readString(source.trustLevel) ? { trustLevel: readString(bibleSource.trustLevel) ?? readString(source.trustLevel) } : {}),
    ...(readString(bibleSource.hiddenStance) ?? readString(source.hiddenStance) ? { hiddenStance: readString(bibleSource.hiddenStance) ?? readString(source.hiddenStance) } : {}),
    ...(voice ? { voice } : {}),
    ...(speechStyle ? { speechStyle } : {}),
    speechSamples: readStringList(bibleSource.speechSamples).length ? readStringList(bibleSource.speechSamples) : readStringList(source.speechSamples),
    personalityBaseline: readStringList(bibleSource.personalityBaseline).length ? readStringList(bibleSource.personalityBaseline) : readStringList(source.personalityBaseline),
    behaviorBoundaries: readStringList(bibleSource.behaviorBoundaries).length ? readStringList(bibleSource.behaviorBoundaries) : readStringList(source.behaviorBoundaries),
    knowledgeKnown: readStringList(bibleSource.knowledgeKnown).length ? readStringList(bibleSource.knowledgeKnown) : readStringList(source.knowledgeKnown),
    knowledgeUnknown: readStringList(bibleSource.knowledgeUnknown).length ? readStringList(bibleSource.knowledgeUnknown) : readStringList(source.knowledgeUnknown),
    cannotReveal: readStringList(bibleSource.cannotReveal).length ? readStringList(bibleSource.cannotReveal) : readStringList(source.cannotReveal),
    cannotDo: readStringList(bibleSource.cannotDo).length ? readStringList(bibleSource.cannotDo) : readStringList(source.cannotDo),
    ...(readString(bibleSource.arcPromise) ?? readString(source.arcPromise) ? { arcPromise: readString(bibleSource.arcPromise) ?? readString(source.arcPromise) } : {}),
    ...(arc ? { arc } : {}),
    ...(readString(bibleSource.currentStateHint) ?? readString(source.currentStateHint) ? { currentStateHint: readString(bibleSource.currentStateHint) ?? readString(source.currentStateHint) } : {}),
  };
  const profileSource = isRecord(source.profile) ? source.profile : source;
  const coreSource = isRecord(source.core) ? source.core : source;
  const stateSource = isRecord(source.state) ? source.state : source;
  const profile: CharacterProfile = {
    id,
    name,
    identity: readString(profileSource.identity) ?? bibleEntry.identity ?? role,
    ...(readString(profileSource.age) ?? bibleEntry.age ? { age: readString(profileSource.age) ?? bibleEntry.age } : {}),
    ...(readString(profileSource.gender) ?? bibleEntry.gender ? { gender: readString(profileSource.gender) ?? bibleEntry.gender } : {}),
    ...(isRecord(profileSource.appearance) ? { appearance: profileSource.appearance } : {}),
    appearanceAnchors: mergeStringArrays(readStringList(profileSource.appearanceAnchors), bibleEntry.appearanceAnchors ?? []),
    tags: readStringList(profileSource.tags),
  };
  const core: CharacterCore = {
    characterId: readString(coreSource.characterId) ?? id,
    personality: readStringList(coreSource.personality).length ? readStringList(coreSource.personality) : readStringList(bibleSource.personalityBaseline),
    ...(readString(coreSource.speechStyle) ?? speechStyle ? { speechStyle: readString(coreSource.speechStyle) ?? speechStyle } : {}),
    taboos: readStringList(coreSource.taboos),
    ...(readString(coreSource.worldview) ? { worldview: readString(coreSource.worldview) } : {}),
    ...(readString(coreSource.desire) ?? bibleEntry.desire ? { desire: readString(coreSource.desire) ?? bibleEntry.desire } : {}),
    ...(readString(coreSource.fear) ?? bibleEntry.fear ? { fear: readString(coreSource.fear) ?? bibleEntry.fear } : {}),
    ...(readString(coreSource.contradiction) ?? bibleEntry.contradiction ? { contradiction: readString(coreSource.contradiction) ?? bibleEntry.contradiction } : {}),
    ...(readString(coreSource.moralBoundary) ?? bibleEntry.moralBoundary ? { moralBoundary: readString(coreSource.moralBoundary) ?? bibleEntry.moralBoundary } : {}),
    ...(readCharacterVoiceProfile(coreSource.voice, bibleEntry.voice) ? { voice: readCharacterVoiceProfile(coreSource.voice, bibleEntry.voice) } : {}),
    behaviorHabits: readStringList(coreSource.behaviorHabits),
    ...(readCharacterArcProfile(coreSource.arc, bibleEntry.arc) ? { arc: readCharacterArcProfile(coreSource.arc, bibleEntry.arc) } : {}),
  };
  const extra = readExtraFields(stateSource) ?? readExtraFields(source);
  const state: CharacterState = {
    characterId: readString(stateSource.characterId) ?? id,
    emotion: readString(stateSource.emotion) ?? "待确认",
    goal: readString(stateSource.goal) ?? readString(source.currentGoal) ?? bibleEntry.desire ?? "待确认",
    ...(readString(stateSource.relationshipToUser) ?? bibleEntry.relationshipToProtagonist ? { relationshipToUser: readString(stateSource.relationshipToUser) ?? bibleEntry.relationshipToProtagonist } : {}),
    ...(readString(stateSource.currentArc) ? { currentArc: readString(stateSource.currentArc) } : {}),
    ...(readString(stateSource.currentPhysicalState) ? { currentPhysicalState: readString(stateSource.currentPhysicalState) } : {}),
    ...(readString(stateSource.currentMentalState) ? { currentMentalState: readString(stateSource.currentMentalState) } : {}),
    ...(readString(stateSource.currentResourceState) ? { currentResourceState: readString(stateSource.currentResourceState) } : {}),
    ...(readString(stateSource.currentLocationId) ?? readString(source.currentLocationId) ? { currentLocationId: readString(stateSource.currentLocationId) ?? readString(source.currentLocationId) } : {}),
    ...(readString(stateSource.currentLocationName) ?? readString(source.currentLocationName) ?? readString(source.currentLocation) ? { currentLocationName: readString(stateSource.currentLocationName) ?? readString(source.currentLocationName) ?? readString(source.currentLocation) } : {}),
    knowledgeKnown: readStringList(stateSource.knowledgeKnown).length ? readStringList(stateSource.knowledgeKnown) : bibleEntry.knowledgeKnown ?? [],
    knowledgeUnknown: readStringList(stateSource.knowledgeUnknown).length ? readStringList(stateSource.knowledgeUnknown) : bibleEntry.knowledgeUnknown ?? [],
    cannotReveal: readStringList(stateSource.cannotReveal).length ? readStringList(stateSource.cannotReveal) : bibleEntry.cannotReveal ?? [],
    lastSeenChapter: typeof stateSource.lastSeenChapter === "number" ? stateSource.lastSeenChapter : null,
    lastUpdatedChapter: typeof stateSource.lastUpdatedChapter === "number" ? stateSource.lastUpdatedChapter : null,
    ...(extra ? { extraFields: extra } : {}),
  };
  return { bibleEntry, profile, core, state };
}

function mergeCharacterBibleEntry(existing: CharacterBibleEntry, patch: CharacterBibleEntry): CharacterBibleEntry {
  const voice = mergeCharacterVoiceProfile(existing.voice, patch.voice);
  const arc = mergeCharacterArcProfile(existing.arc, patch.arc);
  return {
    ...existing,
    id: existing.id || patch.id,
    name: preferStrongString(existing.name, patch.name) ?? patch.name,
    role: preferStrongString(existing.role, patch.role) ?? patch.role,
    ...(preferStrongString(existing.age, patch.age) ? { age: preferStrongString(existing.age, patch.age) } : {}),
    ...(preferStrongString(existing.gender, patch.gender) ? { gender: preferStrongString(existing.gender, patch.gender) } : {}),
    ...(preferStrongString(existing.identity, patch.identity) ? { identity: preferStrongString(existing.identity, patch.identity) } : {}),
    appearanceAnchors: mergeStringArrays(existing.appearanceAnchors ?? [], patch.appearanceAnchors ?? []),
    ...(preferStrongString(existing.longTermDesire, patch.longTermDesire) ? { longTermDesire: preferStrongString(existing.longTermDesire, patch.longTermDesire) } : {}),
    ...(preferStrongString(existing.desire, patch.desire) ? { desire: preferStrongString(existing.desire, patch.desire) } : {}),
    ...(preferStrongString(existing.fear, patch.fear) ? { fear: preferStrongString(existing.fear, patch.fear) } : {}),
    ...(preferStrongString(existing.weakness, patch.weakness) ? { weakness: preferStrongString(existing.weakness, patch.weakness) } : {}),
    ...(preferStrongString(existing.contradiction, patch.contradiction) ? { contradiction: preferStrongString(existing.contradiction, patch.contradiction) } : {}),
    ...(preferStrongString(existing.moralBoundary, patch.moralBoundary) ? { moralBoundary: preferStrongString(existing.moralBoundary, patch.moralBoundary) } : {}),
    ...(preferStrongString(existing.privateMotive, patch.privateMotive) ? { privateMotive: preferStrongString(existing.privateMotive, patch.privateMotive) } : {}),
    ...(preferStrongString(existing.relationshipToProtagonist, patch.relationshipToProtagonist) ? { relationshipToProtagonist: preferStrongString(existing.relationshipToProtagonist, patch.relationshipToProtagonist) } : {}),
    relationshipDynamics: mergeStringArrays(existing.relationshipDynamics ?? [], patch.relationshipDynamics ?? []),
    ...(preferStrongString(existing.trustLevel, patch.trustLevel) ? { trustLevel: preferStrongString(existing.trustLevel, patch.trustLevel) } : {}),
    ...(preferStrongString(existing.hiddenStance, patch.hiddenStance) ? { hiddenStance: preferStrongString(existing.hiddenStance, patch.hiddenStance) } : {}),
    ...(voice ? { voice } : {}),
    speechRules: mergeStringArrays(existing.speechRules ?? [], patch.speechRules ?? []),
    ...(preferStrongString(existing.speechStyle, patch.speechStyle) ? { speechStyle: preferStrongString(existing.speechStyle, patch.speechStyle) } : {}),
    speechSamples: mergeStringArrays(existing.speechSamples ?? [], patch.speechSamples ?? []),
    personalityBaseline: mergeStringArrays(existing.personalityBaseline ?? [], patch.personalityBaseline ?? []),
    ...(preferStrongString(existing.socialEnergy, patch.socialEnergy) ? { socialEnergy: preferStrongString(existing.socialEnergy, patch.socialEnergy) } : {}),
    behaviorBoundaries: mergeStringArrays(existing.behaviorBoundaries ?? [], patch.behaviorBoundaries ?? []),
    knowledgeKnown: mergeStringArrays(existing.knowledgeKnown ?? [], patch.knowledgeKnown ?? []),
    knowledgeUnknown: mergeStringArrays(existing.knowledgeUnknown ?? [], patch.knowledgeUnknown ?? []),
    cannotReveal: mergeStringArrays(existing.cannotReveal ?? [], patch.cannotReveal ?? []),
    cannotDo: mergeStringArrays(existing.cannotDo ?? [], patch.cannotDo ?? []),
    canAiModify: existing.canAiModify ?? patch.canAiModify,
    ...(preferStrongString(existing.arcPromise, patch.arcPromise) ? { arcPromise: preferStrongString(existing.arcPromise, patch.arcPromise) } : {}),
    ...(arc ? { arc } : {}),
    ...(preferStrongString(existing.currentStateHint, patch.currentStateHint) ? { currentStateHint: preferStrongString(existing.currentStateHint, patch.currentStateHint) } : {}),
  };
}

async function writeMergedCharacterFile(path: string, patch: unknown): Promise<void> {
  if (!isRecord(patch)) return;
  const existing = await readJson<Record<string, unknown>>(path, {});
  await writeJson(path, mergeRecordsPreferExisting(existing, patch));
}

/** 返回该文件内容是否真变（用于 writes[] 诚实明细：没变的文件不报）。照常写盘——幂等无变不产生 git diff。 */
async function writePatchedCharacterFile(path: string, patch: unknown): Promise<boolean> {
  if (!isRecord(patch)) return false;
  const existing = await readJson<Record<string, unknown>>(path, {});
  const merged = mergeRecordsPreferPatch(existing, patch);
  await writeJson(path, merged);
  return JSON.stringify(merged) !== JSON.stringify(existing);
}

function mergeRecordsPreferExisting(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = mergeValuePreferExisting(next[key], value);
  }
  return next;
}

function mergeRecordsPreferPatch(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = mergeValuePreferPatch(next[key], value);
  }
  return next;
}

function mergeValuePreferExisting(existing: unknown, patch: unknown): unknown {
  if (Array.isArray(existing) || Array.isArray(patch)) return mergeUnknownArrays(existing, patch);
  if (isRecord(existing) && isRecord(patch)) return mergeRecordsPreferExisting(existing, patch);
  if (hasStrongConcreteValue(existing)) return existing;
  return patch;
}

function mergeValuePreferPatch(existing: unknown, patch: unknown): unknown {
  if (Array.isArray(existing) || Array.isArray(patch)) return mergeUnknownArrays(existing, patch);
  if (isRecord(existing) && isRecord(patch)) return mergeRecordsPreferPatch(existing, patch);
  return patch ?? existing;
}

/** create_location 的真实地点名（after.name / after.locationName / extractedEntityName），都没给则 undefined（不落占位地点）。 */
function resolveCreateLocationName(suggestion: FoundationWriteSuggestionLike): string | undefined {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  return readString(source.name) ?? readString(source.locationName) ?? readString(suggestion.extractedEntityName);
}

async function applyCreateLocation(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  if (!resolveCreateLocationName(suggestion)) {
    return {
      writes: [],
      skip: {
        reason: "missing_name",
        action: "create_location",
        summary: "没给新地点名字，没建地点卡——请说清要建的地点叫什么（如「建个叫旧城档案馆的地点」），避免建出「待确认地点」占位卡。",
      },
    };
  }
  return { writes: await applyLocationSuggestion(projectDir, suggestion) };
}

async function applyLocationSuggestion(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const location = normalizeLocationPatch(suggestion);
  const locationPath = join(projectDir, "story", "location-bible.json");
  const bible = await readJson<LocationBible>(locationPath, { version: "v0", locations: [] });
  const index = bible.locations.findIndex((item) => item.id === location.id || item.name === location.name);
  const existingExtra = index < 0 ? undefined : (bible.locations[index] as LocationBibleEntry).extraFields;
  const merged = mergeExtraFields(existingExtra, location.extraFields);
  const newKeys = newExtraFieldKeys(existingExtra, location.extraFields);
  if (index < 0) {
    await writeJson(locationPath, { ...bible, locations: [...bible.locations, location] });
  } else {
    const nextLocations = [...bible.locations];
    nextLocations[index] = mergeLocationDetail(nextLocations[index] as LocationBibleEntry, location);
    await writeJson(locationPath, { ...bible, locations: nextLocations });
  }
  return [withExtraFieldsReport(
    {
      domain: "location",
      action: "create_or_update_location",
      targetFile: "story/location-bible.json",
      targetId: location.id,
      targetName: location.name,
      summary: extraFieldsSummary(`已写入地点 ${location.name}`, location.name, newKeys),
    },
    merged,
    newKeys,
  )];
}

function normalizeLocationPatch(suggestion: FoundationWriteSuggestionLike): LocationBibleEntry {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const createName = suggestion.actionType === "create_location" ? resolveCreateLocationName(suggestion) : undefined;
  const name = createName ?? readString(source.name) ?? readString(source.locationName) ?? suggestion.targetId ?? "待确认地点";
  const explicitId = readString(source.id);
  const id = explicitId
    ?? (suggestion.actionType === "create_location" && createName
      ? stableId(name, "loc")
      : suggestion.targetId ?? stableId(name, "loc"));
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
    ...(readExtraFields(source) ? { extraFields: readExtraFields(source) } : {}),
  };
}

function mergeLocationDetail(existing: LocationBibleEntry, patch: LocationBibleEntry): LocationBibleEntry {
  return {
    ...existing,
    ...(mergeExtraFields(existing.extraFields, patch.extraFields) ? { extraFields: mergeExtraFields(existing.extraFields, patch.extraFields) } : {}),
    type: text(existing.type) ? existing.type : patch.type,
    parentLocation: text(existing.parentLocation) ? existing.parentLocation : patch.parentLocation,
    locationType: text(existing.locationType) ? existing.locationType : patch.locationType,
    currentKnownPosition: text(existing.currentKnownPosition) ? existing.currentKnownPosition : patch.currentKnownPosition,
    spatialStructure: {
      floors: unique([...(existing.spatialStructure?.floors ?? []), ...(patch.spatialStructure?.floors ?? [])]),
      rooms: unique([...(existing.spatialStructure?.rooms ?? []), ...(patch.spatialStructure?.rooms ?? [])]),
      entrances: unique([...(existing.spatialStructure?.entrances ?? []), ...(patch.spatialStructure?.entrances ?? [])]),
      exits: unique([...(existing.spatialStructure?.exits ?? []), ...(patch.spatialStructure?.exits ?? [])]),
    },
    sensoryDetails: mergeLocationSensoryDetails(existing.sensoryDetails, patch.sensoryDetails),
    connectedLocations: unique([...(existing.connectedLocations ?? []), ...(patch.connectedLocations ?? [])]),
    knownFeatures: unique([...(existing.knownFeatures ?? []), ...(patch.knownFeatures ?? [])]),
    risks: unique([...(existing.risks ?? []), ...(patch.risks ?? [])]),
    resources: unique([...(existing.resources ?? []), ...(patch.resources ?? [])]),
    narrativeFunction: text(existing.narrativeFunction) ? existing.narrativeFunction : patch.narrativeFunction,
    possibleConflicts: unique([...(existing.possibleConflicts ?? []), ...(patch.possibleConflicts ?? [])]),
    currentStatus: text(existing.currentStatus) ? existing.currentStatus : patch.currentStatus,
    hiddenFacts: unique([...(existing.hiddenFacts ?? []), ...(patch.hiddenFacts ?? [])]),
    travelRules: mergeTravelRules(existing.travelRules ?? [], patch.travelRules ?? []),
    secrets: unique([...(existing.secrets ?? []), ...(patch.secrets ?? [])]),
    fixedFacts: unique([...(existing.fixedFacts ?? []), ...(patch.fixedFacts ?? [])]),
    lastSeenChapter: existing.lastSeenChapter ?? patch.lastSeenChapter,
    lastKnownState: text(existing.lastKnownState) ? existing.lastKnownState : patch.lastKnownState,
  };
}

/** create_asset 的真实资产名（extractedEntityName / after.name / 从消息抽取），都没给则 undefined（不落空资产）。 */
function resolveCreateAssetName(suggestion: FoundationWriteSuggestionLike): string | undefined {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const name = (suggestion.extractedEntityName ?? readString(source.name) ?? extractAssetNameFromMessage(suggestion.sourceUserMessage))?.trim();
  return name ? name : undefined;
}

async function applyCreateAsset(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  // 模型无关·诚实失败：create 真缺 name（after.name / extractedEntityName / 从消息抽取 都没给）→ 显式跳过，
  // 不落一个无 name/id 的空资产对象还报成功（违铁律④；Kimi/Qwen 真机都落了 {rules:[]...} 空对象）。
  if (!resolveCreateAssetName(suggestion)) {
    return {
      writes: [],
      skip: {
        reason: "missing_name",
        action: "create_asset",
        summary: "没给资产名字，没建——请说清要建的资产叫什么（如「建个叫事故原始图纸的资产」），避免落一个空资产。",
      },
    };
  }
  const incomingExtra = readExtraFields(suggestion.after);
  const { extraFields: _rawExtra, ...base } = normalizeAssetPatch(suggestion.after, suggestion);
  const asset: AssetItem = incomingExtra ? { ...base, extraFields: incomingExtra } : base;
  const assetPath = join(projectDir, "story", "assets.json");
  const ledger = await readJson<AssetLedger>(assetPath, { version: "v0", assets: [], containers: [] });
  // 去重守卫用 `Boolean(asset.id) &&`：对存量 id=undefined 的老书资产免疫，绝不让 `undefined === undefined`
  // 把不同名资产误判「已存在」（afterfix 真机 BUG）。重名→合并（对齐 create_character 的 findIndex+merge），
  // 且【总是真写盘】——写入记录据真实写盘生成，写盘与「已写入」汇报不再解耦、杜绝静默 no-op 谎报（铁律④）。
  const index = ledger.assets.findIndex((item) => (Boolean(asset.id) && item.id === asset.id) || item.name === asset.name);
  const existingExtra = index < 0 ? undefined : (ledger.assets[index] as AssetItem).extraFields;
  const assets = [...ledger.assets];
  if (index < 0) {
    assets.push(asset);
  } else {
    assets[index] = mergeAssetItem(assets[index] as AssetItem, asset);
  }
  await writeJson(assetPath, { ...ledger, assets });
  const newKeys = newExtraFieldKeys(existingExtra, incomingExtra);
  return { writes: [withExtraFieldsReport(
    {
      domain: "asset",
      action: "create_asset",
      targetFile: "story/assets.json",
      targetId: asset.id,
      targetName: asset.name,
      summary: extraFieldsSummary(`已写入资产 ${asset.name}`, asset.name, newKeys),
    },
    incomingExtra,
    newKeys,
  )] };
}

async function applyAssetSuggestion(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<readonly FoundationWriteRecord[]> {
  const assetPath = join(projectDir, "story", "assets.json");
  const ledger = await readJson<AssetLedger>(assetPath, { version: "v0", assets: [], containers: [] });
  const patch = normalizeAssetUpdatePatch(suggestion, ledger.assets);
  const index = ledger.assets.findIndex((item) => item.id === patch.id || item.name === patch.name);
  const existingExtra = index < 0 ? undefined : (ledger.assets[index] as AssetItem).extraFields;
  const merged = mergeExtraFields(existingExtra, patch.extraFields);
  const newKeys = newExtraFieldKeys(existingExtra, patch.extraFields);
  const assets = [...ledger.assets];
  if (index < 0) {
    assets.push(patch);
  } else {
    assets[index] = mergeAssetItem(assets[index] as AssetItem, patch);
  }
  await writeJson(assetPath, { ...ledger, assets });
  return [withExtraFieldsReport(
    {
      domain: "asset",
      action: "create_or_update_asset",
      targetFile: "story/assets.json",
      targetId: patch.id,
      targetName: patch.name,
      summary: extraFieldsSummary(`已写入资产 ${patch.name}`, patch.name, newKeys),
    },
    merged,
    newKeys,
  )];
}

async function applyWorldRuleSuggestion(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  const worldPath = join(projectDir, "story", "world-bible.json");
  const bible = await readJson<WorldBible>(worldPath, { version: "v0", rules: [], factions: [], powerOrSurvivalSystems: [], historyFacts: [], socialOrder: [] });
  if (!isRecord(suggestion.after)) {
    const record = { ...bible } as Record<string, unknown>;
    writePath(record, targetPathForSuggestion(suggestion), suggestion.after, suggestion.targetId);
    await writeJson(worldPath, record);
  } else {
    const source = suggestion.after;
    const coreRules = mergeStringArrays(readStringList(source.coreRules), readStringList(source.rules), readStringList(source.worldRules));
    const resourceRules = mergeStringArrays(readStringList(source.resourceRules), readStringList(source.powerOrSurvivalSystems));
    // no_recognized_fields 守卫（铁律④·绝不谎报）：source 里没有任何引擎认得的世界观字段、也没有 extraFields →
    // normalize 把内容丢光、实际啥也没写，旧逻辑仍回 write 记录谎称已写入。改为显式跳过、不写。
    const worldHasRecognizedContent =
      Boolean(readString(source.worldPremise))
      || coreRules.length > 0
      || resourceRules.length > 0
      || [
        readStringList(source.historyFacts),
        readStringList(source.socialOrder),
        readStringList(source.socialRules),
        readStringList(source.authorityRules),
        readStringList(source.conflictSources),
        readStringList(source.fixedFacts),
        readStringList(source.protectedSecrets),
        readStringList(source.publicFacts),
        readStringList(source.hiddenFacts),
        readStringList(source.forbiddenRuleBreaks),
      ].some((values) => values.length > 0)
      || readWorldFactions(source.factions).length > 0;
    if (!worldHasRecognizedContent && !readExtraFields(source)) {
      return {
        writes: [],
        skip: {
          reason: "no_recognized_fields",
          action: "update_world_rule",
          summary: "这条没写入：after 里没有引擎认得的世界观字段（如 rules / factions / socialOrder / fixedFacts 等，自由内容可放进 extraFields）。",
        },
      };
    }
    const next: WorldBible = {
      ...bible,
      ...(readString(source.worldPremise) ? { worldPremise: readString(source.worldPremise) } : {}),
      rules: mergeStringArrays(bible.rules ?? [], coreRules),
      factions: mergeWorldFactions(bible.factions ?? [], readWorldFactions(source.factions)),
      powerOrSurvivalSystems: mergeStringArrays(bible.powerOrSurvivalSystems ?? [], resourceRules),
      historyFacts: mergeStringArrays(bible.historyFacts ?? [], readStringList(source.historyFacts)),
      socialOrder: mergeStringArrays(bible.socialOrder ?? [], readStringList(source.socialOrder), readStringList(source.socialRules)),
      resourceRules: mergeStringArrays(bible.resourceRules ?? [], resourceRules),
      authorityRules: mergeStringArrays(bible.authorityRules ?? [], readStringList(source.authorityRules)),
      conflictSources: mergeStringArrays(bible.conflictSources ?? [], readStringList(source.conflictSources)),
      fixedFacts: mergeStringArrays(bible.fixedFacts ?? [], readStringList(source.fixedFacts)),
      protectedSecrets: mergeStringArrays(bible.protectedSecrets ?? [], readStringList(source.protectedSecrets)),
      publicFacts: mergeStringArrays(bible.publicFacts ?? [], readStringList(source.publicFacts)),
      hiddenFacts: mergeStringArrays(bible.hiddenFacts ?? [], readStringList(source.hiddenFacts)),
      forbiddenRuleBreaks: mergeStringArrays(bible.forbiddenRuleBreaks ?? [], readStringList(source.forbiddenRuleBreaks)),
    };
    await writeJson(worldPath, next);
  }
  const records: FoundationWriteRecord[] = [{
    domain: "world",
    action: "update_world_rule",
    targetFile: "story/world-bible.json",
    summary: "已写入世界观资料",
  }];
  // extraFields 落到 world/state.json（WorldState.extraFields），这是写作 prompt 读取的世界观自定义字段位置。
  const incomingExtra = readExtraFields(suggestion.after);
  if (incomingExtra) {
    const statePath = join(projectDir, "world", "state.json");
    const existingState = await readJson<Record<string, unknown>>(statePath, {
      currentPhase: "",
      activeConflicts: [],
      activeHooks: [],
      knownSecrets: [],
    });
    const existingExtra = readExtraFields(existingState);
    const merged = mergeExtraFields(existingExtra, incomingExtra);
    const newKeys = newExtraFieldKeys(existingExtra, incomingExtra);
    await writeJson(statePath, merged ? { ...existingState, extraFields: merged } : existingState);
    records.push(withExtraFieldsReport(
      {
        domain: "world",
        action: "update_world_extra_fields",
        targetFile: "world/state.json",
        summary: extraFieldsSummary("已写入世界观自定义字段", undefined, newKeys),
      },
      merged,
      newKeys,
    ));
  }
  return { writes: records };
}

/** 写作规则里可被 removeFromArrays/replaceArrays 纠错的数组字段（含 WRITING_RULES_TEXT_ARRAY_KEYS 漏的 antiAiPatterns）。 */
const WRITING_RULES_CORRECTABLE_FIELDS = [
  ...WRITING_RULES_TEXT_ARRAY_KEYS,
  "antiAiPatterns",
] as const;

const WRITING_RULE_WRITE_RECORD: FoundationWriteRecord = {
  domain: "writingRules",
  action: "update_writing_rule",
  targetFile: "story/writing-rules.json",
  summary: "已写入写作规则",
};

async function applyWritingRuleSuggestion(projectDir: string, suggestion: FoundationWriteSuggestionLike): Promise<FoundationWriteOutcome> {
  const rulesPath = join(projectDir, "story", "writing-rules.json");
  const rules = await readJson<WritingRules>(rulesPath, {
    version: "v0",
    proseStyle: [],
    genreRequirements: [],
    suspenseRules: [],
    payoffRules: [],
    reversalRules: [],
    readerExperienceRules: [],
    forbiddenContent: [],
    doNotDo: [],
  });
  const scalarTargetWords = !isRecord(suggestion.after)
    ? extractTargetChapterWordsFromTexts([readString(suggestion.after), suggestion.sourceUserMessage])
    : undefined;
  if (!isRecord(suggestion.after) && scalarTargetWords === undefined) {
    const record = { ...rules } as Record<string, unknown>;
    writePath(record, targetPathForSuggestion(suggestion), suggestion.after, suggestion.targetId);
    await writeJson(rulesPath, record);
    return { writes: [WRITING_RULE_WRITE_RECORD] };
  } else {
    const source = isRecord(suggestion.after) ? suggestion.after : { targetChapterWords: scalarTargetWords };
    const rawProseStyle = readStringList(source.proseStyle);
    const rawGenreRequirements = readStringList(source.genreRequirements);
    const rawSuspenseRules = readStringList(source.suspenseRules);
    const rawPayoffRules = readStringList(source.payoffRules);
    const rawReversalRules = readStringList(source.reversalRules);
    const rawReaderExperienceRules = readStringList(source.readerExperienceRules);
    const rawForbiddenContent = readStringList(source.forbiddenContent);
    const rawDoNotDo = readStringList(source.doNotDo);
    const rawAntiAiPatterns = readStringList(source.antiAiPatterns);
    // customNotes（自由 Markdown 标量）：是字符串就采纳（含空串=用户主动清空）；缺省=保留现有。受控破例⑧。
    const customNotesRaw = typeof source.customNotes === "string" ? source.customNotes : undefined;
    const targetWords = readNumber(source.targetChapterWords)
      ?? readNumber(isRecord(source.chapterLength) ? source.chapterLength.targetWords : undefined)
      ?? extractTargetChapterWordsFromTexts([
        ...rawProseStyle,
        ...rawGenreRequirements,
        ...rawSuspenseRules,
        ...rawPayoffRules,
        ...rawReversalRules,
        ...rawReaderExperienceRules,
        ...rawForbiddenContent,
        ...rawDoNotDo,
        ...rawAntiAiPatterns,
        suggestion.sourceUserMessage,
      ]);
    const removals = readRemovalMap(source.removeFromArrays);
    const replacements = readRemovalMap(source.replaceArrays);
    // honest miss（修#2·铁律④）：逐条核对 removeFromArrays 目标是否真命中现存写作规则；没命中如实回报、绝不静默成功。
    const unmatchedTargets: string[] = [];
    for (const [field, targets] of Object.entries(removals)) {
      const present = new Set(
        ((rules[field as keyof WritingRules] as readonly string[] | undefined) ?? []).map(normalizedText),
      );
      for (const target of targets) {
        if (!present.has(normalizedText(target))) unmatchedTargets.push(`「${target}」`);
      }
    }
    const hasAdditive =
      [rawProseStyle, rawGenreRequirements, rawSuspenseRules, rawPayoffRules, rawReversalRules, rawReaderExperienceRules, rawForbiddenContent, rawDoNotDo, rawAntiAiPatterns].some((a) => a.length > 0)
      || Boolean(readString(source.narrativePerspective)) || Boolean(readString(source.pacing)) || Boolean(readString(source.revealPolicy)) || targetWords !== undefined
      || customNotesRaw !== undefined;
    const next: WritingRules = {
      ...rules,
      ...(readString(source.narrativePerspective) ? { narrativePerspective: readString(source.narrativePerspective) } : {}),
      proseStyle: mergeStringArrayField(filterTargetChapterWordsRules(rules.proseStyle ?? []), filterTargetChapterWordsRules(rawProseStyle), removals.proseStyle, replacements.proseStyle),
      ...(readString(source.pacing) ? { pacing: readString(source.pacing) } : {}),
      ...(readString(source.revealPolicy) ? { revealPolicy: readString(source.revealPolicy) } : {}),
      ...(targetWords !== undefined ? { chapterLength: { ...(rules.chapterLength ?? {}), targetWords } } : {}),
      genreRequirements: mergeStringArrayField(filterTargetChapterWordsRules(rules.genreRequirements ?? []), filterTargetChapterWordsRules(rawGenreRequirements), removals.genreRequirements, replacements.genreRequirements),
      suspenseRules: mergeStringArrayField(filterTargetChapterWordsRules(rules.suspenseRules ?? []), filterTargetChapterWordsRules(rawSuspenseRules), removals.suspenseRules, replacements.suspenseRules),
      payoffRules: mergeStringArrayField(filterTargetChapterWordsRules(rules.payoffRules ?? []), filterTargetChapterWordsRules(rawPayoffRules), removals.payoffRules, replacements.payoffRules),
      reversalRules: mergeStringArrayField(filterTargetChapterWordsRules(rules.reversalRules ?? []), filterTargetChapterWordsRules(rawReversalRules), removals.reversalRules, replacements.reversalRules),
      readerExperienceRules: mergeStringArrayField(filterTargetChapterWordsRules(rules.readerExperienceRules ?? []), filterTargetChapterWordsRules(rawReaderExperienceRules), removals.readerExperienceRules, replacements.readerExperienceRules),
      forbiddenContent: mergeStringArrayField(filterTargetChapterWordsRules(rules.forbiddenContent ?? []), filterTargetChapterWordsRules(rawForbiddenContent), removals.forbiddenContent, replacements.forbiddenContent),
      doNotDo: mergeStringArrayField(filterTargetChapterWordsRules(rules.doNotDo ?? []), filterTargetChapterWordsRules(rawDoNotDo), removals.doNotDo, replacements.doNotDo),
      antiAiPatterns: mergeStringArrayField(filterTargetChapterWordsRules(rules.antiAiPatterns ?? []), filterTargetChapterWordsRules(rawAntiAiPatterns), removals.antiAiPatterns, replacements.antiAiPatterns),
      ...(customNotesRaw !== undefined ? { customNotes: customNotesRaw } : {}),
    };
    const arrayChanged = WRITING_RULES_CORRECTABLE_FIELDS.some(
      (f) => JSON.stringify((next[f as keyof WritingRules] as unknown) ?? []) !== JSON.stringify((rules[f as keyof WritingRules] as unknown) ?? []),
    );
    // 纯纠错（无追加）、确有要删的目标且全没命中、也没任何数组变化 → 整条没找到，ok:false 如实回报、不写（修#2）。
    if (!hasAdditive && unmatchedTargets.length > 0 && !arrayChanged) {
      return {
        writes: [],
        skip: {
          reason: "correction_target_not_found",
          action: "update_writing_rule",
          summary: `要删/改的写作规则在资料里没找到（${unmatchedTargets.join("、")}）——删除/替换的原文需与现有条目逐字一致，可先读一下现有写作规则再试。`,
        },
      };
    }
    // no_recognized_fields 守卫（铁律④·绝不谎报）：after 里没有任何引擎认得的写作规则字段、没有数组变化、
    // 也没有要删的目标 → normalize 把内容丢光、实际啥也没写，旧逻辑仍回 write 记录谎称已写入。改为显式跳过、不写。
    if (!hasAdditive && !arrayChanged && unmatchedTargets.length === 0) {
      return {
        writes: [],
        skip: {
          reason: "no_recognized_fields",
          action: "update_writing_rule",
          summary: "这条没写入：after 里没有引擎认得的写作规则字段（如 proseStyle / genreRequirements / forbiddenContent / doNotDo / customNotes 等，自由内容可放进 extraFields）。",
        },
      };
    }
    await writeJson(rulesPath, next);
    // 写成功，但有要删的目标没命中（部分 miss）→ 同时回报 skip 点名没删到的，避免静默成功（修#2·铁律④）。
    return {
      writes: [WRITING_RULE_WRITE_RECORD],
      ...(unmatchedTargets.length > 0
        ? {
            skip: {
              reason: "correction_target_not_found" as const,
              action: "update_writing_rule",
              summary: `要删的写作规则没找到、未删：${unmatchedTargets.join("、")}（原文需逐字一致）——其余已处理。`,
            },
          }
        : {}),
    };
  }
}

function normalizeAssetPatch(after: unknown, suggestion: FoundationWriteSuggestionLike): AssetItem {
  // after 可能为 null / 非 record（模型偶发）：兜成空对象，绝不裸解构/裸展开抛错。
  const source: Record<string, unknown> = isRecord(after) ? after : {};
  const sourceName = suggestion.extractedEntityName
    ?? readString(source.name)
    ?? extractAssetNameFromMessage(suggestion.sourceUserMessage);
  const assetName = sourceName ?? "待确认资产";
  return {
    ...(source as unknown as AssetItem),
    ...(sourceName ? { name: sourceName } : {}),
    // create 路径补 stableId（对齐 update 路径 normalizeAssetUpdatePatch:1843）：模型几乎不给 after.id，不补则
    // 资产落盘即 id=undefined → 下一件 create 因 `undefined === undefined` 误判「已存在」被静默吞掉、却仍报成功
    // （afterfix 真机 BUG：建「锈蚀闸门钥匙」后再建「事故原始图纸」名字不撞也写不进去）。
    id: readString(source.id) ?? stableId(assetName, "asset"),
    // create 路径补齐 list 字段规整（与 update 路径 normalizeAssetUpdatePatch 一致）：模型常把
    // rules/usageRules/lossRules/notes 给成单字符串或对象，不规整就原样落盘，紧接着 state-overview
    // 读回对字符串做 .map 直接炸 → 整批 apply 回滚成 500。readStringList 把单字符串也捕获成数组、不丢数据。
    rules: readStringList(source.rules),
    usageRules: readStringList(source.usageRules),
    lossRules: readStringList(source.lossRules),
    notes: readStringList(source.notes),
  };
}

function normalizeAssetUpdatePatch(suggestion: FoundationWriteSuggestionLike, existingAssets: readonly AssetItem[]): AssetItem {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const sourceName = readString(source.name) ?? suggestion.extractedEntityName;
  // 模型无关·治串字段（真机 rerun2：图纸继承了钥匙的 usageRules/lossRules）：targetId 匹配仅在 name 也一致
  // （或没给 name）时才认——否则模型把 targetId 误传成另一资产的 id、会把那个资产的字段并进本应新建的资产。
  const existing = existingAssets.find((item) =>
    (item.id === suggestion.targetId && (!sourceName || item.name === sourceName))
    || (sourceName ? item.name === sourceName : false),
  );
  const name = sourceName ?? existing?.name ?? suggestion.targetId ?? "待确认资产";
  // 去掉 `?? suggestion.targetId` 这层 id 兜底：existing 为空意味着 targetId 要么过期、要么指向了名字不一致的
  // 【另一资产】(串字段)——拿它当本资产 id 会复用别人的 id。1a 给 create 补 stableId 后这条潜伏 bug 会显形，故一并修：
  // existing 命中才用 existing.id，否则一律落 stableId(name)。
  const id = readString(source.id) ?? existing?.id ?? stableId(name, "asset");
  const carriedBy = readString(source.carriedByCharacterId) ?? readString(source.carriedBy);
  return {
    id,
    name,
    type: readString(source.type) ?? existing?.type ?? "item",
    ...(readString(source.ownerCharacterId) ?? existing?.ownerCharacterId ? { ownerCharacterId: readString(source.ownerCharacterId) ?? existing?.ownerCharacterId } : {}),
    ...(readString(source.ownerName) ?? existing?.ownerName ?? carriedBy ? { ownerName: readString(source.ownerName) ?? existing?.ownerName ?? carriedBy } : {}),
    ...(readString(source.currentLocationId) ?? existing?.currentLocationId ? { currentLocationId: readString(source.currentLocationId) ?? existing?.currentLocationId } : {}),
    ...(readString(source.currentLocationName) ?? readString(source.currentLocation) ?? existing?.currentLocationName ? { currentLocationName: readString(source.currentLocationName) ?? readString(source.currentLocation) ?? existing?.currentLocationName } : {}),
    ...(carriedBy ?? existing?.carriedByCharacterId ? { carriedByCharacterId: carriedBy ?? existing?.carriedByCharacterId } : {}),
    ...(readString(source.containerId) ?? existing?.containerId ? { containerId: readString(source.containerId) ?? existing?.containerId } : {}),
    ...(readNumber(source.quantity) ?? existing?.quantity ? { quantity: readNumber(source.quantity) ?? existing?.quantity } : {}),
    status: readString(source.status) ?? existing?.status ?? "unknown",
    ...(readString(source.conditionNote) ?? existing?.conditionNote ? { conditionNote: readString(source.conditionNote) ?? existing?.conditionNote } : {}),
    ...(typeof source.isConsumable === "boolean" ? { isConsumable: source.isConsumable } : existing?.isConsumable !== undefined ? { isConsumable: existing.isConsumable } : {}),
    ...(typeof source.isPlotCritical === "boolean" ? { isPlotCritical: source.isPlotCritical } : existing?.isPlotCritical !== undefined ? { isPlotCritical: existing.isPlotCritical } : {}),
    ...(typeof source.canAiModify === "boolean" ? { canAiModify: source.canAiModify } : existing?.canAiModify !== undefined ? { canAiModify: existing.canAiModify } : {}),
    ...(typeof source.firstSeenChapter === "number" ? { firstSeenChapter: source.firstSeenChapter } : existing?.firstSeenChapter !== undefined ? { firstSeenChapter: existing.firstSeenChapter } : {}),
    ...(typeof source.lastSeenChapter === "number" ? { lastSeenChapter: source.lastSeenChapter } : existing?.lastSeenChapter !== undefined ? { lastSeenChapter: existing.lastSeenChapter } : {}),
    rules: mergeStringArrays(existing?.rules ?? [], readStringList(source.rules)),
    usageRules: mergeStringArrays(existing?.usageRules ?? [], readStringList(source.usageRules)),
    lossRules: mergeStringArrays(existing?.lossRules ?? [], readStringList(source.lossRules)),
    ...(readString(source.blockedReason) ?? existing?.blockedReason ? { blockedReason: readString(source.blockedReason) ?? existing?.blockedReason } : {}),
    notes: mergeStringArrays(existing?.notes ?? [], readStringList(source.notes)),
    ...(readExtraFields(source) ? { extraFields: readExtraFields(source) } : {}),
  };
}

function mergeAssetItem(existing: AssetItem, patch: AssetItem): AssetItem {
  const mergedExtra = mergeExtraFields(existing.extraFields, patch.extraFields);
  return {
    ...existing,
    ...patch,
    ...(mergedExtra ? { extraFields: mergedExtra } : {}),
    canAiModify: existing.canAiModify === false && patch.canAiModify === true ? false : patch.canAiModify,
    rules: mergeStringArrays(existing.rules ?? [], patch.rules ?? []),
    usageRules: mergeStringArrays(existing.usageRules ?? [], patch.usageRules ?? []),
    lossRules: mergeStringArrays(existing.lossRules ?? [], patch.lossRules ?? []),
    notes: mergeStringArrays(existing.notes ?? [], patch.notes ?? []),
  };
}

function readWorldFactions(value: unknown): WorldBibleFaction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item): WorldBibleFaction | undefined => {
    const name = readString(item.name);
    if (!name) return undefined;
    return {
      id: readString(item.id) ?? stableId(name, "faction"),
      name,
      goal: readString(item.goal) ?? "待确认目标",
      resources: readStringList(item.resources),
    };
  }).filter((item): item is WorldBibleFaction => item !== undefined);
}

function mergeWorldFactions(existing: readonly WorldBibleFaction[], patch: readonly WorldBibleFaction[]): WorldBibleFaction[] {
  const result = [...existing];
  for (const faction of patch) {
    const index = result.findIndex((item) => item.id === faction.id || item.name === faction.name);
    if (index < 0) {
      result.push(faction);
      continue;
    }
    const current = result[index] as WorldBibleFaction;
    result[index] = {
      ...current,
      goal: preferStrongString(current.goal, faction.goal) ?? faction.goal,
      resources: mergeStringArrays(current.resources ?? [], faction.resources ?? []),
    };
  }
  return result;
}

function extractAssetNameFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const amount = message.match(/(\d+(?:\.\d+)?)\s*(?:元|块)(?:\s*现金)?/u)?.[0];
  if (amount) return `${amount.replace(/\s+/gu, "")}现金`;
  const backpack = message.match(/([\u4e00-\u9fffA-Za-z0-9]{0,8}双肩包)/u)?.[1];
  if (backpack) return backpack;
  const gun = message.match(/(?:那把|一把|这把)?([\u4e00-\u9fffA-Za-z0-9]{0,6}枪)/u)?.[1];
  if (gun) return message.includes("抢来") ? `抢来的${gun}` : gun;
  return undefined;
}

function readCharacterVoiceProfile(...values: readonly unknown[]): CharacterVoiceProfile | undefined {
  const records = values.filter(isRecord);
  if (records.length === 0) return undefined;
  const profile: CharacterVoiceProfile = {
    style: firstRecordString(records, "style"),
    rhythm: firstRecordString(records, "rhythm"),
    avoidanceTopics: mergeStringArrays(...records.map((record) => readStringList(record.avoidanceTopics))),
    sampleLines: mergeStringArrays(...records.map((record) => readStringList(record.sampleLines))),
  };
  return Object.values(profile).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)) ? profile : undefined;
}

function mergeCharacterVoiceProfile(existing: CharacterVoiceProfile | undefined, patch: CharacterVoiceProfile | undefined): CharacterVoiceProfile | undefined {
  const profile: CharacterVoiceProfile = {
    style: preferStrongString(existing?.style, patch?.style),
    rhythm: preferStrongString(existing?.rhythm, patch?.rhythm),
    avoidanceTopics: mergeStringArrays(existing?.avoidanceTopics ?? [], patch?.avoidanceTopics ?? []),
    sampleLines: mergeStringArrays(existing?.sampleLines ?? [], patch?.sampleLines ?? []),
  };
  return Object.values(profile).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)) ? profile : undefined;
}

function readCharacterArcProfile(...values: readonly unknown[]): CharacterArcProfile | undefined {
  const records = values.filter(isRecord);
  if (records.length === 0) return undefined;
  const profile: CharacterArcProfile = {
    startState: firstRecordString(records, "startState"),
    currentState: firstRecordString(records, "currentState"),
    projectedDirection: firstRecordString(records, "projectedDirection"),
  };
  return Object.values(profile).some(Boolean) ? profile : undefined;
}

function mergeCharacterArcProfile(existing: CharacterArcProfile | undefined, patch: CharacterArcProfile | undefined): CharacterArcProfile | undefined {
  const profile: CharacterArcProfile = {
    startState: preferStrongString(existing?.startState, patch?.startState),
    currentState: preferStrongString(existing?.currentState, patch?.currentState),
    projectedDirection: preferStrongString(existing?.projectedDirection, patch?.projectedDirection),
  };
  return Object.values(profile).some(Boolean) ? profile : undefined;
}

function firstRecordString(records: readonly Record<string, unknown>[], key: string): string | undefined {
  for (const record of records) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return undefined;
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

function mergeLocationSensoryDetails(
  existing: LocationSensoryDetails | undefined,
  patch: LocationSensoryDetails | undefined,
): LocationSensoryDetails | undefined {
  const details: LocationSensoryDetails = {
    visual: mergeStringArrays(existing?.visual ?? [], patch?.visual ?? []),
    sound: mergeStringArrays(existing?.sound ?? [], patch?.sound ?? []),
    smell: mergeStringArrays(existing?.smell ?? [], patch?.smell ?? []),
    touch: mergeStringArrays(existing?.touch ?? [], patch?.touch ?? []),
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

function mergeTravelRules(existing: readonly LocationTravelRule[], patch: readonly LocationTravelRule[]): readonly LocationTravelRule[] {
  const result = [...existing];
  for (const rule of patch) {
    if (result.some((item) => sameTravelRule(item, rule))) continue;
    result.push(rule);
  }
  return result;
}

function sameTravelRule(left: LocationTravelRule, right: LocationTravelRule): boolean {
  return normalizedText(left.from) === normalizedText(right.from)
    && normalizedText(left.targetLocation) === normalizedText(right.targetLocation)
    && left.method === right.method
    && (left.durationMinutes ?? 0) === (right.durationMinutes ?? 0)
    && normalizedText(left.constraint) === normalizedText(right.constraint);
}

function cleanSpatialItems(items: readonly string[]): readonly string[] {
  return unique(items.map((item) => item.trim()).filter((item) => item.length > 0 && !isTravelSentence(item)));
}

function cleanFixedFacts(items: readonly string[]): readonly string[] {
  return unique(items.map((item) => item.trim()).filter((item) => item.length > 0 && !isTravelSentence(item)));
}

function isTravelSentence(value: string): boolean {
  // Genre-neutral travel-sentence filter: detects a movement verb (walk/drive/transit)
  // paired with a time/distance unit, or an inter-floor "N楼到M楼" spatial step.
  // Registered routes live in location.travelRules; loose travel prose is kept out of
  // floors/rooms/fixedFacts. Intentionally carries NO hardcoded place names — the old
  // "到/去 + <fixed place> + unit" branch leaked genre-specific locations (R5b block 1).
  return /(?:走路|步行|打车|开车|坐车|公交).{0,12}(?:分钟|小时|公里)?/u.test(value)
    || /[一二三四五六七八九十\d]+楼.{0,8}到[一二三四五六七八九十\d]+楼.{0,12}(?:楼梯|分钟)/u.test(value);
}

function targetPathForSuggestion(suggestion: FoundationWriteSuggestionLike): string {
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

function defaultDocument(relativePath: string): Record<string, unknown> {
  if (relativePath === "story/bible.json") {
    return { version: "v0", projectLogline: "", premise: "", genre: "", subgenres: [], readerPromise: "", longFormGoals: [], centralConflicts: [], coreMysteries: [], forbiddenChanges: [], canonFacts: [], openQuestions: [] };
  }
  if (relativePath === "story/writing-rules.json") {
    return { version: "v0", proseStyle: [], genreRequirements: [], suspenseRules: [], payoffRules: [], reversalRules: [], readerExperienceRules: [], forbiddenContent: [], doNotDo: [] };
  }
  if (relativePath === "story/character-bible.json") return { version: "v0", characters: [] };
  if (relativePath === "story/world-bible.json") return { version: "v0", rules: [], factions: [], powerOrSurvivalSystems: [], historyFacts: [], socialOrder: [] };
  if (relativePath === "story/location-bible.json") return { version: "v0", locations: [] };
  if (relativePath === "story/assets.json") return { version: "v0", assets: [], containers: [] };
  return {};
}

function writePath(target: Record<string, unknown>, path: string, value: unknown, targetId?: string): void {
  if (path === "$") return;
  const parts = path.split(".");
  if ((parts[0] === "characters" || parts[0] === "locations" || parts[0] === "assets") && targetId) {
    const listKey = parts[0];
    const list = Array.isArray(target[listKey]) ? target[listKey] as Record<string, unknown>[] : [];
    if (!Array.isArray(target[listKey])) target[listKey] = list;
    let entry = list.find((item) => item.id === targetId);
    if (!entry) {
      entry = { id: targetId, name: "待确认" };
      list.push(entry);
    }
    writePath(entry, parts.slice(2).join("."), value);
    return;
  }
  let current: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] ?? "";
    const currentValue = current[part];
    if (typeof currentValue !== "object" || currentValue === null || Array.isArray(currentValue)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const finalPart = parts.at(-1);
  if (!finalPart) return;
  const existing = current[finalPart];
  if (Array.isArray(existing) && Array.isArray(value)) {
    current[finalPart] = unique([...existing.filter((item): item is string => typeof item === "string"), ...value.filter((item): item is string => typeof item === "string")]);
  } else if (!hasConcreteValue(existing)) {
    current[finalPart] = value;
  }
}

function replacePath(target: Record<string, unknown>, path: string, value: unknown, targetId?: string): void {
  if (path === "$") return;
  const parts = path.split(".");
  if ((parts[0] === "characters" || parts[0] === "locations" || parts[0] === "assets") && targetId) {
    const listKey = parts[0];
    const list = Array.isArray(target[listKey]) ? target[listKey] as Record<string, unknown>[] : [];
    if (!Array.isArray(target[listKey])) target[listKey] = list;
    let entry = list.find((item) => item.id === targetId);
    if (!entry) {
      entry = { id: targetId, name: "待确认" };
      list.push(entry);
    }
    replacePath(entry, parts.slice(2).join("."), value);
    return;
  }
  let current: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] ?? "";
    const currentValue = current[part];
    if (typeof currentValue !== "object" || currentValue === null || Array.isArray(currentValue)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const finalPart = parts.at(-1);
  if (!finalPart) return;
  current[finalPart] = value;
}

async function classifyAssetWriteRisk(
  projectDir: string,
  suggestion: FoundationWriteSuggestionLike,
  targetPath: string,
): Promise<FoundationWriteRisk | undefined> {
  const source = isRecord(suggestion.after) ? suggestion.after : {};
  const ledger = await readJson<AssetLedger>(join(projectDir, "story", "assets.json"), { version: "v0", assets: [], containers: [] });
  const sourceName = readString(source.name) ?? suggestion.extractedEntityName;
  const existing = ledger.assets.find((item) => item.id === suggestion.targetId || item.id === readString(source.id) || (sourceName !== undefined && item.name === sourceName));
  if (existing?.canAiModify === false && source.canAiModify === true) {
    return {
      level: "blocked",
      reason: "受保护资产不能被 AI 写入改成可自动修改。",
      targetFile: "story/assets.json",
      targetPath,
      existingValue: existing.canAiModify,
      suggestedValue: source.canAiModify,
    };
  }
  return undefined;
}

// E2：角色 typed 标量里逻辑上「单值、冲突≈错」的硬字段。只取 age/gender——
// identity/desire/fear 等软字段做厚常合理改写，纳入会误拦做厚 happy path。题材中立（按字段名、不嗅探 value）。
const CHARACTER_CONFLICT_SCALAR_KEYS = ["age", "gender"] as const;

/**
 * E2：update_character_detail 的角色 typed 标量强值冲突检测。
 * 读 character-bible.json 按 targetId 找条目，对 age/gender：旧强值 vs 新强值且不等价、且非显式覆盖意图
 * → needs_confirmation（由 gate 拦下整次写、applied:false，绝不静默覆盖）。复用与结构化标量同一口径。
 */
async function classifyCharacterScalarRisk(
  projectDir: string,
  suggestion: FoundationWriteSuggestionLike,
): Promise<FoundationWriteRisk | undefined> {
  if (!isRecord(suggestion.after) || !suggestion.targetId) return undefined;
  const bible = await readJson<{ readonly characters?: readonly unknown[] }>(
    join(projectDir, "story/character-bible.json"),
    { characters: [] },
  );
  const entry = Array.isArray(bible.characters)
    ? bible.characters.find((character) => isRecord(character) && character.id === suggestion.targetId)
    : undefined;
  if (!isRecord(entry)) return undefined;
  for (const key of CHARACTER_CONFLICT_SCALAR_KEYS) {
    const suggestedValue = suggestion.after[key];
    if (!hasStrongConcreteValue(suggestedValue)) continue;
    const existingValue = entry[key];
    if (hasStrongConcreteValue(existingValue) && !valuesEquivalent(existingValue, suggestedValue) && !isExplicitReplaceIntent(suggestion)) {
      return {
        level: "needs_confirmation",
        reason: "这次写入会替换该角色已确立的长期设定，需要用户明确覆盖。",
        targetFile: "story/character-bible.json",
        targetPath: key,
        existingValue,
        suggestedValue,
      };
    }
  }
  return undefined;
}

async function classifyStructuredScalarRisk(
  projectDir: string,
  suggestion: FoundationWriteSuggestionLike,
  targetPath: string,
  targetFile: string,
  scalarKeys: readonly string[],
): Promise<FoundationWriteRisk | undefined> {
  if (!isRecord(suggestion.after)) return undefined;
  const existing = await readJson<Record<string, unknown>>(join(projectDir, targetFile), defaultDocument(targetFile));
  for (const key of scalarKeys) {
    const suggestedValue = suggestion.after[key];
    if (!hasStrongConcreteValue(suggestedValue)) continue;
    const existingValue = existing[key];
    if (hasStrongConcreteValue(existingValue) && !valuesEquivalent(existingValue, suggestedValue) && !isExplicitReplaceIntent(suggestion)) {
      return {
        level: "needs_confirmation",
        reason: "这次写入会替换已有长期设定，需要用户明确覆盖。",
        targetFile,
        targetPath: key,
        existingValue,
        suggestedValue,
      };
    }
    const risk = classifyValueWriteRisk({ suggestion, targetPath: key, existingValue, suggestedValue });
    if (risk) {
      return { ...risk, targetFile, targetPath: key };
    }
  }
  return undefined;
}

function classifyValueWriteRisk(input: {
  readonly suggestion: FoundationWriteSuggestionLike;
  readonly targetPath: string;
  readonly existingValue: unknown;
  readonly suggestedValue: unknown;
}): FoundationWriteRisk | undefined {
  if (input.targetPath.endsWith("canAiModify") && input.existingValue === false && input.suggestedValue === true) {
    return {
      level: "blocked",
      reason: "受保护标记 canAiModify=false 不能被 AI 自动改成 true。",
      targetFile: input.suggestion.targetFile,
      targetPath: input.targetPath,
      existingValue: input.existingValue,
      suggestedValue: input.suggestedValue,
    };
  }

  if (!hasStrongConcreteValue(input.existingValue)) return undefined;
  if (valuesEquivalent(input.existingValue, input.suggestedValue)) return undefined;
  const destructive = input.suggestion.writeMode === "replace" || isClearingValue(input.suggestedValue) || isProtectedFoundationPath(input.targetPath);
  if (!destructive) return undefined;
  if (isExplicitReplaceIntent(input.suggestion) && !isClearingValue(input.suggestedValue)) return undefined;
  return {
    level: "needs_confirmation",
    reason: "这次写入会替换或清空已有长期资料，需要用户明确覆盖。",
    targetFile: input.suggestion.targetFile,
    targetPath: input.targetPath,
    existingValue: input.existingValue,
    suggestedValue: input.suggestedValue,
  };
}

function readPathValue(root: unknown, path: string, targetId?: string): unknown {
  if (path === "$") return root;
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return root;
  if ((parts[0] === "characters" || parts[0] === "locations" || parts[0] === "assets") && targetId && isRecord(root)) {
    const list = root[parts[0]];
    const entry = Array.isArray(list) ? list.find((item) => isRecord(item) && item.id === targetId) : undefined;
    return readPathValue(entry, parts.slice(2).join("."));
  }
  let current = root;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isProtectedFoundationPath(path: string): boolean {
  return /(?:protectedSecrets|fixedFacts|forbiddenRuleBreaks|cannotReveal|travelRules|lossRules|usageRules)$/u.test(path);
}

function isExplicitReplaceIntent(suggestion: FoundationWriteSuggestionLike): boolean {
  // confirmedByUser：用户确认后的重试放行（agent 工具层只在本轮用户原话含明确同意时才置 true）。
  if (suggestion.confirmedByUser === true) return true;
  if (suggestion.writeMode === "replace") return true;
  return /(?:覆盖|替换|改成|改为|删除|删掉|清空|移除)/u.test(suggestion.sourceUserMessage ?? "");
}

function isClearingValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

function valuesEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function result(
  projectDir: string,
  writes: readonly FoundationWriteRecord[],
  options: { readonly blockedWrites?: readonly FoundationWriteRisk[]; readonly skipped?: readonly FoundationWriteSkip[] } = {},
): FoundationWriteResult {
  const writtenFiles = [...new Set(writes.map((write) => write.targetFile))];
  const blockedWrites = options.blockedWrites ?? [];
  const skipped = options.skipped ?? [];
  return {
    applied: writes.length > 0,
    projectDir,
    writes,
    writtenFiles,
    refreshRequired: writes.length > 0,
    ...(blockedWrites.length > 0 ? { blockedWrites } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
    userSummaryLines: blockedWrites.length > 0 ? [
      "写入已暂停，等待明确覆盖确认。",
      ...blockedWrites.map((write) => `${write.targetFile} / ${write.targetPath}：${write.reason}`),
    ] : [
      "已写入当前书籍资料。",
      ...writes.map((write) => [
        write.targetName ? `对象：${labelForDomain(write.domain)} ${write.targetName}` : `对象：${labelForDomain(write.domain)}`,
        `位置：${write.targetFile}`,
        "状态：刷新后仍可读取",
      ].join(" / ")),
    ],
  };
}

function labelForDomain(domain: FoundationWriteDomain): string {
  if (domain === "character") return "角色";
  if (domain === "location") return "地点";
  if (domain === "world") return "世界观";
  if (domain === "writingRules") return "写作规则";
  if (domain === "asset") return "资产";
  return "资料";
}

function hasConcreteValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return false;
}

function hasStrongConcreteValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && !/^(?:待确认|尚未配置|未知|unknown|重要角色|第\d+章已出现角色|与主角关系待后续确认|按已出现剧情继续承担当前职责|承接已出现剧情继续行动)$/iu.test(trimmed);
  }
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function preferStrongString(existing: string | undefined, patch: string | undefined): string | undefined {
  return hasStrongConcreteValue(existing) ? existing : text(patch) ?? text(existing);
}

function mergeStringArrays(...lists: readonly (readonly string[] | undefined)[]): string[] {
  // E1：去重升级到 dedupeStringList（空白折叠 + 前缀含纳），唯一归一口径与读侧 dedupeAppearanceAnchors 同源。
  // 刻意不动底层 unique()——它另有多处非 list-merge 调用方（章次标签 / 空间结构 floors/rooms 等）。
  return [...dedupeStringList(lists.flatMap((list) => list ?? []))];
}

function mergeStringArrayField(
  current: readonly string[],
  additions: readonly string[],
  removals: readonly string[] | undefined,
  replacement: readonly string[] | undefined,
): string[] {
  if (replacement) return mergeStringArrays(replacement);
  const normalizedRemovals = new Set((removals ?? []).map(normalizedText));
  return mergeStringArrays(
    current.filter((item) => !normalizedRemovals.has(normalizedText(item))),
    additions,
  );
}

function readRemovalMap(value: unknown): Record<string, readonly string[]> {
  // 模型无关：模型可能把嵌套对象整块字符串化（after.removeFromArrays:"{...}"）。先尝试 JSON.parse 还原，
  // 否则旧逻辑见 string→非 record→静默返回 {} 吞掉纠错 + 谎报全成功（击穿字段纠错·破例⑤）。
  const resolved = typeof value === "string" ? parseJsonObjectLike(value) : value;
  if (!isRecord(resolved)) return {};
  return Object.fromEntries(
    Object.entries(resolved).map(([key, item]) => [key, readStringList(item)]),
  );
}

/** 字符串若是 `{...}` JSON 对象则解析，否则原样返回（治模型把嵌套对象字符串化）。 */
function parseJsonObjectLike(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function mergeUnknownArrays(existing: unknown, patch: unknown): unknown[] {
  const values = [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(patch) ? patch : patch !== undefined ? [patch] : []),
  ];
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const value of values) {
    const key = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readFile(path, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return text === undefined ? fallback : JSON.parse(text) as T;
}

/**
 * 原子写（tmp + rename）：与 project-store.writeJson 对齐。
 * 直接 writeFile 覆盖在进程被杀（OOM/断电/强退）时会留下截断的 JSON，而 readJsonSafe
 * 对 SyntaxError 一律返回 fallback → 面板和写手上下文静默显示空设定（2026-09-15 审计 P0-2）。
 * rename 在同文件系统内是原子的：要么完整落盘，要么保持旧文件不动。
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tmpPath, path);
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

function filterTargetChapterWordsRules(values: readonly string[]): string[] {
  return values.filter((value) => !isTargetChapterWordsRule(value));
}

function isTargetChapterWordsRule(value: string | undefined): boolean {
  if (!value) return false;
  return /(?:单章|每章|章节|每一章|一章|目标字数|字数目标|chapterLength|targetWords)[^\d]{0,24}[1-9]\d{1,5}\s*字?/iu.test(value);
}

function extractTargetChapterWordsFromTexts(values: readonly (string | undefined)[]): number | undefined {
  for (const value of values) {
    const matched = extractTargetChapterWordsFromText(value);
    if (matched !== undefined) return matched;
  }
  return undefined;
}

function extractTargetChapterWordsFromText(value: string | undefined): number | undefined {
  if (!value || !/(?:单章|每章|章节|每一章|一章|目标字数|字数目标|chapterLength|targetWords)/iu.test(value)) return undefined;
  const match = /(?:单章|每章|章节|每一章|一章|目标字数|字数目标|chapterLength|targetWords)[^\d]{0,24}([1-9]\d{1,5})\s*字?/iu.exec(value)
    ?? /([1-9]\d{1,5})\s*字/u.exec(value);
  if (!match) return undefined;
  const words = Number(match[1]);
  return Number.isInteger(words) && words >= 50 && words <= 50000 ? words : undefined;
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
