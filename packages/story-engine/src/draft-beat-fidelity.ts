/**
 * draft-beat-fidelity — 出稿后「本章必须命中要点」的确定性保真软警告。
 *
 * 背景（Codex 复测额外发现）：出稿管线只有一句话 chapterGoal、且出稿后无任何一步核对用户要的 beat 写没写，
 * 首稿会静默跑偏（「债权池A-17」→数字串）。非技术用户看不出，长篇无声烂掉。
 *
 * 只做「找原句」（重构 P7「不猜」）：
 *   - 要点里的编号码（同时含字母和数字，如 A-17）——按 token 集合精确匹配，全角先折半；
 *   - 要点里引号括起来的台词——正文里得原样出现。
 *   - 其余要点不做字面核对（意思写没写到交给上层的 AI 复核：模型声明 + 原句核实）。
 * 删掉了「数字+量词+名物」抽名词、按分句主语猜说话人两种字面猜测。
 */

export interface BeatFidelityIssue {
  readonly severity: "warning";
  readonly type: "missing_required_beat";
  readonly beat: string;
  readonly message: string;
}

export interface BeatFidelityReport {
  readonly passed: boolean;
  /** 含具体锚点、确实被检查过的 beat（无锚点的不在此列）。 */
  readonly checkedBeats: readonly string[];
  readonly missingBeats: readonly string[];
  readonly issues: readonly BeatFidelityIssue[];
}

// 字母数字 token（含连字符），用于抽标识符/编号码（A-17 / 3F / B2 …）。
const ALNUM_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]|[A-Za-z0-9]/g;

/** 全角字母/数字/标点（U+FF01–FF5E）折成半角，使 Ａ－１７ 与 A-17 等价。 */
function foldWidth(value: string): string {
  return value.replace(/[！-～]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/** 文本里的【标识符 token】集合：同时含字母与数字的 token（A-17 / B2 …），各自折半+归一成纯小写字母数字。 */
function identifierTokens(text: string): Set<string> {
  const set = new Set<string>();
  for (const match of foldWidth(text).matchAll(ALNUM_TOKEN)) {
    const token = match[0];
    if (/[A-Za-z]/u.test(token) && /\d/u.test(token)) {
      const norm = token.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm) set.add(norm);
    }
  }
  return set;
}

/** 要点里引号括起来的台词（「…」/“…”/『…』/"…"，2～60 字）。 */
function quotedLines(beat: string): readonly string[] {
  return [...beat.matchAll(/[“"「『]([^”"」』]{2,60})[”"」』]/gu)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

export function checkDraftBeatFidelity(input: {
  readonly draftContent: string;
  readonly mustHitBeats: readonly string[];
}): BeatFidelityReport {
  const draft = input.draftContent;
  const draftIds = identifierTokens(draft);
  const checkedBeats: string[] = [];
  const missingBeats: string[] = [];
  const issues: BeatFidelityIssue[] = [];

  for (const rawBeat of input.mustHitBeats) {
    const beat = rawBeat.trim();
    if (!beat) continue;

    const ids = [...identifierTokens(beat)];
    const lines = quotedLines(beat);
    if (ids.length === 0 && lines.length === 0) continue; // 没有能原样找的东西 → 不做字面核对
    checkedBeats.push(beat);
    const idMissing = ids.some((anchor) => !draftIds.has(anchor));
    const lineMissing = lines.some((line) => !draft.includes(line));
    if (idMissing || lineMissing) {
      missingBeats.push(beat);
      issues.push({
        severity: "warning",
        type: "missing_required_beat",
        beat,
        message: `首稿可能漏写或改写了要点「${beat}」，请核对是否要改稿补回。`,
      });
    }
  }

  return { passed: missingBeats.length === 0, checkedBeats, missingBeats, issues };
}
