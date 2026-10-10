/**
 * generate_chapter_steering — 只读工具：为下一章生成一份「剧情方案」（建议清单 + 本章目标预览）。
 *
 * 双轨合一：共享编排（校验方向 → buildChapterSteeringDraft → canonical result）已收进
 * services/steering-service.ts（与 routes/chapter-steering.ts 同调）。本工具只剩适配层：
 * RequestContext 取 projectDir/章号回退（D26 输入面）+ 用户可见 summary（D27 输出面）。
 * 引擎能力是确定性的（writesState:false），本工具同样只读：不调模型、不写盘、不建快照、
 * 不带 snapshotId / refreshScope。
 *
 * 铁律：
 * - 题材中立：description / summary 用中性词，不注入任何题材假设。
 * - 绝不静默失败 / 绝不谎报：缺方向时诚实拒绝（ok:false），不编造方案。
 */
import type {
  ChapterSteeringDraft,
  ChapterSteeringPacing,
  ChapterSteeringRevealLevel,
} from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceEnum, coerceNumber, coerceStringArray, positiveOrUndefined } from "./lenient-args.js";

import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { runChapterSteering } from "../../services/steering-service.js";

const PACINGS = ["slow", "medium", "fast"] as const;
const REVEAL_LEVELS = ["none", "small", "large"] as const;

const inputSchema = z.object({
  userDirection: z.string().describe("用户对这章的方向（必填）。"),
  chapter: coerceNumber(z.number().int().positive().optional().describe("章号；省略=按进度推断。")),
  pacing: coerceEnum(z.enum(PACINGS).optional().describe("节奏，默认 medium。")),
  revealLevel: coerceEnum(z.enum(REVEAL_LEVELS).optional().describe("揭示程度，默认 small。")),
  mustInclude: coerceStringArray(z.array(z.string()).optional().describe("必须包含的要素。")),
  mustAvoid: coerceStringArray(z.array(z.string()).optional().describe("必须避开的内容。")),
  maxSuggestions: coerceNumber(z.number().int().nonnegative().optional().describe("一般不填。")),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功生成方案。缺方向等输入问题时为 false。"),
  draft: z.unknown().optional().describe("剧情方案：建议清单 + 本章目标预览 + 资料上下文提醒；ok=false 时省略。"),
  summary: z.string().describe("方案要点的自然语言摘要，供回答用户。"),
});

export interface ChapterSteeringToolOutput {
  readonly ok: boolean;
  readonly draft?: ChapterSteeringDraft;
  readonly summary: string;
}

/**
 * 工具适配层：调共享 service 拿 canonical draft，再加用户可见 summary（D27）。
 * 只读：不写盘、不建快照。缺方向 → ok:false、不编造。
 */
export async function buildChapterSteeringToolOutput(input: {
  readonly projectDir: string;
  readonly userDirection: string;
  readonly chapter?: number;
  readonly pacing?: ChapterSteeringPacing;
  readonly revealLevel?: ChapterSteeringRevealLevel;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly maxSuggestions?: number;
}): Promise<ChapterSteeringToolOutput> {
  const maxSuggestions = positiveOrUndefined(input.maxSuggestions);
  const result = await runChapterSteering({
    projectDir: input.projectDir,
    userDirection: input.userDirection,
    ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
    ...(input.pacing !== undefined ? { pacing: input.pacing } : {}),
    ...(input.revealLevel !== undefined ? { revealLevel: input.revealLevel } : {}),
    ...(input.mustInclude !== undefined ? { mustInclude: input.mustInclude } : {}),
    ...(input.mustAvoid !== undefined ? { mustAvoid: input.mustAvoid } : {}),
    ...(maxSuggestions !== undefined ? { maxSuggestions } : {}),
  });
  if (!result.ok) {
    return { ok: false, summary: "下一章方向不能为空，请先告诉我这一章想往哪个方向走。" };
  }

  const draft = result.draft;
  return {
    ok: true,
    draft,
    summary:
      `已为${draft.chapter ? `第 ${draft.chapter} 章` : "下一章"}生成剧情方案：` +
      `${draft.suggestions.length} 条剧情建议${
        draft.suggestions.length > 0 ? `（${draft.suggestions.slice(0, 4).map((s) => s.title).join("、")}）` : ""
      }。本章目标预览：${draft.generatedChapterGoalPreview}`,
  };
}

export const generateChapterSteeringTool = createTool({
  id: "generate_chapter_steering",
  description:
    "为下一章生成一份剧情方案：基于项目真实状态（伏笔/线索/主线目标/角色/地点/风险）给出可选的剧情建议清单，" +
    "并合成本章目标预览（只读，不写任何文件、不定稿）。当用户说『下一章怎么写 / 给我下一章的方案 / 帮我规划下一章』时调用。" +
    "需要把方案落实成正文请随后调用 generate_draft。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "generate_chapter_steering 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    return buildChapterSteeringToolOutput({
      projectDir,
      userDirection: input.userDirection,
      ...(resolvedChapter !== undefined ? { chapter: resolvedChapter } : {}),
      ...(input.pacing !== undefined ? { pacing: input.pacing } : {}),
      ...(input.revealLevel !== undefined ? { revealLevel: input.revealLevel } : {}),
      ...(input.mustInclude !== undefined ? { mustInclude: input.mustInclude } : {}),
      ...(input.mustAvoid !== undefined ? { mustAvoid: input.mustAvoid } : {}),
      ...(positiveOrUndefined(input.maxSuggestions) !== undefined ? { maxSuggestions: positiveOrUndefined(input.maxSuggestions) } : {}),
    });
  },
});
