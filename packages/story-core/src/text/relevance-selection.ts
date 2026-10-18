/**
 * 统一「本章相关性」召回——把 selectEffectiveFacts 的"按仍有效+相关性选"推广到
 * 线索/伏笔/事件/主线目标，替掉纯 lastTouchedChapter 排序。确定性、题材中立。
 * 四维：①有效区间(章号机械) ②关键词命中(chapterGoal CJK 词面) ③在场角色关联
 *       ④未收口护栏(closedStatuses 排除 + 古老未收口加分，治早期沉底)。
 * 向后兼容：无元数据字段 → 退化为"古老护栏 + 近章"，旧书不崩。
 */
const STRUCTURAL_GOAL_GRAMS = new Set(["本章", "这章", "这一", "一章", "下一", "继续", "章节", "推进"]);

export interface RelevanceScorable {
  readonly chapter?: number;
  readonly firstSeenChapter?: number;
  readonly lastTouchedChapter?: number;
  readonly effectiveFromChapter?: number;
  readonly supersededByChapter?: number;
  readonly status?: string;
  readonly activationKeywords?: readonly string[];
  readonly relatedCharacterIds?: readonly string[];
  readonly text: string;
}
export interface RelevanceInput<T extends RelevanceScorable> {
  readonly items: readonly T[];
  readonly chapter: number;
  readonly relevantNames?: readonly string[];
  readonly relevantCharacterIds?: readonly string[];
  readonly chapterGoal?: string;
  readonly closedStatuses: readonly string[];
  readonly ancientThreshold?: number;
  readonly ancientBonus?: number;
  readonly cap?: number;
}
export interface RelevanceResult<T> {
  readonly selected: T[];
  readonly diagnostics: { total: number; closed: number; notYetEffective: number; superseded: number };
}

function effectiveFrom(it: RelevanceScorable): number {
  return typeof it.effectiveFromChapter === "number" ? it.effectiveFromChapter
    : typeof it.firstSeenChapter === "number" ? it.firstSeenChapter
    : typeof it.chapter === "number" ? it.chapter : 0;
}
function cjkBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  // 不猜白名单：切句
  for (const run of text.match(/[一-鿿㐀-䶿]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const g = chars[i] + chars[i + 1];
      if (!STRUCTURAL_GOAL_GRAMS.has(g)) grams.add(g);
    }
  }
  return grams;
}

export function selectRelevant<T extends RelevanceScorable>(input: RelevanceInput<T>): RelevanceResult<T> {
  const closed = new Set(input.closedStatuses);
  const ancientThreshold = input.ancientThreshold ?? 10;
  const ancientBonus = input.ancientBonus ?? 3;
  const names = (input.relevantNames ?? []).filter((n) => n.trim());
  const ids = new Set(input.relevantCharacterIds ?? []);
  const goalGrams = cjkBigrams(input.chapterGoal ?? "");

  let closedN = 0, notYet = 0, superseded = 0;
  const valid = input.items.filter((it) => {
    if (it.status && closed.has(it.status)) { closedN += 1; return false; }
    if (input.chapter < effectiveFrom(it)) { notYet += 1; return false; }
    if (typeof it.supersededByChapter === "number" && input.chapter >= it.supersededByChapter) { superseded += 1; return false; }
    return true;
  });

  const lastTouched = (it: T) => it.lastTouchedChapter ?? it.firstSeenChapter ?? it.chapter ?? 0;
  const scored = valid.map((it) => {
    const kwHit = (it.activationKeywords ?? []).some((k) => goalGrams.has(k) || (input.chapterGoal ?? "").includes(k))
      || [...goalGrams].some((g) => it.text.includes(g));
    const charHit = (it.relatedCharacterIds ?? []).some((c) => ids.has(c)) || names.some((n) => it.text.includes(n));
    const ancient = (input.chapter - effectiveFrom(it)) >= ancientThreshold;
    const score = (charHit ? 4 : 0) + (kwHit ? 2 : 0) + (ancient ? ancientBonus : 0);
    return { it, score };
  }).sort((a, b) => b.score - a.score || lastTouched(b.it) - lastTouched(a.it));

  const kept = typeof input.cap === "number" ? scored.slice(0, input.cap) : scored;
  return {
    selected: kept.map((s) => s.it),
    diagnostics: { total: input.items.length, closed: closedN, notYetEffective: notYet, superseded },
  };
}
