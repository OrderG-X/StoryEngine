/**
 * 查错的确定性层：账本里记过的带数字的设定（门牌、年份、年龄、楼层、金额……），本章在同一处写成了别的数。
 *
 * 2026-10-10 引擎升级第 3 期。不调模型：同样的正文和账本，永远同样的结果。
 * 做法：从账本事实的原句里取出「数字两边的字」当模板（槐树巷__号、林秋，__年春），
 * 在本章里找同一模板、同一个人或物、数字不同的句子。
 * 题材中立：模板全部来自这本书自己的账本，不带任何词表；只认量词表里的单位（号、年、岁、层…）。
 * 宁可漏、不乱报：约数（几、多、来）、相对时间（三年前、两天后）、钟点日期都不碰；
 * 同一模板有别的事实正好是这个数（另一个人的门牌）就不报。
 */

import type { FactEntry } from "./types.js";

export interface LedgerNumberConflict {
  /** 本章里写错的那一句。 */
  readonly quote: string;
  /** 账本里那条事实的原句（老账本没有原句时用事实文字）。 */
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly factId: string;
  /** 一句话说哪里对不上。 */
  readonly reason: string;
}

const DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

/** 中文或阿拉伯数字 → 数值；「一九八七」这种逐位写法按位拼。认不出返回 undefined。 */
export function parseNumberToken(token: string): number | undefined {
  // 不猜白名单：数字归一
  const text = token.replace(/[０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  if (/^\d+$/u.test(text)) return Number(text);
  const chars = Array.from(text);
  if (chars.length === 0 || chars.some((char) => DIGITS[char] === undefined && UNITS[char] === undefined && char !== "万")) return undefined;
  if (chars.every((char) => DIGITS[char] !== undefined)) {
    return chars.length === 1 ? DIGITS[chars[0]!] : Number(chars.map((char) => DIGITS[char]).join(""));
  }
  let total = 0;
  let section = 0;
  let digit: number | undefined;
  for (const char of chars) {
    if (char === "万") {
      total += (section + (digit ?? 0)) * 10000;
      section = 0;
      digit = undefined;
    } else if (UNITS[char] !== undefined) {
      section += (digit ?? 1) * UNITS[char]!;
      digit = undefined;
    } else {
      digit = DIGITS[char];
    }
  }
  return total + section + (digit ?? 0);
}

// 不猜白名单开始：数字归一
const NUMBER_RUN = /[0-9０-９]+|[零〇一二两三四五六七八九十百千万]+/gu;
/** 量词：数字后面紧跟这些字才当设定里的数（「一片叶子」「一直」不算）。 */
const UNIT_AFTER = /^(?:号|年|岁|层|楼|室|栋|幢|元|块|米|公里|斤|页|届|级|班|路|封|本|张|把|间|户|座)/u;
/** 约数、相对时间、时长：会随故事推移变，不是死设定。 */
const NOT_FIXED_AFTER = /^(?:[几多来余]|年[前后间来多底初]|岁[前后多]|号[前后])/u;
const HAN_RUN_BEFORE = /([\p{Script=Han}]+)[，,、：:\s“”"'「」]{0,2}$/u;
// 不猜白名单结束
/** 数字前面这些两字太泛，不能单独当模板（「今年二十八岁」谁都能说）：要求事实的主体紧挨在前面。 */
const GENERIC_LEFT = new Set([
  "今年", "已经", "大约", "一共", "只有", "还有", "足足", "整整", "不到", "超过", "将近", "至少", "最多",
  "总共", "大概", "起码", "也就", "不过", "约莫", "刚好", "正好", "共有", "一直", "差不多", "那年", "这年",
]);

interface NumberSlot {
  readonly left: string;
  readonly unit: string;
  readonly value: number;
  readonly text: string;
}

/** 句子里每个「两字以上前缀 + 数字 + 量词」的位置。 */
function numberSlots(sentence: string): readonly (NumberSlot & { readonly index: number })[] {
  const out: (NumberSlot & { readonly index: number })[] = [];
  for (const match of sentence.matchAll(NUMBER_RUN)) {
    const index = match.index ?? 0;
    const after = sentence.slice(index + match[0].length);
    if (!UNIT_AFTER.test(after) || NOT_FIXED_AFTER.test(after)) continue;
    const before = sentence.slice(0, index);
    // 不猜白名单：数字归一
    if (/第$/u.test(before)) continue;
    const run = HAN_RUN_BEFORE.exec(before)?.[1] ?? "";
    // 前缀去掉尾部的数字字（「十一月九号」的「月」前面是数，模板不可靠）
    // 前缀里带数字的不当模板：「十一月九号」的「月」前面是数；「一栋三层」的「一栋」谁家的楼都能说。
    // 不猜白名单：数字归一
    if (run.length < 2 || /[零〇一二两三四五六七八九十百千万]/u.test(run.slice(-2)) || /[零〇一二两三四五六七八九十百千万]$/u.test(run)) continue;
    const value = parseNumberToken(match[0]);
    if (value === undefined) continue;
    out.push({ left: run.slice(-2), unit: UNIT_AFTER.exec(after)![0], value, text: match[0], index });
  }
  return out;
}

export function splitCheckSentences(text: string): readonly string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/u)) {
    // 不猜白名单：切句
    for (const part of paragraph.match(/[^。！？!?…]+[。！？!?…]*[”」』"]?/gu) ?? []) {
      const sentence = part.trim();
      if (sentence.length >= 4) out.push(sentence);
    }
  }
  return out;
}

function bareSubject(subject: string | undefined): string | undefined {
  // 不猜白名单：找原句
  const bare = subject?.replace(/[《》「」“”"'\s]/gu, "").trim();
  return bare && bare.length >= 2 ? bare : undefined;
}

/**
 * 这条事实到本章还算数、能拿来对账：前面章节记的、没被取代、标了「不该变」（hard）。
 * 老账本（2026-10-10 之前记的）没有类型和主体，分不清是死设定还是会变的状态、说的是哪栋楼：
 * 大考卷上拿它对出来的 3 条全是误报（两栋楼的层数、门口停了几辆车），所以不参与，等导入时重建账本。
 */
function factInForce(fact: FactEntry, chapter: number): boolean {
  if (!(fact.chapter < chapter)) return false;
  if (fact.supersededByChapter !== undefined && fact.supersededByChapter <= chapter) return false;
  return fact.kind === "hard";
}

export function findLedgerNumberConflicts(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly facts: readonly FactEntry[];
}): readonly LedgerNumberConflict[] {
  const templates: {
    readonly fact: FactEntry;
    readonly slot: NumberSlot;
    readonly subject?: string;
    readonly source: string;
  }[] = [];
  for (const fact of input.facts) {
    if (!factInForce(fact, input.chapter)) continue;
    const source = fact.quote?.trim() || fact.text;
    const subject = bareSubject(fact.subject);
    const seen = new Set<string>();
    // 模板从事实的值（「槐树巷五号」）和原句两处取：原句常省掉地名（「五号，隔我家一个门」）。
    for (const text of [fact.value ?? "", source]) {
      for (const slot of numberSlots(text)) {
        const key = `${slot.left}|${slot.unit}|${slot.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // 前缀太泛（「今年二十八岁」）又没有主体可认 → 不敢当模板。
        if (GENERIC_LEFT.has(slot.left) && !subject) continue;
        templates.push({ fact, slot, ...(subject ? { subject } : {}), source });
      }
    }
  }
  if (templates.length === 0) return [];
  const conflicts: LedgerNumberConflict[] = [];
  const reported = new Set<string>();
  for (const sentence of splitCheckSentences(input.draftBody)) {
    if (reported.has(sentence)) continue;
    for (const here of numberSlots(sentence)) {
      const same = templates.filter((template) => template.slot.left === here.left && template.slot.unit === here.unit);
      if (same.length === 0) continue;
      // 同一模板有哪条事实正好是这个数（另一个人的门牌、另一本书的年份）→ 说的可能是那一个，不报。
      if (same.some((template) => template.slot.value === here.value)) continue;
      // 认是哪一条：句子里点了名的优先；前缀太泛的必须主体紧挨在数字前面。
      const named = same.filter((template) => {
        if (!template.subject) return false;
        const window = GENERIC_LEFT.has(here.left) ? sentence.slice(Math.max(0, here.index - 8), here.index) : sentence;
        return window.includes(template.subject);
      });
      let target = named[0];
      if (!target) {
        if (GENERIC_LEFT.has(here.left)) continue;
        // 没点名、模板又对得上好几个不同的数（两家的门牌）→ 不知道说的是谁，不报。
        if (new Set(same.map((template) => template.slot.value)).size > 1) continue;
        target = same[0];
      }
      if (!target) continue;
      reported.add(sentence);
      conflicts.push({
        quote: sentence,
        earlierQuote: target.source,
        earlierChapter: target.fact.chapter,
        factId: target.fact.id,
        reason: `第 ${target.fact.chapter} 章写的是「${target.slot.left}${target.slot.text}${target.slot.unit}」，这里写成了「${here.left}${here.text}${here.unit}」`,
      });
      break;
    }
  }
  return conflicts;
}
