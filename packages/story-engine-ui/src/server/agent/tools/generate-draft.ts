/**
 * generate_draft — 写工作稿工具：为某章生成一版正文并落到工作稿（drafts/fast）。
 *
 * 双轨合一（第二波）：出稿编排已抽进共享 application service（services/draft-service.ts，
 * runGenerateDraft），本文件只剩工具适配层 + 兼容再导出：
 *   - RequestContext 取 projectDir / 章号回退 / 已入库前沿推进（治 off-by-one）；
 *   - D3 护栏簇（agent 语义，不是编排语义，留在工具层）：写作意图门（防入库后自主续写）+
 *     章序护栏（前一章未入库防穿帮）——拦在建快照/调模型之前；
 *   - writer 装配：单候选 createConfiguredWriterClient("fastDraft")（可接 delta sink 逐字喂编辑器），
 *     多候选按 temperature 错开构建 N 个 client（采样不接 sink：N 版串进同一章编辑器会花屏）；
 *   - 任务槽 callModel 装配：自动去味改写走 repair 槽、判漏 AI 复核走 triage 槽；
 *   - 本工具的显式策略：lengthPolicy:"annotate"（D1：一次成稿不拒绝，低于下限照写盘 + draftLength
 *     透出 + summary ⚠ 标注，由 agent 转达用户决定重写或接受）、aiFlavorRecheck:true（D2：回检栈开）；
 *   - 输出投影：剥掉 HTTP 适配料（http 袋），ok 时把覆盖前快照的 snapshotId 挂进输出。
 *
 * 快照策略（铁律「直接做+可撤销」的边界）：草稿是「待保存」的工作稿，不是状态入库，
 *   因此**不建入库级 git 快照**；但「再写一版」/自动去味会**覆盖**已有草稿，覆盖前用
 *   snapshotBeforeDraftOverwrite 建轻量快照（M6），output.snapshotId 挂最近一个撤销点。
 *   （D4 已收敛：HTTP 非流式路同调同一 helper 同一语义——仅覆盖已有非空草稿前建，首次出稿不建。）
 *   故本工具用 createTool 而非 writeTool。涉及草稿 → refreshScope:"full"（前端刷新写作区/总览）。
 *
 * 自动去味闭环、多候选采样防坍缩、beats 判漏 AI 复核降噪的实现全部在 services/draft-service.ts
 *   （原逻辑层逐字迁入）；其行为契约不变——generate-draft 的 92+12 个测试是判官。
 *
 * 铁律：
 * - 题材中立：description / summary 用中性词。
 * - 绝不静默失败 / 绝不谎报：runFastDraft.passed=false 时如实回报 ok:false + issues，不假装出稿成功。
 * - 字数透明：低于目标字数下限不拦也不藏——draftLength 进输出、summary 打 ⚠ 标注，不假装字数达标。
 */
import { readFile } from "node:fs/promises";
import { buildStateOverview, type StateOverview } from "@actalk/story-engine";
import type { WriterClient } from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceNumber, coerceStringArray } from "./lenient-args.js";

// 兼容既有测试导入：positiveOrUndefined 现归位 lenient-args（模型无关 helper 正位），此处再导出。
export { positiveOrUndefined } from "./lenient-args.js";

// 兼容既有测试/集成导入（generate-draft.test.ts / longform-consolidation.integration.test.ts 等）：
// 出稿编排与纯逻辑 helper 已归位 services/draft-service.ts（双轨合一），此处原样再导出。
export {
  aiFlavorWeightedScore,
  attachCandidateExcerpts,
  attachCandidateTemperatures,
  buildAiFlavorInfo,
  buildAiFlavorWarning,
  buildAutoDeAiNote,
  buildBeatFidelityInfo,
  buildBeatFidelityNote,
  buildCandidateExcerpt,
  buildCandidateSummaryLine,
  buildDraftLengthInfo,
  buildDraftLengthWarning,
  DRAFT_CANDIDATE_EXCERPT_MAX_CHARS,
  DRAFT_CANDIDATE_SCORE_WEIGHTS,
  DRAFT_CANDIDATE_TEMPERATURE_OFFSETS,
  EMPTY_AUTO_DE_AI_SKIPPED,
  pickAutoDeAiTargets,
  rankDraftCandidates,
  readDraftBodyWithRetry,
  resolveCandidateTemperatures,
  runAutoDeAiRound,
  scoreDraftCandidate,
  runGenerateDraft as runGenerateDraftToolLogic,
} from "../../services/draft-service.js";
export type {
  DraftCandidateReportEntry,
  DraftCandidateScoreInput,
  GenerateDraftAiFlavorInfo,
  GenerateDraftAutoDeAiInfo,
  GenerateDraftBeatFidelityInfo,
  GenerateDraftLengthInfo,
} from "../../services/draft-service.js";

import { createConfiguredWriterClient, createOpenAICompatibleWriterClient, resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { defaultCommittedChapterPath } from "../../lib/project-io.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext, readDraftDeltaSinkFromContext, readUserTurnTextFromContext } from "../request-context.js";
import { userTurnAllowsDraftWrite } from "./turn-intent-gate.js";
import { snapshotBeforeDraftOverwrite } from "./snapshot-on-draft-overwrite.js";
import { evaluateChapterSequencingGuard } from "./chapter-sequencing-guard.js";
import {
  resolveCandidateTemperatures,
  runGenerateDraft,
  type GenerateDraftOutcome,
} from "../../services/draft-service.js";

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

/** 工具输出契约：共享编排 outcome 剥掉 HTTP 适配料（http 袋）与执法标记 + 护栏拦截字段（execute 护栏产出）。 */
export type GenerateDraftToolOutput = Omit<GenerateDraftOutcome, "http" | "rejection"> & {
  readonly blockedReason?: "previous_chapter_not_committed" | "no_write_intent_this_turn";
  readonly pendingChapterToCommit?: number;
};

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
    // M6（D4 收敛后与 HTTP 非流式路同 helper 同语义）：覆盖现有非空草稿前建快照，让「再写一版」可撤销
    // （首次出稿无旧稿可丢则不建）。
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
    // 共享编排在 services/draft-service.ts。本工具的显式策略（D1/D2）：annotate=一次成稿不拒绝、
    // 低于下限照写盘 + draftLength 透出 + summary ⚠ 标注；aiFlavorRecheck 开（回检/去味/beats 裁决全栈）。
    const outcome = await runGenerateDraft({
      projectDir,
      chapter: resolvedChapter,
      ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
      ...(input.requestedDraftLength !== undefined ? { requestedDraftLength: input.requestedDraftLength } : {}),
      ...(input.selectedCharacterIds !== undefined ? { selectedCharacterIds: input.selectedCharacterIds } : {}),
      ...(input.selectedHookIds !== undefined ? { selectedHookIds: input.selectedHookIds } : {}),
      ...(input.mustHitBeats !== undefined ? { mustHitBeats: input.mustHitBeats } : {}),
      ...(input.maxTimelineEvents !== undefined ? { maxTimelineEvents: input.maxTimelineEvents } : {}),
      ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: true },
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
    // 投影：http 适配料（引擎原始报告/落盘全文/预算账本）不进 LLM 视野；rejection 仅 HTTP 执法策略产生、这里恒无。
    const { http: _httpProjection, rejection: _rejection, ...toolOutput } = outcome;
    // 只在真出稿成功时挂 snapshotId（失败=未覆盖旧稿，无需撤销点）；自动去味已落改动时它自带更近的快照，不覆盖。
    return outcome.ok && snapshotId ? { ...toolOutput, snapshotId: toolOutput.snapshotId ?? snapshotId } : toolOutput;
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
