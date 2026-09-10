/**
 * ai_review — 只读工具：对某章草稿做 AI 深度审稿（剧情/节奏/人物/对白/连续性/读者钩子），不改稿。
 *
 * 双轨合一：共享编排（取真草稿 → 确定性质检+上下文 → 组 prompt → callModel → 解析/回退）
 * 已收进 services/review-service.ts（与 routes/draft.ts 的 /api/draft/ai-review 同调）。
 * 本工具只剩适配层：RequestContext 取 projectDir/章号回退 + 用户可见 summary 投影（D20 输出面）。
 * 策略参数由本适配层显式声明：trustExplicit 默认 false（不信模型给的正文、盘稿优先，D19）。
 *
 * 只读：不写盘、不建快照、不带 snapshotId / refreshScope。
 * 题材中立 / 诚实回报：直接摊出审稿报告与 usedFallback 标志，不掩盖「审稿未完成」。
 */
import type { DraftAIReviewReport } from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "./lenient-args.js";

import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { runDraftAIReview } from "../../services/review-service.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要审稿的章号。")),
  draftContent: z.string().optional().describe("可选：直接给出要审的草稿正文；省略时读取该章工作稿文件。"),
  chapterGoal: z.string().optional().describe("可选：本章目标/方向，作为审稿参照。"),
  userDirection: z.string().optional().describe("可选：用户对本章的额外要求，作为审稿参照。"),
});

const outputSchema = z.object({
  chapter: z.number().int().positive(),
  // ok=审稿是否真审成。走安全回退（usedFallback）= 没真审成 → ok:false → 前端显红，不再假装绿「已完成」（治 A5）。
  ok: z.boolean().describe("审稿是否真正完成（走安全回退 usedFallback 时为 false，诚实不掩盖审稿未完成）。"),
  review: z.unknown().describe("审稿报告（评分/裁决/优点/问题清单/各维度笔记/是否建议入库）。"),
  usedFallback: z.boolean().describe("是否因模型不可用/输出不合规走了安全回退（诚实标注，不掩盖审稿未完成）。"),
  summary: z.string().describe("审稿结论的自然语言摘要。"),
});

export interface AIReviewToolOutput {
  readonly chapter: number;
  readonly ok: boolean;
  readonly review: DraftAIReviewReport;
  readonly usedFallback: boolean;
  readonly summary: string;
}

/**
 * 工具适配层：调共享 service 拿 canonical result，投影成工具输出（chapter/ok/review/usedFallback/summary）。
 * callModel 作为参数透传给 service（单测注入桩、不触网）；真实 execute 不传，由 service 走 draftReview 槽。
 */
export async function buildAIReviewToolOutput(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent?: string;
  readonly chapterGoal?: string;
  readonly userDirection?: string;
  readonly callModel?: (prompt: string) => Promise<string>;
  readonly retries?: number;
  readonly delayMs?: number;
}): Promise<AIReviewToolOutput> {
  const result = await runDraftAIReview({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(input.draftContent !== undefined ? { explicitDraftContent: input.draftContent } : {}),
    ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
    ...(input.userDirection !== undefined ? { userDirection: input.userDirection } : {}),
    ...(input.callModel !== undefined ? { callModel: input.callModel } : {}),
    ...(input.retries !== undefined ? { retries: input.retries } : {}),
    ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
  });
  return {
    chapter: result.chapter,
    ok: result.ok,
    review: result.review,
    usedFallback: result.usedFallback,
    summary: result.summary,
  };
}

export const aiReviewTool = createTool({
  id: "ai_review",
  description:
    "对某章草稿做 AI 深度审稿（剧情/节奏/人物/对白/连续性/读者钩子），给出评分、裁决、问题清单与修改建议，不修改任何文件。" +
    "当用户问『帮我深度审一下这章 / 这章写得怎么样 / 有哪些可以改进』时调用。" +
    "审稿不改稿、不入库；模型不可用时会诚实标注审稿未完成，不假装通过。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "ai_review 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("ai_review 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    return buildAIReviewToolOutput({
      projectDir,
      chapter: resolvedChapter,
      ...(input.draftContent !== undefined ? { draftContent: input.draftContent } : {}),
      ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
      ...(input.userDirection !== undefined ? { userDirection: input.userDirection } : {}),
    });
  },
});
