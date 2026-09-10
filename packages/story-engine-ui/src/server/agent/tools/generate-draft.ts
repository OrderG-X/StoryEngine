/**
 * generate_draft — 写工作稿工具：为某章生成一版正文并落到工作稿（drafts/fast）。
 *
 * 对照 routes/draft.ts 的 /api/draft/generate 编排（进程内复刻，不经 HTTP）：
 *   createConfiguredWriterClient("fastDraft") → runFastDraft（dryRun:false, persist:true）。
 *   一次成稿、不自动补写重试（HTTP 旧路的「过短补写重试」只在那条流式路由里，本工具没有）。
 *   引擎会 passed:false 拒绝写盘的只有：有效性校验不过（空正文/JSON 伪正文/未提及在场角色）、
 *   或超出上限且无法安全裁剪；正文低于字数下限【不拒绝】——照写盘，引擎在 report.draftLength
 *   如实记录，本工具把关键信息透传进输出，并在 summary 里如实标注，由 agent 转达用户决定重写或接受。
 *
 * 快照策略（铁律「直接做+可撤销」的边界）：草稿是「待保存」的工作稿，不是状态入库，
 *   因此**不建入库级 git 快照**；但「再写一版」/自动去味会**覆盖**已有草稿，覆盖前用
 *   snapshotBeforeDraftOverwrite 建轻量快照（M6），output.snapshotId 挂最近一个撤销点。
 *   故本工具用 createTool 而非 writeTool。涉及草稿 → refreshScope:"full"（前端刷新写作区/总览）。
 *
 * 自动去味闭环（autoDeAi，默认开）：出稿回检检出 high/medium 时，自动走一轮 de-ai-flavor-batch
 *   批量改写（只处理 high/medium，low 不动；repair 任务槽模型；最多一轮、不循环），落盘前先快照、
 *   改后对改后正文复检同一套确定性规则，结果如实进 autoDeAi 字段与 summary 三态
 *   （干净 / 已修掉 N 处剩 M 处 / 改写模型失败原稿未动）。改写失败/解析失败=原稿不动+如实报，
 *   绝不影响出稿本身的 ok。autoDeAi:false → 只检测标注、不改写。
 *
 * 多候选采样防坍缩（candidates，默认 1=零行为变化）：单候选长篇连载会文风坍缩，多候选+选择是解药；
 *   但「评分选优」有 typicality bias 风险，所以选择依据必须确定性+透明（不用模型打分）。candidates>1 时
 *   先后生成 N 个候选（temperature 依次错开；全部 persist:false 只生成不落盘，绝不互相覆盖工作稿），
 *   确定性评分器（必命中要点 > 字数下限 > AI 腔计权 high×3+medium）选优，优胜稿走引擎同一写盘通道
 *   （persistFastDraftBody，与 persist:true 同路径同标题行格式）落盘，之后与 candidates=1 完全同一条
 *   后续链（aiFlavor 回检 / autoDeAi / 快照 / draftLength 标注）。单个候选失败如实记 failed 不拖死全局，
 *   全部失败 → ok:false + candidatesReport 逐候选列明原因；passed=false 的候选永远不得中选。
 *   落选稿 persist:false 不落盘，故 candidatesReport 每条带正文开头预览（excerpt，约 100 字）
 *   供快速比对候选风格；失败候选没有正文则不带该字段。
 *
 * 必命中要点误报降噪（beats 判漏 AI 复核，对齐 quality-judge 的「规则检出 + LLM 复核降级」模式）：
 *   引擎 checkDraftBeatFidelity 只认词面锚点，对【有锚点却换了措辞】的要点会误报漏写（真机实锤：
 *   「老街坊拿表来修」正文写了桂英老太太+海鸥表仍被判漏）。误报进两处——本工具的「首稿核对 ⚠」与
 *   多候选评分器的「漏必命中要点 -50/条」（冤枉候选扣分）。故确定性判漏的每条 beat 先经 AI 复核
 *   （beat-miss-adjudication.ts，triage 任务槽）：模型报「已覆盖」必须带正文逐字引证（quote 归一化
 *   空白后是草稿逐字子串才采信），模型挂/超时/烂 JSON → 维持确定性结论 + adjudication:"unavailable"。
 *   复核是降噪器不是闸门——只能把「漏」改成「已覆盖」，不新增漏报、不动 passed；被摘除的误报不消失，
 *   进 beatFidelity.adjudicatedCovered 如实列出（可追溯）。零判漏零调用；多候选路径先裁决再进评分器
 *   （评分吃裁决后漏报数）。自动去味真落改动后，还会对最终正文再跑一遍确定性核对（零 token）：
 *   整句改写吃掉锚点造成的新漏进 beatFidelity.postDeAiNewMisses，summary 如实标注「去味后新漏 N 条」。
 *
 * 铁律：
 * - 题材中立：description / summary 用中性词。
 * - 绝不静默失败 / 绝不谎报：runFastDraft.passed=false 时如实回报 ok:false + issues，不假装出稿成功。
 * - 字数透明：低于目标字数下限不拦也不藏——draftLength 进输出、summary 打 ⚠ 标注，不假装字数达标。
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  buildStateOverview,
  checkDraftBeatFidelity,
  detectAiFlavorViolations,
  persistFastDraftBody,
  runFastDraft,
  type AiFlavorReport,
  type AiFlavorRule,
  type AiFlavorSeverity,
  type AiFlavorViolation,
  type DraftLengthReport,
  type DraftLengthStatus,
  type DraftLengthTargetSource,
  type FastDraftInput,
  type FastDraftReport,
  type StateOverview,
  type WriterClient,
} from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceNumber, coerceStringArray, positiveOrUndefined } from "./lenient-args.js";

// 兼容既有测试导入：positiveOrUndefined 现归位 lenient-args（模型无关 helper 正位），此处再导出。
export { positiveOrUndefined } from "./lenient-args.js";

import { createConfiguredWriterClient, createOpenAICompatibleWriterClient, resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { defaultCommittedChapterPath, defaultDraftPath, stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { adjudicateMissingBeats, isAdjudicationQuoteVerbatim, type AdjudicatedCoveredBeat, type BeatMissAdjudication } from "../../lib/beat-miss-adjudication.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext, readDraftDeltaSinkFromContext, readUserTurnTextFromContext } from "../request-context.js";
import { userTurnAllowsDraftWrite } from "./turn-intent-gate.js";
import { contextBudgetPayload, makeWriterRankContext, resolveWriterTokenBudget } from "../context-budget/rank-writer-context.js";
import { resolveSelectedCharacterIds, type CharacterPresenceResult } from "../presence/in-scene-detector.js";
import { snapshotBeforeDraftOverwrite } from "./snapshot-on-draft-overwrite.js";
import { evaluateChapterSequencingGuard } from "./chapter-sequencing-guard.js";
import { ALL_BUILTIN_AI_FLAVOR_RULES, buildUserAntiAiPatternRules } from "../ai-flavor/ai-flavor-rules.js";
import { runDeAiFlavorBatch, type DeAiSkippedByReason } from "../ai-flavor/de-ai-flavor-batch.js";
import { readAntiAiPatterns, readAntiRules } from "./check-ai-flavor.js";

/** 某章是否已入库（chapters/N.md 存在且非空）。读盘只读，题材中立。 */
export async function isChapterCommitted(projectDir: string, chapter: number): Promise<boolean> {
  const content = await readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8").catch(() => undefined);
  return content !== undefined && content.trim().length > 0;
}

/**
 * 已入库前沿 → 推进下一章（治长篇连写的章号 off-by-one，codex 真机 P0：入库第 6 章后说「写第 7 章」
 * 却落回第 6 章）。根因：通过对话入库后前端「当前章」仍停在刚入库那章，模型没显式给章号时回退到
 * currentChapter=已入库章，把「写正文/继续」误解成重写它。
 *
 * 规则：仅当 (a) 用户没显式点名章号（explicitChapter=false，走了 currentChapter 回退）、
 * (b) 回退到的这章【已入库】、(c) 它就是写作前沿（下一章还没入库）时，才把出稿目标推进到下一章——
 * 因为「在刚入库的最新章上写正文」几乎必然是「想写下一章」，而非「重写已入库章的草稿」。
 * 显式点名章号时一律尊重、绝不推进（用户要重写某已入库章的草稿也走这条）；前沿之内的已入库章
 * （下一章也已入库）同样不推进，避免误改中间章。纯逻辑、题材中立、可单测。
 */
export function advancePastCommittedFrontier(input: {
  readonly explicitChapter: boolean;
  readonly resolvedChapter: number;
  readonly resolvedCommitted: boolean;
  readonly nextChapterCommitted: boolean;
}): number {
  if (!input.explicitChapter && input.resolvedCommitted && !input.nextChapterCommitted) {
    return input.resolvedChapter + 1;
  }
  return input.resolvedChapter;
}

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要出稿的章号。")),
  chapterGoal: z.string().optional().describe(
    "本章方向/目标（一句话即可，如『主角与对手第一次正面交锋』）。省略时默认『继续第 N 章』。",
  ),
  requestedDraftLength: coerceNumber(z.number().int().nonnegative().optional().describe("可选：本章期望字数（中文字符数）；省略或填 0=由写作规则/方向推断。")),
  selectedCharacterIds: coerceStringArray(z.array(z.string()).optional().describe("可选：本章明确在场/相关角色 id 列表，用于收窄写作上下文。")),
  selectedHookIds: coerceStringArray(z.array(z.string()).optional().describe("可选：本章明确相关伏笔 id 列表，用于收窄写作上下文。")),
  mustHitBeats: coerceStringArray(z.array(z.string()).optional().describe(
    "可选但强烈建议：当用户给了本章必须落实的【具体要点】（具体名物 / 数字 / 编号 / 关键动作，如『第三块砖』『债权池A-17』『买胶带』），逐条原样填进来，别压成一句话、别替换具体名词。" +
    "引擎会把这些注入『本章硬约束』让模型逐条落实，并在出稿后确定性核对哪条漏了/写歪了；判漏条目还会先经 AI 复核摘除误报（带正文引证才摘），最终以 beatFidelity 字段的裁决后结果为准。",
  )),
  maxTimelineEvents: coerceNumber(z.number().int().nonnegative().optional().describe("可选：最多读取多少条时间线事件。")),
  contextTokenBudget: coerceNumber(z.number().int().nonnegative().optional().describe("可选：动态上下文 token 预算；超出时只裁剪低优先动态块。")),
  allowWriteAhead: coerceBoolean(z.boolean().optional().describe(
    "章序护栏的知情 override：默认 false。前一章未入库时本工具会拦下（防穿帮）；仅当用户被告知风险后明确表示『仍要先写本章』，才带 true 再调一次放行。不要默认带 true。",
  )),
  autoDeAi: coerceBoolean(z.boolean().optional().describe(
    "出稿检出 high/medium AI 腔后是否自动去味一轮（默认 true：repair 任务槽批量改写 + 改后复检，最多一轮不循环，落盘前自动快照，只改文风不动剧情）。false=只检测标注、不改写。",
  )),
  candidates: coerceNumber(z.number().int().min(1).max(3).optional().describe(
    "可选：多候选采样数（1–3，默认 1=一次成稿）。>1 时先后生成 N 个候选（temperature 依次错开），按确定性规则" +
    "（必命中要点 > 字数下限 > AI 腔计权 high×3+medium）选出最优稿落盘，逐候选得分与落选原因进 candidatesReport——防长篇连载文风坍缩。" +
    "注意：token 消耗与生成时间都约为 N 倍，用户没明确要求多版挑选/防文风雷同时保持默认 1。",
  )),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功出稿并写入工作稿。引擎校验不过拒绝写盘（空正文/JSON 伪正文/超上限无法安全裁剪等）时为 false；正文低于字数下限不拒绝、照常写盘（见 draftLength 与 summary 的 ⚠ 标注）。"),
  chapter: z.number().int().positive(),
  draftPath: z.string().optional().describe("工作稿文件路径（成功时）。"),
  draftBody: z.string().optional().describe("生成的正文（不含 Markdown 标题；成功时返回，供前端展示）。"),
  draftTitle: z.string().optional().describe("引擎为本章拟的标题（成功时）。"),
  draftLength: z.object({
    requestedDraftLength: z.number().describe("本章目标字数（中文字符数）。"),
    lowerBound: z.number().describe("目标字数下限。"),
    upperBound: z.number().describe("目标字数上限。"),
    actualLength: z.number().describe("本版正文实际中文字符数。"),
    lengthStatus: z.union([
      z.literal("below_lower_bound"),
      z.literal("within_range"),
      z.literal("above_upper_bound"),
    ]).describe("字数状态。below_lower_bound=低于下限：本工具一次成稿、不自动补写重试、不拒绝，仅在 summary 如实标注，由用户决定重写或接受。"),
    source: z.union([
      z.literal("user"),
      z.literal("writing_rules"),
      z.literal("default"),
    ]).describe("目标字数来源：user=用户/agent 指定，writing_rules=项目写作规则，default=系统默认。"),
  }).optional().describe("引擎对本版正文的字数核对（成功/失败均可能带）。低于下限不代表出稿失败，只是如实标注。"),
  issues: z.array(z.string()).describe("出稿过程中的问题（失败时含拒绝原因，诚实回报）。"),
  overview: z.unknown().describe("出稿后重新读取的 StateOverview，供前端刷新写作区/总览。"),
  summary: z.string().describe("出稿结果的自然语言摘要。"),
  refreshScope: z.literal("full"),
  snapshotId: z.string().optional().describe("覆盖现有非空草稿前建的快照 id（M6：让『再写一版』可撤销）；首次出稿无此值。"),
  contextBudget: z.object({
    droppedSections: z.array(z.string()),
    droppedDetails: z.array(z.object({ name: z.string(), reason: z.string(), coreImpact: z.boolean() })).optional(),
    coreImpact: z.boolean().optional(),
    issues: z.array(z.string()).optional(),
  }).optional().describe("写作上下文预算裁剪诊断。为空或缺省表示未裁剪。"),
  characterSelection: z.unknown().optional().describe("本章相关角色选择诊断。"),
  blockedReason: z.union([
    z.literal("previous_chapter_not_committed"),
    z.literal("no_write_intent_this_turn"),
  ]).optional().describe(
    "被护栏拦下时为此值（ok=false），别当普通失败重试：" +
      "previous_chapter_not_committed=前一章没入库、现在写本章会穿帮；" +
      "no_write_intent_this_turn=本轮用户原话没有写正文/续写意图（防入库后自主续写），按 summary 向用户讲清并给选项。",
  ),
  pendingChapterToCommit: z.number().int().positive().optional().describe("被章序护栏拦下时，建议先入库的那一章（= 本章号-1）。"),
  aiFlavor: z.object({
    total: z.number().int().nonnegative().describe("疑似 AI 腔命中总数（全量，含未截断进清单的）。"),
    bySeverity: z.object({
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
    }).describe("按严重度分布（全量统计）。"),
    truncated: z.boolean().describe("清单是否被截断（引擎 capped 8 条；true=还有未列出的命中）。"),
  }).optional().describe(
    "出稿后 AI 腔确定性回检（warning-only，绝不影响出稿成败）：内置规则 + 项目写作规则 antiAiPatterns 的确定性命中统计。" +
    "检出 high/medium 时 summary 会带 ⚠ 标注（默认还会自动去味一轮，见 autoDeAi 字段）；total=0 或只有 low 时不标注。",
  ),
  autoDeAi: z.object({
    attempted: z.boolean().describe("是否真跑了一轮自动去味改写（false=只检测标注、未动稿，如 autoDeAi:false）。"),
    fixedCount: z.number().int().nonnegative().describe("本轮实际安全替换落盘的处数。"),
    remainingHighMedium: z.number().int().nonnegative().describe("改写后对改后正文复检同一套确定性规则仍剩的 high/medium 处数；未改写/失败时=初检 high+medium。"),
    skipped: z.object({
      notFound: z.number().int().nonnegative(),
      ambiguous: z.number().int().nonnegative(),
      noop: z.number().int().nonnegative(),
      overlap: z.number().int().nonnegative(),
      noRewrite: z.number().int().nonnegative(),
    }).describe("跳过计数：定位不到 / 多处命中 / 改后与原句无异 / 区间重叠 / 模型没给有效改写。"),
    error: z.string().optional().describe("改写模型失败原因（此时原稿未动、保留初始检出）。"),
  }).optional().describe(
    "出稿检出 high/medium 后的自动去味一轮（最多一轮、不循环；仅 autoDeAi 开启且有 high/medium 命中时出现）。" +
    "改写失败/解析失败=原稿不动并如实报告，绝不影响出稿本身的 ok。",
  ),
  candidatesReport: z.array(z.object({
    index: z.number().int().positive().describe("候选序号（1 起，与 summary 的『第 N 个』一致）。"),
    chosen: z.boolean().describe("是否被确定性评分选中并落盘。"),
    score: z.number().optional().describe(
      "确定性得分（100 起扣：漏必命中要点 -50/条、低于字数下限 -25、AI 腔计权 high×3+medium×1 每分 -10；可为负）。" +
      "漏报数先经 AI 复核裁决（误报摘除后不扣分，见 beatFidelity 字段）。仅通过引擎校验的候选参与评分，失败候选无此值。",
    ),
    aiFlavorCounts: z.object({
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
    }).describe("该候选出稿回检的 AI 腔按严重度计数。"),
    actualLength: z.number().describe("该候选正文实际中文字符数。"),
    reason: z.string().describe("优胜/落选/失败的一句人话原因（如『AI 腔 2 处 > 优胜者 0 处』『低于字数下限』）。"),
    excerpt: z.string().optional().describe(
      "该候选正文的开头预览（前 100 字，按码位截断、能落在句读边界就落，超出加省略号），供快速比对候选风格。" +
      "失败候选没有正文 → 不带此字段（落选稿 persist:false 不落盘，这是读到落选稿样貌的唯一窗口）。",
    ),
    temperature: z.number().optional().describe(
      "该候选生成时实际使用的 temperature（依次错开防同分布：基准向上错不开时会向下错开，以此处实际值为准）。",
    ),
  })).optional().describe(
    "多候选采样（candidates>1）的逐候选透明报告：开头预览、得分、AI 腔计数、字数、是否中选、原因全列出，失败候选也在内。candidates=1（默认）无此字段。",
  ),
  beatFidelity: z.object({
    missingBeats: z.array(z.string()).describe("确定性核对判漏、且（跑了复核时）AI 复核后仍可能漏写/被改写的必命中要点原文。"),
    adjudicatedCovered: z.array(z.object({
      beat: z.string().describe("确定性核对判漏、但 AI 复核确认已被正文覆盖而摘除的要点原文。"),
      quote: z.string().describe(
        "模型引用的正文原句（已校验：归一化空白后为【裁决时草稿】的逐字子串），作为覆盖证据；" +
        "若之后自动去味改掉了这句，该条目会移入 staleAdjudications（覆盖结论过期）。",
      ),
    })).describe("被复核摘除的误报要点（可追溯，绝不静默消失）。"),
    adjudication: z.union([
      z.literal("not_run"),
      z.literal("applied"),
      z.literal("unavailable"),
    ]).describe(
      "判漏复核状态：not_run=未跑复核（未注入裁决模型）；applied=复核已跑（哪怕一条没摘）；" +
      "unavailable=复核模型失败/超时/烂 JSON，维持确定性结论、绝不反向谎报。",
    ),
    error: z.string().optional().describe("复核模型失败原因（adjudication=unavailable 时）。"),
    postDeAiNewMisses: z.array(z.string()).optional().describe(
      "自动去味真落了改动后，对最终正文再跑一遍确定性核对时【新出现】的漏写要点（去味整句改写吃掉了锚点；" +
      "基准集是裁决【前】的确定性判漏——裁决已摘除的要点本就词面无锚点、去味后照样判漏，不算新漏）。这些是确定性核对结果、未经 AI 复核，请如实转达。",
    ),
    staleAdjudications: z.array(z.object({
      beat: z.string().describe("复核曾确认覆盖、但引证句随后被自动去味改写的要点原文。"),
      quote: z.string().describe("裁决时的引证原句——已被去味改写，不再是最终稿的逐字子串，覆盖结论过期。"),
    })).optional().describe(
      "引证过期的复核条目（从 adjudicatedCovered 移出，可追溯不静默）：去味恰好改写了它们的证据句，要点当前是否仍被覆盖需要人工或下一轮复核确认。",
    ),
  }).optional().describe(
    "必命中要点保真核对（warning-only，绝不影响出稿成败）：确定性规则判漏的要点先经 AI 复核（带正文逐字引证才摘除误报）；" +
    "仅当确定性核对有判漏、或自动去味后新出现漏写时出现，零判漏零调用。无锚点的要点规则本就不检，不在此列。",
  ),
});

/** 工具输出的字数核对信息：引擎 DraftLengthReport 的关键字段提纯（目标区间/实际字数/是否低于下限/目标来源）。 */
export interface GenerateDraftLengthInfo {
  readonly requestedDraftLength: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly actualLength: number;
  readonly lengthStatus: DraftLengthStatus;
  readonly source: DraftLengthTargetSource;
}

export interface GenerateDraftToolOutput {
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
  readonly snapshotId?: string;
  readonly contextBudget?: ReturnType<typeof contextBudgetPayload>;
  readonly characterSelection?: CharacterPresenceResult;
  readonly blockedReason?: "previous_chapter_not_committed" | "no_write_intent_this_turn";
  readonly pendingChapterToCommit?: number;
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
 * 低于目标字数下限的如实标注：一次成稿不自动补写、不拒绝，让 agent 如实转达用户决定重写或接受。
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

/** 章序护栏拦截时的工具输出（ok:false + 结构化 reason + 讲清穿帮原因的 summary）。纯逻辑、可测。 */
export function buildSequencingBlockedOutput(
  chapter: number,
  priorChapter: number,
  overview: StateOverview,
): GenerateDraftToolOutput {
  return {
    ok: false,
    chapter,
    blockedReason: "previous_chapter_not_committed",
    pendingChapterToCommit: priorChapter,
    issues: [`第 ${priorChapter} 章还没入库`],
    overview,
    summary:
      `第 ${priorChapter} 章还没入库——它的新状态（人物变化/伏笔/世界事实）还没写进故事，` +
      `现在直接写第 ${chapter} 章会读到旧状态、容易前后穿帮。` +
      `建议先把第 ${priorChapter} 章入库（commit_preview → commit_apply）再写第 ${chapter} 章；` +
      `若确认要冒险先写，请明确说「知道风险，仍要先写第 ${chapter} 章」。`,
    refreshScope: "full",
  };
}

/**
 * 本轮无写作意图被意图门拦下时的输出（ok:false + 结构化 reason + 面向用户的中性 summary）。
 * summary 是给用户看的（会进实时字幕/步骤卡），不含内部工具名（铁律④）。纯逻辑、可测。
 */
export function buildNoWriteIntentBlockedOutput(
  chapter: number,
  overview: StateOverview,
): GenerateDraftToolOutput {
  return {
    ok: false,
    chapter,
    blockedReason: "no_write_intent_this_turn",
    issues: ["本轮用户原话没有写正文/续写的意图"],
    overview,
    summary:
      `这一轮我没收到明确要写正文的指令，就没有自动生成第 ${chapter} 章正文——避免擅自往下写，也不白费你的额度。` +
      `想写就直接说「写这一章」或「写下一章」；如果你是想改设定/资料或做别的，告诉我就行。`,
    refreshScope: "full",
  };
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
  const snapshotId = await snapshotBeforeDraftOverwrite(input.projectDir, input.chapter, `第${input.chapter}章自动去AI味前快照`);
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
 * 判漏误报降噪：选优前对每个「通过且有判漏」的候选先跑 AI 复核（顺序调、不并发），评分吃裁决后漏报数——
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
      exceptions.push(error instanceof Error ? error.message : String(error));
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
    const message = error instanceof Error ? error.message : String(error);
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

/**
 * 纯逻辑：复刻路由编排——runFastDraft（注入 writerClient）→ 读回工作稿 → 诚实回报。
 * writerClient 作为参数注入，便于单测用 mock model；真实 execute 注入
 * createConfiguredWriterClient("fastDraft")。出稿本身不建快照；自动去味覆盖刚写盘的草稿前会先快照
 * （runAutoDeAiRound 内，对齐 revise_draft 的覆盖前快照）。
 *
 * 自动去味（autoDeAi，默认 true）：出稿回检检出 high/medium 且注入了 deAiCallModel 时，
 * 自动跑一轮 runAutoDeAiRound（批量改写 + 复检），结果进 autoDeAi 字段与 summary；
 * autoDeAi:false 或未注入 deAiCallModel → 只标注不改写（attempted:false）。
 * 去味真落改动后，对最终正文重跑一遍确定性 beats 核对（零 token）：整句改写吃掉锚点造成的新漏
 * 并入 beatFidelity.postDeAiNewMisses 且 summary 如实标注（已在 missingBeats 列过的不重复报）。
 *
 * 多候选（candidates=2/3，默认 1=零行为变化）：先后生成 N 个 persist:false 候选（candidateWriterClients
 * 按序注入，execute 用 temperature 错开构建），确定性评分选优、优胜稿落盘后汇入下方同一条后续链。
 *
 * 判漏误报降噪（beatAdjudicationCallModel，execute 注入 triage 任务槽）：确定性核对判漏的必命中要点
 * 先经 AI 复核（带正文逐字引证才摘除误报；模型挂→维持原结论+unavailable），beatFidelity 输出与 summary
 * 用裁决后结果；多候选路径在评分器之前逐候选裁决（评分吃裁决后漏报数）。缺失=跳过复核、维持确定性结论
 * （adjudication:"not_run"）。零判漏零调用。
 */
export async function runGenerateDraftToolLogic(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal?: string;
  readonly requestedDraftLength?: number;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly mustHitBeats?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  readonly writerClient: WriterClient;
  /** 自动去味开关（默认 true）；false=检出 high/medium 也只标注、不改写。 */
  readonly autoDeAi?: boolean;
  /** 自动去味的改写模型调用（execute 注入 repair 任务槽；测试注入 mock）。缺失=只标注不改写。 */
  readonly deAiCallModel?: (prompt: string) => Promise<string>;
  /** 多候选采样数（只认 2/3，其余一律当 1=一次成稿现状）。 */
  readonly candidates?: number;
  /** candidates>1 时按序注入的候选 writer（execute 用 temperature 错开构建；测试注入 mock）。缺位的序号回退 writerClient。 */
  readonly candidateWriterClients?: readonly WriterClient[];
  /** 各槽位错温 client 实际使用的 temperature（execute 注入 resolveCandidateTemperatures 的结果），如实进 candidatesReport。 */
  readonly candidateTemperatures?: readonly number[];
  /** 判漏要点的 AI 复核调用（execute 注入 triage 任务槽；测试注入 mock）。缺失=跳过复核、维持确定性结论。 */
  readonly beatAdjudicationCallModel?: (prompt: string) => Promise<string>;
}): Promise<GenerateDraftToolOutput> {
  const { projectDir, chapter, writerClient } = input;
  const chapterGoal = input.chapterGoal?.trim() || `继续第 ${chapter} 章。`;
  // 模型无关：模型常把 maxTimelineEvents/contextTokenBudget 传成 `0`（当"默认/不限"用），而 `0` 在
  // 引擎里是"显式锁定/极限裁剪"——会静默砍掉时间线 + 全部非保护上下文段（长篇慢性失忆，真机 ch2/ch3
  // 已被 contextTokenBudget:"0" 触发）。这里把模型面的非正数一律当"未提供→默认"，绝不当显式锁定。
  // （resolveWriterTokenBudget(0)=0 极限裁剪的内部契约保留给路由/内部调用，只在模型入参层归一。）
  const maxTimelineEvents = positiveOrUndefined(input.maxTimelineEvents) ?? 8;
  // 洞①修复：生产路径即便没显式给预算，也套用默认预算（resolveWriterTokenBudget），
  // 让 dynamic 裁剪真正生效；正常短篇 dynamic 远低于默认值=自然 no-op，仅长篇超额时才裁。
  const contextRanking = makeWriterRankContext({ tokenBudget: resolveWriterTokenBudget(positiveOrUndefined(input.contextTokenBudget)) });
  const characterSelection = await resolveSelectedCharacterIds({
    projectDir,
    chapter,
    chapterGoal,
    explicit: input.selectedCharacterIds,
  });
  const selectedCharacterIds = characterSelection.selectedCharacterIds.length > 0 ? characterSelection.selectedCharacterIds : undefined;

  // 出稿即自动回检（warning-only）：内置确定性规则（7 条模式 + 虚弱副词频率闸）+ 项目写作规则的
  // antiAiPatterns（用户自定义词，字面量匹配、一律 low 档）。writing-rules.json 读不到 → 只剩内置规则，不崩。
  const aiFlavorRules = [...ALL_BUILTIN_AI_FLAVOR_RULES, ...buildUserAntiAiPatternRules(await readAntiAiPatterns(projectDir))];

  const sharedDraftInput = {
    projectDir,
    chapter,
    chapterGoal,
    aiFlavorRules,
    ...(positiveOrUndefined(input.requestedDraftLength) !== undefined ? { requestedDraftLength: positiveOrUndefined(input.requestedDraftLength) } : {}),
    ...(selectedCharacterIds !== undefined ? { selectedCharacterIds } : {}),
    ...(input.selectedHookIds !== undefined ? { selectedHookIds: input.selectedHookIds } : {}),
    ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
    maxTimelineEvents,
    rankContext: contextRanking.rankContext,
  };
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
  // 字数透明：引擎对每版正文都记 draftLength（成功/失败均带），透传关键信息进输出，绝不藏起来。
  const draftLengthInfo = report?.draftLength ? buildDraftLengthInfo(report.draftLength) : undefined;

  if (!report || !report.passed || !report.draftPath) {
    // 候选全部异常（连报告都没有）时，issues 用逐候选原因拼出，绝不空着。
    const failureIssues = report?.issues ?? sampling?.entries.map((entry) => `候选 ${entry.index}：${entry.reason}`) ?? [];
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
    };
  }

  // L1：草稿已写盘，但回读那一刻偶发 FS 读失败会得空稿，前端这次就不刷新（草稿其实在磁盘，切走再回来就有）。
  // 重试回读兜底（刚写盘的文件、读空多是极少数 FS 抖动，重试即得）；仍取不到才退回空——
  // ⚠ 绝不因此判 ok:false：稿子是真写成功的，谎报失败会诱导用户重写覆盖好稿。
  let draftBody = await readDraftBodyWithRetry(report.draftPath);

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

  // 字数透明软警告：低于目标字数下限不拒绝、不自动补写（一次成稿），summary 如实标注，让用户决定重写或接受。
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
          rules: aiFlavorRules,
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

  return {
    ok: true,
    chapter,
    draftPath: report.draftPath,
    draftBody,
    ...(report.title ? { draftTitle: report.title } : {}),
    ...(draftLengthInfo ? { draftLength: draftLengthInfo } : {}),
    ...(aiFlavorInfo ? { aiFlavor: aiFlavorInfo } : {}),
    ...(autoDeAiInfo ? { autoDeAi: autoDeAiInfo } : {}),
    ...(sampling ? { candidatesReport: sampling.entries } : {}),
    ...(beatFidelityInfo ? { beatFidelity: beatFidelityInfo } : {}),
    // 自动去味真落了改动时，snapshotId 用它的快照（最近的撤销点）；否则由 execute 挂「再写一版」快照。
    ...(autoDeAiSnapshotId ? { snapshotId: autoDeAiSnapshotId } : {}),
    issues: report.issues,
    overview,
    summary:
      `第 ${chapter} 章已生成正文并写入工作稿${report.title ? `《${report.title}》` : ""}。` +
      candidateLine +
      `${characterSelection.summary}。草稿尚未入库，可在写作区查看修改；满意后再走 commit_preview / commit_apply 入库。` +
      (beatNote ? `\n${beatNote}` : "") +
      (lengthWarning ? `\n${lengthWarning}` : "") +
      (aiFlavorNote ? `\n${aiFlavorNote}` : "") +
      // A11：回读为空是偶发 FS 抖动、正文确已写盘——加一句可见性提示，别让用户以为没生成而重写覆盖好稿。
      (draftBody.trim().length === 0
        ? "（注：正文已写盘，但本次未能载入到写作区显示——切到别的章再切回本章即可看到，不用重写。）"
        : ""),
    refreshScope: "full",
    characterSelection,
    ...contextBudget,
  };
}

export const generateDraftTool = createTool({
  id: "generate_draft",
  description:
    "为某章生成一版正文并写入工作稿（drafts/fast，不入库）。当用户说『写第 N 章 / 出一版正文 / 把方案写成正文』时调用。" +
    "草稿是待保存的工作稿，不建 git 快照（改坏了走操作历史撤销）；满意后再用 commit_preview / commit_apply 正式入库。" +
    "引擎校验不过（空正文/伪正文等）会拒绝写盘并如实回报 ok:false。一次成稿、不自动补写重试：" +
    "正文低于目标字数下限不会被拒绝，会在 draftLength 和 summary 里如实标注（⚠ 低于下限）——请如实转达用户，由其决定重写或接受，别假装字数达标。" +
    "出稿后自动跑 AI 腔确定性回检（warning-only，不影响成败）：检出 high/medium 时默认自动去味一轮（repair 槽批量改写、只改文风不动剧情、" +
    "最多一轮不循环、落盘前自动快照），结果如实进 autoDeAi 字段，summary 如实说明修掉几处/复检还剩几处（剩下的可引导用户说「去AI味」逐条修订）；" +
    "改写模型没跑成会如实报告、原稿不动。用户明确不要自动改时传 autoDeAi:false（只标注不改写）；total=0 或只有 low 时不触发也不标注。" +
    "默认一次成稿（candidates:1）；用户想多版挑选、或嫌连载文风越来越雷同时，传 candidates:2–3：先后生成 N 个候选（temperature 依次错开），" +
    "按确定性规则（必命中要点 > 字数下限 > AI 腔计权 high×3+medium）自动选出最优稿落盘，逐候选得分与落选原因见 candidatesReport——请如实转达。" +
    "注意多候选的 token 消耗与生成时间都约为 N 倍，别默认开。" +
    "mustHitBeats 的判漏会先经 AI 复核（带正文逐字引证才摘除误报、模型没跑成则维持原结论），裁决后的剩余漏写与" +
    "被摘除条目分别见 beatFidelity.missingBeats / beatFidelity.adjudicatedCovered——summary 的「首稿核对」警告以裁决后结果为准，请如实转达。" +
    "若自动去味真改了稿，会对最终正文再做一遍确定性核对，被改写吃掉锚点的新漏见 beatFidelity.postDeAiNewMisses 与 summary 的「去味后新漏」标注。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "generate_draft 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const resolvedFromInputOrContext = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedFromInputOrContext === undefined) {
      throw new Error("generate_draft 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    // 已入库前沿 → 推进下一章（治 off-by-one：入库后 currentChapter 仍停在刚入库那章，隐式出稿会重写它）。
    // 仅在「模型没显式给章号」且「回退到的章已入库、且是前沿（下一章未入库）」时推进；显式章号一律尊重。
    const explicitChapter = Number.isInteger(input.chapter) && (input.chapter as number) > 0;
    const resolvedChapter = advancePastCommittedFrontier({
      explicitChapter,
      resolvedChapter: resolvedFromInputOrContext,
      resolvedCommitted: explicitChapter ? false : await isChapterCommitted(projectDir, resolvedFromInputOrContext),
      nextChapterCommitted: explicitChapter ? false : await isChapterCommitted(projectDir, resolvedFromInputOrContext + 1),
    });
    // A（写作意图门，防「入库后自主续写」）：那一轮用户原话只有定稿/审稿等意图、没有任何写作意图时，
    // 模型不得擅自 generate_draft 往下写整章（纪律 145「出稿不越权」的确定性护栏——不赌弱模型守规矩）。
    // 缺原话放行（向后兼容/前端按钮直调）；组合意图「定稿并接着写下一章」含写作意图仍放行。拦在调模型之前。
    const userTurnText = readUserTurnTextFromContext(context);
    if (userTurnText !== undefined && !userTurnAllowsDraftWrite(userTurnText)) {
      console.warn("[turn-intent-gate] 拦下未授权 generate_draft（本轮用户原话无写作意图，防入库后自主续写）");
      const overview = await buildStateOverview({ projectDir, chapter: resolvedChapter, maxTimelineEvents: 8 });
      return buildNoWriteIntentBlockedOutput(resolvedChapter, overview);
    }
    // B（章序护栏，防穿帮）：入库会把这章的跨章状态写进故事，下一章靠读它才不穿帮。
    // 前一章没入库就写本章 → 默认拦下（强护栏），知情后带 allowWriteAhead 再调才放行。
    // 拦在建快照/调模型之前——不浪费、不偷偷写。
    const priorChapterCommitted = resolvedChapter <= 1 ? true : await isChapterCommitted(projectDir, resolvedChapter - 1);
    const guard = evaluateChapterSequencingGuard({
      chapter: resolvedChapter,
      allowWriteAhead: input.allowWriteAhead ?? false,
      priorChapterCommitted,
    });
    if (guard.blocked) {
      const prior = guard.pendingChapterToCommit ?? resolvedChapter - 1;
      const overview = await buildStateOverview({ projectDir, chapter: resolvedChapter, maxTimelineEvents: 8 });
      return buildSequencingBlockedOutput(resolvedChapter, prior, overview);
    }
    // M6：覆盖现有非空草稿前建快照，让「再写一版」可撤销（首次出稿无旧稿可丢则不建）。
    const snapshotId = await snapshotBeforeDraftOverwrite(projectDir, resolvedChapter, `第${resolvedChapter}章再次出稿前快照`);
    // 出稿流式：路由注入了 sink 就把正文 delta 逐字喂前端编辑器（带本次章号，前端只往当前章追）；缺失=不流式。
    const draftDeltaSink = readDraftDeltaSinkFromContext(context);
    // 多候选采样（第四层防坍缩）：N 个 writer 的 temperature 依次错开（基准 / ±0.15 / ±0.3——向上封顶 1.0，
    // 部分 provider 的 temperature 上限为 1 超了会被 400 拒；base 已 ≥0.85 时向上错不开会三版同温，
    // 改向下错开，见 resolveCandidateTemperatures），防 N 版同分布。采样不接 delta sink：
    // N 版正文逐字串进同一章编辑器会花屏，优胜稿落盘后由 refreshScope:"full" 一次性刷新。
    const candidateCount = input.candidates === 2 || input.candidates === 3 ? input.candidates : 1;
    let writerClient: WriterClient;
    let candidateWriterClients: readonly WriterClient[] | undefined;
    let candidateTemperatures: readonly number[] | undefined;
    if (candidateCount > 1) {
      const configured = await resolveConfiguredChatModel("fastDraft");
      const baseTemperature = configured.profile.temperature ?? 0.8; // 与 createOpenAICompatibleWriterClient 的兜底一致
      candidateTemperatures = resolveCandidateTemperatures(baseTemperature, candidateCount);
      candidateWriterClients = candidateTemperatures.map((temperature) =>
        createOpenAICompatibleWriterClient({
          ...configured,
          profile: { ...configured.profile, temperature },
        }));
      writerClient = candidateWriterClients[0];
    } else {
      writerClient = await createConfiguredWriterClient(
        "fastDraft",
        draftDeltaSink ? (delta) => draftDeltaSink({ chapter: resolvedChapter, text: delta }) : undefined,
      );
    }
    // 自动去味（默认开）：改写走 repair 任务槽（对齐 routes/de-ai-flavor.ts 的现行读法——
    // resolveConfiguredChatModel 内部合成 task-assignments 旁路）。解析失败不拦出稿：
    // 把错误包进 callModel，由去味闭环如实报「没跑成、原稿未动」。
    const autoDeAiEnabled = input.autoDeAi ?? true;
    const deAiCallModel = autoDeAiEnabled ? await buildRepairDeAiCallModel() : undefined;
    const result = await runGenerateDraftToolLogic({
      projectDir,
      chapter: resolvedChapter,
      ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
      ...(input.requestedDraftLength !== undefined ? { requestedDraftLength: input.requestedDraftLength } : {}),
      ...(input.selectedCharacterIds !== undefined ? { selectedCharacterIds: input.selectedCharacterIds } : {}),
      ...(input.selectedHookIds !== undefined ? { selectedHookIds: input.selectedHookIds } : {}),
      ...(input.mustHitBeats !== undefined ? { mustHitBeats: input.mustHitBeats } : {}),
      ...(input.maxTimelineEvents !== undefined ? { maxTimelineEvents: input.maxTimelineEvents } : {}),
      ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
      autoDeAi: autoDeAiEnabled,
      ...(deAiCallModel ? { deAiCallModel } : {}),
      candidates: candidateCount,
      ...(candidateWriterClients ? { candidateWriterClients } : {}),
      ...(candidateTemperatures ? { candidateTemperatures } : {}),
      // 判漏 AI 复核（默认开，零判漏零调用）：triage 任务槽。惰性解析——只有真有判漏、复核真被调用时
      // 才解析该槽；解析/调用失败在 adjudicateMissingBeats 里被接住 → 维持确定性结论 + unavailable 如实标注。
      beatAdjudicationCallModel: buildTriageBeatAdjudicationCallModel(),
      writerClient,
    });
    // 只在真出稿成功时挂 snapshotId（失败=未覆盖旧稿，无需撤销点）；自动去味已落改动时它自带更近的快照，不覆盖。
    return result.ok && snapshotId ? { ...result, snapshotId: result.snapshotId ?? snapshotId } : result;
  },
});

/**
 * 自动去味的改写模型（repair 任务槽，对齐 routes/de-ai-flavor.ts：流式 + 空闲超时、不传 max_tokens、要 JSON）。
 * 绝不抛错：模型槽解析失败时返回一个「调用即抛该错误」的 callModel——出稿本身已成功，
 * 不能让去味槽的配置问题把 ok:true 的出稿拖成工具报错；闭环会如实报「改写模型没跑成、原稿未动」。
 */
async function buildRepairDeAiCallModel(): Promise<(prompt: string) => Promise<string>> {
  try {
    const configured = await resolveConfiguredChatModel("repair");
    return async (prompt: string): Promise<string> => {
      const { content } = await streamChatModelToText({
        configured,
        messages: [{ role: "user", content: prompt }],
        temperature: configured.profile.temperature ?? 0.4,
        responseFormat: { type: "json_object" },
      });
      if (!content) throw new Error("改写模型返回了空内容。");
      return content;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return async () => {
      throw new Error(message);
    };
  }
}

/**
 * 判漏复核的裁决模型（triage 任务槽：流式 + 空闲超时、不传 max_tokens、要 JSON，低温判定）。
 * 惰性解析：只在真有判漏、复核真被调用时才 resolveConfiguredChatModel（零判漏连槽都不解析，
 * 也不让复核槽的配置问题把 ok:true 的出稿拖成工具报错）——解析/调用失败一律在
 * adjudicateMissingBeats 里被接住：维持确定性结论 + adjudication:"unavailable" 如实标注，绝不反向谎报。
 */
function buildTriageBeatAdjudicationCallModel(): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const configured = await resolveConfiguredChatModel("triage");
    const { content } = await streamChatModelToText({
      configured,
      messages: [{ role: "user", content: prompt }],
      temperature: configured.profile.temperature ?? 0.2,
      responseFormat: { type: "json_object" },
    });
    if (!content) throw new Error("复核模型返回了空内容。");
    return content;
  };
}

function optionalContextBudget(contextRanking: ReturnType<typeof makeWriterRankContext>): { readonly contextBudget: ReturnType<typeof contextBudgetPayload> } | Record<string, never> {
  return contextRanking.droppedSections.length > 0 || contextRanking.coreImpact || contextRanking.issues.length > 0
    ? { contextBudget: contextBudgetPayload(contextRanking) }
    : {};
}
