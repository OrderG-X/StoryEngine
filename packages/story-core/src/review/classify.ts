/**
 * 定稿清单上哪几条要作者亲眼看：规则写死在代码里，不问模型。其余的自动记下、可撤销。
 *
 * 要看的只有会「丢东西」或「改旧账」的：
 *  - 不会变的事实和前文对不上（hard-conflict）
 *  - 明写推翻前文某条事实（replaces-fact）
 *  - 收掉一条线索（closes-thread）——收错了线索就丢了
 *  - 新面孔（new-character）——可能是已有人物的新称呼
 *  - 天数是估的（time-estimated / time-missing）
 * 目标：一章要看的 ≤ 8 条（重构计划第一节）。
 */
import { nameKey } from "../text/quote.js";
import type { EntryInput } from "../schema/ledger.js";
import type { BookProjection } from "../projection/types.js";

export type ReviewReason = "hard-conflict" | "replaces-fact" | "closes-thread" | "new-character" | "time-estimated";

export interface ClassifiedEntry {
  readonly index: number;
  readonly entry: EntryInput;
  readonly reasons: readonly ReviewReason[];
}

export interface ReviewPlan {
  /** 要作者看的。 */
  readonly review: readonly ClassifiedEntry[];
  /** 自动记下的。 */
  readonly auto: readonly ClassifiedEntry[];
  /** 本章没有时间条目（第 1 章除外）：投影会按上一章 +1 估，清单上要请作者确认天数。 */
  readonly timeMissing: boolean;
}

export interface ClassifyOptions {
  readonly chapter: number;
  /** 设定卡上已有的人名（还没在账单里出场过的也算认识）。 */
  readonly knownNames?: readonly string[];
}

export function classifyForReview(
  entries: readonly { readonly index: number; readonly entry: EntryInput }[],
  before: BookProjection,
  options: ClassifyOptions,
): ReviewPlan {
  const aliasToKey = new Map<string, string>();
  for (const member of before.cast) {
    aliasToKey.set(member.key, member.key);
    for (const alias of member.aliases) aliasToKey.set(nameKey(alias), member.key);
  }
  const known = new Set([...aliasToKey.keys(), ...(options.knownNames ?? []).map(nameKey)]);
  const resolve = (name: string): string => aliasToKey.get(nameKey(name)) ?? nameKey(name);
  const hardValues = new Map<string, Set<string>>();
  for (const fact of before.facts) {
    if (fact.nature !== "hard" || fact.status !== "current" || fact.attributeKey === undefined) continue;
    const key = `${fact.subjectKey}|${fact.attributeKey}`;
    const values = hardValues.get(key) ?? new Set<string>();
    values.add(nameKey(fact.value ?? ""));
    hardValues.set(key, values);
  }

  const review: ClassifiedEntry[] = [];
  const auto: ClassifiedEntry[] = [];
  let hasTime = false;
  for (const { index, entry } of entries) {
    const reasons: ReviewReason[] = [];
    if (entry.kind === "fact") {
      if (entry.replaces) reasons.push("replaces-fact");
      if (entry.nature === "hard" && entry.subject && entry.attribute && entry.value) {
        const values = hardValues.get(`${resolve(entry.subject)}|${nameKey(entry.attribute)}`);
        if (values && !values.has(nameKey(entry.value)) && !entry.replaces) reasons.push("hard-conflict");
      }
    } else if (entry.kind === "thread" && entry.op === "close") {
      reasons.push("closes-thread");
    } else if (entry.kind === "presence") {
      if (!known.has(nameKey(entry.name)) && !known.has(nameKey(entry.nameUsed))) reasons.push("new-character");
    } else if (entry.kind === "time") {
      hasTime = true;
      if (entry.basis === "estimated") reasons.push("time-estimated");
    }
    (reasons.length > 0 ? review : auto).push({ index, entry, reasons });
  }
  return { review, auto, timeMissing: !hasTime && options.chapter > 1 };
}
