/**
 * revise_draft — 草稿局部修订工具：对工作稿里某段原文做「确定性替换」的局部改写。
 *
 * 双轨合一：编排（定位 → 预览 → 守卫 → 落盘）已收编进 services/revision-service.ts，
 * 与 routes/draft-revision.ts 的 preview→apply 两步路共享同一实现；本文件只做 Mastra 适配——
 * 入参 schema、上下文章号解析、覆盖前快照、输出契约（summary/refreshScope/draftBody）整形。
 *
 * 安全/诚实（铁律，全部由 service 的守卫承接，本路文案口径不变）：
 * - 原文须唯一命中：缺失/出现多次 → 诚实回报 applied:false，绝不写坏草稿、绝不谎称改了。
 * - 模型输出格式不全（缺 afterText）→ 解析抛错 → 诚实拒，applied:false。
 * 快照策略：草稿是「待保存」工作稿，不建 git 快照（同 generate_draft）；故用 createTool 而非 writeTool，
 *   output 不带 snapshotId。涉及草稿 → refreshScope:"full"。
 * - 题材中立：description / summary 用中性词。
 */
import {
  buildStateOverview,
  type DraftRevisionPreview,
  type StateOverview,
} from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceEnum, coerceNumber, coerceStringArray } from "./lenient-args.js";

import { stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { snapshotBeforeDraftOverwrite } from "./snapshot-on-draft-overwrite.js";
import {
  createRevisionModelChannel,
  reviseDraftOneShot,
  type RevisionOneShotFailure,
  type RevisionOneShotSuccess,
} from "../../services/revision-service.js";

// 定位器实现已收编进 revision-service（D21）；此处保留原名 re-export，供 de-ai-flavor-batch 等既有消费方不动。
export { locateRevisionSpan as locateTargetSpan } from "../../services/revision-service.js";
export type { RevisionTargetSpan } from "../../services/revision-service.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要修订的章号（工作稿所在章）。")),
  targetText: z.string().describe(
    "要修订的原文片段，必须**逐字**取自当前工作稿且在稿中只出现一次（确定性替换的锚点）。出现多次会被拒绝。",
  ),
  revisionGoal: z.string().describe("修订目标：希望把这段改成什么样（如『语气更克制』『补一个动作细节』）。"),
  // afterfix·精确替换：用户给了「替换成的确切文本」时带上它——工具会**原样落地、不再让模型改写**（治真机：
  // 模型拿到精确文本却自行改写成别的）。仅做精确 find-replace 时用；要 AI 改写/润色时省略，走模型路。
  replacementText: z.string().optional().describe(
    "可选：用户指定的【精确替换文本】。给了就把 targetText 原样替换成它（确定性、不调模型改写）；"
    + "用户说『把这句换成「……」』这种点名了确切新文本时填它。要 AI 自行改写/润色则不要填。",
  ),
  // 模型无关：枚举大小写宽容（模型传 "DeAI"/"DEAI" 不再硬失败）。
  style: coerceEnum(z.enum(["deai"]).optional().describe(
    "可选风格模板。deai=去 AI 味改写：自动注入去 AI 腔的写作手法（删空泛形容词/套路排比升华/被滥用的过渡抒情，改用具体动作与可感细节）。"
    + "用户看完 check_ai_flavor 体检后要求『改掉 AI 味/去 AI 腔』时，对命中句逐句调本工具并设 style:deai（仍一次一句、targetText 逐字取自草稿）。",
  )),
  problemSummary: z.string().optional().describe("可选：这段当前的问题一句话概括。"),
  constraints: coerceStringArray(z.array(z.string()).optional().describe("可选：修订约束（如『保留人物关系』『不新增剧情』）。")),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功修订并写回工作稿。"),
  applied: z.boolean().describe("是否真的把改动写进了草稿（诚实回报，未命中/格式不全时为 false）。"),
  preview: z.unknown().describe("修订预览（beforeText/afterText/改动说明等）。"),
  draftBody: z.string().optional().describe(
    "修订后的完整草稿正文（去 Markdown 章节标题）；成功时返回，供前端把真正文载入工作区（防占位覆盖+autosave 抹稿）。",
  ),
  overview: z.unknown().describe("修订后重新读取的 StateOverview，供前端刷新写作区/总览。"),
  summary: z.string().describe("修订结果的自然语言摘要。"),
  refreshScope: z.literal("full"),
  snapshotId: z.string().optional().describe("修订覆盖草稿前建的快照 id（M6：让修订可撤销）；未命中/未写回时无此值。"),
  chapter: z.number().int().positive().optional().describe("被修订草稿的章号。"),
});

export interface ReviseDraftToolOutput {
  readonly ok: boolean;
  readonly applied: boolean;
  readonly preview: DraftRevisionPreview;
  readonly draftBody?: string;
  readonly overview: StateOverview;
  readonly summary: string;
  readonly refreshScope: "full";
  readonly snapshotId?: string;
  readonly chapter?: number;
}

/** 守卫拒绝的用户可见文案（本路历史口径，逐条保持原字）。 */
function refusalReason(failure: RevisionOneShotFailure): string {
  switch (failure.code) {
    case "target_empty":
      return "修订任务缺少原文片段，请先指明要修的那段文字。";
    case "target_not_found":
      return "未在当前草稿中找到要修的原文片段，请逐字确认目标段落。";
    case "target_ambiguous":
      return "原文片段在草稿中出现多次，请改用更精确、只出现一次的片段。";
    case "exact_replacement_noop":
      return "给的替换文本与原句一致，等于没改；草稿未改动。";
    case "model_output_unusable":
      return `修订模型输出不可用，未改动草稿：${failure.detail ?? "未知错误"}`;
    case "before_text_not_found":
    case "before_text_ambiguous":
      return "模型回吐的原句没法在草稿里唯一定位，未改动草稿。请重试或把要改的原文说得更精确。";
    case "drift_rejected":
      return "模型改写的不是你指定的那段（它去动了别处），草稿未改动。请把要改的原文逐字说清，或重试。";
    case "noop":
      return "模型回吐的片段与原文一致，等于没有任何修改；草稿未改动。";
    case "target_unchanged":
      return "改写后你点名的那句仍原样留在草稿里，等于没真改到；草稿未改动。请重试或把要改的原文逐字说清。";
  }
}

/** 模型预览未产出时的兜底预览（拒绝输出的 preview 字段，保持原 refusal 内联构造的同构形状）。 */
function refusalFallbackPreview(failure: RevisionOneShotFailure, reason: string): DraftRevisionPreview {
  return {
    taskId: failure.task.id,
    beforeText: failure.task.targetText,
    afterText: failure.task.targetText,
    changeSummary: "未应用任何修改。",
    rationale: reason,
    riskNotes: [reason],
    preservedFacts: [],
    warnings: ["未应用任何修改。"],
  };
}

/** service 结果 → 工具输出契约（summary/draftBody/overview/refreshScope 整形，纯适配无编排）。 */
async function toToolOutput(
  projectDir: string,
  chapter: number,
  outcome: RevisionOneShotSuccess | RevisionOneShotFailure,
): Promise<ReviseDraftToolOutput> {
  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 });
  if (!outcome.ok) {
    const reason = refusalReason(outcome);
    return {
      ok: false,
      applied: false,
      preview: outcome.preview ?? refusalFallbackPreview(outcome, reason),
      overview,
      summary: `未修订：${reason}`,
      refreshScope: "full",
    };
  }
  return {
    ok: true,
    applied: true,
    preview: outcome.preview,
    // 修订后的完整草稿正文（去标题），供前端把真正文载入工作区，与 generate_draft 的 draftBody 同构。
    draftBody: stripLeadingMarkdownChapterHeading(outcome.updatedContent).trim(),
    overview,
    summary: outcome.mode === "exact"
      ? `已在第 ${chapter} 章工作稿上按你给的精确文本替换了该句。草稿未入库，可继续修改或撤销。`
      : `已在第 ${chapter} 章工作稿上完成局部修订：${outcome.preview.changeSummary}。草稿未入库，可继续修改或撤销。`,
    refreshScope: "full",
    chapter,
  };
}

/**
 * 纯逻辑入口（签名与行为保持收编前原样，供单测注入 callModel mock）：委托 service 一步路。
 * 守卫顺序：原文非空 → 稿中唯一（含空白/引号归一兜底）→ 精确替换快路 → 模型预览 →
 * 漂移/no-op/目标级守卫 → 写回。任何一步不满足都 applied:false 诚实回报、不写坏草稿。
 */
export async function runReviseDraftToolLogic(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly targetText: string;
  readonly revisionGoal: string;
  readonly style?: "deai";
  readonly problemSummary?: string;
  readonly constraints?: readonly string[];
  /** afterfix·精确替换：用户给的确切新文本——给了就原样落地、跳过模型改写。 */
  readonly replacementText?: string;
  readonly callModel: (prompt: string) => Promise<string>;
}): Promise<ReviseDraftToolOutput> {
  const outcome = await reviseDraftOneShot(input);
  return toToolOutput(input.projectDir, input.chapter, outcome);
}

export const reviseDraftTool = createTool({
  id: "revise_draft",
  description:
    "对某章工作稿里某段原文做局部修订（确定性替换：原文必须逐字取自草稿且只出现一次）。" +
    "当用户说『把这段改成…… / 修一下这一句 / 这段语气太冲，改克制点』时调用。" +
    "草稿是待保存的工作稿，不建 git 快照（改坏了走操作历史撤销）。原文未命中或出现多次会被拒绝、不写坏草稿。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "revise_draft 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("revise_draft 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    const channel = await createRevisionModelChannel();
    // M6：修订会覆盖现有草稿，覆盖前建快照让修订可撤销（修订必有非空草稿）。
    const snapshotId = await snapshotBeforeDraftOverwrite(projectDir, resolvedChapter, `第${resolvedChapter}章修订前快照`);
    const outcome = await reviseDraftOneShot({
      projectDir,
      chapter: resolvedChapter,
      targetText: input.targetText,
      revisionGoal: input.revisionGoal,
      ...(input.style !== undefined ? { style: input.style } : {}),
      ...(input.problemSummary !== undefined ? { problemSummary: input.problemSummary } : {}),
      ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
      ...(input.replacementText !== undefined ? { replacementText: input.replacementText } : {}),
      callModel: channel.call,
    });
    const result = await toToolOutput(projectDir, resolvedChapter, outcome);
    // 只在真改了草稿时挂 snapshotId（未命中/未写回=没覆盖，无需撤销点）。
    return result.ok && result.applied && snapshotId ? { ...result, snapshotId } : result;
  },
});
