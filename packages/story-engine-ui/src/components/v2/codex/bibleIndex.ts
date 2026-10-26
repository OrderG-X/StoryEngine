/**
 * 设定视图 → 设定本搜索、⌘K、@ 提及、正文名字速览要的几份名单（重构 P9）。纯函数，只有名字，不带编号。
 */
import type { BibleEntry, BibleView } from "../../../api/bibleClient.js";
import type { BibleCat } from "./BibleBook.js";
import type { LibrarySearchSource } from "./librarySearch.js";
import type { PaletteCharacter } from "./CommandPalette.js";

const CARD_CATS = [
  { key: "characters", cat: "chars", label: "人物" },
  { key: "places", cat: "places", label: "地点" },
  { key: "items", cat: "items", label: "物品" },
  { key: "lore", cat: "story", label: "设定" },
] as const satisfies readonly { readonly key: keyof BibleView; readonly cat: BibleCat; readonly label: string }[];

function cardItems(entry: BibleEntry): string[] {
  return [
    [entry.card.name, ...entry.card.aliases].join(" "),
    ...entry.card.fields.map((field) => `${field.label}：${field.value}`),
  ];
}

/** 设定本搜索的条目：每张卡一组（点结果展开那张卡）、故事设定、写作规则、还没建卡的。 */
export function bibleSearchSources(bible: BibleView | null): LibrarySearchSource[] {
  if (!bible) return [];
  const rules = bible.rules;
  return [
    { cat: "story", catLabel: "故事设定", items: bible.story.map((field) => `${field.label}：${field.value}`) },
    { cat: "canon", catLabel: "定论", items: bible.canon.map((item) => item.text) },
    ...CARD_CATS.flatMap(({ key, cat, label }) =>
      bible[key].map((entry) => ({ cat, catLabel: label, focus: entry.card.name, items: cardItems(entry) }))),
    {
      cat: "rules",
      catLabel: "写作规则",
      items: [
        ...(rules.perspective ? [rules.perspective.value] : []),
        ...[...rules.style, ...rules.musts, ...rules.bans, ...rules.avoid].map((item) => item.text),
        ...(rules.notes ? [rules.notes.value] : []),
      ],
    },
    { cat: "uncarded", catLabel: "还没建卡", items: bible.uncarded.map((entry) => [entry.name, ...entry.aliases].join(" ")) },
  ];
}

/** ⌘K 里的人物：名字 + 身份（卡上有「身份」就带上，主角标主角）。 */
export function paletteCharactersOf(bible: BibleView | null): PaletteCharacter[] {
  if (!bible) return [];
  return bible.characters.map((entry) => ({
    name: entry.card.name,
    role: entry.card.protagonist ? "主角" : entry.card.fields.find((field) => field.label === "身份")?.value ?? "",
  }));
}

/** @ 提及候选：人物（卡 + 账里出场过的）、地点卡。 */
export function mentionNamesOf(bible: BibleView | null): { readonly characters: string[]; readonly locations: string[] } {
  if (!bible) return { characters: [], locations: [] };
  return {
    characters: [...bible.characters.map((entry) => entry.card.name), ...bible.uncarded.filter((entry) => entry.character).map((entry) => entry.name)],
    locations: bible.places.map((entry) => entry.card.name),
  };
}

export interface NamePeekCard {
  readonly name: string;
  /** 正文里可能出现的写法：卡名 + 别名 + 账里用过的称呼。 */
  readonly terms: readonly string[];
  readonly protagonist: boolean;
  /** 卡上前几栏（速览只看个大概）。 */
  readonly lines: readonly string[];
  /** 和谁什么关系。 */
  readonly relations: readonly string[];
  /** 账里记的现状。 */
  readonly now: readonly string[];
}

const PEEK_LINES = 3;

/** 正文名字速览：只看人物卡（名字至少两个字，防单字误中）。 */
export function namePeekCardsOf(bible: BibleView | null): NamePeekCard[] {
  if (!bible) return [];
  return bible.characters.map((entry) => ({
    name: entry.card.name,
    terms: [entry.card.name, ...entry.card.aliases, ...entry.ledgerAliases].filter((term) => Array.from(term.trim()).length >= 2),
    protagonist: entry.card.protagonist === true,
    lines: entry.card.fields.slice(0, PEEK_LINES).map((field) => `${field.label}：${field.value}`),
    relations: entry.relations.map((relation) => `和${relation.other}：${relation.label}`),
    now: entry.now.slice(0, PEEK_LINES).map((fact) => `${fact.attribute}：${fact.value}`),
  }));
}

/** 新书首屏「说说故事」那一步：设定本里有哪些卡（人物在前）。 */
export function starterCardNamesOf(bible: BibleView | null): string[] {
  if (!bible) return [];
  return [...bible.characters, ...bible.places, ...bible.items, ...bible.lore].map((entry) => entry.card.name);
}

/** 设定本左边分类后面的数（0 不显示）。 */
export function bibleNavCounts(bible: BibleView | null): Partial<Record<BibleCat, number>> {
  if (!bible) return {};
  return {
    canon: bible.canon.length,
    chars: bible.characters.length,
    relations: bible.relations.length,
    items: bible.items.length,
    places: bible.places.length,
    // 作者说过不用建卡的不算。
    uncarded: bible.uncarded.filter((entry) => !entry.skipped).length,
  };
}
