/**
 * 中文文本 bigram 相似度工具——供线索去重 (B2-2) 与 overview 聚类 (B2-3) 复用。
 * 纯函数、确定性、题材中立、不调 LLM。
 */

/**
 * 从文本中提取 CJK 连续字符段的所有相邻二元组（bigrams）。
 * 返回 Set<string>，每个元素是两个汉字组成的字符串。
 */
export function cjkBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  // 不猜白名单：切句
  for (const run of text.match(/[一-鿿㐀-䶿]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      grams.add(chars[i] + chars[i + 1]);
    }
  }
  return grams;
}

/**
 * Jaccard 相似度：|A ∩ B| / |A ∪ B|。
 * 任意一方 bigram 集为空时返回 0（防除零）。
 */
export function bigramSimilarity(a: string, b: string): number {
  const ga = cjkBigrams(a);
  const gb = cjkBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;

  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection += 1;
  }
  const union = ga.size + gb.size - intersection;
  return intersection / union;
}

/**
 * 重叠系数（overlap coefficient）：|A ∩ B| / min(|A|, |B|)。
 * R7.8 线索降噪：同一批声明里两条新线索标题是「一条比另一条长出一截」时，Jaccard 会被长出来的那截稀释
 * （十章重放实测 0.36），重叠系数仍能到 0.5+。只用于同批去重——同批是模型对同一章刚写下的两条说法，
 * 短标题的 bigram 被长标题覆盖过半就是同一件事；跨章归并仍走保守的 Jaccard，不受此影响。
 */
export function bigramOverlapCoefficient(a: string, b: string): number {
  const ga = cjkBigrams(a);
  const gb = cjkBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;

  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection += 1;
  }
  return intersection / Math.min(ga.size, gb.size);
}

