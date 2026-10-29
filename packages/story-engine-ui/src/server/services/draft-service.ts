/**
 * draft-service — 出稿共用的小件：写手上下文（在场人物、字数目标、上下文裁剪、AI 腔规则、上一稿核出的错）、
 * 多版确定性选优、字数 / AI 腔 / 要点核对的回执件、自动去味一轮。
 *
 * 出稿本身是 draft.change 操作（写作版本 P2a 3.1，services/draft-change/ + recipes/draft-change.ts）：一步一步跑、
 * 最后一次换上工作稿。HTTP 只剩抽卡候选（generateDraftCandidate，写作版本 P2a 2D 收编进 draft.change pick:author）。
 *
 * 依赖说明：流程层（services）只往下引——写稿底层、编辑部（章纲）、基础设施；不引对话 AI 和 HTTP 出口。
 * 铁律：passed=false 的候选永远不得中选；回检 / 裁决 / 去味全部 warning-only，绝不影响出稿 ok；绝不静默失败、绝不谎报。
 */
import {
  detectAiFlavorViolations,
  type AiFlavorReport,
  type AiFlavorRule,
  type AiFlavorSeverity,
  type AiFlavorViolation,
} from "@actalk/story-core";
import {
  countDraftChineseCharacters,
  lengthRulesOf,
  resolveDraftLengthTarget,
  resolveDraftMaxOutputTokens,
  type DraftLengthReport,
  type DraftLengthStatus,
  type DraftLengthTarget,
  type DraftLengthTargetSource,
} from "../writing/draft-length-control.js";
import {
  runFastDraft,
  type FastDraftInput,
  type FastDraftReport,
  type WriterClient,
} from "../writing/fast-draft-writer.js";
import type { ChapterPlan } from "../book/chapter-plan.js";
import { readCurrentCheckMemory } from "../editorial/continuity/check-service.js";

import type { AdjudicatedCoveredBeat, BeatMissAdjudication } from "../writing/beat-miss-adjudication.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { positiveOrUndefined } from "../lib/lenient-args.js";
import { readAntiAiPatterns } from "../writing/ai-flavor/anti-rules.js";
import { contextBudgetPayload, makeWriterRankContext, resolveWriterTokenBudget, type WriterRankContextPlan } from "../writing/rank-writer-context.js";
import { resolveInSceneCharacters, type InSceneResult } from "../writing/presence/in-scene-detector.js";
import { readBibleTolerant } from "../writing/setting-pack.js";
import { ALL_BUILTIN_AI_FLAVOR_RULES, buildUserAntiAiPatternRules } from "../writing/ai-flavor/ai-flavor-rules.js";
import { runDeAiFlavorBatch, type DeAiCallModel, type DeAiSkippedByReason } from "./de-ai-flavor-batch.js";
import { resolveChapterPlanForReroll } from "../editorial/plan-chapter.js";
import type { LastDraftConflict } from "../writing/context-gateway.js";
import type { BrainCallModel } from "../editorial/index.js";

/* ---------------------------------------------------------------------------
 * 字数、AI 腔、要点核对的回执件
 * ------------------------------------------------------------------------- */

export function countCjkChars(value: string): number {
  return countDraftChineseCharacters(value);
}

export interface GenerateDraftLengthInfo {
  readonly requestedDraftLength: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly actualLength: number;
  readonly lengthStatus: DraftLengthStatus;
  readonly source: DraftLengthTargetSource;
}

/** 工具输出的 AI 腔回检信息：引擎 AiFlavorReport 的关键字段提纯（总数/按严重度分布/清单是否被截断）。 */
export interface GenerateDraftAiFlavorInfo {
  readonly total: number;
  readonly bySeverity: Readonly<Record<AiFlavorSeverity, number>>;
  readonly truncated: boolean;
}

/** 引擎 aiFlavor 报告 → 工具输出的关键信息（total/bySeverity 是全量统计；truncated=清单 capped 8 被截断）。纯逻辑、可测。 */
export function buildAiFlavorInfo(report: AiFlavorReport): GenerateDraftAiFlavorInfo {
  return {
    total: report.total,
    bySeverity: report.bySeverity,
    truncated: report.violations.length < report.total,
  };
}

/**
 * 出稿回检的如实标注：检出 high/medium 才打 ⚠（治噪音铁律——total=0 或只有 low 一律静默，
 * low 档全是「仿佛/一丝」这类弱信号与用户自定义词，提示了也是噪音）。纯逻辑、可测。
 */
export function buildAiFlavorWarning(info: GenerateDraftAiFlavorInfo): string {
  const { high, medium } = info.bySeverity;
  if (high + medium === 0) return "";
  const breakdown = [high > 0 ? `high ${high}` : "", medium > 0 ? `medium ${medium}` : ""].filter(Boolean).join(" / ");
  return `⚠ 检出 ${info.total} 处疑似机器腔（${breakdown}），可以点「检查机器腔」逐条修。`;
}

/** 自动去味一轮的如实回报：跑没跑 / 修了几处 / 复检还剩几处 high/medium / 跳过计数 / 失败原因。 */
export interface GenerateDraftAutoDeAiInfo {
  readonly attempted: boolean;
  readonly fixedCount: number;
  readonly remainingHighMedium: number;
  readonly skipped: DeAiSkippedByReason;
  readonly error?: string;
}

export const EMPTY_AUTO_DE_AI_SKIPPED: DeAiSkippedByReason = { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 };

/** 初检报告里只挑 high/medium 命中去自动改写（low 全是弱信号/用户自定义词，不动）。纯逻辑、可测。 */
export function pickAutoDeAiTargets(report: AiFlavorReport): readonly AiFlavorViolation[] {
  return report.violations.filter((v) => v.severity === "high" || v.severity === "medium");
}

/**
 * 自动去味的 summary 如实三态（+未跑时退回原标注）：
 *   未跑（attempted:false）→ 原来的「检出 N 处…去AI味」标注；
 *   改写模型失败 / 一处没能安全替换 → 如实说没改成、原稿未动；
 *   修掉 N 处且复检干净 → 干净；修掉 N 处还剩 M 处 → 如实报剩、引导手动「去AI味」。
 * 纯逻辑、可测。
 */
export function buildAutoDeAiNote(info: GenerateDraftAutoDeAiInfo, initial: GenerateDraftAiFlavorInfo): string {
  if (!info.attempted) return buildAiFlavorWarning(initial);
  const detectedHighMedium = initial.bySeverity.high + initial.bySeverity.medium;
  if (info.error) {
    return (
      `⚠ 检出 ${detectedHighMedium} 处疑似机器腔，自动去机器腔没跑成（${info.error}）——原稿没动；` +
      `可以让我重试，或点「检查机器腔」逐条修。`
    );
  }
  if (info.fixedCount === 0) {
    return (
      `⚠ 检出 ${detectedHighMedium} 处疑似机器腔，自动去机器腔没能安全替换（模型没给有效改写或定位不到）——原稿没动；` +
      `可以点「检查机器腔」逐条修。`
    );
  }
  if (info.remainingHighMedium === 0) {
    return `已自动去机器腔修掉 ${info.fixedCount} 处，复检干净。`;
  }
  return (
    `⚠ 已自动去机器腔修掉 ${info.fixedCount} 处，复检还剩 ${info.remainingHighMedium} 处——` +
    `可以点「检查机器腔」接着逐条修。`
  );
}

/** 引擎 draftLength 报告 → 工具输出的关键信息（目标区间/实际字数/是否低于下限/目标来源）。纯逻辑、可测。 */
export function buildDraftLengthInfo(report: DraftLengthReport): GenerateDraftLengthInfo {
  return {
    requestedDraftLength: report.requestedDraftLength,
    lowerBound: report.lowerBound,
    upperBound: report.upperBound,
    actualLength: report.actualLength,
    lengthStatus: report.lengthStatus,
    source: report.source,
  };
}

/**
 * 低于目标字数下限的如实标注：annotate 策略一次成稿不自动补写、不拒绝，让 agent 如实转达用户决定重写或接受。
 * 在区间内/超上限返回空串（不标注；超上限引擎已自行裁剪或拒绝）。纯逻辑、可测。
 */
export function buildDraftLengthWarning(info: GenerateDraftLengthInfo): string {
  if (info.lengthStatus !== "below_lower_bound") return "";
  return `⚠ 低于目标字数下限（实际${info.actualLength}字/下限${info.lowerBound}字）。可以按原样接受，或让我接着往下写补足字数。`;
}

/** 必命中要点保真核对的工具输出信息：missingBeats 是【裁决后】结果；被摘除的误报进 adjudicatedCovered（可追溯）。 */
export interface GenerateDraftBeatFidelityInfo {
  readonly missingBeats: readonly string[];
  readonly adjudicatedCovered: readonly AdjudicatedCoveredBeat[];
  readonly adjudication: "not_run" | "applied" | "unavailable";
  readonly error?: string;
  /** 去味前没漏、去味后才漏的要点（去味改写吃掉了锚点；复核在去味后对最终正文跑，复核摘掉的不算）。 */
  readonly postDeAiNewMisses?: readonly string[];
}

/**
 * 确定性判漏 + 复核结果 → 工具输出的 beatFidelity 信息。零判漏 → undefined（字段不出现、零成本）；
 * 有判漏但没跑复核（未注入裁决模型）→ adjudication:"not_run"、维持确定性结论。纯逻辑、可测。
 */
export function buildBeatFidelityInfo(input: {
  readonly deterministicMissingBeats: readonly string[];
  readonly adjudication?: BeatMissAdjudication;
}): GenerateDraftBeatFidelityInfo | undefined {
  if (input.deterministicMissingBeats.length === 0) return undefined;
  const adjudication = input.adjudication;
  if (!adjudication) {
    return { missingBeats: input.deterministicMissingBeats, adjudicatedCovered: [], adjudication: "not_run" };
  }
  return {
    missingBeats: adjudication.missingBeats,
    adjudicatedCovered: adjudication.adjudicatedCovered,
    adjudication: adjudication.adjudication,
    ...(adjudication.error ? { error: adjudication.error } : {}),
  };
}

/**
 * 首稿核对的 summary 文案（裁决后）：仍漏的照旧 ⚠ 如实提示；被复核摘除的误报如实交代去向（可追溯，
 * 绝不静默消失）；复核没跑成（unavailable）在警告后如实补一句；自动去味吃掉锚点造成的新漏
 * （postDeAiNewMisses）单独 ⚠ 如实标注来源。全干净（零判漏/全摘除且无残留）时只剩复核交代或空串——
 * 绝不打无内容的 ⚠。纯逻辑、可测。
 */
export function buildBeatFidelityNote(info: GenerateDraftBeatFidelityInfo): string {
  const parts: string[] = [];
  if (info.missingBeats.length > 0) {
    parts.push(
      `⚠ 首稿核对：这几条要点可能漏写或被改写了——${info.missingBeats.join("、")}。要不要我改稿补回？` +
        (info.adjudication === "unavailable" ? "（AI 复核没跑成，按确定性核对结果如实保留。）" : ""),
    );
  }
  if (info.adjudicatedCovered.length > 0) {
    parts.push(
      `首稿复核：初判漏写的 ${info.adjudicatedCovered.length} 条要点（` +
        `${info.adjudicatedCovered.map((entry) => entry.beat).join("、")}）经 AI 复核确认已写入正文，` +
        `不再列为漏写（证据引文见 beatFidelity.adjudicatedCovered）。`,
    );
  }
  if (info.postDeAiNewMisses && info.postDeAiNewMisses.length > 0) {
    parts.push(
      `⚠ 去味后新漏 ${info.postDeAiNewMisses.length} 条要点（${info.postDeAiNewMisses.join("、")}）：` +
        `自动去味的整句改写吃掉了它们的锚点。要不要我改稿补回？`,
    );
  }
  return parts.join("\n");
}

/**
 * 自动去味一轮（最多一轮、不循环）：对内存里的正文 runDeAiFlavorBatch 批量改写 → 对改后正文复检同一套确定性规则，
 * 如实报剩余。不写盘（写作版本 P1b：出稿流程最后一次换上工作稿）。
 * 改写模型失败/解析失败/一处都没能安全替换 → 正文不动 + 如实报（error 或 fixedCount:0）。
 * 返回 draftBody 仅在有真改动时。
 */
export async function runAutoDeAiRound(input: {
  readonly draftBody: string;
  readonly initialHighMedium: number;
  readonly targets: readonly AiFlavorViolation[];
  readonly rules: readonly AiFlavorRule[];
  readonly antiRules: readonly string[];
  readonly callModel: DeAiCallModel;
}): Promise<{ readonly info: GenerateDraftAutoDeAiInfo; readonly draftBody?: string }> {
  const notRun = (error?: string): { readonly info: GenerateDraftAutoDeAiInfo } => ({
    info: {
      attempted: true,
      fixedCount: 0,
      remainingHighMedium: input.initialHighMedium,
      skipped: EMPTY_AUTO_DE_AI_SKIPPED,
      ...(error ? { error } : {}),
    },
  });
  if (!input.draftBody.trim()) return notRun("正文是空的，没法定位改写");
  // 违规句是正文整句、必为正文子串。
  const result = await runDeAiFlavorBatch({
    draftText: input.draftBody,
    violations: input.targets,
    callModel: input.callModel,
    antiRules: input.antiRules,
  });
  if (!result.ok) {
    return {
      info: {
        attempted: true,
        fixedCount: 0,
        remainingHighMedium: input.initialHighMedium,
        skipped: result.skippedByReason,
        ...(result.error ? { error: scrubLocalAbsolutePaths(result.error) } : {}),
      },
    };
  }
  if (result.rewritten === 0 || result.updatedContent === input.draftBody) {
    return {
      info: {
        attempted: true,
        fixedCount: 0,
        remainingHighMedium: input.initialHighMedium,
        skipped: result.skippedByReason,
      },
    };
  }
  // 复检：对改后正文重跑同一套确定性规则（low 不计入剩余——本来就不动它）。
  const remainingHighMedium = detectAiFlavorViolations(result.updatedContent, input.rules)
    .filter((v) => v.severity !== "low").length;
  return {
    info: { attempted: true, fixedCount: result.rewritten, remainingHighMedium, skipped: result.skippedByReason },
    draftBody: result.updatedContent.trim(),
  };
}

/* ---------------------------------------------------------------------------
 * 第四层：多候选采样防坍缩（candidates>1）
 *
 * 采样：N 个候选都只生成不落盘（引擎不写盘，绝不互相覆盖工作稿），temperature 依次错开；
 *   单个候选失败（模型异常/校验不过）如实记 failed，不拖死全局；passed=false 永远不得中选。
 * 选优：确定性评分器（纯函数、可单测、题材中立），绝不用模型打分——「评分选优」的 typicality bias
 *   靠「规则全透明 + 逐候选得分/落选理由/开头预览如实输出」来对冲，而不是引入另一个黑盒偏好。
 * 落盘：优胜稿和 candidates=1 走同一处 draft.applyGenerated（AI 写稿唯一通道 ai-draft-write），之后同一条后续链（aiFlavor 回检 / autoDeAi / 快照 / draftLength 标注）。
 * ------------------------------------------------------------------------- */

/** 多候选采样的 temperature 错开档位幅度（第 1 个=基准，之后错开 0.15/0.3，方向由 resolveCandidateTemperatures 定）。 */
export const DRAFT_CANDIDATE_TEMPERATURE_OFFSETS = [0, 0.15, 0.3] as const;

/**
 * 逐候选实际 temperature：默认向上错开（base、base+0.15、base+0.3，封顶 1.0——部分 provider 上限为 1，
 * 超了会被 400 拒）；base 已 ≥0.85 时向上错不开（+0.15/+0.3 全撞封顶=三版同温，防坍缩静默失效），
 * 改为向下错开（base、base-0.15、base-0.3，下限夹逼 0）。base 本身也先夹逼进 [0,1]。
 * 两位小数取整：0.8+0.15 的浮点尾差（0.9500000000000001）不上请求线。纯逻辑、可测。
 */
export function resolveCandidateTemperatures(baseTemperature: number, candidateCount: number): readonly number[] {
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const base = Math.min(1, Math.max(0, round2(baseTemperature)));
  const direction = base < 0.85 ? 1 : -1; // base≥0.85 时向上必撞封顶（0.85+0.15=1.0 与 0.85+0.3→1.0 同温）
  return DRAFT_CANDIDATE_TEMPERATURE_OFFSETS.slice(0, candidateCount).map((offset) =>
    Math.min(1, Math.max(0, round2(base + direction * offset))),
  );
}

/**
 * 确定性评分权重（100 起扣，越高越好，同分取序号靠前者）：
 * 漏用户/agent 必命中要点最重（-50/条——内容硬约束，选优之后没有任何环节能补回）；
 * 低于字数下限次之（-25——一次成稿不补写，短稿缺陷不会自愈）；
 * AI 腔计权（high×3+medium×1；low 不计——弱信号/用户自定义词不参与选优）每分 -10，
 * 最轻——优胜稿还有 autoDeAi 一轮兜底可修。
 */
export const DRAFT_CANDIDATE_SCORE_WEIGHTS = {
  perMissingBeat: 50,
  belowLowerBound: 25,
  perAiFlavorPoint: 10,
} as const;

/** 评分器输入：单个候选的确定性体检结果（eligible=false=未通过/生成失败，永远不得中选）。 */
export interface DraftCandidateScoreInput {
  readonly index: number;
  readonly eligible: boolean;
  readonly aiFlavorCounts: Readonly<Record<AiFlavorSeverity, number>>;
  readonly belowLowerBound: boolean;
  readonly actualLength: number;
  readonly lowerBound?: number;
  readonly missingBeatCount: number;
  /** eligible=false 的诚实原因（校验 issues / 异常 message），原样进 candidatesReport。 */
  readonly failureReason?: string;
}

/** 逐候选透明报告（index 1 起，与 summary 的「第 N 个」一致；失败候选也列出、score 缺省=未参与评分）。 */
export interface DraftCandidateReportEntry {
  readonly index: number;
  readonly chosen: boolean;
  readonly score?: number;
  readonly aiFlavorCounts: Readonly<Record<AiFlavorSeverity, number>>;
  readonly actualLength: number;
  readonly reason: string;
  /** 该候选正文的开头预览（约前 100 字，供快速比对候选风格）；失败候选没有正文 → 缺省，绝不编造。 */
  readonly excerpt?: string;
  /** 该候选生成时实际使用的 temperature（错温 client 真注入的槽位才有；缺位回退 writerClient 的槽位不标，不编造）。 */
  readonly temperature?: number;
}

/**
 * 候选实际 temperature 并入逐候选报告（如实反映错温结果，含「base 封顶改向下错开」后的真实值）：
 * 只标【真注入了错温 client】的槽位；缺位回退 writerClient 的槽位温度未知 → 不标，绝不编造。纯逻辑、可测。
 */
export function attachCandidateTemperatures(
  entries: readonly DraftCandidateReportEntry[],
  temperatures: readonly number[] | undefined,
  candidateWriterClients: readonly WriterClient[] | undefined,
): readonly DraftCandidateReportEntry[] {
  if (!temperatures) return entries;
  return entries.map((entry, position) =>
    candidateWriterClients?.[position] !== undefined && temperatures[position] !== undefined
      ? { ...entry, temperature: temperatures[position] }
      : entry);
}

/** 候选开头预览长度上限（字符数，按 Unicode 码位计）。 */
export const DRAFT_CANDIDATE_EXCERPT_MAX_CHARS = 100;

/** 预览截断的句读边界字符：截断能落在整句边界就落（避免句子中间戛然而止）；逗号/顿号/冒号仍算半句，不收。 */
const EXCERPT_BOUNDARY_CHARS = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);

/**
 * 候选正文的开头预览（供快速比对候选风格）：正文不足 maxChars 原样返回（无省略号）；
 * 超出时按 Unicode 码位切（CJK 友好：不劈代理对半个字），窗口内最后一个句读边界能保住至少一半预览
 * 就落在边界后，否则硬切 maxChars；只要正文被截断就一律加省略号。纯逻辑、可测。
 */
export function buildCandidateExcerpt(draftBody: string, maxChars: number = DRAFT_CANDIDATE_EXCERPT_MAX_CHARS): string {
  const body = draftBody.trim();
  const chars = Array.from(body);
  if (chars.length <= maxChars) return body;
  let boundary = -1;
  for (let index = 0; index < maxChars; index += 1) {
    if (EXCERPT_BOUNDARY_CHARS.has(chars[index] as string)) boundary = index;
  }
  // 边界太靠前时预览会短得没用（如「开门。」只剩 3 字），宁可硬切保留更多开头内容。
  const cutAt = boundary + 1 >= Math.floor(maxChars / 2) ? boundary + 1 : maxChars;
  return `${chars.slice(0, cutAt).join("").trimEnd()}…`;
}

/**
 * 候选开头预览并入逐候选报告（真机验收发现落选稿 persist:false 不落盘、candidatesReport 只有分数，
 * 用户完全读不到落选稿长什么样）：有正文的候选带开头预览；失败候选（异常/校验不过）没有正文 →
 * 不带该字段（缺省如实反映「没有正文」，绝不编造）。纯逻辑、可测。
 */
export function attachCandidateExcerpts(
  entries: readonly DraftCandidateReportEntry[],
  draftBodies: readonly (string | undefined)[],
): readonly DraftCandidateReportEntry[] {
  return entries.map((entry, position) => {
    const body = draftBodies[position]?.trim();
    return body ? { ...entry, excerpt: buildCandidateExcerpt(body) } : entry;
  });
}

/** AI 腔计权分：high×3 + medium×1（low 不计）。纯逻辑、可测。 */
export function aiFlavorWeightedScore(counts: Readonly<Record<AiFlavorSeverity, number>>): number {
  return counts.high * 3 + counts.medium * 1;
}

/** 单候选确定性得分：100 起扣（权重见 DRAFT_CANDIDATE_SCORE_WEIGHTS），可为负。纯逻辑、可测。 */
export function scoreDraftCandidate(
  input: Pick<DraftCandidateScoreInput, "missingBeatCount" | "belowLowerBound" | "aiFlavorCounts">,
): number {
  return 100
    - input.missingBeatCount * DRAFT_CANDIDATE_SCORE_WEIGHTS.perMissingBeat
    - (input.belowLowerBound ? DRAFT_CANDIDATE_SCORE_WEIGHTS.belowLowerBound : 0)
    - aiFlavorWeightedScore(input.aiFlavorCounts) * DRAFT_CANDIDATE_SCORE_WEIGHTS.perAiFlavorPoint;
}

/**
 * 确定性选优：eligible 候选里取最高分，同分保留序号靠前者（严格更高才替换，无任何随机/模型偏好）；
 * 无 eligible → chosenIndex 缺省（调用方据此 ok:false 诚实回报）。逐候选报告按生成顺序、index 1 起。
 * 纯逻辑、可测。
 */
export function rankDraftCandidates(
  inputs: readonly DraftCandidateScoreInput[],
): { readonly chosenIndex?: number; readonly entries: readonly DraftCandidateReportEntry[] } {
  const scored = inputs.map((input) => ({ input, score: input.eligible ? scoreDraftCandidate(input) : undefined }));
  let champion: { readonly input: DraftCandidateScoreInput; readonly score?: number } | undefined;
  for (const current of scored) {
    if (current.score === undefined) continue;
    if (champion?.score === undefined || current.score > champion.score) champion = current;
  }
  const entries = scored.map((current, position) => {
    const base = {
      index: position + 1,
      chosen: champion !== undefined && current.input.index === champion.input.index,
      aiFlavorCounts: current.input.aiFlavorCounts,
      actualLength: current.input.actualLength,
    };
    if (current.score === undefined) {
      return { ...base, reason: current.input.failureReason ?? "生成失败：未知原因" };
    }
    if (champion === undefined || champion.input.index === current.input.index) {
      return { ...base, score: current.score, reason: buildWinnerCandidateReason(current.input, current.score) };
    }
    return { ...base, score: current.score, reason: buildLoserCandidateReason(current.input, champion.input) };
  });
  return { ...(champion ? { chosenIndex: champion.input.index } : {}), entries };
}

/** 优胜理由：只讲自己的体检事实 + 综合评分最高（「最少/最好」类比较词留给 summary 行，那里会逐个核实）。 */
function buildWinnerCandidateReason(input: DraftCandidateScoreInput, score: number): string {
  const highMedium = input.aiFlavorCounts.high + input.aiFlavorCounts.medium;
  const facts = [
    input.missingBeatCount === 0 ? "要点全中" : `必命中要点漏 ${input.missingBeatCount} 条`,
    input.belowLowerBound ? `低于字数下限（${belowLowerBoundFact(input)}）` : "字数达标",
    `AI 腔 ${highMedium} 处`,
  ];
  return `综合评分最高（${score} 分）：${facts.join("、")}`;
}

/** 落选理由：一句人话。同分→讲清 tie-break；否则报「第一个比优胜者差的轴」（权重顺序：要点 > 字数 > AI 腔）。 */
function buildLoserCandidateReason(loser: DraftCandidateScoreInput, winner: DraftCandidateScoreInput): string {
  const loserScore = scoreDraftCandidate(loser);
  if (loserScore === scoreDraftCandidate(winner)) {
    return `与优胜者同分（${loserScore} 分），按候选顺序取序号靠前者`;
  }
  if (loser.missingBeatCount > winner.missingBeatCount) {
    return `必命中要点漏 ${loser.missingBeatCount} 条 > 优胜者 ${winner.missingBeatCount} 条`;
  }
  if (loser.belowLowerBound && !winner.belowLowerBound) {
    return `低于字数下限（${belowLowerBoundFact(loser)}），优胜者达标`;
  }
  const loserWeighted = aiFlavorWeightedScore(loser.aiFlavorCounts);
  const winnerWeighted = aiFlavorWeightedScore(winner.aiFlavorCounts);
  if (loserWeighted > winnerWeighted) {
    const loserHighMedium = loser.aiFlavorCounts.high + loser.aiFlavorCounts.medium;
    const winnerHighMedium = winner.aiFlavorCounts.high + winner.aiFlavorCounts.medium;
    return loserHighMedium !== winnerHighMedium
      ? `AI 腔 ${loserHighMedium} 处 > 优胜者 ${winnerHighMedium} 处`
      : `AI 腔同为 ${loserHighMedium} 处但 high 档更多（high ${loser.aiFlavorCounts.high} 处 > 优胜者 ${winner.aiFlavorCounts.high} 处）`;
  }
  // 防御兜底：总分更低必有一轴更差（上面已全覆盖），真走到这也如实给总分对比，绝不静默。
  return `综合评分 ${loserScore} 分 < 优胜者 ${scoreDraftCandidate(winner)} 分`;
}

function belowLowerBoundFact(input: DraftCandidateScoreInput): string {
  return `实际${input.actualLength}字${input.lowerBound !== undefined ? `/下限${input.lowerBound}字` : ""}`;
}

/**
 * summary 一行的选优人话：「已生成 3 个候选并选出第 2 个（要点全中、字数达标、无 AI 腔命中），其余落选原因见
 * candidatesReport。」括号里的优点逐条核实过才说——「AI 腔最少」只在确实不比任何其他合格候选差时讲（含并列），
 * 绝不为了好看夸口。纯逻辑、可测。
 */
export function buildCandidateSummaryLine(
  candidateCount: number,
  chosen: DraftCandidateScoreInput,
  all: readonly DraftCandidateScoreInput[],
): string {
  const merits: string[] = [];
  if (chosen.missingBeatCount === 0) merits.push("要点全中");
  if (!chosen.belowLowerBound) merits.push("字数达标");
  const chosenWeighted = aiFlavorWeightedScore(chosen.aiFlavorCounts);
  const chosenHighMedium = chosen.aiFlavorCounts.high + chosen.aiFlavorCounts.medium;
  if (chosenHighMedium === 0) {
    merits.push("无 AI 腔命中");
  } else {
    const flavorIsMin = all.every((other) =>
      other.index === chosen.index || !other.eligible || aiFlavorWeightedScore(other.aiFlavorCounts) >= chosenWeighted);
    if (flavorIsMin) merits.push(`AI 腔最少（${chosenHighMedium} 处）`);
  }
  return `已生成 ${candidateCount} 个候选并选出第 ${chosen.index + 1} 个` +
    (merits.length > 0 ? `（${merits.join("、")}）` : "（综合评分最高）") +
    `，其余落选原因见 candidatesReport。`;
}

/**
 * 单个候选的 runFastDraft 报告 → 评分器输入（异常 / passed:false / 无正文 → eligible:false + 诚实原因）。
 * beatAdjudication=该候选判漏要点的 AI 复核结果（有判漏且注入了裁决模型才跑）：评分吃【裁决后】漏报数，
 * 误报摘除后不再冤枉扣分；复核 unavailable 时 missingBeats=确定性原样，计数不变（安全方向）。
 */
export function scoreInputFromCandidateReport(
  index: number,
  report: Pick<FastDraftReport, "passed" | "draftBody" | "issues" | "draftLength" | "beatFidelity" | "aiFlavor"> | undefined,
  exception?: string,
  beatAdjudication?: BeatMissAdjudication,
): DraftCandidateScoreInput {
  if (!report) {
    return {
      index,
      eligible: false,
      aiFlavorCounts: { high: 0, medium: 0, low: 0 },
      belowLowerBound: false,
      actualLength: 0,
      missingBeatCount: 0,
      failureReason: `生成失败：${exception ?? "未知错误"}`,
    };
  }
  const base = {
    index,
    aiFlavorCounts: report.aiFlavor?.bySeverity ?? { high: 0, medium: 0, low: 0 },
    belowLowerBound: report.draftLength?.lengthStatus === "below_lower_bound",
    actualLength: report.draftLength?.actualLength ?? 0,
    ...(report.draftLength?.lowerBound !== undefined ? { lowerBound: report.draftLength.lowerBound } : {}),
    missingBeatCount: beatAdjudication?.missingBeats.length ?? report.beatFidelity?.missingBeats.length ?? 0,
  };
  if (!report.passed) {
    return {
      ...base,
      eligible: false,
      failureReason: `未通过引擎校验（${report.issues.length > 0 ? report.issues.join("；") : "引擎拒绝写盘"}）`,
    };
  }
  if (!report.draftBody || report.draftBody.trim().length === 0) {
    return { ...base, eligible: false, failureReason: "引擎未返回候选正文" };
  }
  return { ...base, eligible: true };
}

/* ---------------------------------------------------------------------------
 * 共享 prelude、D5 抽卡
 * ------------------------------------------------------------------------- */

/** D5 抽卡（persist:false）输入：HTTP 专属能力；无策略参数——不写盘、不快照、不执法、不回检。 */
export interface GenerateDraftCandidateInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  /** 作者点名本章要写的人（名字）。 */
  readonly selectedCharacters?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  readonly maxOutputTokens?: number;
  readonly writerClient: WriterClient;
  /**
   * 拟章纲（2026-10-10 引擎升级第 5 期「出稿一条路」）：写作台「写第一版 / 再来一版」也先拿章纲再写，
   * 和对话里让 AI 写同一套（沿用已有章纲；没有就拟一份并审校）。缺省 = 不拟（旧行为，测试用）。
   */
  readonly plannerCallModel?: BrainCallModel;
  readonly planCheckReaderCallModel?: BrainCallModel;
}

export interface GenerateDraftCandidateOutcome {
  /** 章纲一句话（或拟不成的原因），给作者看。 */
  readonly planNote?: string;
  readonly candidate: FastDraftReport;
  readonly characterSelection: InSceneResult;
  readonly contextRanking: WriterRankContextPlan;
}

/** 共享 prelude：出稿操作和抽卡同一套「方向默认/数值归一/预算裁剪账本/在场角色解析/长度目标/回检规则」。 */
export interface DraftRunContext {
  readonly chapterGoal: string;
  readonly requestedDraftLength?: number;
  readonly maxTimelineEvents: number;
  readonly lengthTarget: DraftLengthTarget;
  readonly contextRanking: WriterRankContextPlan;
  readonly characterSelection: InSceneResult;
  /** 作者点名本章要写的人（名字）。 */
  readonly selectedCharacters?: readonly string[];
  readonly aiFlavorRules?: readonly AiFlavorRule[];
  readonly chapterPlan?: ChapterPlan;
  /** 这一章上一稿核出的「确定」对不上（错在本章的）：写手别再照着写错。 */
  readonly lastDraftConflicts?: readonly LastDraftConflict[];
}

/**
 * 这一章上一稿核账核出的「确定」对不上、错在本章的（核账记忆里的）：重写、接着写时交给写手
 * （长篇连写：重写沿用章纲，章纲里的「三楼走廊」又写了一遍）。没核过 / 读不了 / 那之后前文、账、设定改过就没有。
 */
async function readLastDraftConflicts(projectDir: string, chapter: number): Promise<readonly LastDraftConflict[]> {
  const memory = await readCurrentCheckMemory(projectDir, chapter).catch(() => undefined);
  if (!memory) return [];
  return memory.issues
    .filter((issue) => issue.confidence === "sure" && (issue.fixChapter === undefined || issue.fixChapter === chapter))
    .map((issue) => ({
      wrote: issue.quote,
      against: issue.earlierQuote,
      where: issue.againstSetting ? `设定（${issue.againstSetting.label}）` : issue.earlierChapter === chapter ? "本章前面" : `第 ${issue.earlierChapter} 章`,
      why: issue.reason,
    }));
}

export async function resolveDraftRunContext(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  /** 作者点名本章要写的人（名字）。 */
  readonly selectedCharacters?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  readonly aiFlavorRecheck: boolean;
  readonly chapterPlan?: ChapterPlan;
}): Promise<DraftRunContext> {
  // 有章纲而作者没给方向：本章目标用章纲的一句话，不再是空话「继续第 N 章。」。
  const chapterGoal = input.chapterGoal?.trim() || input.chapterPlan?.summary || `继续第 ${input.chapter} 章。`;
  // 模型无关：模型常把 maxTimelineEvents/contextTokenBudget 传成 `0`（当"默认/不限"用），而 `0` 在
  // 引擎里是"显式锁定/极限裁剪"——会静默砍掉时间线 + 全部非保护上下文段（长篇慢性失忆，真机 ch2/ch3
  // 已被 contextTokenBudget:"0" 触发）。这里把模型面的非正数一律当"未提供→默认"，绝不当显式锁定。
  // （resolveWriterTokenBudget(0)=0 极限裁剪的内部契约保留给路由/内部调用，只在模型入参层归一；
  //   路由侧入参先经 readPositiveInteger 过滤，到这里同义。）
  const requestedDraftLength = positiveOrUndefined(input.requestedDraftLength);
  const maxTimelineEvents = positiveOrUndefined(input.maxTimelineEvents) ?? 8;
  // 洞①修复：生产路径即便没显式给预算，也套用默认预算（resolveWriterTokenBudget），
  // 让 dynamic 裁剪真正生效；正常短篇 dynamic 远低于默认值=自然 no-op，仅长篇超额时才裁。
  const contextRanking = makeWriterRankContext({ tokenBudget: resolveWriterTokenBudget(positiveOrUndefined(input.contextTokenBudget)) });
  // 设定本只读一次，在场检测和字数共用。读坏了照样出稿（同写手、上下文网关的口径：降级 + 如实说），不按人物卡选人。
  const bibleRead = await readBibleTolerant(input.projectDir);
  const characterSelection: InSceneResult = bibleRead.projection
    ? await resolveInSceneCharacters({
      projectDir: input.projectDir,
      chapter: input.chapter,
      // 章纲点名的出场人物/要点也参与在场检测（检测按名字词面命中）。
      chapterGoal: input.chapterPlan
        ? [chapterGoal, input.chapterPlan.characters.join("、"), ...input.chapterPlan.beats].join("\n")
        : chapterGoal,
      ...(input.selectedCharacters ? { explicit: input.selectedCharacters } : {}),
      bible: { bible: bibleRead.bible, projection: bibleRead.projection },
    })
    : { selected: [], reasons: {}, prevChapterFound: false, explicit: false, cappedOutNames: [], summary: bibleRead.failure ?? "设定本读不出来，这次没按人物卡挑在场人物。" };
  const selectedCharacters = characterSelection.selected.length > 0 ? characterSelection.selected : undefined;
  const lengthTarget = resolveDraftLengthTarget({ chapterGoal, requestedDraftLength, lengthRules: lengthRulesOf(bibleRead.bible.rules) });

  // D2 出稿即自动回检（warning-only）的开关：内置确定性规则（7 条模式 + 虚弱副词频率闸）+ 项目写作规则的
  // antiAiPatterns（用户自定义词，字面量匹配、一律 low 档）。writing-rules.json 读不到 → 只剩内置规则，不崩。
  // aiFlavorRecheck:false（HTTP 按钮路现状）→ 不传规则给引擎，report 无 aiFlavor 字段。
  const aiFlavorRules = input.aiFlavorRecheck
    ? [...ALL_BUILTIN_AI_FLAVOR_RULES, ...buildUserAntiAiPatternRules(await readAntiAiPatterns(input.projectDir))]
    : undefined;
  const lastDraftConflicts = await readLastDraftConflicts(input.projectDir, input.chapter);

  return {
    chapterGoal,
    ...(requestedDraftLength !== undefined ? { requestedDraftLength } : {}),
    maxTimelineEvents,
    lengthTarget,
    contextRanking,
    characterSelection,
    ...(selectedCharacters !== undefined ? { selectedCharacters } : {}),
    ...(aiFlavorRules !== undefined ? { aiFlavorRules } : {}),
    ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
    ...(lastDraftConflicts.length > 0 ? { lastDraftConflicts } : {}),
  };
}

export function sharedFastDraftInput(run: DraftRunContext, input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly selectedHookIds?: readonly string[];
  readonly mustHitBeats?: readonly string[];
  readonly maxOutputTokens?: number;
  readonly segmentByPlan?: boolean;
}): Omit<FastDraftInput, "writerClient" | "persist" | "dryRun"> {
  return {
    projectDir: input.projectDir,
    chapter: input.chapter,
    chapterGoal: run.chapterGoal,
    ...(run.aiFlavorRules !== undefined ? { aiFlavorRules: run.aiFlavorRules } : {}),
    // 键位恒在（值可 undefined）：HTTP 路由测试按 objectContaining 锁定 requestedDraftLength 键存在性，
    // 引擎侧 `undefined` 与缺键同义（?? 兜底），工具路零行为变化。
    requestedDraftLength: run.requestedDraftLength,
    ...(run.selectedCharacters !== undefined ? { selectedCharacters: run.selectedCharacters } : {}),
    ...(input.selectedHookIds !== undefined ? { selectedHookIds: input.selectedHookIds } : {}),
    ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
    maxTimelineEvents: run.maxTimelineEvents,
    maxOutputTokens: positiveOrUndefined(input.maxOutputTokens) ?? resolveDraftMaxOutputTokens(run.lengthTarget),
    rankContext: run.contextRanking.rankContext,
    ...(run.chapterPlan ? { chapterPlan: run.chapterPlan } : {}),
    ...(run.lastDraftConflicts ? { lastDraftConflicts: run.lastDraftConflicts } : {}),
    ...(run.chapterPlan && input.segmentByPlan ? { segmentByPlan: true } : {}),
  };
}

/**
 * D5 抽卡候选（HTTP 独有入参 persist:false 的 service 能力）：runFastDraft 只生成不落盘、
 * 不快照，候选正文交路由临时并排展示，挑中才落盘（/api/draft/apply-candidate）。不带 AI 腔回检（与
 * 按钮路一致）。失败如实：candidate.passed=false + issues，路由投影 422。
 */
export async function generateDraftCandidate(input: GenerateDraftCandidateInput): Promise<GenerateDraftCandidateOutcome> {
  const planning = input.plannerCallModel
    ? await resolveChapterPlanForReroll({
      projectDir: input.projectDir,
      chapter: input.chapter,
      ...(input.chapterGoal?.trim() ? { direction: input.chapterGoal } : {}),
      plannerCallModel: input.plannerCallModel,
      ...(input.planCheckReaderCallModel ? { planCheckReaderCallModel: input.planCheckReaderCallModel } : {}),
    })
    : undefined;
  // 作者没给新方向：写手拿的本章目标也沿用章纲里记着的作者原话，和第一版出稿时一样。
  const chapterGoal = input.chapterGoal?.trim() || planning?.direction;
  const run = await resolveDraftRunContext({
    ...(planning?.plan ? { chapterPlan: planning.plan } : {}),
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(chapterGoal ? { chapterGoal } : {}),
    ...(input.requestedDraftLength !== undefined ? { requestedDraftLength: input.requestedDraftLength } : {}),
    ...(input.selectedCharacters !== undefined ? { selectedCharacters: input.selectedCharacters } : {}),
    ...(input.maxTimelineEvents !== undefined ? { maxTimelineEvents: input.maxTimelineEvents } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
    aiFlavorRecheck: false,
  });
  const candidate = await runFastDraft({
    // 和对话里出稿一样有章纲就分前后两半写：一口气写的候选常短到目标的一半（换题材长篇实跑 2026-10-27：1,090 / 1,591 字，目标 2,000）。
    ...sharedFastDraftInput(run, { ...input, segmentByPlan: true }),
    writerClient: input.writerClient,
    dryRun: false,
  });
  return { candidate, characterSelection: run.characterSelection, contextRanking: run.contextRanking, ...(planning?.note ? { planNote: planning.note } : {}) };
}

/**
 * 拼接点句号去重（编辑部 R5.4·新发现 4）：占位名册的两句选角回执自带句号（in-scene-detector 的
 * 「本次没拿占位名把关。」），出稿回执在它后面再拼「。」曾得到「把关。。」。选角回执单独展示时
 * 仍应带句号，所以不去改它，在这里归一：末尾句号收干净、补回恰好一个。
 */
export function presenceSummarySentence(summary: string): string {
  // 不猜白名单：切句
  const trimmed = summary.trim().replace(/。+$/u, "");
  return trimmed.length === 0 ? "" : `${trimmed}。`;
}

export function optionalContextBudget(contextRanking: WriterRankContextPlan): { readonly contextBudget: ReturnType<typeof contextBudgetPayload> } | Record<string, never> {
  return contextRanking.droppedSections.length > 0 || contextRanking.coreImpact || contextRanking.issues.length > 0
    ? { contextBudget: contextBudgetPayload(contextRanking) }
    : {};
}
