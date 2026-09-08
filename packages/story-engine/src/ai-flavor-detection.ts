/**
 * ai-flavor-detection —— 「AI 腔」确定性检测机器（机制进引擎、策略留 UI 分层第一步）。
 *
 * 定位：只提供检测机器，**不内置任何具体禁词/规则数据**（题材中立铁律）——规则全部以数据入参传入，
 * 由上层（如 UI 的 ai-flavor-rules）决定收哪些毛病。纯函数、确定性、零 LLM 依赖。
 *
 * 规则两种（判别联合，kind 区分）：
 *   - pattern：正则命中 → 抽出命中处所在【整句】当 violation.text（以 。！？\n 为界、含句末标点，
 *     trim 后仍是草稿子串）。
 *   - frequency_gate：词表累计密度闸（如弱化副词扎堆这类「单字常用、出现即报必误报」的词）——
 *     总出现次数 ≥ minOccurrences 且每千字密度 > maxPerThousandChars 才报一条，挂在第一处
 *     「还没被模式规则命中」的整句上（守「同一整句只报一条」）；偶用不报，治噪音。
 *
 * 语义与 UI 原实现（story-engine-ui ai-flavor-rules.ts 的 detectAiFlavorRules）逐点一致，供 UI 删本地实现改调这里：
 *   - 同一整句被多条规则命中 → 只留 severity 最高的一条（避免对同一句重复报）；
 *   - violation id 形如 aiflavor-rule-{ruleId}-{序号}（频率闸为 aiflavor-rule-{ruleId}）——
 *     UI 侧频率闸规则 id 取 "filler-adverb-flood" 即与原硬编码 id 逐字一致；
 *   - 密度按草稿全长（JS string length）归一：per1000 = 命中数 / max(1, draftText.length / 1000)；
 *   - 返回按 severity 高→低排序（同级保持首次出现序，Array.sort 稳定）。
 *   - start/end 为 text 在草稿里的逐字区间：draftText.slice(start, end) === text，
 *     供下游「必须是草稿子串」的诚实校验与「改掉这句」定位。
 *
 * RegExp 直接作入参（进程内调用）；UI 如需从可序列化数据重建规则：new RegExp(pattern.source, pattern.flags)。
 */

export type AiFlavorSeverity = "high" | "medium" | "low";

/** 模式规则：正则命中即抽整句。 */
export interface AiFlavorPatternRule {
  readonly kind: "pattern";
  readonly id: string;
  readonly severity: AiFlavorSeverity;
  /** 全局正则（带 g/u；缺 g 会自动补）。命中的所在整句会被抽出当 violation.text。 */
  readonly pattern: RegExp;
  readonly label: string;
  readonly reason: string;
  readonly suggestedFix: string;
}

/** 频率闸规则：词表扎堆（次数 ≥ minOccurrences 且每千字密度 > maxPerThousandChars）才报一条。 */
export interface AiFlavorFrequencyGateRule {
  readonly kind: "frequency_gate";
  readonly id: string;
  readonly severity: AiFlavorSeverity;
  /** 词表（按字面量匹配，正则元字符会被转义）；这些词的累计出现次数进入密度统计。 */
  readonly words: readonly string[];
  /** 每千字密度阈值：密度严格大于该值才可能报。 */
  readonly maxPerThousandChars: number;
  /** 最少出现次数：总次数达到该值才可能报。 */
  readonly minOccurrences: number;
  readonly label: string;
  readonly reason: string;
  readonly suggestedFix: string;
}

export type AiFlavorRule = AiFlavorPatternRule | AiFlavorFrequencyGateRule;

export interface AiFlavorViolation {
  readonly id: string;
  /** 命中它的规则 id（多条命中同一句时，是 severity 最高那条）。 */
  readonly ruleId: string;
  /** AI 腔原句，逐字取自草稿（整句，草稿子串）。 */
  readonly text: string;
  /** text 在草稿里的逐字区间：draftText.slice(start, end) === text。 */
  readonly start: number;
  readonly end: number;
  readonly reason: string;
  readonly severity: AiFlavorSeverity;
  readonly suggestedFix?: string;
}

/** 清单 cap，对齐 UI ai-flavor-check.ts 的 MAX_VIOLATIONS。 */
export const AI_FLAVOR_MAX_VIOLATIONS = 8;

/** warning-only 回检报告：总数与按 severity 分布统计【全量】命中，violations 为 capped 清单。 */
export interface AiFlavorReport {
  readonly total: number;
  readonly bySeverity: Readonly<Record<AiFlavorSeverity, number>>;
  readonly violations: readonly AiFlavorViolation[];
}

const SEVERITY_RANK: Readonly<Record<AiFlavorSeverity, number>> = { high: 3, medium: 2, low: 1 };

interface SentenceSlice {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** 抽出 index 命中处所在的整句（以 。！？\n 为界，含句末标点）；trim 用区间推进实现，保证 slice(start,end)===text。 */
function sentenceAround(text: string, start: number, end: number): SentenceSlice {
  const isBoundary = (ch: string): boolean => ch === "。" || ch === "！" || ch === "？" || ch === "\n";
  let s = start;
  while (s > 0 && !isBoundary(text[s - 1] ?? "")) s--;
  let e = Math.max(end, start + 1);
  while (e < text.length && !isBoundary(text[e] ?? "")) e++;
  if (e < text.length) e += 1; // 含句末标点
  while (s < e && /\s/u.test(text[s] ?? "")) s += 1;
  while (e > s && /\s/u.test(text[e - 1] ?? "")) e -= 1;
  return { text: text.slice(s, e), start: s, end: e };
}

/** 频率闸词表按字面量拼正则（转义元字符，词表词是数据不是正则）。 */
function escapeRegExpLiteral(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 确定性检测：跑调用方给的规则，命中处抽整句去重，返回 AiFlavorViolation[]（severity 高→低排序）。
 * 空文本/空规则 → []。纯函数，不改入参。
 */
export function detectAiFlavorViolations(
  draftText: string,
  rules: readonly AiFlavorRule[],
): readonly AiFlavorViolation[] {
  if (!draftText.trim() || rules.length === 0) return [];
  // sentence → 命中它的最高优先规则（+ 首次出现位置）
  const bySentence = new Map<string, { rule: AiFlavorPatternRule; start: number; end: number }>();
  for (const rule of rules) {
    if (rule.kind !== "pattern") continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(draftText)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      const sentence = sentenceAround(draftText, m.index, m.index + m[0].length);
      if (!sentence.text) continue;
      const existing = bySentence.get(sentence.text);
      if (!existing) {
        bySentence.set(sentence.text, { rule, start: sentence.start, end: sentence.end });
      } else if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[existing.rule.severity]) {
        // 同句被更高 severity 规则命中 → 换规则，但保留首次出现位置（同一整句串）。
        bySentence.set(sentence.text, { rule, start: existing.start, end: existing.end });
      }
    }
  }
  const violations: AiFlavorViolation[] = [];
  let i = 0;
  for (const [sentence, hit] of bySentence) {
    violations.push({
      id: `aiflavor-rule-${hit.rule.id}-${i++}`,
      ruleId: hit.rule.id,
      text: sentence,
      start: hit.start,
      end: hit.end,
      reason: `${hit.rule.label}：${hit.rule.reason}`,
      severity: hit.rule.severity,
      suggestedFix: hit.rule.suggestedFix,
    });
  }

  // 频率闸：扎堆才报一条，挂在第一处「还没被模式规则命中」的整句上（守「同一整句只报一条」）。
  for (const rule of rules) {
    if (rule.kind !== "frequency_gate") continue;
    const words = rule.words.map((word) => word.trim()).filter(Boolean);
    if (words.length === 0) continue;
    const wordPattern = new RegExp(words.map(escapeRegExpLiteral).join("|"), "gu");
    const matches = [...draftText.matchAll(wordPattern)];
    const per1000 = matches.length / Math.max(1, draftText.length / 1000);
    if (matches.length < rule.minOccurrences || per1000 <= rule.maxPerThousandChars) continue;
    for (const m of matches) {
      if (m.index === undefined) continue;
      const sentence = sentenceAround(draftText, m.index, m.index + m[0].length);
      if (!sentence.text || bySentence.has(sentence.text)) continue;
      violations.push({
        id: `aiflavor-rule-${rule.id}`,
        ruleId: rule.id,
        text: sentence.text,
        start: sentence.start,
        end: sentence.end,
        reason: `${rule.label}：${rule.reason}`,
        severity: rule.severity,
        suggestedFix: rule.suggestedFix,
      });
      break;
    }
  }

  return violations.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** 把全量命中清单收成 warning-only 报告：total/bySeverity 统计全量，violations 截到 AI_FLAVOR_MAX_VIOLATIONS 条。 */
export function buildAiFlavorReport(violations: readonly AiFlavorViolation[]): AiFlavorReport {
  const bySeverity: Record<AiFlavorSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const violation of violations) bySeverity[violation.severity] += 1;
  return {
    total: violations.length,
    bySeverity,
    violations: violations.slice(0, AI_FLAVOR_MAX_VIOLATIONS),
  };
}
