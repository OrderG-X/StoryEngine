/**
 * manage_threads —— 线索管理一个入口（2026-10-10 引擎升级第 5 期·对话 AI 瘦身）。
 *
 * 原来 4 个工具（收口单条 / 清理垃圾与字面重复 / 语义归并 / 大小分级）各占一份说明。现在对话 AI 只看这一个，
 * 按 op 转给原来的工具执行——快照、撤销标签、写前守卫（清理/归并要用户原话有这个意思）都是原工具的。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { groupRelatedLeadsTool } from "./group-related-leads.js";
import { cleanLegacyThreadsTool } from "./legacy-thread-cleanup.js";
import { blankToUndefined, coerceEnum } from "./lenient-args.js";
import { resolveThreadTool } from "./resolve-thread.js";
import { setForeshadowingImportanceTool } from "./set-foreshadowing-importance.js";

export const THREAD_OPS = ["resolve", "clean", "group", "importance"] as const;
export type ThreadOp = (typeof THREAD_OPS)[number];

/** 原工具名（界面步骤名、撤销标签、诚实检测都认它）。 */
export const THREAD_OP_TOOL_NAMES: Record<ThreadOp, string> = {
  resolve: "resolve_thread",
  clean: "clean_legacy_threads",
  group: "group_related_leads",
  importance: "set_foreshadowing_importance",
};

const TOOLS: Record<ThreadOp, { readonly execute?: unknown }> = {
  resolve: resolveThreadTool,
  clean: cleanLegacyThreadsTool,
  group: groupRelatedLeadsTool,
  importance: setForeshadowingImportanceTool,
};

const inputSchema = z.object({
  op: coerceEnum(z.enum(THREAD_OPS).describe(
    "resolve=用户说某一条已经完结，按标题收这一条（多条匹配会返回候选）；clean=清理垃圾碎片和字面重复（不调模型）；" +
      "group=把措辞不同但讲同一件事的线索归并成一条（调模型）；importance=把某条定为大伏笔或小线索。",
  )),
  query: blankToUndefined(z.string().optional().describe("resolve：要收口的线索标题或关键词。")),
  id: blankToUndefined(z.string().optional().describe("importance：伏笔或线索的 id（先 read_state_overview 取）。")),
  importance: coerceEnum(z.enum(["major", "minor"]).optional().describe("importance：major=大伏笔，minor=小线索。")),
});

export const manageThreadsTool = createTool({
  id: "manage_threads",
  description: "管理伏笔线索：收口单条、清理、归并、调大小。写前自动存档、可撤销。清理和归并只在用户明确要时做，绝不自己顺手跑。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const execute = TOOLS[input.op].execute as ((args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>) | undefined;
    if (!execute) throw new Error(`线索操作「${input.op}」暂不可用。`);
    if (input.op === "resolve" && !input.query) {
      return { ok: false, summary: "要收哪一条？请说出那条线索的标题或关键词。", op: input.op };
    }
    if (input.op === "importance" && (!input.id || !input.importance)) {
      return { ok: false, summary: "调大小要知道是哪一条、调成大伏笔还是小线索。", op: input.op };
    }
    const args: Record<string, unknown> = input.op === "resolve"
      ? { query: input.query }
      : input.op === "importance"
        ? { id: input.id, importance: input.importance }
        : {};
    const output = await execute(args, context);
    return output && typeof output === "object" && !Array.isArray(output)
      ? { ...(output as Record<string, unknown>), op: input.op }
      : output;
  },
});
