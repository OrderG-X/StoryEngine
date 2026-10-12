import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readArcGoalPool,
  readCharacterBible,
  readThreadPool,
  toSafeCharacterId,
  PLACEHOLDER_CHARACTER_NAME,
  type ArcGoal,
  type CharacterBibleEntry,
  type NarrativeThread,
} from "@actalk/story-engine";

import { readAliasTable, type AliasTable } from "../alias-generator/alias-generator.js";
import { readRecentPresentCharacterNames } from "./delta-present-names.js";
import { resolveEntityLabel } from "./entity-labels.js";

export interface CharacterPresenceTraceItem {
  readonly viaGoal: boolean;
  readonly viaPrevBody: boolean;
  readonly alwaysResident: boolean;
  readonly reasons: readonly string[];
}

export interface CharacterPresenceTrace {
  readonly selectedCharacterIds: readonly string[];
  readonly selectedNames: readonly string[];
  readonly byId: Record<string, CharacterPresenceTraceItem>;
  readonly prevChapterFound: boolean;
  readonly explicit?: boolean;
  /** 软 cap 收窄出去的角色名（洞②透明度：绝不静默截断）。无收窄时省略/空。 */
  readonly cappedOutNames?: readonly string[];
}

/**
 * 自动在场检测的软 cap：超过此数的"相关角色"会按在场信号强度收窄，主角恒保。
 * 治洞②——长篇里活跃弧线累积 + 群像章上章命中一大票会让 selected 膨胀，而
 * character_profile/core 是 stable 段、预算器裁不动，"几乎全选"使 Phase 1 收窄形同虚设。
 * 正常一场戏的主要角色远少于此=自然不触发；仅群像超额时才按相关性取前 N。
 */
export const DEFAULT_MAX_IN_SCENE_CHARACTERS = 8;

export interface CharacterPresenceResult {
  readonly selectedCharacterIds: readonly string[];
  readonly trace: CharacterPresenceTrace;
  readonly summary: string;
  /**
   * 名册全是开书占位卡（建书模板固定名，PLACEHOLDER_CHARACTER_NAME 标记）时，从最近几章已定稿
   * ChapterDelta 的 charactersPresent（时间线 presentCharacterNames）取的本章角色名，最新章在前。
   * 出稿编排把它点进写作方向，占位卡本身不进引擎选角关卡（编辑部 R4.6）。有名册真名或没有已定稿
   * 声明时缺省。
   */
  readonly chapterCharactersFromDeltas?: readonly string[];
}

export interface DetectInSceneCharactersInput {
  readonly characters: readonly CharacterBibleEntry[];
  readonly aliasTable: AliasTable;
  readonly chapterGoal: string;
  readonly previousChapterText: string;
  readonly prevChapterFound: boolean;
  readonly activeRelatedCharacterIds: readonly string[];
  /** 软 cap（默认 DEFAULT_MAX_IN_SCENE_CHARACTERS）：相关角色超额时按在场信号收窄。 */
  readonly maxInScene?: number;
}

export interface ResolveSelectedCharacterIdsInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly explicit?: readonly string[];
  readonly maxInScene?: number;
}

export function detectInSceneCharacters(input: DetectInSceneCharactersInput): CharacterPresenceResult {
  const characters = input.characters;
  const byId = new Map(characters.map((character) => [character.id, character]));
  const selected = new Set<string>();
  const traceById: Record<string, CharacterPresenceTraceItem> = {};
  const matchedByGoal = new Set<string>();
  const matchedByPrevBody = new Set<string>();

  for (const character of characters) {
    const terms = matchingTermsFor(character, input.aliasTable);
    if (terms.some((term) => input.chapterGoal.includes(term))) matchedByGoal.add(character.id);
    if (terms.some((term) => input.previousChapterText.includes(term))) matchedByPrevBody.add(character.id);
  }

  const activeRelatedIds = input.activeRelatedCharacterIds
    .map((idOrName) => resolveCharacterRefToId(idOrName, characters))
    .filter((id): id is string => id !== undefined);
  const alwaysResident = new Set<string>([
    ...characters.filter(isProtagonist).map((character) => character.id),
    ...activeRelatedIds,
    ...matchedByPrevBody,
  ]);

  for (const id of alwaysResident) selected.add(id);
  for (const id of matchedByGoal) selected.add(id);
  for (const id of matchedByPrevBody) selected.add(id);

  if (selected.size === 0 && characters[0]) {
    selected.add(characters[0].id);
    alwaysResident.add(characters[0].id);
  }

  const detectedIds = characters.map((character) => character.id).filter((id) => selected.has(id));

  // 软 cap（洞②）：相关角色超额时按在场信号强度收窄，主角恒保。
  // 信号分：方向命中=3（本章明确点到）> 上章命中=2（承接）> 活跃弧线=1（背景相关，对本场最弱）。
  // 稳定排序（score desc，并列按 bible 原序）→ cache-safe：同输入同输出。
  const cap = input.maxInScene ?? DEFAULT_MAX_IN_SCENE_CHARACTERS;
  const order = new Map(characters.map((character, index) => [character.id, index]));
  const inSceneScore = (id: string): number =>
    (matchedByGoal.has(id) ? 3 : 0) + (matchedByPrevBody.has(id) ? 2 : 0) + (activeRelatedIds.includes(id) ? 1 : 0);
  let selectedCharacterIds = detectedIds;
  let cappedOutNames: string[] = [];
  if (detectedIds.length > cap) {
    // 主角先占名额（恒保，并计入 cap），剩余名额按在场信号取高分配角。
    const protagonistIds = detectedIds.filter((id) => isProtagonist(byId.get(id)));
    const remainingSlots = Math.max(0, cap - protagonistIds.length);
    const keptNonProtagonist = detectedIds
      .filter((id) => !isProtagonist(byId.get(id)))
      .sort((a, b) => inSceneScore(b) - inSceneScore(a) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .slice(0, remainingSlots);
    const keptSet = new Set([...protagonistIds, ...keptNonProtagonist]);
    selectedCharacterIds = detectedIds.filter((id) => keptSet.has(id));
    cappedOutNames = detectedIds
      .filter((id) => !keptSet.has(id))
      .map((id) => byId.get(id)?.name)
      .filter((name): name is string => Boolean(name));
  }

  for (const id of selectedCharacterIds) {
    const reasons: string[] = [];
    if (isProtagonist(byId.get(id))) reasons.push("protagonist");
    if (activeRelatedIds.includes(id)) reasons.push("active_arc_or_thread");
    if (matchedByPrevBody.has(id)) reasons.push("previous_chapter");
    if (matchedByGoal.has(id)) reasons.push("chapter_goal");
    traceById[id] = {
      viaGoal: matchedByGoal.has(id),
      viaPrevBody: matchedByPrevBody.has(id),
      alwaysResident: alwaysResident.has(id),
      reasons,
    };
  }

  const selectedNames = selectedCharacterIds.map((id) => byId.get(id)?.name).filter((name): name is string => Boolean(name));
  return {
    selectedCharacterIds,
    trace: {
      selectedCharacterIds,
      selectedNames,
      byId: traceById,
      prevChapterFound: input.prevChapterFound,
      ...(cappedOutNames.length > 0 ? { cappedOutNames } : {}),
    },
    summary:
      selectedNames.length > 0
        ? `本章相关角色：${selectedNames.join("、")}${cappedOutNames.length > 0 ? `（已按在场相关性收窄至 ${cap} 人，未纳入：${cappedOutNames.join("、")}）` : ""}`
        : "本章相关角色：未命中，使用默认核心角色。",
  };
}

/**
 * 一个角色 id 的三件套（profile/core/state.json）是否都在磁盘上可读——这正是下游 writer context 读它们的方式
 * （context-gateway 的 readCharacterProfile/Core/State 经 toSafeCharacterId 拼路径、Promise.all 无 catch、缺一即
 * ENOENT 崩）。只放行可读 id；「仅在册无文件 / 类别词 / 捏造 / 哨兵 id」一律判不可读、过滤掉。
 */
async function characterFilesReadable(projectDir: string, id: string): Promise<boolean> {
  const dir = join(projectDir, "characters", toSafeCharacterId(id));
  const present = await Promise.all(
    ["profile.json", "core.json", "state.json"].map((file) =>
      access(join(dir, file)).then(() => true).catch(() => false)),
  );
  return present.every(Boolean);
}

export async function resolveSelectedCharacterIds(input: ResolveSelectedCharacterIdsInput): Promise<CharacterPresenceResult> {
  // 空数组（含全空白被 unique 清掉）不算「显式指定」——agent 常把 selectedCharacterIds 传成 []，
  // 绝不能因此旁路自动在场检测（长篇上下文裁剪命门：角色一多必须按在场信号收窄，否则上下文爆炸/早期记忆塌陷）。
  // 只有真给了非空 id 列表才走显式分支；[]/缺省/全空白都回落自动检测。
  const explicitIds = input.explicit !== undefined ? unique(input.explicit) : undefined;
  if (explicitIds !== undefined && explicitIds.length > 0) {
    // 解析 id → 角色名：summary/selectedNames 给用户看，绝不直接 join 原始 id（治「本章相关角色：char-ffe5af」泄露）。
    // 读 bible 失败/解析不到的 id 诚实回落显原值（不编造名字）；selectedCharacterIds 仍是 id（下游喂引擎用、不动语义）。
    const characters = (await readCharacterBible(input.projectDir).catch(() => null))?.characters ?? [];
    const nameById = new Map(characters.map((character) => [character.id, character.name]));
    const idByName = new Map(characters.map((character) => [character.name, character.id]));
    // 接缝防御（审计 + 真机 + 复审实锤）：有效 id = 下游 buildWriterContext 真能读到三件套的 id——它对每个 id
    // 直读 characters/<toSafeCharacterId(id)>/{profile,core,state}.json（无 catch、缺一即 ENOENT 崩）。所以
    // 「类别词/捏造/哨兵 id」和「仅在册、无角色目录文件」的退化输入都不能放行（旧 bible∪dir 并集漏了后者）。
    // 显式 ref 解析成【可读】canonical id（id 直认可读 / 名字→id 再验可读），解析不到一律丢；全丢则回落自动在场检测。
    const resolved = await Promise.all(explicitIds.map(async (ref) => {
      if (await characterFilesReadable(input.projectDir, ref)) return ref;
      const idFromName = idByName.get(ref);
      if (idFromName && await characterFilesReadable(input.projectDir, idFromName)) return idFromName;
      return undefined;
    }));
    const resolvedIds = unique(resolved.filter((id): id is string => id !== undefined));
    if (resolvedIds.length > 0) {
      const selectedNames = resolvedIds.map((id) => resolveEntityLabel(id, nameById));
      return {
        selectedCharacterIds: resolvedIds,
        trace: {
          selectedCharacterIds: resolvedIds,
          selectedNames,
          byId: {},
          prevChapterFound: false,
          explicit: true,
        },
        summary: `本章相关角色：${selectedNames.join("、")}`,
      };
    }
    // resolvedIds 为空（显式 ref 全是类别词/捏造/哨兵 id）→ 不崩、不旁路：落到下面自动在场检测。
  }

  const [characterBible, aliasTable, previousChapter, activeRelatedCharacterIds] = await Promise.all([
    readCharacterBible(input.projectDir).catch(() => null),
    readAliasTable(input.projectDir),
    readPreviousChapterText(input.projectDir, input.chapter),
    readActiveRelatedCharacterIds(input.projectDir, input.chapter),
  ]);

  const detected = detectInSceneCharacters({
    characters: characterBible?.characters ?? [],
    aliasTable,
    chapterGoal: input.chapterGoal,
    previousChapterText: previousChapter.text,
    prevChapterFound: previousChapter.found,
    activeRelatedCharacterIds,
    ...(input.maxInScene !== undefined ? { maxInScene: input.maxInScene } : {}),
  });

  // 编辑部 R4.6：名册只有开书占位卡（模板固定名，按标记识别、不按名字猜）的新书——作者手写开局是常态，
  // 章节声明里的出场名才是真实名册。改用最近几章已定稿声明的出场名当本章角色：占位卡不进关卡
  // （引擎侧 fast-draft-writer 用同一份标记豁免），出场名交给出稿编排点进写作方向。summary 如实说明来源。
  const roster = characterBible?.characters ?? [];
  const rosterAllPlaceholder = roster.length > 0
    && roster.every((character) => PLACEHOLDER_CHARACTER_NAME.test(character.name?.trim() ?? ""));
  if (rosterAllPlaceholder) {
    const deltaNames = await readRecentPresentCharacterNames(input.projectDir, input.chapter);
    if (deltaNames.length > 0) {
      return {
        ...detected,
        chapterCharactersFromDeltas: deltaNames,
        summary: `本章相关角色（按最近定稿章的出场记账）：${deltaNames.join("、")}。角色名册还是开书占位「${roster.map((character) => character.name).join("、")}」，本次没拿占位名把关。`,
      };
    }
    return {
      ...detected,
      summary: `本章相关角色：名册只有开书占位「${roster.map((character) => character.name).join("、")}」，最近定稿章也没有出场记账，本次没拿占位名把关。`,
    };
  }
  return detected;
}

function matchingTermsFor(character: CharacterBibleEntry, aliasTable: AliasTable): readonly string[] {
  const entry = aliasTable.byEntity[character.id];
  return unique([
    character.name,
    entry?.canonicalName,
    entry?.primary,
    ...(entry?.aliases ?? []).filter((alias) => Array.from(alias).length >= 2),
  ]);
}

function isProtagonist(character: CharacterBibleEntry | undefined): boolean {
  if (!character) return false;
  if ((character as { readonly isMainCharacter?: unknown }).isMainCharacter === true) return true;
  // 题材中立·模型无关：role 可能缺失/为 null（退化角色卡）——null 安全，绝不 .includes 崩。
  return character.role === "protagonist" || (character.role?.includes("主角") ?? false);
}

function resolveCharacterRefToId(ref: string, characters: readonly CharacterBibleEntry[]): string | undefined {
  return characters.find((character) => character.id === ref || character.name === ref)?.id;
}

async function readPreviousChapterText(projectDir: string, chapter: number): Promise<{ readonly text: string; readonly found: boolean }> {
  if (chapter <= 1) return { text: "", found: false };
  const previous = String(chapter - 1).padStart(4, "0");
  const candidates = [
    join(projectDir, "chapters", `${previous}.md`),
    join(projectDir, "drafts", "fast", `chapter-${previous}.md`),
  ];
  for (const file of candidates) {
    const text = await readFile(file, "utf-8").catch(() => undefined);
    if (text !== undefined && text.trim().length > 0) return { text, found: true };
  }
  return { text: "", found: false };
}

async function readActiveRelatedCharacterIds(projectDir: string, chapter: number): Promise<readonly string[]> {
  const [arcPool, threadPool] = await Promise.all([
    readArcGoalPool(projectDir).catch(() => ({ goals: [] })),
    readThreadPool(projectDir).catch(() => ({ threads: [] })),
  ]);
  return unique([
    ...arcPool.goals.filter((goal) => isActiveArcGoal(goal, chapter)).flatMap((goal) => goal.relatedCharacters ?? []),
    ...threadPool.threads.filter((thread) => isActiveThread(thread, chapter)).flatMap((thread) => thread.relatedCharacters ?? []),
  ]);
}

function isActiveArcGoal(goal: ArcGoal, chapter: number): boolean {
  return (goal.status === "active" || goal.status === "touched") && goal.firstSeenChapter <= chapter;
}

function isActiveThread(thread: NarrativeThread, chapter: number): boolean {
  return (thread.status === "open" || thread.status === "touched") && thread.firstSeenChapter <= chapter;
}

function unique(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
