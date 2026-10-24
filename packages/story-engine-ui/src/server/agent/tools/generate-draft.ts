/**
 * generate_draft — 写工作稿工具：为某章生成一版正文并落到工作稿（drafts/fast）。
 *
 * 双轨合一（第二波）：出稿编排已抽进共享 application service（services/draft-service.ts，
 * runGenerateDraft），本文件只剩工具适配层 + 兼容再导出：
 *   - RequestContext 取 projectDir / 章号回退 / 已入库前沿推进（治 off-by-one）；
 *   - D3 护栏簇（agent 语义，不是编排语义，留在工具层）：方向找原句 + 有稿不覆盖（重构 P4，作者档按钮）+
 *     章序护栏（前一章未入库防穿帮）——拦在建快照/调模型之前；
 *   - writer 装配：单候选 createConfiguredWriterClient("fastDraft")（可接 delta sink 逐字喂编辑器），
 *     多候选按 temperature 错开构建 N 个 client（采样不接 sink：N 版串进同一章编辑器会花屏）；
 *   - 任务槽 callModel 装配：自动去味改写走 repair 槽、判漏 AI 复核走 triage 槽；
 *   - 本工具的显式策略：lengthPolicy:"annotate"（D1：一次成稿不拒绝，低于下限照写盘 + draftLength
 *     透出 + summary ⚠ 标注，由 agent 转达用户决定重写或接受）、aiFlavorRecheck:true（D2：回检栈开）；
 *   - 输出投影：剥掉 HTTP 适配料（http 袋），ok 时把覆盖前快照的 snapshotId 挂进输出。
 *
 * 快照策略（铁律「直接做+可撤销」的边界）：草稿是「待保存」的工作稿，不是状态入库，
 *   因此**不建入库级 git 快照**；写盘前用 snapshotBeforeDraftOverwrite 建这一步的存档点（M6+R4.2）：
 *   覆盖已有草稿建「再次出稿前」、首次出稿建「出稿：第N章」（首稿也是作者眼里的一步，撤销要能撤它），
 *   output.snapshotId 挂最近一个撤销点。（D4 已收敛：HTTP 非流式路同调同一 helper 同一语义。）
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
import { buildStateOverview, type StateOverview } from "../../book/state-overview.js";
import type { WriterClient } from "../../writing/fast-draft-writer.js";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceNumber, coerceStringArray } from "../../lib/lenient-args.js";

// 兼容既有测试导入：positiveOrUndefined 现归位 lenient-args（模型无关 helper 正位），此处再导出。
export { positiveOrUndefined } from "../../lib/lenient-args.js";

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

import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { createConfiguredWriterClient, createOpenAICompatibleWriterClient } from "../../writing/writer-client.js";
import { defaultCommittedChapterPath, defaultDraftPath, stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext, readDraftDeltaSinkFromContext, readAuthorWordsFromContext, isUserConfirmedTool } from "../request-context.js";
import { checkAuthorQuote } from "./author-quote.js";
import { hasWorkingDraftText, snapshotBeforeDraftOverwrite } from "../../lib/snapshot-on-draft-overwrite.js";
import { evaluateChapterSequencingGuard } from "./chapter-sequencing-guard.js";
import {
  resolveCandidateTemperatures,
  runGenerateDraft,
  type GenerateDraftOutcome,
} from "../../services/draft-service.js";
import { callConfiguredBrainModel, callConfiguredPlannerModel, rereadBlocker } from "../../editorial/index.js";
import { callConfiguredContinueModel, callConfiguredFixModel } from "../../services/draft-pipeline/production-call-models.js";

/**
 * 某章是否已入库（chapters/N.md 存在且非空）。读盘只读，题材中立。
 *
 * P2 铁律④（永不静默）：此前 `.catch(() => undefined)` 把所有读盘错误都塌成「未入库」——
 * 权限不足（EACCES）、路径被目录占位（EISDIR）时，已入库的章会被误判成没入库，
 * 进而触发 advancePastCommittedFrontier 把出稿目标悄悄推进到下一章（写串章号）。
 * 只有 ENOENT 才真的代表「没入库」；其它错误必须如实上抛。
 */
export async function isChapterCommitted(projectDir: string, chapter: number): Promise<boolean> {
  const content = await readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
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
  // 2026-10-10 对话 AI 瘦身：参数说明只留模型要知道的（原来约 1700 字，每轮都发）。
  chapter: coerceNumber(z.number().int().positive().optional().describe("章号；省略=用户当前所在章。")),
  chapterGoal: z.string().optional().describe(
    "本章方向：只能原样抄作者说过的话（可以只抄讲方向的那几句）；作者没给方向就别填，章纲会按故事现状往下推。不是原话会被退回。",
  ),
  requestedDraftLength: coerceNumber(z.number().int().nonnegative().optional().describe("期望字数；省略=按写作规则。continueDraft 时是这次接着写多少字（省略=写到本章目标）。")),
  continueDraft: coerceBoolean(z.boolean().optional().describe(
    "true=接着这一章的工作稿往下写：已写的字一个不动，从最后一句接着写（作者写了半章要你接、稿子短了要补、作者说接着写 / 续写 / 再写几百字）。不用作者点按钮；chapterGoal 这时填作者说接下来写什么（原话）。",
  )),
  selectedCharacters: coerceStringArray(z.array(z.string()).optional().describe("一般不填。作者点名这章要写谁时，填人物名字。")),
  selectedHookIds: coerceStringArray(z.array(z.string()).optional().describe("一般不填。")),
  mustHitBeats: coerceStringArray(z.array(z.string()).optional().describe(
    "用户给的本章必须写到的具体要点（名物、数字、编号、关键动作），逐条原样填，别压成一句话、别换词。",
  )),
  maxTimelineEvents: coerceNumber(z.number().int().nonnegative().optional().describe("一般不填。")),
  contextTokenBudget: coerceNumber(z.number().int().nonnegative().optional().describe("一般不填。")),
  allowWriteAhead: coerceBoolean(z.boolean().optional().describe("前一章没定稿被拦下时，只有用户明确说仍要先写才带 true。")),
  autoDeAi: coerceBoolean(z.boolean().optional().describe("false=检出机器腔只标注、不自动去味（默认自动去味一轮）。")),
  candidates: coerceNumber(z.number().int().min(1).max(3).optional().describe("1–3，默认 1；用户明确要多版挑选才填，耗时和 token 约 N 倍。")),
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
  summary: z.string().describe("出稿结果的自然语言摘要（首行是本章章纲一句话，或章纲没拟成的原因）。"),
  continued: z.object({ kept: z.number(), added: z.number() }).optional()
    .describe("continueDraft 时：本来写好的字数、这次接着写的字数。"),
  qualityPipeline: z.object({
    continuation: z.object({
      before: z.number(), after: z.number(), rounds: z.number(), failures: z.array(z.string()),
    }).optional(),
    continuity: z.object({
      checked: z.boolean(),
      sure: z.array(z.object({ quote: z.string(), earlierQuote: z.string(), earlierChapter: z.number(), reason: z.string() })),
      maybe: z.array(z.object({ quote: z.string(), earlierQuote: z.string(), earlierChapter: z.number(), reason: z.string() })),
      failures: z.array(z.string()),
      autoFixed: z.object({ applied: z.number(), failed: z.number(), also: z.number().optional() }).optional(),
    }).optional(),
  }).optional().describe("出稿后的质量环节：续写够字数、前后核对（和「核账」同一套）。核出的确定问题已按前文改过一轮（continuity.autoFixed：改成几处、几处没改成），continuity.sure / maybe 是改完再核还剩、要用户定的问题。"),
  chapterPlan: z.object({
    summary: z.string(),
    beats: z.array(z.string()),
    newInformation: z.array(z.string()),
    scene: z.object({ location: z.string().optional(), time: z.string().optional() }).optional(),
    reused: z.boolean(),
  }).optional().describe("本章章纲：出稿前先拟的要点（推进什么、新信息是什么）。沿用 = 同一方向重写时用了这章已有的章纲。"),
  refreshScope: z.literal("full"),
  snapshotId: z.string().optional().describe("覆盖现有非空工作稿前建的快照 id（M6：让『再写一版』可撤销）；首次出稿无此值。"),
  contextBudget: z.object({
    droppedSections: z.array(z.string()),
    droppedDetails: z.array(z.object({ name: z.string(), reason: z.string(), coreImpact: z.boolean() })).optional(),
    coreImpact: z.boolean().optional(),
    issues: z.array(z.string()).optional(),
  }).optional().describe("写作上下文预算裁剪诊断。为空或缺省表示未裁剪。"),
  characterSelection: z.unknown().optional().describe("本章相关角色选择诊断。"),
  blockedReason: z.union([
    z.literal("previous_chapter_not_committed"),
    z.literal("chapter_has_text"),
    z.literal("chapter_goal_not_author_words"),
    z.literal("rereading"),
    z.literal("nothing_to_continue"),
    z.literal("chapter_committed"),
  ]).optional().describe(
    "被护栏拦下时为此值（ok=false）：" +
      "rereading=导入的书记账员还在通读前文记账，记完才能出稿（summary 里有进度），如实转告、别重试；" +
      "previous_chapter_not_committed=前一章没定稿、现在写本章会穿帮；" +
      "chapter_has_text=这一章已经有稿子，整章重写要作者点「重写这一章」按钮（随这次结果出在对话里），告诉作者点按钮或说要改哪里，别重试；" +
      "chapter_goal_not_author_words=chapterGoal 不是作者原话，原样抄作者的话（或不填）重调；" +
      "nothing_to_continue=continueDraft 但这一章还没有正文，要从头写就不带 continueDraft 再调；" +
      "chapter_committed=continueDraft 但这一章已经定稿，如实转告（summary 里说了怎么办），别重试。",
  ),
  needsConfirmation: z.boolean().optional().describe("true=要作者点按钮才做（chapter_has_text）。"),
  rewriteConfirm: z.object({
    chapter: z.number().int().positive(),
    chapterGoal: z.string().optional(),
    canContinue: z.boolean().optional(),
  }).optional().describe("「重写这一章」「接着往下写」按钮带的东西（界面用，你不用转述）。"),
  pendingChapterToCommit: z.number().int().positive().optional().describe("被章序护栏拦下时，建议先定稿的那一章（= 本章号-1）。"),
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
        "模型引用的正文原句（已校验：归一化空白后为【裁决时工作稿】的逐字子串），作为覆盖证据；" +
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
  readonly blockedReason?:
    | "previous_chapter_not_committed"
    | "chapter_has_text"
    | "chapter_goal_not_author_words"
    | "rereading"
    | "nothing_to_continue"
    | "chapter_committed";
  readonly pendingChapterToCommit?: number;
  readonly needsConfirmation?: boolean;
  /** canContinue：工作稿还没定稿，卡上另给「接着往下写」。 */
  readonly rewriteConfirm?: { readonly chapter: number; readonly chapterGoal?: string; readonly canContinue?: boolean };
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
    issues: [`第 ${priorChapter} 章还没定稿`],
    overview,
    summary:
      `第 ${priorChapter} 章还没定稿——它的新状态（人物变化/伏笔/世界事实）还没写进故事，` +
      `现在直接写第 ${chapter} 章会读到旧状态、容易前后穿帮。` +
      `建议先把第 ${priorChapter} 章定稿（先预览、再点「确认定稿」）再写第 ${chapter} 章；` +
      `若确认要冒险先写，请明确说「知道风险，仍要先写第 ${chapter} 章」。`,
    refreshScope: "full",
  };
}

/**
 * 这一章已经有稿子（工作稿或已定稿）时 AI 不覆盖：整章重写是作者档，出「重写这一章」按钮（重构 P4）。
 * 替代原来按作者原话猜「有没有写作意图」的门——那道门的用途（防定稿后 AI 自己往下写把稿子冲掉）现在由结构保证：
 * 空章 AI 照写（先存档、可撤销），有稿的章只有作者点了才重写。纯逻辑、可测。
 */
export function buildRewriteAwaitingAuthorOutput(
  chapter: number,
  committed: boolean,
  overview: StateOverview,
  chapterGoal?: string,
): GenerateDraftToolOutput {
  return {
    ok: false,
    chapter,
    blockedReason: "chapter_has_text",
    needsConfirmation: true,
    issues: [committed ? `第 ${chapter} 章已经定稿` : `第 ${chapter} 章已有工作稿`],
    overview,
    summary: committed
      ? `第 ${chapter} 章已经定稿了，我不直接重写。要整章重写就点「重写第 ${chapter} 章」（重写前存档，可撤销；重写后要重新定稿）。`
      : `第 ${chapter} 章已经有工作稿了，我不直接覆盖。要从最后一句接着写就点「接着往下写」，要整章重写就点「重写第 ${chapter} 章」（都先存档，可撤销）；只想改几处的话告诉我改哪里。`,
    refreshScope: "full",
    rewriteConfirm: { chapter, ...(chapterGoal ? { chapterGoal } : {}), ...(committed ? {} : { canContinue: true }) },
  };
}

/** 接着往下写却没得接 / 这章已定稿：如实说，不调模型。纯逻辑、可测。 */
export function buildContinueBlockedOutput(
  chapter: number,
  reason: "nothing_to_continue" | "chapter_committed",
  overview: StateOverview,
): GenerateDraftToolOutput {
  return {
    ok: false,
    chapter,
    blockedReason: reason,
    issues: [reason === "chapter_committed" ? `第 ${chapter} 章已经定稿` : `第 ${chapter} 章还没有正文`],
    overview,
    summary: reason === "chapter_committed"
      ? `第 ${chapter} 章已经定稿了，接着写只接还没定稿的章。要往这章里加内容，先在稿纸上改、再重新定稿。`
      : `第 ${chapter} 章还没有正文，没有可以接着写的。要从头写，就说「写第 ${chapter} 章」。`,
    refreshScope: "full",
  };
}

/** chapterGoal 不是作者原话：退回让 AI 原样抄或不填（在建快照、调模型之前，不花额度）。纯逻辑、可测。 */
export function buildGoalNotQuotedOutput(
  chapter: number,
  notFound: readonly string[],
  overview: StateOverview,
): GenerateDraftToolOutput {
  const shown = notFound.slice(0, 3).map((clause) => `「${clause.slice(0, 30)}」`).join("");
  return {
    ok: false,
    chapter,
    blockedReason: "chapter_goal_not_author_words",
    issues: notFound.map((clause) => `不是作者原话：${clause}`),
    overview,
    summary:
      `这次还没动笔：AI 填的本章方向里有不是你原话的句子${shown}。` +
      "AI 会改用你的原话（或不填方向、按故事现状往下推）再写。",
    refreshScope: "full",
  };
}

export const generateDraftTool = createTool({
  id: "generate_draft",
  description:
    "为某章写一版正文进工作稿（未定稿）。一次调用里完成：先拟章纲、按章纲翻前文写，字数不够接着写，写完自动核账，检出机器腔默认自动去味一轮。" +
    "核账核出的确定对不上会按前文改一轮再核；改完还剩的在 qualityPipeline.continuity 和 summary 里，原样转告让用户定，别说「已经一致」。" +
    "summary 里的「首稿核对」漏写、「去味后新漏」、字数不够都要如实转达。引擎拒稿会 ok:false，如实说没写成。章纲见 chapterPlan，转达时一两句话说这章写了什么。",
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
    const continuing = input.continueDraft === true;
    // 接着写就是接作者眼前这章，不往下一章推。
    const resolvedChapter = continuing ? resolvedFromInputOrContext : advancePastCommittedFrontier({
      explicitChapter,
      resolvedChapter: resolvedFromInputOrContext,
      resolvedCommitted: explicitChapter ? false : await isChapterCommitted(projectDir, resolvedFromInputOrContext),
      nextChapterCommitted: explicitChapter ? false : await isChapterCommitted(projectDir, resolvedFromInputOrContext + 1),
    });
    // 作者档的两道结构护栏（重构 P4，替代按作者原话猜意图的门）。按钮点出来的出稿带作者确认标记，不受这两道约束。
    const authorConfirmed = isUserConfirmedTool(context, "generate_draft");
    const chapterGoal = input.chapterGoal?.trim() || undefined;
    if (!authorConfirmed) {
      // A1 找原句：chapterGoal 是「作者给的方向」，必须逐句出自作者在这段对话里说过的话（不是对话通道调的就没得核，照用）。
      const authorWords = readAuthorWordsFromContext(context);
      if (chapterGoal && authorWords) {
        const quote = checkAuthorQuote(chapterGoal, authorWords);
        if (quote.notFound.length > 0) {
          const overview = await buildStateOverview({ projectDir, chapter: resolvedChapter, maxTimelineEvents: 8 });
          return buildGoalNotQuotedOutput(resolvedChapter, quote.notFound, overview);
        }
      }
      // A2 有稿不覆盖：这一章已有工作稿或已定稿，整章重写要作者点「重写这一章」。接着写不覆盖，不拦。
      const committedNow = continuing ? false : await isChapterCommitted(projectDir, resolvedChapter);
      if (!continuing && (committedNow || await hasWorkingDraftText(projectDir, resolvedChapter))) {
        const overview = await buildStateOverview({ projectDir, chapter: resolvedChapter, maxTimelineEvents: 8 });
        return buildRewriteAwaitingAuthorOutput(resolvedChapter, committedNow, overview, chapterGoal);
      }
    }
    // 接着写：已定稿的章不接（要改先改稿再定稿）；没正文没得接。读的是工作稿（作者眼前那份）。
    let continueText = "";
    if (continuing) {
      const blocked = await isChapterCommitted(projectDir, resolvedChapter)
        ? "chapter_committed" as const
        : !(await hasWorkingDraftText(projectDir, resolvedChapter)) ? "nothing_to_continue" as const : undefined;
      if (blocked) {
        const overview = await buildStateOverview({ projectDir, chapter: resolvedChapter, maxTimelineEvents: 8 });
        return buildContinueBlockedOutput(resolvedChapter, blocked, overview);
      }
      continueText = stripLeadingMarkdownChapterHeading(await readFile(defaultDraftPath(projectDir, resolvedChapter), "utf-8")).trim();
    }
    // 导入的书还在通读记账（P8）：账没记全，章纲员、核账员对照的前文是缺的，记完再出稿。
    const rereading = await rereadBlocker(projectDir, "出稿");
    if (rereading) {
      const overview = await buildStateOverview({ projectDir, chapter: resolvedChapter, maxTimelineEvents: 8 });
      return { ok: false, chapter: resolvedChapter, blockedReason: "rereading", issues: [rereading], overview, summary: rereading, refreshScope: "full" } as GenerateDraftToolOutput;
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
    // M6 + R4.2（D4 收敛后与 HTTP 非流式路同 helper 同语义）：写盘前建这一步的存档点——覆盖现有非空草稿
    // 用「再次出稿前」；首次出稿用「出稿：第N章」（首稿也是作者眼里的一步，撤销必须能撤它）。
    const snapshotId = await snapshotBeforeDraftOverwrite(
      projectDir,
      resolvedChapter,
      continuing ? `第${resolvedChapter}章接着写前快照` : `第${resolvedChapter}章再次出稿前快照`,
      `出稿：第${resolvedChapter}章`,
    );
    // 出稿流式：路由注入了 sink 就把正文 delta 逐字喂前端编辑器（带本次章号，前端只往当前章追）；缺失=不流式。
    const draftDeltaSink = readDraftDeltaSinkFromContext(context);
    // 多候选采样（第四层防坍缩）：N 个 writer 的 temperature 依次错开（基准 / ±0.15 / ±0.3——向上封顶 1.0，
    // 部分 provider 的 temperature 上限为 1 超了会被 400 拒；base 已 ≥0.85 时向上错不开会三版同温，
    // 改向下错开，见 resolveCandidateTemperatures），防 N 版同分布。采样不接 delta sink：
    // N 版正文逐字串进同一章编辑器会花屏，优胜稿落盘后由 refreshScope:"full" 一次性刷新。
    const candidateCount = !continuing && (input.candidates === 2 || input.candidates === 3) ? input.candidates : 1;
    // 接着写：稿纸上先推已写的那段，再接着推新写的字（原文不会在稿纸上消失再出现）。
    if (continuing && draftDeltaSink) draftDeltaSink({ chapter: resolvedChapter, text: `${continueText}\n\n`, base: true });
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
      // 只出一版且在流式时：重写一段、接下一段前换掉稿纸上已流出的字（多候选不流式）。
      ...(draftDeltaSink && candidateCount === 1
        ? { onStreamReset: (visible: string) => draftDeltaSink({ chapter: resolvedChapter, text: visible, replace: true }) }
        : {}),
      ...(chapterGoal ? { chapterGoal } : {}),
      ...(input.requestedDraftLength !== undefined ? { requestedDraftLength: input.requestedDraftLength } : {}),
      ...(continuing
        ? {
          continueFrom: {
            text: continueText,
            ...(input.requestedDraftLength && input.requestedDraftLength > 0 ? { length: input.requestedDraftLength } : {}),
            ...(chapterGoal ? { direction: chapterGoal } : {}),
          },
        }
        : {}),
      ...(input.selectedCharacters !== undefined ? { selectedCharacters: input.selectedCharacters } : {}),
      ...(input.selectedHookIds !== undefined ? { selectedHookIds: input.selectedHookIds } : {}),
      ...(input.mustHitBeats !== undefined ? { mustHitBeats: input.mustHitBeats } : {}),
      ...(input.maxTimelineEvents !== undefined ? { maxTimelineEvents: input.maxTimelineEvents } : {}),
      ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: true },
      // R4.2：出稿内部第二次落盘（自动去味/续写补字）不再各建存档点——本步的存档点已建（snapshotId），
      // 一次出稿在操作历史里就是一步，撤销一键退回这步之前。
      ...(snapshotId ? { preWriteSnapshotId: snapshotId } : {}),
      autoDeAi: autoDeAiEnabled,
      ...(deAiCallModel ? { deAiCallModel } : {}),
      candidates: candidateCount,
      ...(candidateWriterClients ? { candidateWriterClients } : {}),
      ...(candidateTemperatures ? { candidateTemperatures } : {}),
      // 判漏 AI 复核（默认开，零判漏零调用）：triage 任务槽。惰性解析——只有真有判漏、复核真被调用时
      // 才解析该槽；解析/调用失败在 adjudicateMissingBeats 里被接住 → 维持确定性结论 + unavailable 如实标注。
      beatAdjudicationCallModel: buildTriageBeatAdjudicationCallModel(),
      // 阶段 2「先想后写」：出稿前编辑部拟章纲（章纲员 chapterSteering 槽 → 核账员审）。拟不成如实进 summary、照旧出稿。
      plannerCallModel: callConfiguredPlannerModel,
      // 阶段 3：出稿后续写够字数（fastDraft 槽）+ 前后核对（核账员，qualityCheck 槽）+ 按核账改（repair 槽）。
      continueCallModel: callConfiguredContinueModel,
      continuityCheckCallModel: callConfiguredBrainModel,
      // 第八轮验收（旧核对，误报 35～57%）自动改了 32 句、18 句改出新毛病，那时停了自动改；2026-10-23 换成核账员的「确定」
      // + 核账卡「改这处」同一条改稿路，考卷 9 份稿每千字确定错 2.10 → 0.69、人工抽 22 处 17 处干净，恢复改一轮再核。
      continuityFixCallModel: callConfiguredFixModel,
      // 有章纲就按要点分前后两半写（字数在出稿时就够，少走事后续写）。
      segmentByPlan: true,
      writerClient,
      // 出稿阶段推给稿纸（拟章纲要一两分钟、稿纸空着，作者得知道 AI 在干什么）。
      ...(draftDeltaSink ? { onPhase: (phase: "plan" | "write" | "check") => draftDeltaSink({ chapter: resolvedChapter, text: "", phase }) } : {}),
    });
    // 投影：http 适配料（引擎原始报告/落盘全文/预算账本）不进 LLM 视野；rejection 仅 HTTP 执法策略产生、这里恒无。
    const { http: _httpProjection, rejection: _rejection, ...toolOutput } = outcome;
    // 只在真出稿成功时挂 snapshotId（失败=没写成稿，无需撤销点）；service 已把本步存档点带出来，这里兜底。
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
