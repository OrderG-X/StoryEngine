/**
 * enrichment-dedup —— 做厚工具共用的 list 去重原语（E1）。
 *
 * 直接复用引擎唯一归一口径 `dedupeStringList`（空白折叠 + 前缀含纳，零文本损失、守 #357），
 * 替换各 generate_* 工具里各自拷贝的精确 Set 去重，保证与引擎写侧（mergeStringArrays）/
 * 读侧（dedupeAppearanceAnchors）同源、不再口径漂移。题材中立、纯确定性、不调 LLM。
 *
 * P0-4 语义去重委托 shared/rule-semantic-dedup（面板与写入共用）。
 */
import { dedupeStringList } from "../book/canonical-resolvers.js";

export {
  normalizeRuleKey,
  semanticDedupRules,
} from "../../shared/rule-semantic-dedup.js";

/** 把 additions 追加进 existing 并去重（空白折叠 + 前缀含纳，保序、留更长）。 */
export function appendDedup(existing: readonly string[], additions: readonly string[]): string[] {
  return [...dedupeStringList([...existing, ...additions])];
}
