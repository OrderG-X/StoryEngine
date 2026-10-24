/**
 * 设定视图（重构 P9）：设定卡 + 账里记的，纯函数，界面、对话 AI、写手、核账员读的都是这一份。
 *
 * - 每张卡按名字 / 别名（nameKey，只认写法完全一样）对上投影里的出场人物和主体：带上出场章、
 *   账里记的现状（会变的，按最新一章）和定下的（不会变的），每条带哪章、原句。
 * - 账里有、卡里没有的列进 uncarded：出场人物一定是人物；别的主体不知道是什么，交给作者 / AI 分，不猜。
 * - 关系两端换成名字。编号只留给程序回指，展示时不许拼进文案。
 */
import type { CanonItem, Card, CardAuthor, CardField, CardKind, SettingCardsFile, WritingRules } from "../schema/cards.js";
import { nameKey } from "../text/quote.js";
import type { BookProjection, CastMember, FactView, SubjectView } from "../projection/types.js";

export interface BibleFact {
  readonly attribute: string;
  readonly value: string;
  readonly chapter: number;
  readonly quote?: string;
}

export interface BibleAppearances {
  readonly chapters: readonly number[];
  readonly first: number;
  readonly last: number;
  readonly viewpointChapters: number;
}

export interface BibleRelation {
  readonly id: string;
  readonly other: string;
  readonly label: string;
  readonly by: CardAuthor;
}

export interface BibleEntry {
  readonly card: Card;
  /** 账里出场时还用过的称呼（卡上没记的别名）。 */
  readonly ledgerAliases: readonly string[];
  readonly appearances?: BibleAppearances;
  /** 账里记的现状（会变的，按最新一章算）。 */
  readonly now: readonly BibleFact[];
  /** 账里记的定下的（不会变的）。 */
  readonly fixed: readonly BibleFact[];
  readonly relations: readonly BibleRelation[];
}

export interface UncardedEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  /** 出场人物（一定是人）；false = 账里的别的主体（不知道是什么）。 */
  readonly character: boolean;
  readonly appearances?: BibleAppearances;
  readonly now: readonly BibleFact[];
  readonly fixed: readonly BibleFact[];
}

export interface BibleRelationView {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly label: string;
  readonly by: CardAuthor;
}

export interface BibleView {
  readonly story: readonly CardField[];
  readonly rules: WritingRules;
  readonly characters: readonly BibleEntry[];
  readonly places: readonly BibleEntry[];
  readonly items: readonly BibleEntry[];
  readonly lore: readonly BibleEntry[];
  readonly relations: readonly BibleRelationView[];
  readonly uncarded: readonly UncardedEntry[];
  /** 定论（作者定下的，全书以它为准）。 */
  readonly canon: readonly CanonItem[];
  /** 主角卡的名字（没标就没有）。 */
  readonly protagonist?: string;
}

function namesOf(card: Card): string[] {
  return [card.name, ...card.aliases];
}

function factsOf(subject: SubjectView | undefined, facts: ReadonlyMap<string, FactView>): { now: BibleFact[]; fixed: BibleFact[] } {
  const now: BibleFact[] = [];
  const fixed: BibleFact[] = [];
  for (const attribute of subject?.attributes ?? []) {
    for (const id of attribute.current) {
      const fact = facts.get(id);
      if (!fact || fact.status !== "current") continue;
      const item: BibleFact = {
        attribute: attribute.attribute,
        value: fact.value ?? fact.text,
        chapter: fact.chapter,
        ...(fact.quote ? { quote: fact.quote } : {}),
      };
      (attribute.nature === "state" ? now : fixed).push(item);
    }
  }
  const byChapter = (a: BibleFact, b: BibleFact): number => b.chapter - a.chapter;
  return { now: now.sort(byChapter), fixed: fixed.sort((a, b) => a.chapter - b.chapter) };
}

function appearancesOf(member: CastMember | undefined): BibleAppearances | undefined {
  if (!member || member.chapters.length === 0) return undefined;
  return {
    chapters: member.chapters,
    first: Math.min(...member.chapters),
    last: Math.max(...member.chapters),
    viewpointChapters: member.viewpointChapters.length,
  };
}

export function bibleView(projection: BookProjection, cards: SettingCardsFile): BibleView {
  const facts = new Map(projection.facts.map((fact) => [fact.id, fact] as const));
  const castByKey = new Map<string, CastMember>();
  for (const member of projection.cast) {
    castByKey.set(member.key, member);
    for (const alias of member.aliases) if (!castByKey.has(nameKey(alias))) castByKey.set(nameKey(alias), member);
  }
  const subjectByKey = new Map(projection.subjects.map((subject) => [subject.key, subject] as const));
  const usedCast = new Set<string>();
  const usedSubjects = new Set<string>();
  const cardById = new Map(cards.cards.map((card) => [card.id, card] as const));

  const entryOf = (card: Card): BibleEntry => {
    const keys = namesOf(card).map(nameKey);
    const member = card.kind === "character" ? keys.map((key) => castByKey.get(key)).find((item) => item !== undefined) : undefined;
    if (member) usedCast.add(member.key);
    const subjectKeys = [...keys, ...(member ? [member.key, ...member.aliases.map(nameKey)] : [])];
    const subject = subjectKeys.map((key) => subjectByKey.get(key)).find((item) => item !== undefined);
    if (subject) usedSubjects.add(subject.key);
    const known = new Set(keys);
    const ledgerAliases = member ? [member.name, ...member.aliases].filter((alias) => !known.has(nameKey(alias))) : [];
    const relations = cards.relations
      .filter((relation) => relation.a === card.id || relation.b === card.id)
      .map((relation) => ({ relation, other: cardById.get(relation.a === card.id ? relation.b : relation.a) }))
      .filter((item): item is { relation: SettingCardsFile["relations"][number]; other: Card } => item.other !== undefined)
      .map(({ relation, other }) => ({ id: relation.id, other: other.name, label: relation.label, by: relation.by }));
    const appearances = appearancesOf(member);
    return { card, ledgerAliases, ...(appearances ? { appearances } : {}), ...factsOf(subject, facts), relations };
  };

  const entries = cards.cards.map(entryOf);
  const byKind = (kind: CardKind): BibleEntry[] => entries.filter((entry) => entry.card.kind === kind);
  const characters = byKind("character").sort((a, b) => {
    if (a.card.protagonist !== b.card.protagonist) return a.card.protagonist ? -1 : 1;
    const first = (entry: BibleEntry): number => entry.appearances?.first ?? Number.MAX_SAFE_INTEGER;
    return first(a) - first(b);
  });

  const uncarded: UncardedEntry[] = [];
  for (const member of projection.cast) {
    if (usedCast.has(member.key)) continue;
    const subject = [member.key, ...member.aliases.map(nameKey)].map((key) => subjectByKey.get(key)).find((item) => item !== undefined);
    if (subject) usedSubjects.add(subject.key);
    const appearances = appearancesOf(member);
    uncarded.push({ name: member.name, aliases: member.aliases, character: true, ...(appearances ? { appearances } : {}), ...factsOf(subject, facts) });
  }
  uncarded.sort((a, b) => (b.appearances?.chapters.length ?? 0) - (a.appearances?.chapters.length ?? 0));
  const others: UncardedEntry[] = [];
  for (const subject of projection.subjects) {
    if (usedSubjects.has(subject.key)) continue;
    const found = factsOf(subject, facts);
    if (found.now.length + found.fixed.length === 0) continue;
    others.push({ name: subject.name, aliases: [], character: false, ...found });
  }
  others.sort((a, b) => b.now.length + b.fixed.length - (a.now.length + a.fixed.length));

  const relations = cards.relations
    .map((relation) => ({ relation, a: cardById.get(relation.a), b: cardById.get(relation.b) }))
    .filter((item): item is { relation: SettingCardsFile["relations"][number]; a: Card; b: Card } => item.a !== undefined && item.b !== undefined)
    .map(({ relation, a, b }) => ({ id: relation.id, a: a.name, b: b.name, label: relation.label, by: relation.by }));

  const protagonist = cards.cards.find((card) => card.protagonist)?.name;
  return {
    story: cards.story.fields,
    rules: cards.rules,
    characters,
    places: byKind("place"),
    items: byKind("item"),
    lore: byKind("lore"),
    relations,
    uncarded: [...uncarded, ...others],
    canon: cards.canon,
    ...(protagonist ? { protagonist } : {}),
  };
}
