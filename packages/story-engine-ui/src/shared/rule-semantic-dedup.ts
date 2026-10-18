/**
 * 写作规则语义去重（P0-4）——确定性规则，不调模型。
 * 供做厚写入与资料面板计数共用，避免 client→server import 越界。
 */

/** 去掉空白与常见中英文标点，便于同义标题比对。 */
export function normalizeRuleKey(text: string): string {
  return `${text}`
    .normalize("NFKC")
    .replace(/[\s\u3000]+/gu, "")
    // 不猜白名单：切句
    .replace(/[：:·•.,，。；;！!？?、""''「」『』（）()【】\[\]<>《》…—\-_/\\|]+/gu, "")
    .toLowerCase();
}

function titleHead(text: string): string {
  const raw = `${text}`.trim();
  // 不猜白名单：切句
  const cut = raw.split(/[：:]/u, 1)[0] ?? raw;
  return normalizeRuleKey(cut);
}

function prefix20(text: string): string {
  return normalizeRuleKey(text).slice(0, 20);
}

function isSemanticDuplicate(a: string, b: string): boolean {
  const na = normalizeRuleKey(a);
  const nb = normalizeRuleKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = titleHead(a);
  const tb = titleHead(b);
  if (ta && tb && (ta.includes(tb) || tb.includes(ta))) return true;
  const pa = prefix20(a);
  const pb = prefix20(b);
  return Boolean(pa && pb && pa === pb);
}

/**
 * 语义去重：保序，后出现的相似项丢弃。
 * 只按字面比（归一后相同、标题互相包含、前 20 字相同）；不再剥「禁止 / 勿」外壳猜同义（重构 P7「不猜」）。
 */
export function semanticDedupRules(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = `${line}`.trim();
    if (!trimmed) continue;
    if (out.some((kept) => isSemanticDuplicate(kept, trimmed))) continue;
    out.push(trimmed);
  }
  return out;
}
