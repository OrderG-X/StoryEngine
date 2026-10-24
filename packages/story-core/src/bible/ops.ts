/**
 * 改设定卡的一步步操作（ops）：作者档 `card.write` 和 AI 档 `card.fill` 用同一套，区别只在权限。
 *
 * - 作者：什么都能改，写下的一律记成作者的（by: author）。
 * - AI：只能建新卡 / 新关系、填空的、改自己补的、加别名、列表加项、删自己加的项；碰作者写的就停（needs_author），
 *   交给作者点「确认改设定」。`splitForAi` 先替对话 AI 把一批 ops 拆成「能直接做的」和「要作者点头的」。
 *
 * 卡用名字或别名指（nameKey 比，只认写法完全一样）；同一批里前面新建的卡，后面的 op 就能用。
 * 一批 ops 要么全做、要么全不做。给人看的话（lines）只有名字，不带编号。
 */
import { z } from "zod";
import {
  CANON_MAX,
  CANON_TEXT_MAX,
  CARD_NAME_MAX,
  CardKind,
  EXEMPLAR_TEXT_MAX,
  EXEMPLARS_MAX,
  FIELD_LABEL_MAX,
  FIELD_VALUE_MAX,
  FIELDS_PER_CARD_MAX,
  RULE_ITEM_MAX,
  RULE_LIST_MAX,
  RULE_LISTS,
  RULE_SCALARS,
  type Card,
  type CardAuthor,
  type CardField,
  type SettingCardsFile,
} from "../schema/cards.js";
import { nameKey } from "../text/quote.js";

const name = z.string().trim().min(1).max(CARD_NAME_MAX);
const label = z.string().trim().min(1).max(FIELD_LABEL_MAX);
/** 空串 = 删掉这一项。 */
const value = z.string().trim().max(FIELD_VALUE_MAX);
const ref = z.string().trim().min(1).max(80);
const names = z.array(name).max(12);

export const CardOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("card.create"),
    kind: CardKind,
    name,
    aliases: names.optional(),
    fields: z.array(z.object({ label, value: value.min(1) })).max(FIELDS_PER_CARD_MAX).optional(),
    protagonist: z.boolean().optional(),
  }),
  z.object({ op: z.literal("card.rename"), card: ref, name }),
  z.object({ op: z.literal("card.aliases"), card: ref, add: names.optional(), remove: names.optional() }),
  z.object({ op: z.literal("card.kind"), card: ref, kind: CardKind }),
  z.object({ op: z.literal("card.delete"), card: ref }),
  z.object({ op: z.literal("card.protagonist"), card: ref }),
  z.object({ op: z.literal("field.set"), card: ref, label, value }),
  z.object({ op: z.literal("field.accept"), card: ref, label: label.optional() }),
  z.object({ op: z.literal("story.set"), label, value }),
  z.object({ op: z.literal("story.accept"), label: label.optional() }),
  z.object({ op: z.literal("relation.set"), a: ref, b: ref, label: value }),
  z.object({
    op: z.literal("rules.set"),
    field: z.enum(RULE_SCALARS),
    /** 视角 / 补充是一段字；字数是正整数。空串、0、null = 删掉。 */
    value: z.union([z.string().trim().max(FIELD_VALUE_MAX), z.number().int().min(0).max(100_000), z.null()]),
  }),
  z.object({ op: z.literal("rules.add"), list: z.enum(RULE_LISTS), text: z.string().trim().min(1).max(RULE_ITEM_MAX) }),
  z.object({ op: z.literal("rules.remove"), list: z.enum(RULE_LISTS), text: z.string().trim().min(1).max(RULE_ITEM_MAX) }),
  z.object({ op: z.literal("rules.accept") }),
  z.object({ op: z.literal("exemplar.add"), text: z.string().trim().min(1).max(EXEMPLAR_TEXT_MAX), note: z.string().trim().max(RULE_ITEM_MAX).optional() }),
  z.object({ op: z.literal("exemplar.remove"), exemplar: ref }),
  /** 定论（P12）：只有作者能记、能改；AI 提的一律等作者点头。 */
  z.object({ op: z.literal("canon.add"), text: z.string().trim().min(1).max(CANON_TEXT_MAX) }),
  /** 改一条定论（按编号或原文认）；空串 = 删掉。 */
  z.object({ op: z.literal("canon.set"), canon: z.string().trim().min(1).max(CANON_TEXT_MAX), text: z.string().trim().max(CANON_TEXT_MAX) }),
]);
export type CardOp = z.infer<typeof CardOp>;

export const MAX_OPS_PER_CHANGE = 60;
export const CardOps = z.array(CardOp).min(1).max(MAX_OPS_PER_CHANGE);

export const KIND_LABELS: Record<Card["kind"], string> = { character: "人物", place: "地点", item: "物品", lore: "设定" };
export const RULE_LIST_LABELS = { style: "文风", musts: "一定要做到", bans: "一定不要写", avoid: "别用的说法" } as const;
export const RULE_SCALAR_LABELS = { perspective: "视角", notes: "补充", targetWords: "每章目标字数", minWords: "每章至少字数" } as const;

export interface OpContext {
  readonly by: CardAuthor;
  readonly at: string;
}

type Step = { readonly ok: true; readonly file: SettingCardsFile; readonly line?: string } | { readonly ok: false; readonly code: "needs_author" | "invalid"; readonly message: string };

const invalid = (message: string): Step => ({ ok: false, code: "invalid", message });
const needsAuthor = (message: string): Step => ({ ok: false, code: "needs_author", message });

const same = (a: string, b: string): boolean => nameKey(a) === nameKey(b);

export function findCard(file: SettingCardsFile, cardRef: string): Card | undefined {
  const trimmed = cardRef.trim();
  return file.cards.find((card) => card.id === trimmed)
    ?? file.cards.find((card) => same(card.name, trimmed) || card.aliases.some((alias) => same(alias, trimmed)));
}

/** 这个名字已经被哪张卡占了（卡名和别名全书不重复）。 */
function nameTaken(file: SettingCardsFile, candidate: string, except?: string): Card | undefined {
  return file.cards.find((card) => card.id !== except && (same(card.name, candidate) || card.aliases.some((alias) => same(alias, candidate))));
}

function nextId(ids: readonly string[], prefix: string): string {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const seq = Number(id.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return `${prefix}${max + 1}`;
}

const quoted = (text: string): string => `「${text}」`;
const authorOwned = (card: Card): boolean => card.by === "author" || card.fields.some((field) => field.by === "author");

function setField(fields: readonly CardField[], fieldLabel: string, fieldValue: string, context: OpContext): { fields: CardField[]; verb?: string } | { error: Step } {
  const index = fields.findIndex((field) => same(field.label, fieldLabel));
  const existing = index >= 0 ? fields[index] : undefined;
  if (context.by === "ai" && existing?.by === "author") return { error: needsAuthor(`${quoted(existing.label)}是你写的，AI 改要你点头`) };
  if (!fieldValue) {
    if (!existing) return { fields: [...fields] };
    return { fields: fields.filter((_, at) => at !== index), verb: "删了" };
  }
  if (existing && existing.value === fieldValue && existing.by === context.by) return { fields: [...fields] };
  if (!existing && fields.length >= FIELDS_PER_CARD_MAX) return { error: invalid(`一张卡最多 ${FIELDS_PER_CARD_MAX} 项`) };
  const next: CardField = { label: existing?.label ?? fieldLabel, value: fieldValue, by: context.by, at: context.at };
  const copy = [...fields];
  if (existing) copy[index] = next;
  else copy.push(next);
  return { fields: copy, verb: existing ? (existing.value === fieldValue ? "认下了" : "改了") : "写上了" };
}

function acceptFields(fields: readonly CardField[], fieldLabel: string | undefined, context: OpContext): { fields: CardField[]; count: number } {
  let count = 0;
  const next = fields.map((field) => {
    if (field.by !== "ai" || (fieldLabel !== undefined && !same(field.label, fieldLabel))) return field;
    count += 1;
    return { ...field, by: "author" as const, at: context.at };
  });
  return { fields: next, count };
}

function replaceCard(file: SettingCardsFile, card: Card): SettingCardsFile {
  return { ...file, cards: file.cards.map((item) => (item.id === card.id ? card : item)) };
}

/** 做一步。AI 碰了作者的东西返回 needs_author；指错了、超限返回 invalid。 */
export function applyCardOp(file: SettingCardsFile, op: CardOp, context: OpContext): Step {
  const ai = context.by === "ai";
  switch (op.op) {
    case "card.create": {
      const taken = [op.name, ...(op.aliases ?? [])].map((item) => ({ item, card: nameTaken(file, item) })).find((hit) => hit.card);
      if (taken?.card) return invalid(`已经有叫${quoted(taken.item)}的卡了（${KIND_LABELS[taken.card.kind]}卡${quoted(taken.card.name)}）`);
      const aliases = dedupe((op.aliases ?? []).filter((alias) => !same(alias, op.name)));
      const fields: CardField[] = [];
      for (const field of op.fields ?? []) {
        if (fields.some((item) => same(item.label, field.label))) continue;
        fields.push({ label: field.label, value: field.value, by: context.by, at: context.at });
      }
      const card: Card = { id: nextId(file.cards.map((item) => item.id), "k-"), kind: op.kind, name: op.name, aliases, fields, by: context.by, at: context.at };
      let next: SettingCardsFile = { ...file, cards: [...file.cards, card] };
      if (op.protagonist) {
        const step = applyCardOp(next, { op: "card.protagonist", card: card.id }, context);
        if (!step.ok) return step;
        next = step.file;
      }
      return { ok: true, file: next, line: `建了${KIND_LABELS[op.kind]}卡${quoted(op.name)}${op.protagonist ? "（主角）" : ""}` };
    }
    case "card.rename": {
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      if (card.name === op.name) return { ok: true, file };
      if (ai && authorOwned(card)) return needsAuthor(`${quoted(card.name)}是你建的卡，改名要你点头`);
      const taken = nameTaken(file, op.name, card.id);
      if (taken) return invalid(`已经有叫${quoted(op.name)}的卡了`);
      const aliases = card.aliases.filter((alias) => !same(alias, op.name));
      return { ok: true, file: replaceCard(file, { ...card, name: op.name, aliases }), line: `${quoted(card.name)}改名为${quoted(op.name)}` };
    }
    case "card.aliases": {
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      const remove = op.remove ?? [];
      if (ai && remove.length > 0 && authorOwned(card)) return needsAuthor(`去掉${quoted(card.name)}的别名要你点头`);
      let aliases = card.aliases.filter((alias) => !remove.some((item) => same(item, alias)));
      const added: string[] = [];
      for (const alias of op.add ?? []) {
        if (same(alias, card.name) || aliases.some((item) => same(item, alias))) continue;
        const taken = nameTaken(file, alias, card.id);
        if (taken) return invalid(`${quoted(alias)}已经是${quoted(taken.name)}的名字了`);
        aliases = [...aliases, alias];
        added.push(alias);
      }
      const removed = card.aliases.length + added.length - aliases.length;
      if (added.length === 0 && removed === 0) return { ok: true, file };
      const parts = [added.length > 0 ? `加了别名${added.map(quoted).join("")}` : "", removed > 0 ? `去掉了 ${removed} 个别名` : ""].filter(Boolean);
      return { ok: true, file: replaceCard(file, { ...card, aliases }), line: `${quoted(card.name)}${parts.join("，")}` };
    }
    case "card.kind": {
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      if (card.kind === op.kind) return { ok: true, file };
      if (ai && authorOwned(card)) return needsAuthor(`${quoted(card.name)}是你建的卡，换类要你点头`);
      const next = { ...card, kind: op.kind };
      if (op.kind !== "character") delete (next as { protagonist?: true }).protagonist;
      return { ok: true, file: replaceCard(file, next), line: `${quoted(card.name)}改成${KIND_LABELS[op.kind]}卡` };
    }
    case "card.delete": {
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      const relations = file.relations.filter((relation) => relation.a === card.id || relation.b === card.id);
      if (ai && (authorOwned(card) || relations.some((relation) => relation.by === "author"))) return needsAuthor(`删${quoted(card.name)}要你点头`);
      return {
        ok: true,
        file: { ...file, cards: file.cards.filter((item) => item.id !== card.id), relations: file.relations.filter((relation) => !relations.includes(relation)) },
        line: `删了${KIND_LABELS[card.kind]}卡${quoted(card.name)}`,
      };
    }
    case "card.protagonist": {
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      if (card.kind !== "character") return invalid(`${quoted(card.name)}不是人物卡，当不了主角`);
      if (card.protagonist) return { ok: true, file };
      const current = file.cards.find((item) => item.protagonist);
      if (ai && current) return needsAuthor(`主角现在是${quoted(current.name)}，换主角要你点头`);
      const cards = file.cards.map((item) => {
        if (item.id === card.id) return { ...item, protagonist: true as const };
        if (!item.protagonist) return item;
        const rest = { ...item };
        delete (rest as { protagonist?: true }).protagonist;
        return rest;
      });
      return { ok: true, file: { ...file, cards }, line: `${quoted(card.name)}设为主角` };
    }
    case "field.set": {
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      const result = setField(card.fields, op.label, op.value, context);
      if ("error" in result) return result.error;
      if (!result.verb) return { ok: true, file };
      return { ok: true, file: replaceCard(file, { ...card, fields: result.fields }), line: `${quoted(card.name)}的${quoted(op.label)}${result.verb}` };
    }
    case "field.accept": {
      if (ai) return needsAuthor("认下 AI 补的要你自己点");
      const card = findCard(file, op.card);
      if (!card) return invalid(`没有叫${quoted(op.card)}的卡`);
      const result = acceptFields(card.fields, op.label, context);
      const cardAccepted = op.label === undefined && card.by === "ai";
      if (result.count === 0 && !cardAccepted) return { ok: true, file };
      return {
        ok: true,
        file: replaceCard(file, { ...card, fields: result.fields, ...(cardAccepted ? { by: "author" as const, at: context.at } : {}) }),
        line: `认下了${quoted(card.name)}里 AI 补的${op.label ? quoted(op.label) : ` ${result.count} 项`}`,
      };
    }
    case "story.set": {
      const result = setField(file.story.fields, op.label, op.value, context);
      if ("error" in result) return result.error;
      if (!result.verb) return { ok: true, file };
      return { ok: true, file: { ...file, story: { fields: result.fields } }, line: `故事设定${quoted(op.label)}${result.verb}` };
    }
    case "story.accept": {
      if (ai) return needsAuthor("认下 AI 补的要你自己点");
      const result = acceptFields(file.story.fields, op.label, context);
      if (result.count === 0) return { ok: true, file };
      return { ok: true, file: { ...file, story: { fields: result.fields } }, line: `认下了故事设定里 AI 补的 ${result.count} 项` };
    }
    case "relation.set": {
      const a = findCard(file, op.a);
      const b = findCard(file, op.b);
      if (!a) return invalid(`没有叫${quoted(op.a)}的卡`);
      if (!b) return invalid(`没有叫${quoted(op.b)}的卡`);
      if (a.id === b.id) return invalid(`${quoted(a.name)}和自己没法记关系`);
      const existing = file.relations.find((relation) => (relation.a === a.id && relation.b === b.id) || (relation.a === b.id && relation.b === a.id));
      if (ai && existing?.by === "author") return needsAuthor(`${quoted(a.name)}和${quoted(b.name)}的关系是你写的，AI 改要你点头`);
      const pair = `${quoted(a.name)}和${quoted(b.name)}的关系`;
      if (!op.label) {
        if (!existing) return { ok: true, file };
        return { ok: true, file: { ...file, relations: file.relations.filter((relation) => relation !== existing) }, line: `${pair}删了` };
      }
      if (existing && existing.label === op.label && existing.by === context.by) return { ok: true, file };
      if (existing) {
        return {
          ok: true,
          file: { ...file, relations: file.relations.map((relation) => (relation === existing ? { ...relation, label: op.label, by: context.by, at: context.at } : relation)) },
          line: `${pair}改了`,
        };
      }
      const relation = { id: nextId(file.relations.map((item) => item.id), "r-"), a: a.id, b: b.id, label: op.label, by: context.by, at: context.at };
      return { ok: true, file: { ...file, relations: [...file.relations, relation] }, line: `${pair}写上了` };
    }
    case "rules.set": {
      const fieldLabel = RULE_SCALAR_LABELS[op.field];
      const rules = file.rules;
      const existing = rules[op.field];
      if (ai && existing?.by === "author") return needsAuthor(`写作规则${quoted(fieldLabel)}是你定的，AI 改要你点头`);
      const numeric = op.field === "targetWords" || op.field === "minWords";
      const raw = op.value;
      let next: string | number | undefined;
      if (numeric) {
        const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : 0;
        if (!Number.isInteger(parsed) || parsed < 0) return invalid(`${quoted(fieldLabel)}要写一个整数`);
        next = parsed > 0 ? parsed : undefined;
      } else {
        if (typeof raw === "number") return invalid(`${quoted(fieldLabel)}要写一段字`);
        next = raw?.trim() || undefined;
      }
      if (next === undefined) {
        if (!existing) return { ok: true, file };
        const copy = { ...rules };
        delete copy[op.field];
        return { ok: true, file: { ...file, rules: copy }, line: `写作规则${quoted(fieldLabel)}删了` };
      }
      if (existing && existing.value === next && existing.by === context.by) return { ok: true, file };
      return {
        ok: true,
        file: { ...file, rules: { ...rules, [op.field]: { value: next, by: context.by, at: context.at } } },
        line: `写作规则${quoted(fieldLabel)}${existing ? "改了" : "写上了"}`,
      };
    }
    case "rules.add": {
      const list = file.rules[op.list];
      if (list.some((item) => same(item.text, op.text))) return { ok: true, file };
      if (list.length >= RULE_LIST_MAX) return invalid(`${quoted(RULE_LIST_LABELS[op.list])}最多 ${RULE_LIST_MAX} 条`);
      return {
        ok: true,
        file: { ...file, rules: { ...file.rules, [op.list]: [...list, { text: op.text, by: context.by, at: context.at }] } },
        line: `写作规则${quoted(RULE_LIST_LABELS[op.list])}加了一条`,
      };
    }
    case "rules.remove": {
      const list = file.rules[op.list];
      const item = list.find((entry) => same(entry.text, op.text));
      if (!item) return invalid(`${quoted(RULE_LIST_LABELS[op.list])}里没有这一条`);
      if (ai && item.by === "author") return needsAuthor(`这条${quoted(RULE_LIST_LABELS[op.list])}是你定的，AI 删要你点头`);
      return {
        ok: true,
        file: { ...file, rules: { ...file.rules, [op.list]: list.filter((entry) => entry !== item) } },
        line: `写作规则${quoted(RULE_LIST_LABELS[op.list])}删了一条`,
      };
    }
    case "rules.accept": {
      if (ai) return needsAuthor("认下 AI 补的要你自己点");
      let count = 0;
      const own = <T extends { by: CardAuthor }>(item: T): T => {
        if (item.by !== "ai") return item;
        count += 1;
        return { ...item, by: "author", at: context.at };
      };
      const rules = file.rules;
      const next = {
        ...rules,
        style: rules.style.map(own),
        musts: rules.musts.map(own),
        bans: rules.bans.map(own),
        avoid: rules.avoid.map(own),
        exemplars: rules.exemplars.map(own),
        ...(rules.perspective ? { perspective: own(rules.perspective) } : {}),
        ...(rules.notes ? { notes: own(rules.notes) } : {}),
        ...(rules.targetWords ? { targetWords: own(rules.targetWords) } : {}),
        ...(rules.minWords ? { minWords: own(rules.minWords) } : {}),
      };
      if (count === 0) return { ok: true, file };
      return { ok: true, file: { ...file, rules: next }, line: `认下了写作规则里 AI 补的 ${count} 项` };
    }
    case "exemplar.add": {
      const exemplars = file.rules.exemplars;
      if (exemplars.some((item) => item.text === op.text)) return { ok: true, file };
      if (exemplars.length >= EXEMPLARS_MAX) return invalid(`文风样本最多 ${EXEMPLARS_MAX} 段，先删一段`);
      const exemplar = {
        id: nextId(exemplars.map((item) => item.id), "e-"),
        text: op.text,
        ...(op.note ? { note: op.note } : {}),
        by: context.by,
        at: context.at,
      };
      return { ok: true, file: { ...file, rules: { ...file.rules, exemplars: [...exemplars, exemplar] } }, line: "加了一段文风样本" };
    }
    case "canon.add": {
      if (ai) return needsAuthor("定论要你自己定");
      if (file.canon.some((item) => same(item.text, op.text))) return { ok: true, file };
      if (file.canon.length >= CANON_MAX) return invalid(`定论最多 ${CANON_MAX} 条，先删几条旧的`);
      const item = { id: nextId(file.canon.map((entry) => entry.id), "n-"), text: op.text, at: context.at };
      return { ok: true, file: { ...file, canon: [...file.canon, item] }, line: `记下定论${quoted(op.text)}` };
    }
    case "canon.set": {
      if (ai) return needsAuthor("定论要你自己改");
      const target = op.canon.trim();
      const item = file.canon.find((entry) => entry.id === target) ?? file.canon.find((entry) => same(entry.text, target));
      if (!item) return invalid(`没有这条定论${quoted(target)}`);
      if (!op.text) return { ok: true, file: { ...file, canon: file.canon.filter((entry) => entry !== item) }, line: `删了定论${quoted(item.text)}` };
      if (item.text === op.text) return { ok: true, file };
      return {
        ok: true,
        file: { ...file, canon: file.canon.map((entry) => (entry === item ? { ...entry, text: op.text, at: context.at } : entry)) },
        line: `定论${quoted(item.text)}改成${quoted(op.text)}`,
      };
    }
    case "exemplar.remove": {
      const exemplars = file.rules.exemplars;
      const target = op.exemplar.trim();
      const exemplar = exemplars.find((item) => item.id === target)
        ?? (target.length >= 8 ? single(exemplars.filter((item) => item.text.startsWith(target))) : undefined);
      if (!exemplar) return invalid("没找到这段文风样本（按开头至少 8 个字认）");
      if (ai && exemplar.by === "author") return needsAuthor("这段文风样本是你放的，AI 删要你点头");
      return { ok: true, file: { ...file, rules: { ...file.rules, exemplars: exemplars.filter((item) => item !== exemplar) } }, line: "删了一段文风样本" };
    }
  }
}

function single<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function dedupe(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of items) if (!out.some((existing) => same(existing, item))) out.push(item);
  return out;
}

export type ApplyResult =
  | { readonly ok: true; readonly file: SettingCardsFile; readonly lines: readonly string[] }
  | { readonly ok: false; readonly code: "needs_author" | "invalid"; readonly message: string; readonly index: number };

/** 一批 ops 按顺序做；有一步不成整批不算（返回第几步、为什么）。 */
export function applyCardOps(file: SettingCardsFile, ops: readonly CardOp[], context: OpContext): ApplyResult {
  let current = file;
  const lines: string[] = [];
  for (const [index, op] of ops.entries()) {
    const step = applyCardOp(current, op, context);
    if (!step.ok) return { ok: false, code: step.code, message: step.message, index };
    current = step.file;
    if (step.line) lines.push(step.line);
  }
  return { ok: true, file: current, lines };
}

export interface AiSplit {
  /** AI 能直接做的（走 card.fill）。 */
  readonly direct: readonly CardOp[];
  /** 碰了作者写的，要作者点「确认改设定」（走 card.write）。 */
  readonly needsAuthor: readonly { readonly op: CardOp; readonly reason: string }[];
  /** 指错了、超限了：哪条、为什么，如实告诉 AI。 */
  readonly invalid: readonly { readonly op: CardOp; readonly reason: string }[];
}

/**
 * 替对话 AI 拆一批 ops：按顺序在草稿上试做，能做的进 direct，碰作者写的进 needsAuthor（草稿上不做，后面依赖它的照样会被拦下）。
 * 指错的进 invalid。
 */
export function splitForAi(file: SettingCardsFile, ops: readonly CardOp[], at: string): AiSplit {
  let current = file;
  const direct: CardOp[] = [];
  const blocked: { op: CardOp; reason: string }[] = [];
  const wrong: { op: CardOp; reason: string }[] = [];
  for (const op of ops) {
    const step = applyCardOp(current, op, { by: "ai", at });
    if (step.ok) {
      current = step.file;
      direct.push(op);
    } else if (step.code === "needs_author") {
      blocked.push({ op, reason: step.message });
    } else if (blocked.length > 0) {
      // 多半是跟着前面被拦下的那步（比如先改名、再按新名字改字段）：一起交给作者，作者点了按顺序做，真指错了那时如实报。
      blocked.push({ op, reason: step.message });
    } else {
      wrong.push({ op, reason: step.message });
    }
  }
  return { direct, needsAuthor: blocked, invalid: wrong };
}
