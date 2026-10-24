/**
 * 设定包（重构 P9）：把设定视图（设定卡 + 账里记的现状）压成给模型看的一份，写手、审稿、改稿、质检共用。
 *
 * - 卡上的字段原样渲染成「标签：内容」，代码不认字段的意思（题材中立）；会变的（在哪、在谁手里）只从账来，带章号。
 * - 选哪些：主角恒带；人物按在场检测给的名字；地点 / 物品 / 设定按名字（或别名）在本章方向、章纲、上一章正文里出现过
 *   就整张带上，其余只列名字（防编造重名的东西，也不撑爆上下文）。名字出现与否是逐字找（找原句），不猜意思。
 * - 有上限：每张卡最多 MAX_LINES_PER_CARD 行，每行最多 MAX_LINE_CHARS 字；超了如实标「（还有 N 项没列）」。
 */
import { emptyWritingRules, readBible, type BibleEntry, type BibleFact, type BibleView, type BookProjection, type UncardedEntry, type WritingRules } from "@actalk/story-core";
import { describeErrorBriefly } from "../book/project-store.js";

export const MAX_LINES_PER_CARD = 14;
export const MAX_LINE_CHARS = 300;
export const MAX_FACTS_PER_CARD = 6;
export const MAX_CAST = 8;
export const MAX_FULL_ENTRIES = 6;
/** 文风样本进提示词的预算：每条最多这么多字，全部样本合计最多这么多字；超了的整条不进（仍在设定卡上）。 */
export const EXEMPLAR_PROMPT_TEXT_CHARS = 800;
export const EXEMPLAR_PROMPT_TOTAL_CHARS = 1600;

export interface SettingBrief {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** 设定卡上的（作者定的 / AI 补的）。 */
  readonly card: readonly string[];
  /** 账里记的现状（会变的，最新一章）。 */
  readonly now?: readonly string[];
  /** 账里记的定下的（正文写过、不会变的）。 */
  readonly fixed?: readonly string[];
  readonly relations?: readonly string[];
  /** 这张卡还没建（账里有、作者没建卡）。 */
  readonly uncarded?: true;
}

export interface SettingRulesPack {
  readonly perspective?: string;
  readonly style: readonly string[];
  readonly targetWords?: number;
  readonly minWords?: number;
  readonly musts: readonly string[];
  readonly bans: readonly string[];
  readonly avoid: readonly string[];
  readonly notes?: string;
}

export interface ExemplarPromptItem {
  readonly text: string;
  readonly note?: string;
}

export interface SettingPack {
  /** 定论（P12）：作者定下的说法，全书以它为准。 */
  readonly canon: readonly string[];
  /** 故事设定（一句话、题材、世界规矩……）。 */
  readonly story: readonly string[];
  readonly protagonist?: SettingBrief;
  readonly cast: readonly SettingBrief[];
  readonly places: readonly SettingBrief[];
  readonly items: readonly SettingBrief[];
  readonly lore: readonly SettingBrief[];
  /** 没整张带上的卡，只列名字：别编出重名的、也别当不存在。 */
  readonly otherNames: { readonly places: readonly string[]; readonly items: readonly string[]; readonly lore: readonly string[]; readonly characters: readonly string[] };
  readonly rules: SettingRulesPack;
  /** 作者文风样本（正向锚，已按预算截断）。 */
  readonly exemplars: readonly ExemplarPromptItem[];
}

export interface SettingFocus {
  /** 本章要带的人物（在场检测的结果，名字）。 */
  readonly characters?: readonly string[];
  /** 本章方向、章纲、上一章正文等：里面点到名字的地点 / 物品 / 设定整张带上。 */
  readonly texts?: readonly string[];
  /** 章纲定的地点（必带）。 */
  readonly plannedPlaces?: readonly string[];
}

export const EMPTY_BIBLE: BibleView = {
  story: [],
  rules: emptyWritingRules(),
  characters: [],
  places: [],
  items: [],
  lore: [],
  relations: [],
  uncarded: [],
  canon: [],
};

/**
 * 写稿路径读设定：设定卡坏了不炸掉整次出稿——按空设定降级，失败原因如实交给调用方（进 read_failures）。
 */
export async function readBibleTolerant(projectDir: string): Promise<{ readonly bible: BibleView; readonly projection?: BookProjection; readonly failure?: string }> {
  try {
    return await readBible(projectDir);
  } catch (error) {
    return { bible: EMPTY_BIBLE, failure: `设定本读取失败（${describeErrorBriefly(error)}），已按空设定降级。` };
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s*\n\s*/gu, "；").trim();
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat;
}

function factLine(fact: BibleFact): string {
  return clip(`${fact.attribute}：${fact.value}（第 ${fact.chapter} 章）`);
}

function namesOf(entry: BibleEntry): string[] {
  return [entry.card.name, ...entry.card.aliases, ...entry.ledgerAliases];
}

function briefOf(entry: BibleEntry): SettingBrief {
  const lines = entry.card.fields.map((field) => clip(`${field.label}：${field.value}`));
  const card = lines.length > MAX_LINES_PER_CARD
    ? [...lines.slice(0, MAX_LINES_PER_CARD), `（还有 ${lines.length - MAX_LINES_PER_CARD} 项没列）`]
    : lines;
  const aliases = [...entry.card.aliases, ...entry.ledgerAliases];
  const now = entry.now.slice(0, MAX_FACTS_PER_CARD).map(factLine);
  const fixed = entry.fixed.slice(0, MAX_FACTS_PER_CARD).map(factLine);
  const relations = entry.relations.map((relation) => clip(`和${relation.other}：${relation.label}`));
  return {
    name: entry.card.name,
    ...(aliases.length > 0 ? { aliases } : {}),
    card,
    ...(now.length > 0 ? { now } : {}),
    ...(fixed.length > 0 ? { fixed } : {}),
    ...(relations.length > 0 ? { relations } : {}),
  };
}

function uncardedBrief(entry: UncardedEntry): SettingBrief {
  const now = entry.now.slice(0, MAX_FACTS_PER_CARD).map(factLine);
  const fixed = entry.fixed.slice(0, MAX_FACTS_PER_CARD).map(factLine);
  return {
    name: entry.name,
    ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
    card: [],
    ...(now.length > 0 ? { now } : {}),
    ...(fixed.length > 0 ? { fixed } : {}),
    uncarded: true,
  };
}

/** 名字（或别名，两个字起）在这些文字里逐字出现过。 */
export function mentionedIn(names: readonly string[], texts: readonly string[]): boolean {
  return names.some((name) => Array.from(name.trim()).length >= 2 && texts.some((text) => text.includes(name.trim())));
}

function pick(entries: readonly BibleEntry[], focus: SettingFocus, must: readonly string[] = []): { full: BibleEntry[]; rest: string[] } {
  const texts = (focus.texts ?? []).filter((text) => text.trim().length > 0);
  const hit = (entry: BibleEntry): boolean => mentionedIn(namesOf(entry), [...texts, ...must]) || must.some((name) => namesOf(entry).includes(name));
  const full = entries.length <= MAX_FULL_ENTRIES ? [...entries] : entries.filter(hit).slice(0, MAX_FULL_ENTRIES);
  return { full, rest: entries.filter((entry) => !full.includes(entry)).map((entry) => entry.card.name) };
}

export function rulesPack(rules: WritingRules): SettingRulesPack {
  const texts = (items: readonly { readonly text: string }[]): string[] => items.map((item) => item.text);
  return {
    ...(rules.perspective ? { perspective: rules.perspective.value } : {}),
    style: texts(rules.style),
    ...(rules.targetWords ? { targetWords: rules.targetWords.value } : {}),
    ...(rules.minWords ? { minWords: rules.minWords.value } : {}),
    musts: texts(rules.musts),
    bans: texts(rules.bans),
    avoid: texts(rules.avoid),
    ...(rules.notes ? { notes: rules.notes.value } : {}),
  };
}

export function exemplarPromptItems(rules: WritingRules): ExemplarPromptItem[] {
  const items: ExemplarPromptItem[] = [];
  let remaining = EXEMPLAR_PROMPT_TOTAL_CHARS;
  for (const exemplar of rules.exemplars) {
    if (remaining <= 0) break;
    const text = exemplar.text.trim().slice(0, Math.min(EXEMPLAR_PROMPT_TEXT_CHARS, remaining));
    if (!text) continue;
    items.push({ text, ...(exemplar.note?.trim() ? { note: exemplar.note.trim() } : {}) });
    remaining -= text.length;
  }
  return items;
}

export function buildSettingPack(bible: BibleView, focus: SettingFocus = {}): SettingPack {
  const protagonistEntry = bible.characters.find((entry) => entry.card.protagonist);
  const wanted = (focus.characters ?? []).map((name) => name.trim()).filter(Boolean);
  const cast: SettingBrief[] = [];
  const castNames = new Set<string>();
  for (const name of wanted) {
    if (cast.length >= MAX_CAST) break;
    const entry = bible.characters.find((item) => item !== protagonistEntry && namesOf(item).includes(name));
    if (entry && !castNames.has(entry.card.name)) {
      cast.push(briefOf(entry));
      castNames.add(entry.card.name);
      continue;
    }
    const uncarded = bible.uncarded.find((item) => item.character && (item.name === name || item.aliases.includes(name)));
    if (uncarded && !castNames.has(uncarded.name)) {
      cast.push(uncardedBrief(uncarded));
      castNames.add(uncarded.name);
    }
  }
  const places = pick(bible.places, focus, focus.plannedPlaces ?? []);
  const items = pick(bible.items, focus);
  const lore = pick(bible.lore, focus);
  const otherCharacters = bible.characters
    .filter((entry) => entry !== protagonistEntry && !castNames.has(entry.card.name))
    .map((entry) => entry.card.name);
  return {
    canon: bible.canon.map((item) => clip(item.text)),
    story: bible.story.map((field) => clip(`${field.label}：${field.value}`)),
    ...(protagonistEntry ? { protagonist: briefOf(protagonistEntry) } : {}),
    cast,
    places: places.full.map(briefOf),
    items: items.full.map(briefOf),
    lore: lore.full.map(briefOf),
    otherNames: { places: places.rest, items: items.rest, lore: lore.rest, characters: otherCharacters },
    rules: rulesPack(bible.rules),
    exemplars: exemplarPromptItems(bible.rules),
  };
}

function briefLines(brief: SettingBrief): string[] {
  const head = `【${brief.name}】${brief.aliases && brief.aliases.length > 0 ? `（也叫：${brief.aliases.join("、")}）` : ""}${brief.uncarded ? "（还没建卡，只有账里记的）" : ""}`;
  return [
    head,
    ...brief.card.map((line) => `- ${line}`),
    ...(brief.relations ?? []).map((line) => `- ${line}`),
    ...(brief.fixed && brief.fixed.length > 0 ? ["- 正文里已经定下的：", ...brief.fixed.map((line) => `  - ${line}`)] : []),
    ...(brief.now && brief.now.length > 0 ? ["- 账里记的现状（以最新一章为准）：", ...brief.now.map((line) => `  - ${line}`)] : []),
  ];
}

function rulesLines(rules: SettingRulesPack): string[] {
  const list = (label: string, items: readonly string[]): string[] => (items.length > 0 ? [`- ${label}：${items.join("；")}`] : []);
  return [
    ...(rules.perspective ? [`- 视角：${rules.perspective}`] : []),
    ...list("文风", rules.style),
    ...(rules.targetWords ? [`- 每章目标字数：${rules.targetWords}`] : []),
    ...(rules.minWords ? [`- 每章最少字数：${rules.minWords}`] : []),
    ...list("一定要做到", rules.musts),
    ...list("一定不要写", rules.bans),
    ...list("别用的说法", rules.avoid),
  ];
}

/**
 * 设定包渲染成给模型读的文字（不用 JSON：中文转义费字数、也难读）。
 * 作者自定的写作规矩和文风样本单独提到前面（它们是每次都要照着写的）。
 */
export function renderSettingPack(pack: SettingPack): string[] {
  const out: string[] = [];
  if (pack.rules.notes?.trim()) out.push("## 作者自定写作规矩（务必遵守）", pack.rules.notes.trim(), "");
  if (pack.exemplars.length > 0) {
    out.push(
      "## 作者文风样本（模仿风格·不得照抄内容）",
      "以下是作者文风样本：模仿其句法节奏、用词偏好与叙事温度；不得照抄样本内容、情节或具体名物。",
      ...pack.exemplars.flatMap((item, index) => [`### 样本${index + 1}`, ...(item.note ? [`（注：${item.note}）`] : []), item.text, ""]),
    );
  }
  if (pack.canon.length > 0) {
    out.push("## 作者定论（前文说法打架时作者定下的，全书以它为准；写的时候不许和它矛盾）", ...pack.canon.map((line) => `- ${line}`), "");
  }
  const rules = rulesLines(pack.rules);
  if (rules.length > 0) out.push("## 写作规则", ...rules, "");
  if (pack.story.length > 0) out.push("## 故事设定", ...pack.story.map((line) => `- ${line}`), "");
  const group = (title: string, briefs: readonly SettingBrief[]): void => {
    if (briefs.length > 0) out.push(`## ${title}`, ...briefs.flatMap((brief) => [...briefLines(brief), ""]));
  };
  group("主角", pack.protagonist ? [pack.protagonist] : []);
  group("本章相关人物", pack.cast);
  group("地点", pack.places);
  group("物品", pack.items);
  group("其他设定", pack.lore);
  const others = [
    ...(pack.otherNames.characters.length > 0 ? [`- 人物：${pack.otherNames.characters.join("、")}`] : []),
    ...(pack.otherNames.places.length > 0 ? [`- 地点：${pack.otherNames.places.join("、")}`] : []),
    ...(pack.otherNames.items.length > 0 ? [`- 物品：${pack.otherNames.items.join("、")}`] : []),
    ...(pack.otherNames.lore.length > 0 ? [`- 设定：${pack.otherNames.lore.join("、")}`] : []),
  ];
  if (others.length > 0) out.push("## 设定本里还有（这次没展开，用到时别写成别的样子，也别编出重名的）", ...others, "");
  return out;
}
