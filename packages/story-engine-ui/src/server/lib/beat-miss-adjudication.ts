/**
 * beat-miss-adjudication — beats 保真检查误报的 AI 复核裁决（降噪器，不是闸门）。
 *
 * 背景（三轮真机验收实锤）：引擎 checkDraftBeatFidelity 只做词面锚点核对（标识符精确匹配 /
 * 数字+量词+名物 / 具名角色+台词归属），对【有锚点却换了措辞】的要点仍误报漏写——
 * 「老街坊拿表来修」正文写了「桂英老太太+海鸥表」、「表背牵出往事」正文写了表背刻字往事，都被判漏。
 * 误报进两个地方：generate_draft 输出的「首稿核对 ⚠」、多候选评分器的「漏必命中要点 -50/条」
 * （真机已发生：优胜者被冤枉扣分）。
 *
 * 设计（对齐 quality-judge.ts 的「规则检出 + LLM 复核降级」既定模式）：
 *   - 只对确定性检查【判漏】的 beat 复核：给草稿全文 + 被判漏的 beat 原文，问模型
 *     「该要点是否已被正文实质覆盖？覆盖则逐字引用正文原句作证」。
 *   - 诚实校验：模型报「已覆盖」必须带 quote，且 quote 归一化空白后必须是草稿的逐字子串，
 *     否则维持漏报——模型空口说覆盖不算数（治幻觉式摘报）。
 *   - 模型挂 / 超时 / 烂 JSON / 结构不识 → 维持确定性结论 + adjudication:"unavailable" 如实标注，
 *     绝不反向谎报（复核永远只能降噪，不能制造新问题）。
 *   - 只能把「漏」改成「已覆盖」：不新增漏报、不动引擎 passed；无锚点 beat 规则本就不检，
 *     根本没有漏报条目，不在此链路。
 *   - 零漏报零成本：调用方只在确定性判漏非空时才调本模块（连模型都不调用）。
 *
 * 题材中立、无状态；LLM 调用以 callModel 注入（生产=triage 任务槽，测试=mock），本模块不认配置。
 */

import { extractJsonObject, isRecord } from "./project-io.js";

/**
 * 引证（quote）归一化空白后的最短字符数：更短的「引证」没有证明力（「一块」「的」这类片段
 * 几乎必为子串，采信等于没校验），一律不采。正常覆盖证据是一整句正文，远超此下限。
 */
export const BEAT_ADJUDICATION_MIN_QUOTE_CHARS = 4;

/**
 * 喂给裁决模型的草稿上限字符数：超出部分模型看不到、无从引证 → 相应要点维持漏报
 * （安全方向：复核是降噪器，漏摘一条误报只是保留原警告，绝不反向谎报）。
 */
export const BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS = 12_000;

/** 一条被复核摘除的误报：beat 原文 + 模型引用的正文原句（已过诚实校验），可追溯。 */
export interface AdjudicatedCoveredBeat {
  readonly beat: string;
  readonly quote: string;
}

/**
 * 复核裁决结果。
 * adjudication: "applied"=模型复核已跑（哪怕一条没摘）；"unavailable"=模型挂/超时/烂 JSON/草稿为空，
 *   维持确定性结论（missingBeats=输入原样）+ error 如实记录。
 */
export interface BeatMissAdjudication {
  readonly adjudication: "applied" | "unavailable";
  readonly error?: string;
  /** 裁决后仍判漏的 beat 原文（输入集的子集，只减不增）。 */
  readonly missingBeats: readonly string[];
  /** 被摘除的误报（输入集的子集），带正文引证。 */
  readonly adjudicatedCovered: readonly AdjudicatedCoveredBeat[];
}

/** 空白归一化：比对引证是否草稿逐字子串时，所有空白（空格/换行/全角空格）不参与比对。 */
export function normalizeAdjudicationWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}

/**
 * 诚实校验：quote 归一化空白后必须是 draft 的逐字子串、且达最低证明力长度。
 * 两个方向都归一化——模型跨行/跨段引用时空白形态不同，但文字必须逐字对得上。纯逻辑、可测。
 */
export function isAdjudicationQuoteVerbatim(quote: string, draftContent: string): boolean {
  const normalizedQuote = normalizeAdjudicationWhitespace(quote);
  if (normalizedQuote.length < BEAT_ADJUDICATION_MIN_QUOTE_CHARS) return false;
  return normalizeAdjudicationWhitespace(draftContent).includes(normalizedQuote);
}

/** 裁决 prompt：草稿全文（ capped ）+ 被判漏的 beat 逐条编号，要求 JSON 且覆盖必须带逐字引证。纯逻辑、可测。 */
export function buildBeatMissAdjudicationPrompt(input: {
  readonly draftContent: string;
  readonly missingBeats: readonly string[];
}): string {
  const excerpt = input.draftContent.slice(0, BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS);
  const truncated = input.draftContent.length > BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS;
  return [
    "你是长篇小说草稿的「必命中要点」复核员。",
    "确定性规则按字面锚点（编号/数字+名物/台词归属）判定下面这些要点在草稿里【漏写或被改写】，但规则只认字面——同义改写、换了措辞、换了人称指代都会被冤枉。",
    "请逐条复核：该要点要求的内容是否【已实质写进】草稿正文。",
    "- 已实质写进（哪怕换了措辞）：covered=true，并在 quote 里【逐字引用】正文中能证明的一整段连续原文（必须是草稿原句，不得改写、不得跨段拼接、不得自己编）。",
    "- 确实没写、或写成了另一回事：covered=false，reason 一句话说清。",
    "- 拿不准一律 covered=false（宁可保留漏报，也不冤放）。",
    "只返回 JSON，不要 Markdown：{\"judgements\":[{\"index\":1,\"covered\":true,\"quote\":\"……\",\"reason\":\"……\"}]}。judgements 必须逐条覆盖下面全部要点，index 与编号一致。",
    "",
    "【草稿全文】",
    excerpt,
    ...(truncated ? [`（草稿过长，以上只到 ${BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS} 字；看不到的内容视为未写进。）`] : []),
    "",
    "【被判漏的必命中要点】",
    ...input.missingBeats.map((beat, index) => `${index + 1}. ${beat}`),
  ].join("\n");
}

/**
 * 对确定性判漏的 beat 逐条做 AI 复核。一次调用复核全部判漏条目（按编号对位——模型复述 beat
 * 原文可能走样，只认 index）。每条独立裁决：covered=true 且 quote 过诚实校验才摘除；
 * 模型漏判某条 / 条目烂 / index 越界 → 该条维持漏报（安全方向），不拖死其他条。
 * 调用级失败（抛错/超时/烂 JSON/无 judgements）→ 整体 unavailable + 维持确定性结论。
 */
export async function adjudicateMissingBeats(input: {
  readonly draftContent: string;
  readonly missingBeats: readonly string[];
  readonly callModel: (prompt: string) => Promise<string>;
}): Promise<BeatMissAdjudication> {
  const keepDeterministic = (error?: string): BeatMissAdjudication => ({
    adjudication: "unavailable",
    ...(error ? { error } : {}),
    missingBeats: input.missingBeats,
    adjudicatedCovered: [],
  });
  // 调用方保证只在有判漏时调用；防御：空判漏不花 token。
  if (input.missingBeats.length === 0) {
    return { adjudication: "applied", missingBeats: [], adjudicatedCovered: [] };
  }
  // 草稿读不到（FS 抖动等）无从复核——别花 token 问一个注定全漏的问题，直接 unavailable 如实标注。
  if (!input.draftContent.trim()) {
    return keepDeterministic("草稿正文为空，无法复核");
  }

  let raw: string;
  try {
    raw = await input.callModel(buildBeatMissAdjudicationPrompt(input));
  } catch (error) {
    return keepDeterministic(error instanceof Error ? error.message : String(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw) ?? raw);
  } catch {
    return keepDeterministic("复核模型返回的内容不是有效 JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.judgements)) {
    return keepDeterministic("复核模型返回缺少 judgements 数组");
  }

  const coveredByIndex = new Map<number, AdjudicatedCoveredBeat>();
  for (const item of parsed.judgements) {
    if (!isRecord(item)) continue;
    const index = typeof item.index === "number" && Number.isInteger(item.index) ? item.index : undefined;
    if (index === undefined || index < 1 || index > input.missingBeats.length) continue;
    if (item.covered !== true) continue;
    const beat = input.missingBeats[index - 1];
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    if (!beat || !isAdjudicationQuoteVerbatim(quote, input.draftContent)) continue;
    coveredByIndex.set(index, { beat, quote });
  }

  const missingBeats: string[] = [];
  const adjudicatedCovered: AdjudicatedCoveredBeat[] = [];
  input.missingBeats.forEach((beat, position) => {
    const covered = coveredByIndex.get(position + 1);
    if (covered) {
      adjudicatedCovered.push(covered);
    } else {
      missingBeats.push(beat);
    }
  });
  return { adjudication: "applied", missingBeats, adjudicatedCovered };
}
