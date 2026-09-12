/**
 * draft-service — 出稿的共享 application service（双轨合一·第二波最后一对：generate-draft 簇）。
 *
 * POST /api/draft/generate（非流式，routes/draft.ts handleGenerateDraft）与 generate_draft 工具
 * （agent/tools/generate-draft.ts execute）此前各自进程内复刻同一出稿编排，是全部双轨对里漂移
 * 最大的一对（漂移清单 D1–D5 的处置结论见 parity/draft-generate.parity.test.ts 头注释）。收编后
 * 本 service 落定 canonical 编排：上下文预算裁剪 + 在场角色解析 → runFastDraft（单候选 persist:true
 * 落盘；或多候选 persist:false 采样 + 确定性评分选优 + persistFastDraftBody 优胜落盘）→ 字数执法
 * （显式策略参数）→ AI 腔回检/自动去味/beats 裁决（显式开关）→ 总览重建 + 诚实 summary。
 *
 * 两侧只剩适配层：
 *   - 路由：HTTP 入参解析 + 200/422 投影（report/draftContent/draftTitle/overview/warnings 包装）。
 *   - 工具：RequestContext 章号回退与已入库前沿推进、写作意图门、章序护栏（D3：agent 语义，留在
 *     工具层）、writer 装配（delta sink / 候选错温）、repair/triage 任务槽 callModel 装配、输出投影。
 *
 * 显式策略参数（原豁免清单里的分歧，收敛成参数而非暗差）：
 *   - policies.lengthPolicy（D1）：
 *       "enforce_or_rollback"（HTTP 非流式路现状）——落盘后回读执法：低于下限 → 回滚旧稿（无旧稿
 *         删新文件）+ rejection:length_rejected（路由投影 422）；超上限 → 确定性裁剪重写落盘并重建
 *         report.draftLength。
 *       "annotate"（工具路现状，默认）——一次成稿不拒绝：照写盘，draftLength 如实透出 + summary ⚠ 标注。
 *   - policies.aiFlavorRecheck（D2，默认 true=工具语义）：给引擎传内置规则+项目 antiAiPatterns 做出稿
 *       回检（report.aiFlavor），并接通 autoDeAi/beats 裁决栈。HTTP 按钮路显式传 false 维持现状
 *       （产品尚未决定给按钮路开回检）——分歧从「两套实现」变成「同一 service 的显式开关」。
 *   - input.autoDeAi（默认 true）：检出 high/medium 后自动去味一轮（批量改写+复检，最多一轮不循环，
 *       覆盖落盘前快照）；false=只标注不改写。
 *
 * 快照时机（D4，刻意收敛为统一语义）：两侧适配层同调 snapshotBeforeDraftOverwrite——仅覆盖已有
 *   非空草稿前建可撤销快照；首次出稿无旧稿可丢，不建、不留无意义提交（M6 语义）。HTTP 路原「每次
 *   出稿前无条件 createSnapshot」收敛到此：首次出稿不再产生空快照/不再进操作历史（与工具路自 M6 起
 *   的行为一致；「覆盖写前必有撤销点」的安全不变量两侧一寸未让）。自动去味覆盖刚落盘的草稿前同样
 *   先快照（本 service 内 runAutoDeAiRound，行为未动）。
 *
 * HTTP 专属能力（保留在 service，工具 schema 不变）：
 *   - generateDraftCandidate（D5 persist:false 抽卡）：只生成不落盘、不快照，候选正文交路由临时展示。
 *   - maxOutputTokens 显式覆盖入参（工具入参面无此项）；缺省统一显式解析为
 *     resolveDraftMaxOutputTokens(lengthTarget)——与引擎内部默认逐位同源同值，两侧同一来源。
 *
 * 流式出稿（POST /api/draft/stream）不走本 service：它是 SSE 特有编排（直连上游 fetch 流式吐字 +
 *   空闲超时守活 + 断流/过短补写重试 + 标题生成 + 不落盘由前端接稿），与非流式/工具路无共享编排面；
 *   仅复用本 service 导出的长度解析/校验纯函数（resolveProjectDraftLengthTarget / countCjkChars /
 *   validateStreamedDraftBody）。
 *
 * 依赖说明：本 service 自包含（无共享 index），但出稿编排真实复用 agent 侧的纯函数/helper
 *   （context-budget/presence/ai-flavor/lenient-args/snapshot-on-draft-overwrite/check-ai-flavor 的
 *   读规则函数）——它们不 import services，无循环依赖。
 *
 * 铁律继承（一字未动）：优胜稿落盘唯一通道 persistFastDraftBody；passed=false 的候选永远不得中选；
 * 回检/裁决/去味全部 warning-only，绝不影响出稿 ok；绝不静默失败、绝不谎报。
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  buildDraftLengthReport,
  buildStateOverview,
  checkDraftBeatFidelity,
  countDraftChineseCharacters,
  detectAiFlavorViolations,
  persistFastDraftBody,
  readWritingRules,
  resolveDraftLengthTarget,
  resolveDraftMaxOutputTokens,
  runFastDraft,
  trimDraftBodyToLengthTarget,
  type AiFlavorReport,
  type AiFlavorRule,
  type AiFlavorSeverity,
  type AiFlavorViolation,
  type DraftLengthReport,
  type DraftLengthStatus,
  type DraftLengthTarget,
  type DraftLengthTargetSource,
  type FastDraftInput,
  type FastDraftReport,
  type StateOverview,
  type WriterClient,
} from "@actalk/story-engine";

import { adjudicateMissingBeats, isAdjudicationQuoteVerbatim, type AdjudicatedCoveredBeat, type BeatMissAdjudication } from "../lib/beat-miss-adjudication.js";
import { defaultDraftPath, extractDraftTitle, stripLeadingMarkdownChapterHeading } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { positiveOrUndefined } from "../agent/tools/lenient-args.js";
import { readAntiAiPatterns, readAntiRules } from "../agent/tools/check-ai-flavor.js";
import { snapshotBeforeDraftOverwrite } from "../agent/tools/snapshot-on-draft-overwrite.js";
import { contextBudgetPayload, makeWriterRankContext, resolveWriterTokenBudget, type WriterRankContextPlan } from "../agent/context-budget/rank-writer-context.js";
import { resolveSelectedCharacterIds, type CharacterPresenceResult } from "../agent/presence/in-scene-detector.js";
import { ALL_BUILTIN_AI_FLAVOR_RULES, buildUserAntiAiPatternRules } from "../agent/ai-flavor/ai-flavor-rules.js";
import { runDeAiFlavorBatch, type DeAiSkippedByReason } from "../agent/ai-flavor/de-ai-flavor-batch.js";

/* ---------------------------------------------------------------------------
 * 长度目标解析与执法（D1：原 routes/draft.ts 的 enforce 栈整体迁入，逻辑一字未动）
 * ------------------------------------------------------------------------- */

const DRAFT_TOO_SHORT_ERROR = "草稿正文低于目标字数过多，已拒绝写入工作稿；请重试或提高模型输出上限。";
const DRAFT_TOO_LONG_ERROR = "草稿正文超出目标字数过多，压缩后仍不稳定；已拒绝写入工作稿，请重试。";

/** 项目级章节目标字数解析：用户显式 > 方向文本里的数字 > 写作规则 > 默认（引擎 resolveDraftLengthTarget 同序）。 */
export async function resolveProjectDraftLengthTarget(
  projectDir: string,
  chapterGoal: string,
  requestedDraftLength?: number,
): Promise<DraftLengthTarget> {
  const writingRules = await readWritingRules(projectDir).catch(() => null);
  return resolveDraftLengthTarget({ chapterGoal, requestedDraftLength, writingRules });
}

export function countCjkChars(value: string): number {
  return countDraftChineseCharacters(value);
}

/** 流式/执法共用的正文有效性校验：过短或段落数不足视为「只吐了标题/无效草稿」。 */
export function validateStreamedDraftBody(value: string): string | null {
  const body = value
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/^#+\s*第[一二三四五六七八九十百\d]+章[^\n]*$/gmu, "")
    .trim();
  const cjkCount = countCjkChars(body);
  const paragraphs = body.split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
  if (cjkCount < 200 || paragraphs.length < 3) {
    return "模型返回的正文过短，疑似只返回标题或无效草稿；已拒绝写入 drafts/fast，请重新生成。";
  }
  return null;
}

/** D1 执法器：低于下限拒；区间内放行（正文 trim）；超上限允许确定性裁剪，裁剪失败/裁后无效拒。 */
function enforceDraftLengthTarget(input: {
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly allowDeterministicTrim: boolean;
}): { readonly ok: true; readonly draftBody: string } | { readonly ok: false; readonly error: string } {
  const currentLength = countCjkChars(input.draftBody);
  if (currentLength < input.lengthTarget.lowerBound) {
    return { ok: false, error: DRAFT_TOO_SHORT_ERROR };
  }
  if (currentLength <= input.lengthTarget.upperBound) {
    return { ok: true, draftBody: input.draftBody.trim() };
  }
  if (!input.allowDeterministicTrim) {
    return { ok: false, error: DRAFT_TOO_LONG_ERROR };
  }
  const trimmed = trimDraftBodyToLengthTarget(input.draftBody, input.lengthTarget);
  if (!trimmed.ok || validateStreamedDraftBody(trimmed.draftBody)) {
    return { ok: false, error: DRAFT_TOO_LONG_ERROR };
  }
  return { ok: true, draftBody: trimmed.draftBody.trim() };
}

/** 执法拒稿回滚：有旧稿原文则写回，无旧稿删掉引擎刚写的文件（绝不把拒收的短稿留在盘上）。 */
async function restoreDraftFile(draftPath: string, previousContent: string | undefined): Promise<void> {
  if (previousContent !== undefined) {
    await writeFile(draftPath, previousContent, "utf-8");
    return;
  }
  await rm(draftPath, { force: true });
}

/* ---------------------------------------------------------------------------
 * 输出信息的纯逻辑提纯/文案（原 generate-draft.ts 的逻辑层，逐字迁入）
 * ------------------------------------------------------------------------- */

/** 工具输出的字数核对信息：引擎 DraftLengthReport 的关键字段提纯（目标区间/实际字数/是否低于下限/目标来源）。 */
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
  return `⚠ 检出 ${info.total} 处疑似 AI 腔（${breakdown}），可对我说「去AI味」逐条修订。`;
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
      `⚠ 检出 ${detectedHighMedium} 处疑似 AI 腔，自动去味没跑成（${info.error}）——原稿未动、保留初始检出；` +
      `可让我重试，或对我说「去AI味」手动逐条修。`
    );
  }
  if (info.fixedCount === 0) {
    return (
      `⚠ 检出 ${detectedHighMedium} 处疑似 AI 腔，自动去味没能安全替换（模型没给有效改写或定位不到）——原稿未动；` +
      `可对我说「去AI味」逐条手动修。`
    );
  }
  if (info.remainingHighMedium === 0) {
    return `已自动去 AI 味修掉 ${info.fixedCount} 处，复检干净。`;
  }
  return (
    `⚠ 已自动去 AI 味修掉 ${info.fixedCount} 处疑似 AI 腔，复检还剩 ${info.remainingHighMedium} 处——` +
    `可对我说「去AI味」继续逐条修。`
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
  return `⚠ 低于目标字数下限（实际${info.actualLength}字/下限${info.lowerBound}字）。可以按原样接受，或让我重写一版补足字数。`;
}

/** 必命中要点保真核对的工具输出信息：missingBeats 是【裁决后】结果；被摘除的误报进 adjudicatedCovered（可追溯）。 */
export interface GenerateDraftBeatFidelityInfo {
  readonly missingBeats: readonly string[];
  readonly adjudicatedCovered: readonly AdjudicatedCoveredBeat[];
  readonly adjudication: "not_run" | "applied" | "unavailable";
  readonly error?: string;
  /** 自动去味真落改动后对最终正文复核时【新出现】的漏写（基准集是裁决【前】的确定性判漏）；确定性结果、未经 AI 复核。 */
  readonly postDeAiNewMisses?: readonly string[];
  /** 去味恰好改写了复核引证句的条目：覆盖结论的证据已过期，从 adjudicatedCovered 移出单列（可追溯，不静默）。 */
  readonly staleAdjudications?: readonly AdjudicatedCoveredBeat[];
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
        `自动去味的整句改写吃掉了它们的锚点（这是对去味后最终正文的确定性复核，未经 AI 复核）。要不要我改稿补回？`,
    );
  }
  if (info.staleAdjudications && info.staleAdjudications.length > 0) {
    parts.push(
      `⚠ 去味改写了 ${info.staleAdjudications.length} 条要点的复核引证句（` +
        `${info.staleAdjudications.map((entry) => entry.beat).join("、")}）：这些要点此前经 AI 复核确认已写入正文，` +
        `但证据句被自动去味改掉了，当前是否仍被覆盖需要确认。要不要我复核一遍？`,
    );
  }
  return parts.join("\n");
}

/**
 * 回读工作稿正文，去 Markdown 章节标题。刚写盘的文件偶发读空（FS 抖动）→ 重试几次兜底（L1）。
 * 全部取不到才返回空（调用方据此沿用旧 draft，不谎报失败）。retries/delayMs 仅为单测可注入。
 */
export async function readDraftBodyWithRetry(
  draftPath: string,
  opts: { readonly retries?: number; readonly delayMs?: number } = {},
): Promise<string> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 60;
  for (let attempt = 0; attempt < retries; attempt++) {
    const fileContent = await readFile(draftPath, "utf-8").catch(() => "");
    const body = stripLeadingMarkdownChapterHeading(fileContent).trim();
    if (body.length > 0) return body;
    if (attempt < retries - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return "";
}

/**
 * 回读刚写盘文件的原始全文（含标题行），FS 抖动重试（与 L1 同口径：3×60ms）。
 * D1 enforce 路的执法基准必须是磁盘真稿（执法/标题提取都要原文），故不能用上面的去标题版。
 * 全部失败返回 ""——调用方据此如实降级（执法跳过留痕），绝不静默。retries/delayMs 仅为单测可注入。
 */
export async function readFileContentWithRetry(
  path: string,
  opts: { readonly retries?: number; readonly delayMs?: number } = {},
): Promise<string> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 60;
  for (let attempt = 0; attempt < retries; attempt++) {
    const content = await readFile(path, "utf-8").catch(() => "");
    if (content.trim().length > 0) return content;
    if (attempt < retries - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return "";
}

/** D1 enforce 写前读旧稿的三态结果：缺席（首稿）/读到原文/存在但读不出（调用方须 fail-closed 拒稿）。 */
export type PreviousDraftReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly content: string }
  | { readonly kind: "unreadable"; readonly error: string };

/**
 * enforce 路的写前旧稿读取（P2-5 fail-closed）：旧稿原文是执法拒稿回滚的唯一凭据——旧稿存在但读失败
 * 时若当「无旧稿」继续，拒稿回滚会走 rm 把盘上真稿删掉。故三态必须分清：ENOENT=真无旧稿（确定答案，
 * 不重试；回滚删引擎新写的文件是对的）；读到=回滚写回原文；其余错误重试（L1 同口径 3×60ms）仍失败
 * =unreadable——调用方在写盘前诚实拒稿（此刻引擎尚未落盘，真稿分毫不动），绝不删真稿。
 * retries/delayMs 仅为单测可注入。
 */
export async function readPreviousDraftForRollback(
  draftPath: string,
  opts: { readonly retries?: number; readonly delayMs?: number } = {},
): Promise<PreviousDraftReadResult> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 60;
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const content = await readFile(draftPath, "utf-8");
      return { kind: "present", content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      lastError = error;
      if (attempt < retries - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return { kind: "unreadable", error: lastError instanceof Error ? lastError.message : String(lastError) };
}

/**
 * 自动去味一轮（最多一轮、不循环）：读工作稿全文 → runDeAiFlavorBatch 批量改写 → 有真改动才
 * 先快照（对齐 revise_draft 的覆盖前快照）+ 写盘 → 对改后正文复检同一套确定性规则，如实报剩余。
 * 改写模型失败/解析失败/一处都没能安全替换 → 原稿不动 + 如实报（error 或 fixedCount:0）。
 * 返回 draftBody 仅在有真改动时（调用方据此更新输出里的正文，前端看到的是改后稿）。
 */
export async function runAutoDeAiRound(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftPath: string;
  readonly initialHighMedium: number;
  readonly targets: readonly AiFlavorViolation[];
  readonly rules: readonly AiFlavorRule[];
  readonly antiRules: readonly string[];
  readonly callModel: (prompt: string) => Promise<string>;
}): Promise<{ readonly info: GenerateDraftAutoDeAiInfo; readonly draftBody?: string; readonly snapshotId?: string }> {
  const notRun = (error?: string): { readonly info: GenerateDraftAutoDeAiInfo } => ({
    info: {
      attempted: true,
      fixedCount: 0,
      remainingHighMedium: input.initialHighMedium,
      skipped: EMPTY_AUTO_DE_AI_SKIPPED,
      ...(error ? { error } : {}),
    },
  });
  // 违规句是正文整句、必为全文子串；对全文（含标题行）定位落盘，标题不动（对齐 routes/de-ai-flavor.ts）。
  const rawDraft = await readFile(input.draftPath, "utf-8").catch(() => "");
  if (!rawDraft.trim()) return notRun("工作稿读不到，没法定位改写");

  const result = await runDeAiFlavorBatch({
    draftText: rawDraft,
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
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }
  if (result.rewritten === 0 || result.updatedContent === rawDraft) {
    return {
      info: {
        attempted: true,
        fixedCount: 0,
        remainingHighMedium: input.initialHighMedium,
        skipped: result.skippedByReason,
      },
    };
  }
  // 覆盖刚写盘的工作稿前先快照（对齐 revise_draft），让自动去味可撤销。
  // 快照读稿 fail-closed 抛错时（P2-5）：本出稿的草稿确已落盘——绝不因去味中止而谎报整稿失败；
  // 放弃本轮改写、原稿不动，error 如实报（与「改写失败=原稿不动+如实报」同款降级）。
  let snapshotId: string | undefined;
  try {
    snapshotId = await snapshotBeforeDraftOverwrite(input.projectDir, input.chapter, `第${input.chapter}章自动去AI味前快照`);
  } catch (error) {
    // 错误原文可能内嵌绝对路径（快照读稿 errno / git 报错带 -C 仓库路径）——info.error 直达用户，先消毒（铁律④）。
    return notRun(scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)));
  }
  const written = `${result.updatedContent.trimEnd()}\n`;
  await writeFile(input.draftPath, written, "utf-8");
  // 复检：对改后正文重跑同一套确定性规则（low 不计入剩余——本来就不动它）。
  const remainingHighMedium = detectAiFlavorViolations(result.updatedContent, input.rules)
    .filter((v) => v.severity !== "low").length;
  return {
    info: { attempted: true, fixedCount: result.rewritten, remainingHighMedium, skipped: result.skippedByReason },
    draftBody: stripLeadingMarkdownChapterHeading(written).trim(),
    ...(snapshotId ? { snapshotId } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * 第四层：多候选采样防坍缩（candidates>1）
 *
 * 采样：N 个候选全部 persist:false（只生成不落盘，绝不互相覆盖工作稿），temperature 依次错开；
 *   单个候选失败（模型异常/校验不过）如实记 failed，不拖死全局；passed=false 永远不得中选。
 * 选优：确定性评分器（纯函数、可单测、题材中立），绝不用模型打分——「评分选优」的 typicality bias
 *   靠「规则全透明 + 逐候选得分/落选理由/开头预览如实输出」来对冲，而不是引入另一个黑盒偏好。
 * 落盘：优胜稿走引擎同一写盘通道 persistFastDraftBody（与 persist:true 同路径同标题行格式），
 *   之后与 candidates=1 完全同一条后续链（aiFlavor 回检 / autoDeAi / 快照 / draftLength 标注）。
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
function scoreInputFromCandidateReport(
  index: number,
  report: FastDraftReport | undefined,
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

/** 采样编排结果：逐候选报告 + 汇入单候选下游链的报告（优胜=带 draftPath 的原报告；全失败=首个失败报告；全部异常=undefined）。 */
interface DraftCandidateSampling {
  readonly entries: readonly DraftCandidateReportEntry[];
  readonly scoreInputs: readonly DraftCandidateScoreInput[];
  readonly chosenIndex?: number;
  /** 全部候选无一通过（含全部异常）时为 true；false 而 effectiveReport.passed=false = 优胜稿落盘失败。 */
  readonly allFailed: boolean;
  readonly effectiveReport?: FastDraftReport;
  /** 优胜候选的判漏 AI 复核结果（该候选无判漏/未注入裁决模型=undefined）；调用方据此构建裁决后的 beatFidelity 输出。 */
  readonly chosenBeatAdjudication?: BeatMissAdjudication;
}

/**
 * 多候选采样：顺序生成 N 个 persist:false 候选（不并发——同一项目上下文并发只会给 provider 徒增限流压力、
 * 诊断乱序），确定性选优后优胜稿走引擎同一写盘通道落盘。单个候选失败如实记录、不拖死全局；
 * 至少 1 个通过就能继续；全部失败或优胜稿落盘失败 → effectiveReport.passed=false，由调用方 ok:false 诚实回报。
 * 判漏误报降噪：选优前对每个「通过 + 有判漏」的候选先跑 AI 复核（顺序调、不并发），评分吃裁决后漏报数——
 * 治「换了措辞被判漏 → 冤枉扣分」（真机实锤：优胜者被扣到 0 分）。未注入裁决模型=跳过、按确定性计数。
 */
async function sampleDraftCandidates(input: {
  readonly candidateCount: number;
  readonly resolveWriterClient: (index: number) => WriterClient;
  readonly sharedDraftInput: Omit<FastDraftInput, "writerClient" | "persist" | "dryRun">;
  /** 判漏要点的 AI 复核调用（execute 注入 triage 任务槽；测试注入 mock）。缺失=跳过裁决、按确定性漏报数评分。 */
  readonly beatAdjudicationCallModel?: (prompt: string) => Promise<string>;
}): Promise<DraftCandidateSampling> {
  const reports: (FastDraftReport | undefined)[] = [];
  const exceptions: (string | undefined)[] = [];
  for (let index = 0; index < input.candidateCount; index += 1) {
    try {
      reports.push(await runFastDraft({
        ...input.sharedDraftInput,
        writerClient: input.resolveWriterClient(index),
        dryRun: false,
        persist: false,
      }));
      exceptions.push(undefined);
    } catch (error) {
      reports.push(undefined);
      exceptions.push(scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)));
    }
  }
  // 判漏误报降噪：选优前对每个「通过 + 有正文 + 有判漏」的候选跑 AI 复核（顺序调、不并发，同生成纪律）；
  // 失败/未通过/零判漏的候选不花 token（零判漏零调用）。复核 unavailable 时 missingBeats=原样、计数不变。
  const adjudications: (BeatMissAdjudication | undefined)[] = [];
  for (const report of reports) {
    const missingBeats = report?.beatFidelity?.missingBeats ?? [];
    if (!input.beatAdjudicationCallModel || !report?.passed || !report.draftBody || missingBeats.length === 0) {
      adjudications.push(undefined);
      continue;
    }
    adjudications.push(await adjudicateMissingBeats({
      draftContent: report.draftBody,
      missingBeats,
      callModel: input.beatAdjudicationCallModel,
    }));
  }
  const scoreInputs = reports.map((report, index) => scoreInputFromCandidateReport(index, report, exceptions[index], adjudications[index]));
  const ranked = rankDraftCandidates(scoreInputs);
  // 开头预览进逐候选报告：落选稿 persist:false 不落盘，这是用户读到落选稿样貌的唯一窗口；
  // 失败候选（异常/校验不过）没有正文 → 不带 excerpt 字段。
  const entries = attachCandidateExcerpts(ranked.entries, reports.map((report) => report?.draftBody));
  if (ranked.chosenIndex === undefined) {
    return {
      entries,
      scoreInputs,
      allFailed: true,
      effectiveReport: reports.find((report) => report !== undefined),
    };
  }
  const winnerReport = reports[ranked.chosenIndex];
  const chosenBeatAdjudication = adjudications[ranked.chosenIndex];
  if (!winnerReport?.draftBody) {
    // 防御：eligible 必有正文（scoreInputFromCandidateReport 保证），走到这是内部不一致——如实按全失败报，不假装出稿。
    return { entries, scoreInputs, allFailed: true, effectiveReport: winnerReport };
  }
  try {
    const draftPath = await persistFastDraftBody({
      projectDir: input.sharedDraftInput.projectDir,
      chapter: input.sharedDraftInput.chapter,
      title: winnerReport.title ?? `第${input.sharedDraftInput.chapter}章`,
      draftBody: winnerReport.draftBody,
    });
    return {
      entries,
      scoreInputs,
      chosenIndex: ranked.chosenIndex,
      allFailed: false,
      effectiveReport: { ...winnerReport, draftPath },
      ...(chosenBeatAdjudication ? { chosenBeatAdjudication } : {}),
    };
  } catch (error) {
    const message = scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));
    return {
      entries,
      scoreInputs,
      chosenIndex: ranked.chosenIndex,
      allFailed: false,
      effectiveReport: {
        ...winnerReport,
        passed: false,
        issues: [`优胜候选（第 ${ranked.chosenIndex + 1} 个）写入工作稿失败：${message}`],
      },
    };
  }
}

/* ---------------------------------------------------------------------------
 * 入口：策略参数、共享 prelude、D5 抽卡、主编排
 * ------------------------------------------------------------------------- */

/** 出稿策略参数（原豁免清单分歧的显式化；默认值 = 工具路语义，保证逻辑层既有调用方零变化）。 */
export interface GenerateDraftPolicies {
  /**
   * D1 长度执法：
   *   "enforce_or_rollback"（HTTP 非流式路）——落盘后回读执法：低于下限 → 回滚旧稿 + rejection（路由投影 422）；
   *     超上限 → 确定性裁剪重写落盘并重建 report.draftLength。写前读旧稿（回滚凭据）读不出 → 写盘前
   *     诚实拒稿（ok:false、真稿不动），绝不带丢失的回滚凭据继续写（P2-5 fail-closed）。
   *   "annotate"（默认，工具路）——一次成稿不拒绝：照写盘，draftLength 透出 + summary ⚠ 标注。
   */
  readonly lengthPolicy?: "enforce_or_rollback" | "annotate";
  /**
   * D2 AI 腔回检栈开关（默认 true=工具语义）：true=给引擎传 aiFlavorRules 做出稿回检，并允许
   *   autoDeAi/beats 裁决链路；false=完全不跑（report 无 aiFlavor 字段）。HTTP 按钮路显式传 false（现状）。
   */
  readonly aiFlavorRecheck?: boolean;
}

/** 主编排输入：原工具逻辑层入参 + 策略参数 + HTTP 专属的 maxOutputTokens 覆盖通道。 */
export interface GenerateDraftInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly mustHitBeats?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  /** HTTP 专属输入通道：显式输出上限；缺省显式解析 resolveDraftMaxOutputTokens(lengthTarget)（与引擎内部默认同源同值）。 */
  readonly maxOutputTokens?: number;
  readonly writerClient: WriterClient;
  readonly policies?: GenerateDraftPolicies;
  /** 自动去味开关（默认 true）；false=检出 high/medium 也只标注、不改写。 */
  readonly autoDeAi?: boolean;
  /** 自动去味的改写模型调用（工具 execute 注入 repair 任务槽；测试注入 mock）。缺失=只标注不改写。 */
  readonly deAiCallModel?: (prompt: string) => Promise<string>;
  /** 多候选采样数（只认 2/3，其余一律当 1=一次成稿现状）。 */
  readonly candidates?: number;
  /** candidates>1 时按序注入的候选 writer（工具 execute 用 temperature 错开构建；测试注入 mock）。缺位的序号回退 writerClient。 */
  readonly candidateWriterClients?: readonly WriterClient[];
  /** 各槽位错温 client 实际使用的 temperature（execute 注入 resolveCandidateTemperatures 的结果），如实进 candidatesReport。 */
  readonly candidateTemperatures?: readonly number[];
  /** 判漏要点的 AI 复核调用（工具 execute 注入 triage 任务槽；测试注入 mock）。缺失=跳过复核、维持确定性结论。 */
  readonly beatAdjudicationCallModel?: (prompt: string) => Promise<string>;
}

/** HTTP 适配层投影料：工具 execute 投影时剥掉（不进 LLM 视野），路由据此组装 200/422 响应。 */
export interface GenerateDraftHttpProjection {
  /** 引擎出稿报告（enforce 裁剪后 draftLength 为重建版）；极端情形（全候选异常）可缺省。 */
  readonly report?: FastDraftReport;
  /** 最终落盘文件全文（含 Markdown 标题行）：enforce 策略填最终内容；annotate 策略与失败/拒稿态为 ""。 */
  readonly draftContent: string;
  /** 上下文预算裁剪账本：路由无条件投影 contextBudgetPayload；工具侧按 optionalContextBudget 条件投影（已并进顶层）。 */
  readonly contextRanking: WriterRankContextPlan;
  /** 降级留痕（enforce 回读失败/正文未载入等）：summary 同款文案的纯文本版，路由 200 投影带出——
   *  否则 HTTP 调用方拿到 ok:true+空稿却零信号（形同假成功）。无降级时字段缺省。 */
  readonly warnings?: readonly string[];
}

/** 主编排 canonical 结果：工具输出契约的全部字段 + HTTP 投影料 + 执法拒稿标记。 */
export interface GenerateDraftOutcome {
  readonly ok: boolean;
  readonly chapter: number;
  readonly draftPath?: string;
  readonly draftBody?: string;
  readonly draftTitle?: string;
  readonly draftLength?: GenerateDraftLengthInfo;
  readonly aiFlavor?: GenerateDraftAiFlavorInfo;
  readonly autoDeAi?: GenerateDraftAutoDeAiInfo;
  readonly candidatesReport?: readonly DraftCandidateReportEntry[];
  readonly beatFidelity?: GenerateDraftBeatFidelityInfo;
  readonly issues: readonly string[];
  readonly overview: StateOverview;
  readonly summary: string;
  readonly refreshScope: "full";
  /** 自动去味落改动时=它的快照（最近的撤销点）；覆盖前快照由适配层建、由工具 execute 挂（ok 时）。 */
  readonly snapshotId?: string;
  readonly contextBudget?: ReturnType<typeof contextBudgetPayload>;
  readonly characterSelection?: CharacterPresenceResult;
  /** D1 执法拒稿（仅 lengthPolicy:"enforce_or_rollback"）：旧稿已回滚，路由投影 422 + error。 */
  readonly rejection?: { readonly kind: "length_rejected"; readonly error: string };
  readonly http: GenerateDraftHttpProjection;
}

/** D5 抽卡（persist:false）输入：HTTP 专属能力；无策略参数——不写盘、不快照、不执法、不回检。 */
export interface GenerateDraftCandidateInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  readonly maxOutputTokens?: number;
  readonly writerClient: WriterClient;
}

export interface GenerateDraftCandidateOutcome {
  readonly candidate: FastDraftReport;
  readonly characterSelection: CharacterPresenceResult;
  readonly contextRanking: WriterRankContextPlan;
}

/** 共享 prelude：两轨同一套「方向默认/数值归一/预算裁剪账本/在场角色解析/长度目标/回检规则」。 */
interface DraftRunContext {
  readonly chapterGoal: string;
  readonly requestedDraftLength?: number;
  readonly maxTimelineEvents: number;
  readonly lengthTarget: DraftLengthTarget;
  readonly contextRanking: WriterRankContextPlan;
  readonly characterSelection: CharacterPresenceResult;
  readonly selectedCharacterIds?: readonly string[];
  readonly aiFlavorRules?: readonly AiFlavorRule[];
}

async function resolveDraftRunContext(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  readonly selectedCharacterIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  readonly aiFlavorRecheck: boolean;
}): Promise<DraftRunContext> {
  const chapterGoal = input.chapterGoal?.trim() || `继续第 ${input.chapter} 章。`;
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
  const characterSelection = await resolveSelectedCharacterIds({
    projectDir: input.projectDir,
    chapter: input.chapter,
    chapterGoal,
    explicit: input.selectedCharacterIds,
  });
  const selectedCharacterIds = characterSelection.selectedCharacterIds.length > 0 ? characterSelection.selectedCharacterIds : undefined;
  const lengthTarget = await resolveProjectDraftLengthTarget(input.projectDir, chapterGoal, requestedDraftLength);

  // D2 出稿即自动回检（warning-only）的开关：内置确定性规则（7 条模式 + 虚弱副词频率闸）+ 项目写作规则的
  // antiAiPatterns（用户自定义词，字面量匹配、一律 low 档）。writing-rules.json 读不到 → 只剩内置规则，不崩。
  // aiFlavorRecheck:false（HTTP 按钮路现状）→ 不传规则给引擎，report 无 aiFlavor 字段。
  const aiFlavorRules = input.aiFlavorRecheck
    ? [...ALL_BUILTIN_AI_FLAVOR_RULES, ...buildUserAntiAiPatternRules(await readAntiAiPatterns(input.projectDir))]
    : undefined;

  return {
    chapterGoal,
    ...(requestedDraftLength !== undefined ? { requestedDraftLength } : {}),
    maxTimelineEvents,
    lengthTarget,
    contextRanking,
    characterSelection,
    ...(selectedCharacterIds !== undefined ? { selectedCharacterIds } : {}),
    ...(aiFlavorRules !== undefined ? { aiFlavorRules } : {}),
  };
}

function sharedFastDraftInput(run: DraftRunContext, input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly selectedHookIds?: readonly string[];
  readonly mustHitBeats?: readonly string[];
  readonly maxOutputTokens?: number;
}): Omit<FastDraftInput, "writerClient" | "persist" | "dryRun"> {
  return {
    projectDir: input.projectDir,
    chapter: input.chapter,
    chapterGoal: run.chapterGoal,
    ...(run.aiFlavorRules !== undefined ? { aiFlavorRules: run.aiFlavorRules } : {}),
    // 键位恒在（值可 undefined）：HTTP 路由测试按 objectContaining 锁定 requestedDraftLength 键存在性，
    // 引擎侧 `undefined` 与缺键同义（?? 兜底），工具路零行为变化。
    requestedDraftLength: run.requestedDraftLength,
    ...(run.selectedCharacterIds !== undefined ? { selectedCharacterIds: run.selectedCharacterIds } : {}),
    ...(input.selectedHookIds !== undefined ? { selectedHookIds: input.selectedHookIds } : {}),
    ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
    maxTimelineEvents: run.maxTimelineEvents,
    maxOutputTokens: positiveOrUndefined(input.maxOutputTokens) ?? resolveDraftMaxOutputTokens(run.lengthTarget),
    rankContext: run.contextRanking.rankContext,
  };
}

/**
 * D5 抽卡候选（HTTP 独有入参 persist:false 的 service 能力）：runFastDraft persist:false 只生成不落盘、
 * 不快照，候选正文交路由临时并排展示，挑中才落盘（/api/draft/apply-candidate）。不带 AI 腔回检（与
 * 按钮路一致）。失败如实：candidate.passed=false + issues，路由投影 422。
 */
export async function generateDraftCandidate(input: GenerateDraftCandidateInput): Promise<GenerateDraftCandidateOutcome> {
  const run = await resolveDraftRunContext({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
    ...(input.requestedDraftLength !== undefined ? { requestedDraftLength: input.requestedDraftLength } : {}),
    ...(input.selectedCharacterIds !== undefined ? { selectedCharacterIds: input.selectedCharacterIds } : {}),
    ...(input.maxTimelineEvents !== undefined ? { maxTimelineEvents: input.maxTimelineEvents } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
    aiFlavorRecheck: false,
  });
  const candidate = await runFastDraft({
    ...sharedFastDraftInput(run, input),
    writerClient: input.writerClient,
    dryRun: false,
    persist: false,
  });
  return { candidate, characterSelection: run.characterSelection, contextRanking: run.contextRanking };
}

/**
 * 出稿主编排（canonical）：两侧适配层同调。写盘前快照由适配层负责（D4 收敛后两侧同调
 * snapshotBeforeDraftOverwrite）；本编排内的写盘点：引擎 persist:true / persistFastDraftBody /
 * enforce 裁剪重写 / autoDeAi 覆盖（自带快照）。
 *
 * 行为继承（原工具逻辑层逐字语义）：
 * - writerClient 注入（真实 execute 注入 createConfiguredWriterClient("fastDraft")，测试注入 mock）。
 * - 自动去味（autoDeAi 默认 true）：report.aiFlavor 检出 high/medium 且注入了 deAiCallModel 时
 *   自动跑一轮 runAutoDeAiRound；否则只标注不改写（attempted:false）。去味真落改动后对最终正文重跑
 *   确定性 beats 核对（零 token），新漏进 beatFidelity.postDeAiNewMisses、summary 如实标注。
 * - 多候选（candidates=2/3）：persist:false 采样 → 逐候选判漏 AI 复核 → 确定性选优 → 优胜稿落盘，
 *   汇入同一条后续链。
 * - 判漏误报降噪（beatAdjudicationCallModel）：确定性判漏先经 AI 复核（带正文逐字引证才摘除误报；
 *   模型挂→维持原结论+unavailable）。零判漏零调用。
 */
export async function runGenerateDraft(input: GenerateDraftInput): Promise<GenerateDraftOutcome> {
  const { projectDir, chapter, writerClient } = input;
  const lengthPolicy = input.policies?.lengthPolicy ?? "annotate";
  const run = await resolveDraftRunContext({
    projectDir,
    chapter,
    ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
    ...(input.requestedDraftLength !== undefined ? { requestedDraftLength: input.requestedDraftLength } : {}),
    ...(input.selectedCharacterIds !== undefined ? { selectedCharacterIds: input.selectedCharacterIds } : {}),
    ...(input.maxTimelineEvents !== undefined ? { maxTimelineEvents: input.maxTimelineEvents } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
    aiFlavorRecheck: input.policies?.aiFlavorRecheck !== false,
  });
  const { chapterGoal, maxTimelineEvents, lengthTarget, contextRanking, characterSelection } = run;

  // D1 enforce 策略：执法拒稿要回滚旧稿——写盘前先留旧稿原文（annotate 无回滚，不读）。
  // P2-5 fail-closed：旧稿存在但读不出时诚实拒稿——继续写会让拒稿回滚丢旧稿原文、走 rm 误删真稿；
  // 此刻引擎尚未落盘，拒稿即真稿分毫不动。
  const draftPath = defaultDraftPath(projectDir, chapter);
  const previousDraft = lengthPolicy === "enforce_or_rollback"
    ? await readPreviousDraftForRollback(draftPath)
    : undefined;
  if (previousDraft?.kind === "unreadable") {
    const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents });
    const contextBudget = optionalContextBudget(contextRanking);
    // previousDraft.error 是 errno 原文、内嵌绝对路径——summary/issues 直达用户，先消毒（铁律④）。
    const message =
      `第 ${chapter} 章已有工作稿但读取失败（${scrubLocalAbsolutePaths(previousDraft.error)}）。` +
      "为保护旧稿，本次未生成、未覆盖任何内容；请检查该文件后重试。";
    return {
      ok: false,
      chapter,
      issues: [message],
      overview,
      summary: message,
      refreshScope: "full",
      characterSelection,
      ...contextBudget,
      http: { draftContent: "", contextRanking },
    };
  }
  const previousDraftContent = previousDraft?.kind === "present" ? previousDraft.content : undefined;

  const sharedDraftInput = sharedFastDraftInput(run, input);
  // candidates 只认 2/3（schema 已卡 1–3；逻辑层被直接调用时其余值一律当 1=现状零变化）。
  const candidateCount = input.candidates === 2 || input.candidates === 3 ? input.candidates : 1;
  let report: FastDraftReport | undefined;
  let sampling: DraftCandidateSampling | undefined;
  let beatAdjudication: BeatMissAdjudication | undefined;
  if (candidateCount > 1) {
    // 多候选：N 个 persist:false 候选（只生成不落盘）→ 逐候选判漏 AI 复核 → 确定性选优（吃裁决后漏报数）
    // → 优胜稿统一落盘，汇入下方同一条后续链。
    sampling = await sampleDraftCandidates({
      candidateCount,
      resolveWriterClient: (index) => input.candidateWriterClients?.[index] ?? writerClient,
      sharedDraftInput,
      ...(input.beatAdjudicationCallModel ? { beatAdjudicationCallModel: input.beatAdjudicationCallModel } : {}),
    });
    // 候选实际 temperature 进逐候选报告（只对真注入了错温 client 的槽位标注，缺位回退槽不编造）。
    sampling = {
      ...sampling,
      entries: attachCandidateTemperatures(sampling.entries, input.candidateTemperatures, input.candidateWriterClients),
    };
    report = sampling.effectiveReport;
    beatAdjudication = sampling.chosenBeatAdjudication;
  } else {
    report = await runFastDraft({
      ...sharedDraftInput,
      writerClient,
      dryRun: false,
      persist: true,
    });
  }

  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents });
  const contextBudget = optionalContextBudget(contextRanking);

  if (!report || !report.passed || !report.draftPath) {
    // 候选全部异常（连报告都没有）时，issues 用逐候选原因拼出，绝不空着。
    const failureIssues = report?.issues ?? sampling?.entries.map((entry) => `候选 ${entry.index}：${entry.reason}`) ?? [];
    const draftLengthInfo = report?.draftLength ? buildDraftLengthInfo(report.draftLength) : undefined;
    return {
      ok: false,
      chapter,
      ...(draftLengthInfo ? { draftLength: draftLengthInfo } : {}),
      ...(sampling ? { candidatesReport: sampling.entries } : {}),
      issues: failureIssues,
      overview,
      summary: sampling
        ? sampling.allFailed
          ? `第 ${chapter} 章已生成 ${candidateCount} 个候选，但全部未通过或生成失败，未写入工作稿：` +
            `${failureIssues.length > 0 ? failureIssues.join("；") : "全部候选生成失败"}。各候选情况见 candidatesReport。请重试或调整本章方向。`
          : `第 ${chapter} 章已生成 ${candidateCount} 个候选并选出第 ${(sampling.chosenIndex ?? 0) + 1} 个，但优胜稿写入工作稿失败：` +
            `${failureIssues.join("；")}。各候选情况见 candidatesReport。`
        : `第 ${chapter} 章出稿未通过，未写入工作稿：` +
          `${failureIssues.length > 0 ? failureIssues.join("；") : "引擎拒绝写盘"}。${characterSelection.summary}。请重试或调整本章方向。`,
      refreshScope: "full",
      characterSelection,
      ...contextBudget,
      http: { ...(report ? { report } : {}), draftContent: "", contextRanking },
    };
  }

  // D1 长度执法（enforce_or_rollback，HTTP 非流式路）：落盘后回读执法——低于下限拒写+回滚旧稿；
  // 超上限确定性裁剪重写落盘并重建 report.draftLength。annotate（工具路）跳过整段（引擎已如实记 draftLength）。
  // 回读对齐 L1 口径（3×60ms 重试）；彻底读不到 → 执法如实降级跳过（summary 留痕 lengthEnforcementSkipped），
  // 绝不静默漏执法（草稿确已落盘，ok 仍 true，绝不谎报失败）。
  let finalReport = report;
  let draftBody: string;
  let finalDraftContent = "";
  let lengthEnforcementSkipped = false;
  if (lengthPolicy === "enforce_or_rollback") {
    const writtenContent = await readFileContentWithRetry(report.draftPath);
    if (writtenContent.trim()) {
      const writtenBody = stripLeadingMarkdownChapterHeading(writtenContent);
      const enforced = enforceDraftLengthTarget({
        draftBody: writtenBody,
        lengthTarget,
        allowDeterministicTrim: true,
      });
      if (!enforced.ok) {
        await restoreDraftFile(report.draftPath, previousDraftContent);
        return {
          ok: false,
          chapter,
          issues: [enforced.error],
          overview,
          summary: enforced.error,
          refreshScope: "full",
          characterSelection,
          ...contextBudget,
          rejection: { kind: "length_rejected", error: enforced.error },
          http: { report, draftContent: "", contextRanking },
        };
      }
      const routeTrimmed = enforced.draftBody !== writtenBody;
      if (routeTrimmed) {
        const title = extractDraftTitle(writtenContent) ?? report.title ?? `第${chapter}章`;
        await writeFile(report.draftPath, `# ${title}\n\n${enforced.draftBody.trim()}\n`, "utf-8");
      }
      if (routeTrimmed || !report.draftLength) {
        finalReport = {
          ...report,
          draftLength: buildDraftLengthReport({
            draftBody: enforced.draftBody,
            lengthTarget,
            finalLengthAfterTrim: countCjkChars(enforced.draftBody),
            whetherTrimmed: routeTrimmed || report.draftLength?.whetherTrimmed === true,
          }),
        };
      }
    } else {
      // 执法基准回读彻底失败：执法跳过必须留痕（summary 如实标注），绝不静默放行未执法的稿子。
      lengthEnforcementSkipped = true;
    }
    finalDraftContent = await readFileContentWithRetry(report.draftPath);
    draftBody = stripLeadingMarkdownChapterHeading(finalDraftContent).trim();
  } else {
    // L1：草稿已写盘，但回读那一刻偶发 FS 读失败会得空稿，前端这次就不刷新（草稿其实在磁盘，切走再回来就有）。
    // 重试回读兜底（刚写盘的文件、读空多是极少数 FS 抖动，重试即得）；仍取不到才退回空——
    // ⚠ 绝不因此判 ok:false：稿子是真写成功的，谎报失败会诱导用户重写覆盖好稿。
    draftBody = await readDraftBodyWithRetry(report.draftPath);
  }

  // 字数透明：引擎对每版正文都记 draftLength（成功/失败均带；enforce 裁剪后为重建版），透传关键信息进输出，绝不藏起来。
  const draftLengthInfo = finalReport.draftLength ? buildDraftLengthInfo(finalReport.draftLength) : undefined;

  // 出稿后保真软警告（裁决后）：确定性核对判漏的要点先经 AI 复核（带正文逐字引证才摘除误报），
  // 用裁决后结果如实提示、让用户决定改不改（绝不静默放过、也不阻塞）。复核没跑成 → 维持确定性结论
  // + adjudication:"unavailable" 如实标注。零判漏零调用（连裁决模型都不碰）。无锚点 beat 规则不检，不在此列。
  // 多候选路径的复核已在采样选优前逐候选跑完（beatAdjudication=优胜者那份），这里不重复调。
  const deterministicMissingBeats = report.beatFidelity?.missingBeats ?? [];
  if (!sampling && deterministicMissingBeats.length > 0 && input.beatAdjudicationCallModel) {
    beatAdjudication = await adjudicateMissingBeats({
      draftContent: draftBody,
      missingBeats: deterministicMissingBeats,
      callModel: input.beatAdjudicationCallModel,
    });
  }
  // 去味真落改动后会往里并入新漏（见下），故用 let；summary 文案到最后才统一构建。
  let beatFidelityInfo = buildBeatFidelityInfo({
    deterministicMissingBeats,
    ...(beatAdjudication ? { adjudication: beatAdjudication } : {}),
  });

  // 字数透明软警告（annotate）：低于目标字数下限不拒绝、不自动补写（一次成稿），summary 如实标注。
  const lengthWarning = draftLengthInfo ? buildDraftLengthWarning(draftLengthInfo) : "";

  // AI 腔回检（warning-only）：检出 high/medium 默认接一轮自动去味（批量改写 + 复检，最多一轮）；
  // autoDeAi:false 或未注入改写模型 → 只标注不改写。改写失败=原稿不动+如实报，绝不影响本出稿的 ok。
  const aiFlavorInfo = report.aiFlavor ? buildAiFlavorInfo(report.aiFlavor) : undefined;
  let autoDeAiInfo: GenerateDraftAutoDeAiInfo | undefined;
  let autoDeAiSnapshotId: string | undefined;
  if (report.aiFlavor) {
    const targets = pickAutoDeAiTargets(report.aiFlavor);
    const initialHighMedium = report.aiFlavor.bySeverity.high + report.aiFlavor.bySeverity.medium;
    if (targets.length > 0) {
      if ((input.autoDeAi ?? true) && input.deAiCallModel) {
        const round = await runAutoDeAiRound({
          projectDir,
          chapter,
          draftPath: report.draftPath,
          initialHighMedium,
          targets,
          rules: run.aiFlavorRules ?? ALL_BUILTIN_AI_FLAVOR_RULES,
          antiRules: await readAntiRules(projectDir),
          callModel: input.deAiCallModel,
        });
        autoDeAiInfo = round.info;
        autoDeAiSnapshotId = round.snapshotId;
        if (round.draftBody !== undefined) {
          const deAiBody = round.draftBody;
          draftBody = deAiBody;
          // 去味真落了改动 → 对最终正文重跑一遍引擎确定性 beats 核对（纯函数、零 token）：
          // ① 基准集用裁决【前】的确定性判漏 deterministicMissingBeats——裁决已摘除的要点本就词面无锚点，
          //    去味后照样判漏，不算「新漏」（若拿裁决后的 missingBeats 当基准，会把它们误报成「去味吃掉了」）。
          // ② adjudicatedCovered 的引证时效性：去味恰好改写了引证句的条目移出、单列 staleAdjudications 如实标注。
          if (input.mustHitBeats && input.mustHitBeats.length > 0) {
            const postDeAiMissing = checkDraftBeatFidelity({
              draftContent: deAiBody,
              mustHitBeats: input.mustHitBeats,
            }).missingBeats;
            const deterministicBaseline = new Set(deterministicMissingBeats);
            const newMisses = postDeAiMissing.filter((beat) => !deterministicBaseline.has(beat));
            if (newMisses.length > 0) {
              beatFidelityInfo = {
                ...(beatFidelityInfo ?? { missingBeats: [], adjudicatedCovered: [], adjudication: "not_run" as const }),
                postDeAiNewMisses: newMisses,
              };
            }
            const coveredEntries = beatFidelityInfo?.adjudicatedCovered ?? [];
            const staleEntries = coveredEntries.filter((entry) => !isAdjudicationQuoteVerbatim(entry.quote, deAiBody));
            if (beatFidelityInfo && staleEntries.length > 0) {
              beatFidelityInfo = {
                ...beatFidelityInfo,
                adjudicatedCovered: coveredEntries.filter((entry) => isAdjudicationQuoteVerbatim(entry.quote, deAiBody)),
                staleAdjudications: staleEntries,
              };
            }
          }
        }
      } else {
        autoDeAiInfo = {
          attempted: false,
          fixedCount: 0,
          remainingHighMedium: initialHighMedium,
          skipped: EMPTY_AUTO_DE_AI_SKIPPED,
        };
      }
    }
  }
  const aiFlavorNote = aiFlavorInfo && autoDeAiInfo
    ? buildAutoDeAiNote(autoDeAiInfo, aiFlavorInfo)
    : aiFlavorInfo ? buildAiFlavorWarning(aiFlavorInfo) : "";

  // 首稿核对文案在去味复核之后构建：去味吃掉锚点的新漏（postDeAiNewMisses）也要进 summary 如实标注。
  const beatNote = beatFidelityInfo ? buildBeatFidelityNote(beatFidelityInfo) : "";

  // 多候选选优透明化：summary 一行讲清选了第几个、凭什么（优点逐条核实过才说），逐候选得分/落选原因进 candidatesReport。
  const candidateLine = sampling && sampling.chosenIndex !== undefined
    ? buildCandidateSummaryLine(candidateCount, sampling.scoreInputs[sampling.chosenIndex], sampling.scoreInputs)
    : "";

  // 降级留痕双通道（复审 P2②）：这两条降级此前只进 summary，而路由 200 投影不带 summary——
  // HTTP 调用方拿到 ok:true+空稿却零信号（形同假成功）。warnings 纯文本版随 http 投影带出；
  // summary 的 ⚠/（注：…）装饰原样保留（既有契约锁定原文案），两处文案同源不漂移。
  const enforcementSkippedWarning = "工作稿落盘后回读失败，本章长度执法未执行（正文以引擎写盘为准）；请切换章节刷新后核对字数。";
  const draftNotLoadedWarning = "正文已写盘，但本次未能载入到写作区显示——切到别的章再切回本章即可看到，不用重写。";
  const httpWarnings: string[] = [];
  if (lengthEnforcementSkipped) httpWarnings.push(enforcementSkippedWarning);
  if (draftBody.trim().length === 0) httpWarnings.push(draftNotLoadedWarning);

  return {
    ok: true,
    chapter,
    draftPath: report.draftPath,
    draftBody,
    ...(finalReport.title ? { draftTitle: finalReport.title } : {}),
    ...(draftLengthInfo ? { draftLength: draftLengthInfo } : {}),
    ...(aiFlavorInfo ? { aiFlavor: aiFlavorInfo } : {}),
    ...(autoDeAiInfo ? { autoDeAi: autoDeAiInfo } : {}),
    ...(sampling ? { candidatesReport: sampling.entries } : {}),
    ...(beatFidelityInfo ? { beatFidelity: beatFidelityInfo } : {}),
    // 自动去味真落了改动时，snapshotId 用它的快照（最近的撤销点）；否则由工具 execute 挂「再写一版」快照。
    ...(autoDeAiSnapshotId ? { snapshotId: autoDeAiSnapshotId } : {}),
    issues: report.issues,
    overview,
    summary:
      `第 ${chapter} 章已生成正文并写入工作稿${finalReport.title ? `《${finalReport.title}》` : ""}。` +
      candidateLine +
      `${characterSelection.summary}。草稿尚未入库，可在写作区查看修改；满意后再走 commit_preview / commit_apply 入库。` +
      (beatNote ? `\n${beatNote}` : "") +
      (lengthWarning ? `\n${lengthWarning}` : "") +
      // D1 执法降级留痕：落盘回读彻底失败时长度执法未执行，必须如实标注（不静默）。
      (lengthEnforcementSkipped ? `\n⚠ ${enforcementSkippedWarning}` : "") +
      (aiFlavorNote ? `\n${aiFlavorNote}` : "") +
      // A11：回读为空是偶发 FS 抖动、正文确已写盘——加一句可见性提示，别让用户以为没生成而重写覆盖好稿。
      (draftBody.trim().length === 0 ? `（注：${draftNotLoadedWarning}）` : ""),
    refreshScope: "full",
    characterSelection,
    ...contextBudget,
    http: {
      report: finalReport,
      draftContent: finalDraftContent,
      contextRanking,
      ...(httpWarnings.length > 0 ? { warnings: httpWarnings } : {}),
    },
  };
}

function optionalContextBudget(contextRanking: WriterRankContextPlan): { readonly contextBudget: ReturnType<typeof contextBudgetPayload> } | Record<string, never> {
  return contextRanking.droppedSections.length > 0 || contextRanking.coreImpact || contextRanking.issues.length > 0
    ? { contextBudget: contextBudgetPayload(contextRanking) }
    : {};
}
