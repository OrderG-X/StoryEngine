/**
 * read_state_overview — 读类工具：读取当前项目的状态总览。
 *
 * 当对话涉及「现在写到哪了 / 有哪些角色 / 世界设定 / 伏笔线索现状」时，
 * agent 必须调本工具拿真实数据，绝不凭空编造（铁律：绝不静默失败、引擎题材中立）。
 *
 * 读类工具不建快照、不带 snapshotId，只回 `refreshScope:"full"` 让前端整屏刷新。
 */
import { buildStateOverview } from "../../book/state-overview.js";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "../../lib/lenient-args.js";

import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { summarizeStateOverview } from "../overview-summary.js";

const inputSchema = z.object({
  focus: z.string().optional().describe("可选：想重点了解的方面，如『人物』『伏笔』『时间线』。"),
  chapter: coerceNumber(z.number().int().positive().optional().describe("可选：想看某一章的上下文时填章号；不填则用用户当前所在章（不是最新章）。")),
});

const outputSchema = z.object({
  summary: z.string().describe("当前状态的自然语言摘要，供回答用户。"),
  overview: z.unknown().describe("完整的 StateOverview 结构，供前端刷新左侧面板。"),
  refreshScope: z.literal("full"),
});

export const readStateOverviewTool = createTool({
  id: "read_state_overview",
  description:
    "读取当前项目的状态总览（写到第几章、有哪些人物、设定本有几张卡、活跃伏笔与线索、时间线）。" +
    "当用户询问当前进度/现状时，必须先调用本工具获取真实数据再回答，绝不凭空编造。设定本的具体内容用 read_foundation。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "read_state_overview 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    // H3：用户没点名某章时，按「用户当前所在章」建总览（而非引擎推断的最新章），
    // 否则用户回看第2章问『现在状态』会被总览/工作台拉到最新章。
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    const overview = await buildStateOverview({
      projectDir,
      ...(chapter !== undefined ? { chapter } : {}),
      maxTimelineEvents: 8,
    });
    return {
      summary: summarizeStateOverview(overview),
      overview,
      refreshScope: "full" as const,
    };
  },
});
