/**
 * 设定卡（作者裁定的一部分，PLAN.md 第 57 行）：`ledger/cards.json`。
 *
 * 只放作者定的、不会变的：人是谁、长什么样、地方是什么样、物件有什么规矩、这本书怎么写。
 * 会变的（在哪、在谁手里、知道什么）不进卡，一律从账（投影）算。
 *
 * 只由两条命令写：`card.write`（作者档，写下的一律算作者的）、`card.fill`（AI 档，只能补空的、改自己补的）。
 * 每个值都记着是谁写的（by），作者写的 AI 永远改不了。
 *
 * 字段不做死：人物、地点、物品、设定和故事设定都是「标签：内容」，作者想起什么标签都行（题材中立）。
 * 代码要认语义的只有主角标记和写作规则。编号（k- / r- / e-）只给程序用，展示一律用名字。
 */
import { z } from "zod";

export const SETTING_CARDS_SCHEMA = "setting-cards/1" as const;

export const CARD_NAME_MAX = 40;
export const FIELD_LABEL_MAX = 20;
export const FIELD_VALUE_MAX = 4_000;
export const FIELDS_PER_CARD_MAX = 40;
export const RULE_ITEM_MAX = 400;
export const RULE_LIST_MAX = 40;
export const EXEMPLAR_TEXT_MAX = 3_000;
export const EXEMPLARS_MAX = 12;
export const CANON_TEXT_MAX = 400;
export const CANON_MAX = 200;
export const SKIPPED_MAX = 500;

const text = z.string().trim().min(1);

export const CardAuthor = z.enum(["author", "ai"]);
export type CardAuthor = z.infer<typeof CardAuthor>;

const prov = { by: CardAuthor, at: text };

export const CardKind = z.enum(["character", "place", "item", "lore"]);
export type CardKind = z.infer<typeof CardKind>;

export const CardField = z.object({ label: text.max(FIELD_LABEL_MAX), value: text.max(FIELD_VALUE_MAX), ...prov });
export type CardField = z.infer<typeof CardField>;

export const Card = z.object({
  id: text,
  kind: CardKind,
  name: text.max(CARD_NAME_MAX),
  aliases: z.array(text.max(CARD_NAME_MAX)),
  /** 主角（全书至多一张）。 */
  protagonist: z.literal(true).optional(),
  fields: z.array(CardField).max(FIELDS_PER_CARD_MAX),
  ...prov,
});
export type Card = z.infer<typeof Card>;

/** 两张卡之间的关系：label 是这两人（两样东西）关系的一句话，两张卡上都显示「和 X：label」。 */
export const Relation = z.object({ id: text, a: text, b: text, label: text.max(FIELD_VALUE_MAX), ...prov });
export type Relation = z.infer<typeof Relation>;

export const RuleText = z.object({ value: text.max(FIELD_VALUE_MAX), ...prov });
export type RuleText = z.infer<typeof RuleText>;
export const RuleNumber = z.object({ value: z.number().int().min(1).max(100_000), ...prov });
export type RuleNumber = z.infer<typeof RuleNumber>;
export const RuleItem = z.object({ text: text.max(RULE_ITEM_MAX), ...prov });
export type RuleItem = z.infer<typeof RuleItem>;
export const Exemplar = z.object({ id: text, text: text.max(EXEMPLAR_TEXT_MAX), note: text.max(RULE_ITEM_MAX).optional(), ...prov });
export type Exemplar = z.infer<typeof Exemplar>;

/**
 * 定论（P12）：前文自己打架时作者定下的说法，一条一句（「杜长顺十年前去世」）。全书最高：核账、写手、章纲员都以它为准，
 * 和它不一致的句子不管在哪一章都算写错了。只能是作者的——AI 只能提，作者点「确认」才记（所以不带 by）。
 */
export const CanonItem = z.object({ id: text, text: text.max(CANON_TEXT_MAX), at: text });
export type CanonItem = z.infer<typeof CanonItem>;

export const RULE_LISTS = ["style", "musts", "bans", "avoid"] as const;
export type RuleList = (typeof RULE_LISTS)[number];
export const RULE_SCALARS = ["perspective", "notes", "targetWords", "minWords"] as const;
export type RuleScalar = (typeof RULE_SCALARS)[number];

/** 写作规则：这本书怎么写。代码认它（字数、视角、禁写、别用的说法、文风样本）。 */
export const WritingRules = z.object({
  /** 视角（「第三人称，紧跟主角」）。 */
  perspective: RuleText.optional(),
  /** 文风（一条一句）。 */
  style: z.array(RuleItem).max(RULE_LIST_MAX),
  targetWords: RuleNumber.optional(),
  minWords: RuleNumber.optional(),
  /** 一定要做到的写法。 */
  musts: z.array(RuleItem).max(RULE_LIST_MAX),
  /** 一定不要写的。 */
  bans: z.array(RuleItem).max(RULE_LIST_MAX),
  /** 别用的说法、句式（机器腔）。 */
  avoid: z.array(RuleItem).max(RULE_LIST_MAX),
  /** 作者的补充（自由一段，可多行）。 */
  notes: RuleText.optional(),
  /** 文风样本：作者的原文片段，写稿时照它的节奏和用词。 */
  exemplars: z.array(Exemplar).max(EXEMPLARS_MAX),
});
export type WritingRules = z.infer<typeof WritingRules>;

export const SettingCardsFile = z.object({
  schema: z.literal(SETTING_CARDS_SCHEMA),
  /** 故事设定：一句话、题材、基调、世界规矩……都是「标签：内容」。 */
  story: z.object({ fields: z.array(CardField).max(FIELDS_PER_CARD_MAX) }),
  rules: WritingRules,
  cards: z.array(Card),
  relations: z.array(Relation),
  /** 定论（P12 起；老文件没有这一栏，读进来是空的）。 */
  canon: z.array(CanonItem).max(CANON_MAX).default([]),
  /** 作者说「不用建卡」的名字（账里记着的泛称、群体、物件……）：不再列进「还没建卡」、不再提醒；老文件没有这一栏。 */
  skipped: z.array(text.max(CARD_NAME_MAX)).max(SKIPPED_MAX).default([]),
  /**
   * 历法（P3a）：换天规矩——过了半夜就算第二天（midnight）/ 天亮才算第二天（dawn）；缺 = 没定，时间两种都推（设计 2.4）。
   * 只有作者写（card.write），AI 补不了。
   */
  calendar: z.object({ dayBoundary: z.enum(["midnight", "dawn"]).optional(), at: text.optional() }).optional(),
});
export type SettingCardsFile = z.infer<typeof SettingCardsFile>;

export function emptyWritingRules(): WritingRules {
  return { style: [], musts: [], bans: [], avoid: [], exemplars: [] };
}

export function emptySettingCards(): SettingCardsFile {
  return { schema: SETTING_CARDS_SCHEMA, story: { fields: [] }, rules: emptyWritingRules(), cards: [], relations: [], canon: [], skipped: [] };
}
