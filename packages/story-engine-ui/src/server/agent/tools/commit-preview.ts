/**
 * commit_preview — 只读工具：预览把某章草稿入库会产生哪些变更，并做入库前质量门槛检查。
 *
 * 双轨合一（第二波·commit 簇）：共享编排（锁内 recover → 读草稿 → 声明通道 → 建计划 →
 * 质检 → 事务身份）已收进 services/commit-service.ts（与 routes/commit.ts 的
 * /api/commit/preview 同调 runCommitPreview）。本工具只剩适配层：
 *   - RequestContext 取 projectDir/章号回退 + zod schema；
 *   - 显式策略参数：declarationChannel（D7，生产路径带 declareDelta 声明模型通道）+
 *     judge 注入确定性透传桩（D6，工具预览不调判定模型）；
 *   - canonical result 的工具投影（D8/D9）：issues 裁三元组、名字漂移/待收口/声明被拒/衔接
 *     提醒组装、blockingReasons/canCommit 判定、summary/modelHint 文案；
 *   - previewToken 登记（commit-preview-store 的所有权在本适配层）：canCommit 时把
 *     (项目, 章节, 草稿哈希, 声明) 登记成 previewToken，供 commit_apply 守卫「必须先预览过且草稿未变」。
 * 读类工具不建快照、不带 snapshotId。
 */
import type { ChapterDeltaDeclaration, NameDriftFinding } from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "./lenient-args.js";

import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import {
  runCommitPreview,
  type CommitPreviewDeclareDelta,
} from "../../services/commit-service.js";
import { callConfiguredDeclareModel, declareChapterDelta } from "./chapter-delta-declaration.js";
import { hashDraftContent, recordCommitPreview } from "./commit-preview-store.js";

/**
 * 预览阶段生成章节语义声明的注入点（单测可传假实现；缺省=不声明，走引擎正则）。
 * 类型的真家在 services/commit-service.ts（CommitPreviewDeclareDelta），此处保留别名兼容。
 */
export type DeclareDeltaFn = CommitPreviewDeclareDelta;

/** 生产用：调用配置模型声明本章语义；任何失败 → undefined（非致命，降级到引擎正则）。 */
const defaultDeclareDelta: DeclareDeltaFn = async ({ chapter, draft, openThreadTitles, establishedNames, openGoalTitles, previousChapterEnding }) =>
  declareChapterDelta({
    chapter,
    draft,
    callModel: callConfiguredDeclareModel,
    ...(openThreadTitles ? { openThreadTitles } : {}),
    ...(establishedNames ? { establishedNames } : {}),
    ...(openGoalTitles ? { openGoalTitles } : {}),
    ...(previousChapterEnding ? { previousChapterEnding } : {}),
  });

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要预览入库的章号。")),
});

const outputSchema = z.object({
  chapter: z.number().int().positive(),
  ok: z.boolean().describe(
    "统一诚实成功标志：等于 canCommit。false=本章暂不可定稿（缺工作稿/计划不通过/有 error 级问题）。" +
      "前端据此把时间线步骤置 failed，避免「想定稿却不可定稿」被显示成绿色完成（谎报）。",
  ),
  canCommit: z.boolean().describe("是否可以定稿（计划构建通过 + 质量检查无 error 级问题）。"),
  previewToken: z.string().optional().describe("预览通过时签发的一次性令牌；commit_apply 可省略它，由系统使用最近一次有效预览票据。canCommit=false 时省略。"),
  plan: z.unknown().describe("定稿计划（角色/伏笔/线索/时间线等将发生的变更）。"),
  draftQualityIssues: z.array(z.object({
    severity: z.string(),
    type: z.string(),
    message: z.string(),
  })).describe("工作稿定稿前的确定性质量检查问题（error 级会阻止定稿）。"),
  semanticQualityIssues: z.array(z.object({
    severity: z.string(),
    type: z.string(),
    message: z.string(),
  })).describe("定稿计划语义质量检查问题（含 type=character_name_drift 的人物名近形漂移 warning）。"),
  nameConsistencyWarnings: z.array(z.object({
    establishedName: z.string(),
    driftedVariant: z.string(),
    message: z.string(),
  })).describe(
    "人物名一致性提醒：本章出现的名字与已确立角色名形近、疑似写歪（引擎确定性判定，非模型主观）。" +
      "必须原样转达给用户、不得淡化为『有意设计/无关紧要』；这是写前一致性护栏，不阻断定稿。",
  ),
  staleThreadWarnings: z.array(z.object({
    kind: z.string(),
    title: z.string(),
    lastTouchedChapter: z.number().int().nonnegative(),
    chaptersSinceTouched: z.number().int().nonnegative(),
    message: z.string(),
  })).describe(
    "伏笔/线索/目标待收口提醒（引擎确定性判定 + 里程碑制：新停滞头两章提醒、长期停滞每 10 章重提一次，" +
      "不会每章重复刷全量；全量底数见 summary 的 digest）。kind 含 伏笔/线索/主线目标/阶段目标。" +
      "必须原样转达给用户、不得淡化——这是防『埋了不收、开了没下文』的遗漏护栏，只提示、不阻断定稿。",
  ),
  blockingReasons: z.array(z.string()).describe("阻止定稿的原因（工作稿缺失/计划不通过/存在 error 级质量问题等）。"),
  summary: z.string().describe("预览结果的自然语言摘要（用户可见文案，UI 会直接展示；不含内部工具名）。"),
  modelHint: z.string().optional().describe("给你（模型）的行动指引：下一步流程与转达要求。仅你可见，UI 不展示。"),
});

export interface StaleThreadWarningView {
  readonly kind: string;
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
}

export interface CommitPreviewToolOutput {
  readonly chapter: number;
  readonly ok: boolean;
  readonly canCommit: boolean;
  readonly previewToken?: string;
  readonly plan: unknown;
  readonly draftQualityIssues: { severity: string; type: string; message: string }[];
  readonly semanticQualityIssues: { severity: string; type: string; message: string }[];
  readonly nameConsistencyWarnings: { establishedName: string; driftedVariant: string; message: string }[];
  readonly staleThreadWarnings: StaleThreadWarningView[];
  readonly blockingReasons: string[];
  readonly summary: string;
  /** 给模型的行动指引（下一步调 commit_apply、转达要求）；UI 不渲染，summary 保持用户可见纯净。 */
  readonly modelHint?: string;
}

/**
 * 工具适配层：调共享 service 拿 canonical result，投影成工具输出；canCommit 时登记 previewToken。
 * 读草稿失败（缺草稿）→ canCommit=false，blockingReasons 含 missing_draft，不发 token（D8 工具渲染）。
 */
export async function buildCommitPreviewToolOutput(input: {
  readonly projectDir: string;
  readonly chapter: number;
  /**
   * 可选：生成本章语义声明的函数。传入时（生产路径）在预览阶段算一次声明，随 previewToken 缓存供 apply 复用；
   * 不传（纯逻辑单测/无模型环境）→ declaration=undefined，完全走引擎正则（旧行为）。
   */
  readonly declareDelta?: DeclareDeltaFn;
}): Promise<CommitPreviewToolOutput> {
  const result = await runCommitPreview({
    projectDir: input.projectDir,
    chapter: input.chapter,
    // D7 显式策略：工具路带声明通道（声明上下文收集 + 声明喂计划 + 名册进计划）。
    declarationChannel: { ...(input.declareDelta ? { declareDelta: input.declareDelta } : {}) },
    // D6 显式策略：工具预览只跑引擎确定性检查，不调判定模型（透传桩）。
    judge: async ({ deterministicQuality }) => deterministicQuality,
  });
  if (result.kind === "no_draft") {
    return {
      chapter: result.chapter,
      ok: false,
      canCommit: false,
      plan: undefined,
      draftQualityIssues: [],
      semanticQualityIssues: [],
      nameConsistencyWarnings: [],
      staleThreadWarnings: [],
      blockingReasons: ["missing_draft"],
      summary: `第 ${result.chapter} 章还没有工作稿，无法生成定稿预览。`,
    };
  }

  const { projectDir, chapter } = input;
  const { commitPlan, draftQuality, semanticQuality, declaration } = result;

  const draftQualityIssues = draftQuality.issues.map((issue) => ({
    severity: issue.severity,
    type: issue.type,
    message: issue.message,
  }));
  const baseSemanticQualityIssues = (semanticQuality?.issues ?? []).map((issue) => ({
    severity: issue.severity,
    type: issue.type,
    message: issue.message,
  }));
  const deltaRejectedWarnings = collectDeltaRejectedWarnings(commitPlan);

  // 人物名近形漂移：引擎的确定性发现（结构化）升级成明确 warning，别让模型在回执里把它说软或说没。
  // severity=warning（不阻断入库），type 固定为 character_name_drift，供 UI 固定展示、供模型忠实转述。
  const nameDriftFindings: readonly NameDriftFinding[] = commitPlan.nameDriftFindings ?? [];
  const nameConsistencyWarnings = nameDriftFindings.map((finding) => ({
    establishedName: finding.establishedName,
    driftedVariant: finding.driftedVariant,
    message: `人物名疑似写歪：本章出现「${finding.driftedVariant}」，与已确立角色「${finding.establishedName}」形近。请确认应写作「${finding.establishedName}」，还是「${finding.driftedVariant}」确为另一个角色。`,
  }));
  const continuityBreakWarning = collectContinuityBreakWarning(declaration);
  // 伏笔/线索/目标待收口：引擎按里程碑制（新停滞头两章 + 长期停滞每 10 章重提）确定性选出本章该提醒的条目，
  // 这里合并成一份结构化提醒（含 r7 新接入的停滞目标——此前 staleGoalWarnings 从没到过用户面前），
  // 升级成带类型的 warning，供 UI 固定展示 + 模型忠实转达。全量底数走 staleBacklog 进 digest，绝不静默。题材中立。
  const staleThreadWarnings = collectStaleThreadWarnings(commitPlan);
  const staleBacklog = readStaleBacklog(commitPlan);
  const semanticQualityIssues = [
    ...baseSemanticQualityIssues,
    ...deltaRejectedWarnings,
    ...nameConsistencyWarnings.map((warning) => ({
      severity: "warning",
      type: "character_name_drift",
      message: warning.message,
    })),
    ...staleThreadWarnings.map((warning) => ({
      severity: "warning",
      type: warning.kind.includes("目标") ? "stale_arc_goal" : "stale_thread",
      message: warning.message,
    })),
    ...(continuityBreakWarning ? [continuityBreakWarning] : []),
  ];

  const blockingReasons: string[] = [];
  if (!commitPlan.passed || !commitPlan.commitPlan) {
    blockingReasons.push("commit_plan_not_passed");
    blockingReasons.push(...commitPlan.issues);
  }
  if (draftQualityIssues.some((issue) => issue.severity === "error")) {
    blockingReasons.push("draft_quality_error");
  }
  if (semanticQualityIssues.some((issue) => issue.severity === "error")) {
    blockingReasons.push("semantic_quality_error");
  }

  const canCommit = blockingReasons.length === 0;
  let previewToken: string | undefined;
  if (canCommit) {
    // previewToken 内存 store 的所有权在本适配层（D7 机制外皮）：登记草稿哈希 + 预览声明，供 apply 守卫/复用。
    const record = recordCommitPreview({
      projectDir,
      chapter,
      draftHash: hashDraftContent(result.draftContent),
      ...(declaration ? { declaration } : {}),
    });
    previewToken = record.token;
  }

  const preview = buildPreviewSummary({
    chapter,
    canCommit,
    blockingReasons,
    nameConsistencyWarnings,
    staleThreadWarnings,
    staleBacklog,
    deltaRejectedWarnings,
    continuityBreakWarning,
  });
  return {
    chapter,
    ok: canCommit,
    canCommit,
    ...(previewToken ? { previewToken } : {}),
    plan: commitPlan,
    draftQualityIssues,
    semanticQualityIssues,
    nameConsistencyWarnings,
    staleThreadWarnings,
    blockingReasons,
    summary: preview.summary,
    ...(preview.modelHint ? { modelHint: preview.modelHint } : {}),
  };
}

function collectDeltaRejectedWarnings(commitPlan: { readonly issues?: readonly string[] }): { severity: "warning"; type: "delta_rejected"; message: string }[] {
  return (commitPlan.issues ?? [])
    .filter((issue) => issue.startsWith("章节语义声明被拒（"))
    .map((message) => ({
      severity: "warning",
      type: "delta_rejected",
      message,
    }));
}

function collectContinuityBreakWarning(declaration: ChapterDeltaDeclaration | undefined): { severity: "warning"; type: "continuity_break"; message: string } | undefined {
  const continuity = declaration?.continuityWithPrevious;
  if (!continuity || continuity.connects !== false) return undefined;
  const note = continuity.note?.trim();
  return {
    severity: "warning",
    type: "continuity_break",
    message: `本章开头与上一章结尾疑似衔接断裂${note ? `：${note}` : ""}。请确认这是有意的时间跳转，还是需要改稿补足承接。`,
  };
}

interface PlanStaleWarningLike {
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message?: string;
  readonly scope?: string;
}

/**
 * 从 commit plan 收集「伏笔/线索/目标待收口」提醒，合并成一份带中文文案的结构化视图。
 * 伏笔=staleHookWarnings、线索=staleThreadWarnings、目标=staleGoalWarnings（r7 新接入——此前目标停滞从没提醒过用户，
 * 主线「查明师父真相」停 14 章无人知晓）。引擎已按里程碑制选好该提醒的条目并给了中文 message（含主线升级文案），
 * 这里只做归类 + 去重排序，绝不重算、绝不改写引擎判词。
 */
function collectStaleThreadWarnings(commitPlan: {
  readonly staleHookWarnings?: readonly PlanStaleWarningLike[];
  readonly staleThreadWarnings?: readonly PlanStaleWarningLike[];
  readonly staleGoalWarnings?: readonly PlanStaleWarningLike[];
}): StaleThreadWarningView[] {
  const toView = (kind: string) => (warning: PlanStaleWarningLike): StaleThreadWarningView => ({
    kind,
    title: warning.title,
    lastTouchedChapter: warning.lastTouchedChapter,
    chaptersSinceTouched: warning.chaptersSinceTouched,
    message: warning.message?.trim()
      ? warning.message
      : `${kind}「${warning.title}」已经 ${warning.chaptersSinceTouched} 章没有推进（上次出现在第 ${warning.lastTouchedChapter} 章）。考虑在本章推进或收口，别让它埋了不收。`,
  });
  const merged = [
    ...(commitPlan.staleHookWarnings ?? []).map(toView("伏笔")),
    ...(commitPlan.staleThreadWarnings ?? []).map(toView("线索")),
    ...(commitPlan.staleGoalWarnings ?? []).map((warning) =>
      toView(warning.scope === "main_arc" ? "主线目标" : "阶段目标")(warning),
    ),
  ];
  // 同名去重（伏笔/线索池偶有重叠标题），保留 chaptersSinceTouched 更大的那条（更该提醒），再按停滞最久排前。
  const byKey = new Map<string, StaleThreadWarningView>();
  for (const view of merged) {
    const key = `${view.kind}|${view.title}`;
    const existing = byKey.get(key);
    if (!existing || view.chaptersSinceTouched > existing.chaptersSinceTouched) byKey.set(key, view);
  }
  return [...byKey.values()].sort((a, b) => b.chaptersSinceTouched - a.chaptersSinceTouched);
}

interface StaleBacklogView {
  readonly count: number;
  readonly oldestChaptersSinceTouched?: number;
}

/** 全书停滞线索底数（引擎 hygiene report 提供，不做里程碑过滤）——digest 用它报真话，降噪≠静默。 */
function readStaleBacklog(commitPlan: {
  readonly threadHygieneReport?: {
    readonly staleWarningCount?: number;
    readonly oldestStaleChaptersSinceTouched?: number;
  };
}): StaleBacklogView {
  const report = commitPlan.threadHygieneReport;
  const count = typeof report?.staleWarningCount === "number" ? report.staleWarningCount : 0;
  return {
    count,
    ...(typeof report?.oldestStaleChaptersSinceTouched === "number"
      ? { oldestChaptersSinceTouched: report.oldestStaleChaptersSinceTouched }
      : {}),
  };
}

/**
 * 预览摘要（工具确定性产出），拆两份（2026-08-11 真机走查：summary 曾把「需定稿时调用 commit_apply」
 * 和「请如实转达」这类模型指令原样端到 UI 实时字幕上，泄漏内部工具名，违反铁律④）：
 *  - summary：给用户看的事实文案（UI 实时字幕/步骤卡直接展示）——不出现内部工具名、不出现「请转达」类
 *    模型指令。警示内容本身保留：即便模型偷懒不展开 nameConsistencyWarnings，这句固定摘要也会把
 *    「名字疑似写歪」摆到台面上。
 *  - modelHint：给模型看的行动指引（下一步调用 commit_apply、警示须如实转达勿淡化）。模型读的是完整
 *    工具输出 JSON，指引不丢；UI 不渲染该字段。agent instructions 里另有同款流程铁律兜底。
 */
function buildPreviewSummary(input: {
  readonly chapter: number;
  readonly canCommit: boolean;
  readonly blockingReasons: readonly string[];
  readonly nameConsistencyWarnings: readonly { readonly establishedName: string; readonly driftedVariant: string }[];
  readonly staleThreadWarnings: readonly StaleThreadWarningView[];
  readonly staleBacklog?: StaleBacklogView;
  readonly deltaRejectedWarnings?: readonly { readonly message: string }[];
  readonly continuityBreakWarning?: { readonly message: string };
}): { readonly summary: string; readonly modelHint?: string } {
  const base = input.canCommit
    ? `第 ${input.chapter} 章可以定稿：定稿影响预览已生成、质量检查通过。说「确认定稿」即可写入。`
    : `第 ${input.chapter} 章暂不可定稿：${input.blockingReasons.join("；")}。`;
  let summary = base;
  if (input.nameConsistencyWarnings.length > 0) {
    const detail = input.nameConsistencyWarnings
      .map((warning) => `「${warning.driftedVariant}」疑似应为已确立角色「${warning.establishedName}」`)
      .join("；");
    summary += `【人物名一致性提醒】${detail}。请确认是否写错名字。`;
  }
  // r7：逐条只列本章该提醒的（引擎里程碑制已选好，最多再截 5 条防刷屏）；全量底数一行报真话（降噪≠静默）。
  const backlogCount = input.staleBacklog?.count ?? 0;
  if (input.staleThreadWarnings.length > 0 || backlogCount > 0) {
    const visibleWarnings = input.staleThreadWarnings.slice(0, 5);
    const detail = visibleWarnings
      .map((warning) => `${warning.kind}「${warning.title}」已 ${warning.chaptersSinceTouched} 章没推进`)
      .join("；");
    const backlogNote = backlogCount > 0
      ? `全书共 ${backlogCount} 条线索超 3 章未推进${
        input.staleBacklog?.oldestChaptersSinceTouched !== undefined
          ? `（最旧已停 ${input.staleBacklog.oldestChaptersSinceTouched} 章）`
          : ""
      }，需要批量处理可对我说『清理旧线索』或『归并相关线索』。`
      : "";
    summary += `【伏笔/线索待收口】${detail ? `本章提醒：${detail}。` : ""}${backlogNote}`;
  }
  if ((input.deltaRejectedWarnings?.length ?? 0) > 0) {
    const detail = input.deltaRejectedWarnings
      ?.slice(0, 3)
      .map((warning) => warning.message)
      .join("；");
    summary += `【章节语义声明被拒】${detail}。已回退安全路径处理。`;
  }
  if (input.continuityBreakWarning) {
    summary += `【跨章衔接提醒】${input.continuityBreakWarning.message}`;
  }
  const hints: string[] = [];
  if (input.canCommit) {
    hints.push("用户明确确认定稿后再调用 commit_apply 正式写入（可省略 token，系统用最近一次有效预览票据）；未确认前不得自行定稿。");
  }
  if (summary !== base) {
    hints.push("summary 里【】内的提醒须如实转达给用户，勿淡化、勿隐去。");
  }
  return { summary, ...(hints.length > 0 ? { modelHint: hints.join(" ") } : {}) };
}

export const commitPreviewTool = createTool({
  id: "commit_preview",
  description:
    "预览把某章工作稿正式定稿会产生的变更，并做定稿前的质量门槛检查（不修改任何文件）。" +
    "当用户想把某章定稿、或想知道定稿会带来哪些状态变更时，先调用本工具。" +
    "预览通过会返回 previewToken；正式定稿必须随后调用 commit_apply。commit_apply 可省略 token，由系统使用最近一次有效预览票据。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "commit_preview 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("commit_preview 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    return buildCommitPreviewToolOutput({ projectDir, chapter: resolvedChapter, declareDelta: defaultDeclareDelta });
  },
});
