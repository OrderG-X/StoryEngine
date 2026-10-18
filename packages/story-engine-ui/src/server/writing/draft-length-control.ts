import type { WritingRules } from "../book/types.js";

export type DraftLengthTargetSource = "user" | "writing_rules" | "default";

export type DraftLengthStatus = "below_lower_bound" | "within_range" | "above_upper_bound";

export interface DraftLengthTarget {
  readonly requested: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly source: DraftLengthTargetSource;
  /** lowerBound 是作者写明的「至少 N 字」（chapterLength.minWords）：定稿侧按它硬拦，不够就得补到它。 */
  readonly hardMinimum?: boolean;
}

export interface DraftLengthReport {
  readonly requestedDraftLength: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly actualLength: number;
  readonly lengthStatus: DraftLengthStatus;
  readonly source: DraftLengthTargetSource;
  readonly retryReason?: Exclude<DraftLengthStatus, "within_range">;
  readonly finalLengthAfterTrim?: number;
  readonly whetherTrimmed: boolean;
}

export interface DraftLengthTrimResult {
  readonly ok: boolean;
  readonly draftBody: string;
  readonly finalLength: number;
}

export const DEFAULT_DRAFT_TARGET_WORDS = 1_800;

const MIN_DRAFT_TARGET_WORDS = 300;
const MAX_DRAFT_TARGET_WORDS = 30_000;
const MIN_DRAFT_MAX_OUTPUT_TOKENS = 360;
const MAX_DRAFT_MAX_OUTPUT_TOKENS = 4_096;

export function resolveDraftLengthTarget(input: {
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  readonly writingRules?: unknown;
}): DraftLengthTarget {
  // 长跑 2026-10-04 #4：显式下限（chapterLength.minWords）是「至少 N 字」的硬约束本体，
  // 在任何来源分支（用户点单/写作规则/默认）都生效——下限是地板不是目标，不跟目标比优先级。
  const explicitMinimum = readWritingRulesMinimumWords(input.writingRules);
  // 字数只认结构化的 requestedDraftLength（对话 AI 按作者的话传），不从本章目标那句话里抠数字（重构 P7「不猜」）。
  const explicitTarget = normalizeDraftLengthNumber(input.requestedDraftLength);
  if (explicitTarget) return withExplicitMinimum(buildDraftLengthTarget(explicitTarget, "user"), explicitMinimum);
  const writingRulesTarget = readWritingRulesTargetWords(input.writingRules);
  if (writingRulesTarget) return withExplicitMinimum(buildDraftLengthTarget(writingRulesTarget, "writing_rules"), explicitMinimum);
  // 只有显式下限、没有目标：min 也来自写作规则 → 来源仍是 writing_rules（不是 default），目标抬到下限。
  if (explicitMinimum) return withExplicitMinimum(buildDraftLengthTarget(explicitMinimum, "writing_rules"), explicitMinimum);
  return withExplicitMinimum(buildDraftLengthTarget(DEFAULT_DRAFT_TARGET_WORDS, "default"), explicitMinimum);
}

/**
 * 把显式下限套进长度目标（长跑 2026-10-04 #4）：旧算法一律 lowerBound=requested×0.85，
 * 「至少 3000 字」会被稀释成「下限 2550」。显式 minWords 存在时：
 *  - 目标本身低于下限 → 目标顶到下限（否则区间倒挂，模型被要求写「不到下限」的稿）；
 *  - 下限本体取代 0.85 系数推导（显式 min 就是地板，与定稿执法侧 resolveMinBodyChineseCharacters
 *    同语义；写 0/非法值 = 视为缺省，回落推导算法）。
 */
function withExplicitMinimum(target: DraftLengthTarget, minimum: number | undefined): DraftLengthTarget {
  const min = normalizeDraftLengthNumber(minimum);
  if (min === undefined) return target;
  const requested = Math.max(target.requested, min);
  const { upperBound } = requestedDraftLengthBounds(requested);
  return { ...target, requested, lowerBound: min, upperBound, hardMinimum: true };
}

export function buildDraftLengthTarget(requested: number, source: DraftLengthTargetSource): DraftLengthTarget {
  const normalized = normalizeDraftLengthNumber(requested) ?? DEFAULT_DRAFT_TARGET_WORDS;
  const { lowerBound, upperBound } = requestedDraftLengthBounds(normalized);
  return { requested: normalized, source, lowerBound, upperBound };
}

export function requestedDraftLengthBounds(requested: number): { readonly lowerBound: number; readonly upperBound: number } {
  const upperBound = Math.ceil((requested * 115) / 100);
  const lowerBound = Math.max(MIN_DRAFT_TARGET_WORDS, Math.floor(requested * 0.85));
  return {
    lowerBound: Math.min(lowerBound, Math.max(1, upperBound - 1)),
    upperBound,
  };
}

export function applyDraftLengthConstraint(chapterGoal: string, lengthTarget: DraftLengthTarget): string {
  const sourceLabel = lengthTarget.source === "user"
    ? "用户明确要求"
    : lengthTarget.source === "writing_rules"
      ? "项目写作规则要求"
      : "系统默认章节目标";
  const { requested, lowerBound, upperBound } = lengthTarget;
  return [
    chapterGoal,
    "",
    `【本轮硬性字数要求】${sourceLabel}约 ${requested} 字，本次草稿必须遵守这个字数。正文不含标题必须控制在 ${lowerBound}-${upperBound} 个中文字符内。`,
    "不要提前收束，不要写成结局感；不要为了压缩字数跳过前情承接、动作推进、证据链和必要场景转换。",
    "如果接近上限，优先收束当前场景，不要开启新的大段剧情。",
  ].join("\n");
}

export function resolveDraftMaxOutputTokens(lengthTarget: DraftLengthTarget): number {
  return Math.max(
    MIN_DRAFT_MAX_OUTPUT_TOKENS,
    Math.min(MAX_DRAFT_MAX_OUTPUT_TOKENS, Math.ceil(lengthTarget.upperBound / 1.35) + 220),
  );
}

export function countDraftChineseCharacters(value: string): number {
  return (value.match(/[\u3400-\u9fff]/gu) ?? []).length;
}

export function buildDraftLengthReport(input: {
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly finalLengthAfterTrim?: number;
  readonly whetherTrimmed?: boolean;
}): DraftLengthReport {
  const actualLength = countDraftChineseCharacters(input.draftBody);
  const lengthStatus = assessDraftLengthStatus(actualLength, input.lengthTarget);
  return {
    requestedDraftLength: input.lengthTarget.requested,
    lowerBound: input.lengthTarget.lowerBound,
    upperBound: input.lengthTarget.upperBound,
    actualLength,
    lengthStatus,
    source: input.lengthTarget.source,
    ...(lengthStatus === "within_range" ? {} : { retryReason: lengthStatus }),
    ...(input.finalLengthAfterTrim !== undefined ? { finalLengthAfterTrim: input.finalLengthAfterTrim } : {}),
    whetherTrimmed: input.whetherTrimmed ?? false,
  };
}

export function buildFastDraftRetryPrompt(prompt: string, lengthTarget?: DraftLengthTarget): string {
  const lengthLine = lengthTarget
    ? [
      `- 正文长度继续遵守本轮硬性要求：约 ${lengthTarget.requested} 个中文字符；`,
      `- 正文不含标题必须控制在 ${lengthTarget.lowerBound}-${lengthTarget.upperBound} 个中文字符内；`,
      "- 不要重写成新故事，只补足必要动作、感官细节、证据链和承接段落；",
    ].join("\n")
    : "- 正文至少 1200 个中文字符；";
  return `${prompt}

上一次模型只返回了标题、极短内容或未满足字数范围，这次必须输出完整章节正文：
- 必须以 "# 第N章 · 标题" 开头；
- 标题之后必须继续写正文；
${lengthLine}
- 不要提前收束，不要写成结局感；
- 不要解释，不要道歉，不要只返回标题。`;
}

export function trimDraftBodyToLengthTarget(draftBody: string, lengthTarget: DraftLengthTarget): DraftLengthTrimResult {
  const normalized = draftBody.trim();
  if (!normalized) return { ok: false, draftBody: "", finalLength: 0 };
  const currentLength = countDraftChineseCharacters(normalized);
  if (currentLength <= lengthTarget.upperBound) {
    return {
      ok: currentLength >= lengthTarget.lowerBound,
      draftBody: normalized,
      finalLength: currentLength,
    };
  }

  const byParagraph = trimByParagraphs(normalized, lengthTarget);
  if (byParagraph.ok) return byParagraph;

  const bySentences = trimBySentences(normalized, lengthTarget);
  if (bySentences.ok) return bySentences;

  return trimByCjkBoundary(normalized, lengthTarget);
}

function assessDraftLengthStatus(actualLength: number, lengthTarget: DraftLengthTarget): DraftLengthStatus {
  if (actualLength < lengthTarget.lowerBound) return "below_lower_bound";
  if (actualLength > lengthTarget.upperBound) return "above_upper_bound";
  return "within_range";
}

function trimByParagraphs(draftBody: string, lengthTarget: DraftLengthTarget): DraftLengthTrimResult {
  const paragraphs = draftBody
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const selected: string[] = [];
  let total = 0;

  for (const paragraph of paragraphs) {
    const paragraphLength = countDraftChineseCharacters(paragraph);
    if (total >= lengthTarget.lowerBound && total + paragraphLength > lengthTarget.upperBound) break;
    if (total + paragraphLength > lengthTarget.upperBound) break;
    selected.push(paragraph);
    total += paragraphLength;
  }

  const draftBodyCandidate = selected.join("\n\n").trim();
  if (draftBodyCandidate && total >= lengthTarget.lowerBound && total <= lengthTarget.upperBound) {
    return { ok: true, draftBody: draftBodyCandidate, finalLength: total };
  }
  return { ok: false, draftBody: draftBodyCandidate, finalLength: total };
}

function trimBySentences(draftBody: string, lengthTarget: DraftLengthTarget): DraftLengthTrimResult {
  const chunks = draftBody
    // 不猜白名单：切句
    .split(/(?<=[。！？!?；;])/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const selected: string[] = [];
  let total = 0;

  for (const chunk of chunks) {
    const chunkLength = countDraftChineseCharacters(chunk);
    if (total >= lengthTarget.lowerBound && total + chunkLength > lengthTarget.upperBound) break;
    if (total + chunkLength > lengthTarget.upperBound) break;
    selected.push(chunk);
    total += chunkLength;
  }

  const draftBodyCandidate = selected.join("").trim();
  if (draftBodyCandidate && total >= lengthTarget.lowerBound && total <= lengthTarget.upperBound) {
    return { ok: true, draftBody: draftBodyCandidate, finalLength: total };
  }
  return { ok: false, draftBody: draftBodyCandidate, finalLength: total };
}

function trimByCjkBoundary(draftBody: string, lengthTarget: DraftLengthTarget): DraftLengthTrimResult {
  let seen = 0;
  let result = "";
  for (const char of draftBody) {
    result += char;
    if (/[\u3400-\u9fff]/u.test(char)) seen += 1;
    if (seen >= lengthTarget.upperBound) break;
  }
  const draftBodyCandidate = result.trim();
  const finalLength = countDraftChineseCharacters(draftBodyCandidate);
  return {
    ok: Boolean(draftBodyCandidate) && finalLength >= lengthTarget.lowerBound && finalLength <= lengthTarget.upperBound,
    draftBody: draftBodyCandidate,
    finalLength,
  };
}

function readWritingRulesTargetWords(writingRules: unknown): number | undefined {
  if (!isRecord(writingRules)) return undefined;
  const chapterLength = isRecord(writingRules.chapterLength) ? writingRules.chapterLength : undefined;
  const rawValue = chapterLength?.targetWords
    ?? chapterLength?.maxWords
    ?? (writingRules as Partial<WritingRules> & { readonly targetChapterWords?: unknown; readonly targetWords?: unknown }).targetChapterWords
    ?? (writingRules as Partial<WritingRules> & { readonly targetChapterWords?: unknown; readonly targetWords?: unknown }).targetWords;
  const value = typeof rawValue === "number"
    ? rawValue
    : typeof rawValue === "string"
      ? Number.parseInt(rawValue.replace(/[^\d]/gu, ""), 10)
      : undefined;
  return normalizeDraftLengthNumber(value);
}

/** 写作规则字数意图（目标 + 显式下限），出稿与定稿执法共用同一份解析，防两侧口径漂移。 */
export interface WritingRulesLengthIntent {
  /** 归一化目标（300..30000；出稿执法 resolveDraftLengthTarget 用，与旧口径一致）。 */
  readonly targetWords?: number;
  /**
   * 原始正数目标（只验证是 >0 的有限数，不做 300 地板/30000 天花板归一）。
   * 供定稿执法的软推导用——旧口径允许「targetWords:200 → 下限 150」这种把门槛往下调的写法
   * （见 commit-quality-check 既有契约），归一化会把 <300 的目标直接丢掉、破坏该行为。
   */
  readonly rawTargetWords?: number;
  /** 显式硬下限（chapterLength.minWords，纯汉字口径）。0/非法值视为缺省。 */
  readonly minWords?: number;
}

/** 供定稿执法侧（commit-quality-check）复用的入口：从已解析的 writing-rules 对象读字数意图。 */
export function readWritingRulesLengthIntent(writingRules: unknown): WritingRulesLengthIntent {
  const targetWords = readWritingRulesTargetWords(writingRules);
  const minWords = readWritingRulesMinimumWords(writingRules);
  const rawValue = isRecord(writingRules) && isRecord(writingRules.chapterLength)
    && typeof writingRules.chapterLength.targetWords === "number"
    && Number.isFinite(writingRules.chapterLength.targetWords)
    && writingRules.chapterLength.targetWords > 0
    ? Math.floor(writingRules.chapterLength.targetWords)
    : undefined;
  return {
    ...(targetWords !== undefined ? { targetWords } : {}),
    ...(rawValue !== undefined ? { rawTargetWords: rawValue } : {}),
    ...(minWords !== undefined ? { minWords } : {}),
  };
}

/** 显式下限（chapterLength.minWords，长跑 2026-10-04 #4）：字段早就在 WritingRules 类型里，只是从没被执法读走。 */
export function readWritingRulesMinimumWords(writingRules: unknown): number | undefined {
  if (!isRecord(writingRules)) return undefined;
  const chapterLength = isRecord(writingRules.chapterLength) ? writingRules.chapterLength : undefined;
  const rawValue = chapterLength?.minWords;
  const value = typeof rawValue === "number"
    ? rawValue
    : typeof rawValue === "string"
      ? Number.parseInt(rawValue.replace(/[^\d]/gu, ""), 10)
      : undefined;
  // 0=用户主动清空下限（回落推导算法）；<300 与目标下限地板重合无意义，一并视为缺省。
  return normalizeDraftLengthNumber(value);
}

function normalizeDraftLengthNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized < MIN_DRAFT_TARGET_WORDS || normalized > MAX_DRAFT_TARGET_WORDS) return undefined;
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
