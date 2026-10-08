/**
 * 按"本章仍有效 + 相关性"挑已确立事实喂正文，替代旧的 .slice(-20) 纯 recency 截断。
 * 根治长篇"早期硬设定被最近 N 条挤出蒸发"——早期事实只要仍有效、且与本章相关，就不会被挤掉。
 * 纯函数、确定性、题材中立：有效性只按章号机械判定（不读 text 语义）。
 * 相关性分级（洞#9 补齐；2026-10-08 加「上一章原文特有词」与「人人都带的名字降权」）：与上一章原文共享特有词
 * (每个 2 分，封顶 6) ≈ 在场角色名命中(4，人人都带的只算 1) > 本章方向 chapterGoal 文本重叠(2) > 含硬 token 数字/金额(1)，
 * 同级按近章。补 chapterGoal + 硬 token 后，不含人名的关键硬设定（遗产3亿/密道在城西）不再 relevance 恒 0 被挤出。
 */
import type { FactEntry } from "./types.js";

export interface EffectiveFactsInput {
  readonly facts: readonly FactEntry[];
  readonly chapter: number;
  /** 本章在场角色名（来自 selectedCharacterIds 对应角色）；提到的事实优先、不被 cap 挤出。 */
  readonly relevantNames?: readonly string[];
  /** 本章方向/目标文本；与之有 CJK 词重叠的事实（哪怕不含人名）优先，治"不含人名的硬设定蒸发"。 */
  readonly chapterGoal?: string;
  /**
   * 接着写的上下文原文（上一章正文）。事实里的「特有词」（物件/地点/事件词，不是人人都带的主角名）
   * 在这段原文里出现 → 加分：上一章提到菜场，第 4 章记下的「菜场十年前就拆了」才会被翻出来。
   */
  readonly continuityText?: string;
  /** 进 prompt 的事实条数上限（避免长篇几百条全塞爆）。默认 30。 */
  readonly cap?: number;
}

export interface EffectiveFactsDiagnostics {
  readonly total: number;
  readonly valid: number;
  readonly superseded: number;
  readonly notYetEffective: number;
  readonly cappedOut: number;
}

export interface EffectiveFactsResult {
  /** 按重要性排序（相关性 → 近章）的事实串「第N章：text」；hardConstraints 取前 K 即取最重要的。 */
  readonly facts: readonly string[];
  readonly diagnostics: EffectiveFactsDiagnostics;
}

const DEFAULT_CAP = 30;
/**
 * 「人人都带」的名字：有效事实 ≥ UBIQUITY_MIN_FACTS 条、且某名字出现在 ≥ UBIQUITY_SHARE 的事实里（通常是主角）→
 * 它的命中只算 1 分。2026-10-08 十章验收实锤：主角名出现在一半以上的事实里，+4 让相关性退化成「最近 20 条」，
 * 三章前「菜场十年前就拆了」这类不带人名的事实再也进不了上下文。
 */
const UBIQUITY_MIN_FACTS = 12;
const UBIQUITY_SHARE = 0.3;
/** 特有词：只出现在不超过这个比例事实里的 bigram；超过 COMMON_MAX_SHARE 的（主角名、「没有」）不算。 */
const DISTINCTIVE_MAX_SHARE = 0.15;
const COMMON_MAX_SHARE = 0.4;
/**
 * 与上一章原文最相关的事实保底名额：先按词面重合度挑出这么多条，再按综合分补满 cap。
 * 小卡司里几乎每条事实都带个配角名，只靠综合分排，上一章正在写的物件/地点的旧事实会被「配角出场过」挤掉。
 */
const CONTINUITY_QUOTA = 12;

// 章目标里的结构性 2-gram（非内容词），不参与方向相关性匹配，避免"本章/继续"误命中一切。
const STRUCTURAL_GOAL_GRAMS = new Set(["本章", "这章", "这一", "一章", "下一", "继续", "章节", "推进"]);
// 硬 token：阿拉伯/全角数字 + 大额量词。强信号"金额/数字/编号"类硬事实，且极少出现在普通叙述词里。
const HARD_TOKEN_RE = /[0-9０-９]|[亿萬万]/u;

function effectiveFromChapter(fact: FactEntry): number {
  return typeof fact.effectiveFromChapter === "number" ? fact.effectiveFromChapter : fact.chapter;
}

/** 取连续 CJK 段内的 2-gram 集合（跨标点/数字不连），剔除结构性词。用于章目标的内容词相关性。 */
function cjkBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  const runs = text.match(/[一-鿿㐀-䶿]+/gu) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const gram = chars[i] + chars[i + 1];
      if (!STRUCTURAL_GOAL_GRAMS.has(gram)) grams.add(gram);
    }
  }
  return grams;
}

function sharesGoalGram(text: string, goalGrams: Set<string>): boolean {
  if (goalGrams.size === 0) return false;
  for (const gram of goalGrams) {
    if (text.includes(gram)) return true;
  }
  return false;
}

function nameScore(text: string, names: readonly string[], ubiquitous: ReadonlySet<string>): number {
  const hits = names.filter((name) => text.includes(name));
  if (hits.length === 0) return 0;
  return hits.some((name) => !ubiquitous.has(name)) ? 4 : 1;
}

/**
 * 事实与上一章原文的词面重合度（原始分，未换算）。按全部有效事实算每个 CJK bigram 的出现比例：
 * 只在少数事实里出现的「特有词」（某个地点、某件物件）记 1；较常见的（如全书主线物件「登记表」）记 0.5；
 * 几乎条条都有的（主角名、「没有」）记 0。事实不多（< UBIQUITY_MIN_FACTS）时没法统计常见度，一律记 1。
 * 没有原文 → 恒 0（旧行为）。
 */
function buildContinuityScorer(facts: readonly FactEntry[], continuityText: string | undefined): (text: string) => number {
  const contextGrams = cjkBigrams(continuityText ?? "");
  if (contextGrams.size === 0) return () => 0;
  const documentFrequency = new Map<string, number>();
  for (const fact of facts) {
    for (const gram of cjkBigrams(fact.text)) documentFrequency.set(gram, (documentFrequency.get(gram) ?? 0) + 1);
  }
  const enoughToCount = facts.length >= UBIQUITY_MIN_FACTS;
  const weight = (gram: string): number => {
    if (!enoughToCount) return 1;
    const share = (documentFrequency.get(gram) ?? 0) / facts.length;
    if (share <= DISTINCTIVE_MAX_SHARE) return 1;
    if (share <= COMMON_MAX_SHARE) return 0.5;
    return 0;
  };
  return (text) => {
    let shared = 0;
    for (const gram of cjkBigrams(text)) {
      if (contextGrams.has(gram)) shared += weight(gram);
    }
    return shared;
  };
}

/** 事实在第 chapter 章是否仍有效（生效且未被取代）。无区间字段=从来源章起一直有效（向后兼容）。 */
export function isFactValidAtChapter(fact: FactEntry, chapter: number): boolean {
  if (chapter < effectiveFromChapter(fact)) return false;
  if (typeof fact.supersededByChapter === "number" && chapter >= fact.supersededByChapter) return false;
  return true;
}

export function selectEffectiveFacts(input: EffectiveFactsInput): EffectiveFactsResult {
  const cap = input.cap ?? DEFAULT_CAP;
  const relevantNames = (input.relevantNames ?? []).filter((name) => name.trim().length > 0);

  const nonEmpty = input.facts.filter(
    (fact) => fact && typeof fact.text === "string" && fact.text.trim().length > 0,
  );

  let superseded = 0;
  let notYetEffective = 0;
  const valid = nonEmpty.filter((fact) => {
    if (input.chapter < effectiveFromChapter(fact)) {
      notYetEffective += 1;
      return false;
    }
    if (typeof fact.supersededByChapter === "number" && input.chapter >= fact.supersededByChapter) {
      superseded += 1;
      return false;
    }
    return true;
  });

  const goalGrams = cjkBigrams(input.chapterGoal ?? "");
  const ubiquitousNames = new Set(
    valid.length >= UBIQUITY_MIN_FACTS
      ? relevantNames.filter((name) => valid.filter((fact) => fact.text.includes(name)).length / valid.length >= UBIQUITY_SHARE)
      : [],
  );
  const continuityScore = buildContinuityScorer(valid, input.continuityText);
  const recency = (a: { readonly fact: FactEntry }, b: { readonly fact: FactEntry }) => (b.fact.chapter ?? 0) - (a.fact.chapter ?? 0);
  const scored = valid
    .map((fact) => {
      const continuity = continuityScore(fact.text);
      return {
        fact,
        continuity,
        // 分级：在场角色名(4，人人都带的名字只算 1) + 与上一章原文的重合(每单位 2 分，封顶 6)
        // + 本章方向文本重叠(2) + 含硬 token 数字/金额(1)；可叠加。
        score:
          nameScore(fact.text, relevantNames, ubiquitousNames) +
          Math.min(6, continuity * 2) +
          (sharesGoalGram(fact.text, goalGrams) ? 2 : 0) +
          (HARD_TOKEN_RE.test(fact.text) ? 1 : 0),
      };
    })
    // 相关性优先（早期但相关/重要的不被挤出），同级按近章优先
    .sort((a, b) => b.score - a.score || recency(a, b));

  // 保底：与上一章原文重合最多的若干条先占位（≥1 个特有词才算），再按综合分补满。输出仍按综合分排序。
  const keptSet = new Set(
    scored
      .filter((item) => item.continuity >= 1)
      .sort((a, b) => b.continuity - a.continuity || recency(a, b))
      .slice(0, Math.min(CONTINUITY_QUOTA, cap)),
  );
  for (const item of scored) {
    if (keptSet.size >= cap) break;
    keptSet.add(item);
  }
  const kept = scored.filter((item) => keptSet.has(item));
  return {
    facts: kept.map((item) => `第${item.fact.chapter}章：${item.fact.text.trim()}`),
    diagnostics: {
      total: nonEmpty.length,
      valid: valid.length,
      superseded,
      notYetEffective,
      cappedOut: scored.length - kept.length,
    },
  };
}
