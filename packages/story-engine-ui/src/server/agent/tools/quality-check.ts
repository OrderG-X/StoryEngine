/**
 * quality_check — 只读工具：对某章草稿做入库前质量检查（确定性规则 + AI 判定），不改稿。
 *
 * 双轨合一：共享编排（取真草稿 → checkDraftBeforeCommit → judge → refined）已收进
 * services/quality-service.ts（与 routes/draft.ts 的 /api/draft/quality 同调）。本工具只剩适配层：
 * RequestContext 取 projectDir/章号回退 + ok/partialMiss/refined/summary 的工具输出投影（D15）。
 * 策略参数由本适配层显式声明：trustExplicit 默认 false（不信模型给的正文，D14）、
 * onNoDraft "honest_short_circuit"（无稿诚实短路，D16）。
 *
 * 只读：不写盘、不建快照、不带 snapshotId / refreshScope（不动磁盘，前端无需刷新面板）。
 * 题材中立 / 诚实回报：直接摊出引擎的质检报告，不夸大也不掩盖问题。
 */
import type { CommitQualityReport } from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "./lenient-args.js";

import type { RefinedQualityReport } from "../../lib/quality-report-refine.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { runDraftQualityCheck, type QualityJudge } from "../../services/quality-service.js";

export { resolveDraftContentForQualityCheck } from "../../services/quality-service.js";
export type { QualityJudge } from "../../services/quality-service.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要质检的章号。")),
  draftContent: z.string().optional().describe("可选：直接给出要质检的草稿正文；省略时读取该章工作稿文件。"),
});

const outputSchema = z.object({
  chapter: z.number().int().positive(),
  // ok=工具是否跑成（检查本身完成即 true）；partialMiss=有阻止级问题（投影成琥珀「部分完成」而非绿「已完成」，
  // 治「质检没通过却显绿、假装全好」A5）。真正的失败（草稿缺失等）走 throw、由上层显红。
  ok: z.boolean().describe("质检工具是否成功执行（跑完即 true；草稿缺失等会 throw 而非 ok:false）。"),
  partialMiss: z.boolean().describe("草稿存在阻止级问题（errorIssueCount>0）→ true，前端显「部分完成」琥珀态、不显绿。"),
  passed: z.boolean().describe("是否通过质检（无未消解的 error 级问题）。"),
  quality: z.unknown().describe("完整质检报告（确定性问题 + AI 判定）。"),
  refined: z.unknown().describe("分层降噪后的报告：硬伤(拦)/软提示(参考)/参考/已降级，每项带中文标签。"),
  errorIssueCount: z.number().int().nonnegative().describe("error 级问题数（会阻止定稿）。"),
  summary: z.string().describe("质检结果的自然语言摘要（已分层降噪）。"),
});

export interface QualityCheckToolOutput {
  readonly chapter: number;
  readonly ok: boolean;
  readonly partialMiss: boolean;
  readonly passed: boolean;
  readonly quality: CommitQualityReport;
  readonly refined: RefinedQualityReport;
  readonly errorIssueCount: number;
  readonly summary: string;
}

/** 三处都没真稿时的诚实输出：明确「还没正文可质检」，不把空/占位符喂引擎误报「正文为空/过短」（铁律④诚实回报）。 */
function buildNoDraftQualityOutput(result: {
  readonly chapter: number;
  readonly quality: CommitQualityReport;
  readonly refined: RefinedQualityReport;
}): QualityCheckToolOutput {
  return {
    chapter: result.chapter,
    ok: true,
    partialMiss: true,
    passed: false,
    quality: result.quality,
    refined: result.refined,
    errorIssueCount: result.refined.blocking.length,
    summary: `第 ${result.chapter} 章还没有可质检的正文（工作稿为空或还没生成）。请先生成本章正文，再来质检。`,
  };
}

/**
 * 工具适配层：调共享 service（显式策略：不信模型正文 + 无稿诚实短路），再投影工具输出面。
 * judge 作为参数透传给 service：真实 execute 用默认 judgeDraftQualityWithModel；单测注入桩避免触网。
 */
export async function buildQualityCheckToolOutput(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent?: string;
  readonly judge?: QualityJudge;
  readonly retries?: number;
  readonly delayMs?: number;
}): Promise<QualityCheckToolOutput> {
  const { projectDir, chapter } = input;
  const result = await runDraftQualityCheck({
    projectDir,
    chapter,
    onNoDraft: "honest_short_circuit",
    ...(input.draftContent !== undefined ? { explicitDraftContent: input.draftContent } : {}),
    ...(input.judge !== undefined ? { judge: input.judge } : {}),
    ...(input.retries !== undefined ? { retries: input.retries } : {}),
    ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
  });
  if (!result.hasRealDraft) {
    return buildNoDraftQualityOutput(result);
  }

  const { quality, refined } = result;
  const errorIssueCount = refined.blocking.length;

  // 铁律④·绝不静默失败：AI 语义判定层走 fallback（超时/网络失败/输出不合规）时，确定性规则照常出结论，
  // 但必须诚实披露「AI 语义判定本轮未完成」——否则 agent 会把它当『通过、可入库』转告，掩盖判定层没跑。
  const aiJudgeFallbackNote = quality.modelJudge?.fallbackUsed === true
    ? "（注意：AI 语义判定本轮未完成，仅按确定性规则分级；可重试或切换质检模型再判一次）"
    : "";

  return {
    chapter,
    ok: true, // 跑到这里=质检确实执行完了（无稿已在上面诚实短路、不到这里）
    // 有阻止级硬伤、或 AI 判定 confirmed+high 的严重问题(severe)→琥珀「部分完成」，不再假装绿「已完成」
    // （afterfix：severe 虽不硬拦入库，但绝不让质检步骤显绿误导用户以为全好了）。
    partialMiss: errorIssueCount > 0 || refined.severe.length > 0,
    passed: refined.passed,
    quality,
    refined,
    errorIssueCount,
    summary: `第 ${chapter} 章质检：${refined.summary}${aiJudgeFallbackNote}`,
  };
}

export const qualityCheckTool = createTool({
  id: "quality_check",
  description:
    "对某章工作稿做定稿前质量检查（确定性规则 + AI 判定），不修改任何文件。" +
    "当用户问『这章工作稿有没有问题 / 能定稿吗 / 帮我检查一下质量』时调用（用户旧说法「草稿/入库」也指同一件事）。" +
    "返回质检报告（含 error 级阻止项），但不改稿、不定稿。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "quality_check 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("quality_check 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    return buildQualityCheckToolOutput({
      projectDir,
      chapter: resolvedChapter,
      ...(input.draftContent !== undefined ? { draftContent: input.draftContent } : {}),
    });
  },
});
