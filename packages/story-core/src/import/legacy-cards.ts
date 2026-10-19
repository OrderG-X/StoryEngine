/**
 * 老格式设定文件 → 设定卡（重构 P9）。只读老文件，绝不改、绝不删；读坏的文件跳过并记下来。
 *
 * 搬：不会变的（人是谁、长什么样、地方什么样、物件的规矩、故事和世界的设定、写作规则），自定义字段原样带上。
 * 不搬：会变的（人物现状 state.json、出场矩阵、物件归属 / 位置 / 状态、地点当前状态、信任度、知道什么）——
 *   这些以后一律从账（投影）算；建书模板的占位话（下面 TEMPLATE_* 逐字比，是本程序自己写进去的固定字，自家格式）。
 * `.story-engine-ui/` 下做厚工具的展示文件不搬：做厚的要点当年已并进上面这些文件；手加的别称（alias-tables 的 aliases）搬。
 *
 * 分不清当年哪些是作者写的、哪些是 AI 补的，一律记成作者的（by: author）：AI 以后不能悄悄改。
 * 新旧隔离：不 import 旧引擎，按需取字段，形状不对的字段当没有。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CARD_NAME_MAX,
  emptySettingCards,
  EXEMPLAR_TEXT_MAX,
  EXEMPLARS_MAX,
  FIELD_LABEL_MAX,
  FIELD_VALUE_MAX,
  FIELDS_PER_CARD_MAX,
  RULE_ITEM_MAX,
  RULE_LIST_MAX,
  SETTING_CARDS_SCHEMA,
  type Card,
  type CardField,
  type CardKind,
  type RuleItem,
  type SettingCardsFile,
} from "../schema/cards.js";
import { nameKey } from "../text/quote.js";
import type { ImportSkip } from "./legacy.js";

/** 建书模板写进老文件的占位话（旧 createStoryProject 的常量）。 */
const TEMPLATE_PREMISE = "主角进入一个等待展开的故事世界。";
const TEMPLATE_TEXTS = new Set([
  TEMPLATE_PREMISE,
  "长篇故事",
  "沉浸",
  "状态感知",
  "好奇",
  "状态驱动的长篇连载推进",
  "主角第一次遭遇与故事核心设定相关的明显阻力。",
  "进入开篇情境并面对核心变化",
  "进入故事开篇情境",
  "自主行动",
  "自然",
  "第三人称有限视角",
  "草稿阶段不要改写正式状态。",
  "没有正文证据时不要解决长期伏笔。",
  "主角本人",
  "本人",
]);
/** 写作规则模板里的节奏 / 揭示默认值（作者没选过）。 */
const TEMPLATE_PACING = "中等";
const TEMPLATE_REVEAL = "均衡";
const TEMPLATE_TARGET_WORDS = 1800;
/** 旧建书模板的占位主角名（主角没填名字时落的）。 */
const PLACEHOLDER_NAMES = new Set(["主角", "男主", "女主", "主人公", "男主角", "女主角", "未命名", "未命名角色", "待定"]);
const PROTAGONIST_ROLES = new Set(["主角", "protagonist", "主人公", "男主", "女主", "男主角", "女主角"]);

export interface LegacyCardsResult {
  readonly file: SettingCardsFile;
  /** 有没有老设定文件（一份都没有 = 新书或别处来的书）。 */
  readonly found: boolean;
  readonly skipped: readonly ImportSkip[];
  readonly counts: { readonly characters: number; readonly places: number; readonly items: number; readonly relations: number; readonly storyFields: number };
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !TEMPLATE_TEXTS.has(trimmed) ? trimmed : undefined;
}

function strs(value: unknown): string[] {
  if (typeof value === "string") return str(value) ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((item): item is string => item !== undefined);
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 一张卡（或故事设定）上的字段收集器：同标签合并、同一行不重复、空的不要。 */
class Fields {
  private readonly items: { label: string; lines: string[] }[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly at: string) {}

  add(label: string, ...values: readonly (string | readonly string[] | undefined)[]): void {
    const lines = values.flatMap((value) => (value === undefined ? [] : typeof value === "string" ? [value] : [...value]));
    for (const line of lines) {
      const key = nameKey(line);
      if (!key || this.seen.has(key)) continue;
      this.seen.add(key);
      let bucket = this.items.find((item) => nameKey(item.label) === nameKey(label));
      if (!bucket) {
        bucket = { label: cap(label.trim(), FIELD_LABEL_MAX), lines: [] };
        this.items.push(bucket);
      }
      bucket.lines.push(line);
    }
  }

  /** 自定义字段（extraFields）：标签原样，值是一段字或几段字。 */
  addExtra(extra: unknown, skip: readonly string[] = []): void {
    if (!isRecord(extra)) return;
    for (const [label, value] of Object.entries(extra)) {
      if (!label.trim() || skip.includes(label.trim())) continue;
      this.add(label, strs(value));
    }
  }

  build(): CardField[] {
    return this.items
      .filter((item) => item.lines.length > 0)
      .slice(0, FIELDS_PER_CARD_MAX)
      .map((item) => ({ label: item.label, value: cap(item.lines.join("\n"), FIELD_VALUE_MAX), by: "author" as const, at: this.at }));
  }
}

async function readJson(bookDir: string, file: string, skipped: ImportSkip[]): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(bookDir, file), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    skipped.push({ file, reason: "读不了" });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    skipped.push({ file, reason: "不是合法的 JSON，没搬" });
    return undefined;
  }
}

async function listDirs(bookDir: string, dir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(bookDir, dir), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

const LEGACY_FILES = [
  "story/character-bible.json",
  "story/location-bible.json",
  "story/assets.json",
  "story/world-bible.json",
  "story/bible.json",
  "story/core.json",
  "story/writing-rules.json",
  "world/core.json",
  "world/state.json",
] as const;

interface CharacterSource {
  readonly id: string;
  readonly bible?: Json;
  readonly profile?: Json;
  readonly core?: Json;
}

/** 读老设定文件，拼成设定卡（不写盘）。 */
export async function readLegacyCards(bookDir: string, at: string): Promise<LegacyCardsResult> {
  const skipped: ImportSkip[] = [];
  const loaded = new Map<string, unknown>();
  for (const file of LEGACY_FILES) loaded.set(file, await readJson(bookDir, file, skipped));
  const characterDirs = await listDirs(bookDir, "characters");
  const profiles = new Map<string, { profile?: Json; core?: Json }>();
  for (const dir of characterDirs) {
    const profile = await readJson(bookDir, `characters/${dir}/profile.json`, skipped);
    const core = await readJson(bookDir, `characters/${dir}/core.json`, skipped);
    profiles.set(dir, { ...(isRecord(profile) ? { profile } : {}), ...(isRecord(core) ? { core } : {}) });
  }
  const aliasTable = await readJson(bookDir, ".story-engine-ui/alias-tables.json", skipped);
  const found = [...loaded.values()].some((value) => value !== undefined) || characterDirs.length > 0;
  const file = emptySettingCards();
  if (!found) return { file, found, skipped, counts: { characters: 0, places: 0, items: 0, relations: 0, storyFields: 0 } };

  const cards: Card[] = [];
  const taken = new Set<string>();
  const claim = (...names: string[]): boolean => {
    const keys = names.map(nameKey);
    if (keys.some((key) => !key || taken.has(key))) return false;
    for (const key of keys) taken.add(key);
    return true;
  };
  const newCard = (kind: CardKind, name: string, aliases: readonly string[], fields: CardField[]): Card | undefined => {
    const cardName = cap(name, CARD_NAME_MAX);
    if (!claim(cardName)) {
      skipped.push({ file: "设定卡", item: cardName, reason: "重名，后一张没搬" });
      return undefined;
    }
    const kept = aliases.map((alias) => cap(alias, CARD_NAME_MAX)).filter((alias) => claim(alias));
    const card: Card = { id: `k-${cards.length + 1}`, kind, name: cardName, aliases: kept, fields, by: "author", at };
    cards.push(card);
    return card;
  };

  // —— 人物 ——
  const manualAliases = new Map<string, string[]>();
  const aliasEntries = isRecord(aliasTable) && Array.isArray(aliasTable.entries) ? aliasTable.entries : Array.isArray(aliasTable) ? aliasTable : [];
  for (const entry of aliasEntries) {
    if (!isRecord(entry)) continue;
    const canonical = str(entry.canonicalName);
    if (canonical) manualAliases.set(nameKey(canonical), strs(entry.aliases));
  }
  const bible = loaded.get("story/character-bible.json");
  const bibleEntries = isRecord(bible) && Array.isArray(bible.characters) ? bible.characters.filter(isRecord) : [];
  const sources: CharacterSource[] = [];
  const usedDirs = new Set<string>();
  for (const entry of bibleEntries) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const dir = (id && profiles.has(id) ? id : undefined)
      ?? characterDirs.find((candidate) => !usedDirs.has(candidate) && typeof profiles.get(candidate)?.profile?.name === "string" && nameKey(String(profiles.get(candidate)?.profile?.name)) === nameKey(name));
    if (dir) usedDirs.add(dir);
    sources.push({ id: id || dir || name, bible: entry, ...(dir ? profiles.get(dir) : {}) });
  }
  for (const dir of characterDirs) {
    if (usedDirs.has(dir)) continue;
    const pair = profiles.get(dir);
    if (pair?.profile) sources.push({ id: dir, ...pair });
  }
  const idToCard = new Map<string, Card>();
  const relationTexts: { from: Card; text: string; notes: string[] }[] = [];
  let protagonist: Card | undefined;
  for (const source of sources) {
    const b = source.bible ?? {};
    const p = source.profile ?? {};
    const c = source.core ?? {};
    const name = (typeof b.name === "string" && b.name.trim()) || (typeof p.name === "string" && p.name.trim()) || "";
    if (!name) {
      skipped.push({ file: "story/character-bible.json", item: source.id, reason: "没有名字" });
      continue;
    }
    const role = typeof b.role === "string" ? b.role.trim() : "";
    const isProtagonist = PROTAGONIST_ROLES.has(role) || b.isMainCharacter === true || p.identity === "protagonist"
      || (Array.isArray(p.tags) && p.tags.includes("main-character"));
    const fields = new Fields(at);
    const identity = str(b.identity) ?? (p.identity === "protagonist" ? undefined : str(p.identity));
    if (role && !PROTAGONIST_ROLES.has(role) && !(identity ?? "").includes(role)) fields.add("定位", role);
    fields.add("身份", identity);
    fields.add("年龄", str(b.age) ?? str(p.age));
    fields.add("性别", str(b.gender) ?? str(p.gender));
    const look = isRecord(p.appearance) ? p.appearance : {};
    fields.add("外貌", strs(b.appearanceAnchors), strs(p.appearanceAnchors), str(look.body), str(look.face), str(look.hair), str(look.clothing), strs(look.distinguishingFeatures));
    fields.add("性格", strs(b.personalityBaseline), strs(c.personality));
    const voice = isRecord(b.voice) ? b.voice : isRecord(c.voice) ? c.voice : {};
    fields.add("说话方式", str(b.speechStyle) ?? str(c.speechStyle), strs(b.speechRules), str(voice.style), str(voice.rhythm));
    fields.add("说话样例", strs(b.speechSamples), strs(voice.sampleLines));
    fields.add("想要什么", str(b.desire) ?? str(b.longTermDesire) ?? str(c.desire));
    fields.add("怕什么", str(b.fear) ?? str(c.fear));
    fields.add("弱点", str(b.weakness));
    fields.add("矛盾", str(b.contradiction) ?? str(c.contradiction));
    fields.add("底线", str(b.moralBoundary) ?? str(c.moralBoundary));
    fields.add("不会做的事", strs(b.behaviorBoundaries), strs(b.cannotDo), strs(c.taboos), strs(voice.avoidanceTopics));
    fields.add("暗里的心思", str(b.privateMotive), str(b.hiddenStance));
    fields.add("世界观", str(c.worldview));
    fields.add("习惯", strs(c.behaviorHabits));
    const arc = isRecord(b.arc) ? b.arc : isRecord(c.arc) ? c.arc : {};
    fields.add("会怎么变", str(b.arcPromise), str(arc.startState) ? `起点：${str(arc.startState)}` : undefined, str(arc.projectedDirection));
    fields.add("还没揭开的", strs(b.knowledgeUnknown));
    fields.add("不能说破的", strs(b.cannotReveal));
    fields.addExtra(b.extraFields);
    fields.addExtra(p.extraFields);
    fields.addExtra(c.extraFields);
    const built = fields.build();
    if (PLACEHOLDER_NAMES.has(name) && built.length === 0) continue;
    const aliases = [...strs(b.aliases), ...(manualAliases.get(nameKey(name)) ?? [])].filter((alias) => nameKey(alias) !== nameKey(name));
    const card = newCard("character", name, aliases, built);
    if (!card) continue;
    idToCard.set(source.id, card);
    if (isProtagonist && !protagonist) protagonist = card;
    const toProtagonist = str(b.relationshipToProtagonist);
    const dynamics = strs(b.relationshipDynamics);
    if (toProtagonist || dynamics.length > 0) relationTexts.push({ from: card, text: toProtagonist ?? "", notes: dynamics });
  }
  if (protagonist) protagonist.protagonist = true;
  const relations: SettingCardsFile["relations"] = [];
  for (const item of relationTexts) {
    if (protagonist && item.from !== protagonist && item.text) {
      relations.push({ id: `r-${relations.length + 1}`, a: item.from.id, b: protagonist.id, label: cap(item.text, FIELD_VALUE_MAX), by: "author", at });
    }
    if (item.notes.length > 0 && item.from.fields.length < FIELDS_PER_CARD_MAX) {
      item.from.fields.push({ label: "人际", value: cap(item.notes.join("\n"), FIELD_VALUE_MAX), by: "author", at });
    }
  }

  // —— 地点 ——
  const locationBible = loaded.get("story/location-bible.json");
  const locations = isRecord(locationBible) && Array.isArray(locationBible.locations) ? locationBible.locations.filter(isRecord) : [];
  let places = 0;
  for (const location of locations) {
    const name = str(location.name);
    if (!name) continue;
    const fields = new Fields(at);
    fields.add("类型", str(location.type), str(location.locationType));
    fields.add("在哪", str(location.parentLocation));
    const structure = isRecord(location.spatialStructure) ? location.spatialStructure : {};
    fields.add("格局", strs(structure.floors), strs(structure.rooms), strs(structure.entrances).map((item) => `入口：${item}`), strs(structure.exits).map((item) => `出口：${item}`));
    const senses = isRecord(location.sensoryDetails) ? location.sensoryDetails : {};
    fields.add("感官", strs(senses.visual), strs(senses.sound), strs(senses.smell), strs(senses.touch));
    fields.add("特点", strs(location.knownFeatures));
    fields.add("作用", str(location.narrativeFunction));
    fields.add("固定的事", strs(location.fixedFacts));
    fields.add("有什么", strs(location.resources));
    fields.add("要注意", strs(location.risks), strs(location.possibleConflicts));
    fields.add("藏着的", strs(location.hiddenFacts), strs(location.secrets));
    fields.add("连着", strs(location.connectedLocations));
    const travel = Array.isArray(location.travelRules) ? location.travelRules.filter(isRecord) : [];
    fields.add("怎么去", travel.map((rule) => [str(rule.targetLocation), str(rule.method), typeof rule.durationMinutes === "number" ? `${rule.durationMinutes} 分钟` : undefined, str(rule.constraint)].filter(Boolean).join("，")).filter(Boolean));
    fields.addExtra(location.extraFields, ["状态"]);
    if (newCard("place", name, [], fields.build())) places += 1;
  }

  // —— 物品 ——
  const assetLedger = loaded.get("story/assets.json");
  const assets = isRecord(assetLedger) && Array.isArray(assetLedger.assets) ? assetLedger.assets.filter(isRecord) : [];
  let items = 0;
  for (const asset of assets) {
    const name = str(asset.name);
    if (!name) continue;
    const fields = new Fields(at);
    fields.add("类型", str(asset.type));
    fields.add("作用", str(asset.narrativeFunction));
    fields.add("规矩", strs(asset.rules), strs(asset.usageRules), strs(asset.lossRules));
    if (asset.isConsumable === true) fields.add("规矩", "用了就没了");
    fields.add("要注意", strs(asset.risks));
    fields.add("备注", strs(asset.notes));
    fields.addExtra(asset.extraFields, ["读者可见性"]);
    if (newCard("item", name, [], fields.build())) items += 1;
  }

  // —— 故事设定 ——
  const storyBible = loaded.get("story/bible.json");
  const storyCore = loaded.get("story/core.json");
  const worldCore = loaded.get("world/core.json");
  const worldState = loaded.get("world/state.json");
  const worldBible = loaded.get("story/world-bible.json");
  const sb = isRecord(storyBible) ? storyBible : {};
  const sc = isRecord(storyCore) ? storyCore : {};
  const wc = isRecord(worldCore) ? worldCore : {};
  const wb = isRecord(worldBible) ? worldBible : {};
  const story = new Fields(at);
  story.add("一句话", str(sb.projectLogline) ?? str(sb.premise) ?? str(wc.premise));
  story.add("前提", str(sb.premise), str(wc.premise));
  story.add("题材", str(sb.genre) ?? str(wc.genre), strs(sb.subgenres));
  story.add("读者期待", str(sb.readerPromise), str(sc.readerPromise));
  story.add("基调", str(sc.tone), str(sc.targetEmotion));
  story.add("节奏", str(sc.pacingStyle));
  story.add("世界一句话", str(wb.worldPremise));
  story.add("世界规矩", strs(wc.rules), strs(wb.rules));
  story.add("体系", strs(wb.powerOrSurvivalSystems), strs(wb.resourceRules), strs(wb.authorityRules));
  story.add("社会", strs(wb.socialOrder));
  story.add("历史", strs(wb.historyFacts));
  const factions = Array.isArray(wb.factions) ? wb.factions : [];
  story.add("势力", factions.map((faction) => {
    if (typeof faction === "string") return str(faction);
    if (!isRecord(faction)) return undefined;
    const factionName = str(faction.name);
    if (!factionName) return undefined;
    const goal = str(faction.goal);
    const resources = strs(faction.resources);
    return `${factionName}${goal ? `：${goal}` : ""}${resources.length > 0 ? `（${resources.join("、")}）` : ""}`;
  }).filter((item): item is string => item !== undefined));
  story.add("主线冲突", str(wc.mainConflict), strs(sb.centralConflicts), strs(wb.conflictSources));
  story.add("长线目标", strs(sb.longFormGoals));
  story.add("核心谜团", strs(sb.coreMysteries), strs(sb.openQuestions));
  story.add("定下的事", strs(sb.canonFacts), strs(wb.fixedFacts), strs(wb.publicFacts));
  story.add("不能改的", strs(sb.forbiddenChanges), strs(wb.forbiddenRuleBreaks));
  story.add("不能说破的", strs(sb.protectedSecrets), strs(wb.protectedSecrets), strs(wb.hiddenFacts));
  const setup = isRecord(sb.setupAssets) ? sb.setupAssets : {};
  story.add("开局资源", strs(setup.initialAssets), strs(setup.keyItems), strs(setup.resourceLimits));
  const opening = isRecord(sb.firstChapterSetup) ? sb.firstChapterSetup : {};
  story.add("开篇设想", str(opening.goal), str(opening.openingScene), str(opening.hook), str(opening.conflict));
  story.addExtra(isRecord(worldState) ? worldState.extraFields : undefined);
  file.story.fields = story.build();

  // —— 写作规则 ——
  const rules = loaded.get("story/writing-rules.json");
  if (isRecord(rules)) {
    const item = (text: string): RuleItem => ({ text: cap(text, RULE_ITEM_MAX), by: "author", at });
    const list = (...values: readonly (string | readonly string[] | undefined)[]): RuleItem[] => {
      const out: RuleItem[] = [];
      const seen = new Set<string>();
      for (const value of values.flatMap((entry) => (entry === undefined ? [] : typeof entry === "string" ? [entry] : [...entry]))) {
        const key = nameKey(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item(value));
      }
      return out.slice(0, RULE_LIST_MAX);
    };
    const perspective = str(rules.narrativePerspective);
    if (perspective) file.rules.perspective = { value: perspective, by: "author", at };
    file.rules.style = list(strs(rules.proseStyle));
    const length = isRecord(rules.chapterLength) ? rules.chapterLength : {};
    const target = typeof length.targetWords === "number" && Number.isInteger(length.targetWords) ? length.targetWords : undefined;
    if (target && target > 0 && target !== TEMPLATE_TARGET_WORDS) file.rules.targetWords = { value: target, by: "author", at };
    const min = typeof length.minWords === "number" && Number.isInteger(length.minWords) ? length.minWords : undefined;
    if (min && min > 0) file.rules.minWords = { value: min, by: "author", at };
    const pacing = typeof rules.pacing === "string" && rules.pacing.trim() !== TEMPLATE_PACING ? str(rules.pacing) : undefined;
    const reveal = typeof rules.revealPolicy === "string" && rules.revealPolicy.trim() !== TEMPLATE_REVEAL ? str(rules.revealPolicy) : undefined;
    file.rules.musts = list(
      pacing ? `节奏：${pacing}` : undefined,
      reveal ? `揭示：${reveal}` : undefined,
      strs(rules.genreRequirements),
      strs(rules.suspenseRules),
      strs(rules.payoffRules),
      strs(rules.reversalRules),
      strs(rules.readerExperienceRules),
    );
    file.rules.bans = list(strs(rules.forbiddenContent), strs(rules.doNotDo));
    file.rules.avoid = list(strs(rules.antiAiPatterns));
    const notes = str(rules.customNotes);
    if (notes) file.rules.notes = { value: cap(notes, FIELD_VALUE_MAX), by: "author", at };
    const exemplars = Array.isArray(rules.styleExemplars) ? rules.styleExemplars.filter(isRecord) : [];
    for (const exemplar of exemplars) {
      const text = typeof exemplar.text === "string" ? exemplar.text.trim() : "";
      if (!text || file.rules.exemplars.length >= EXEMPLARS_MAX) continue;
      const note = [str(exemplar.title), str(exemplar.note)].filter(Boolean).join("：");
      file.rules.exemplars.push({
        id: `e-${file.rules.exemplars.length + 1}`,
        text: cap(text, EXEMPLAR_TEXT_MAX),
        ...(note ? { note: cap(note, RULE_ITEM_MAX) } : {}),
        by: "author",
        at,
      });
    }
  }

  file.cards = cards;
  file.relations = relations;
  return {
    file: { ...file, schema: SETTING_CARDS_SCHEMA },
    found,
    skipped,
    counts: {
      characters: cards.filter((card) => card.kind === "character").length,
      places,
      items,
      relations: relations.length,
      storyFields: file.story.fields.length,
    },
  };
}
