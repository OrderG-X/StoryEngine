/**
 * manage_ledger —— 账本管理一个入口（2026-10-12 编辑部 R3b·对话 AI 瘦身）。
 *
 * 原来 edit_fact_ledger（硬事实增删改/标记取代）和 manage_threads（线索收口/清理/归并/调大小）
 * 两个工具各占一份说明和参数。现在对话 AI 只看这一个，两套 op 合流：
 * - add / update / remove / supersede = 硬事实（story/fact-ledger.json）；
 * - resolve / clean / group / importance = 伏笔线索。
 * 按 op 转给原来的工具执行——快照、撤销标签、写前守卫（清理/归并要用户原话有这个意思）都是原工具的。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { groupRelatedLeadsTool } from "./group-related-leads.js";
import { cleanLegacyThreadsTool } from "./legacy-thread-cleanup.js";
import { blankToUndefined, coerceEnum, coerceNumber } from "./lenient-args.js";
import { resolveThreadTool } from "./resolve-thread.js";
import { setForeshadowingImportanceTool } from "./set-foreshadowing-importance.js";
import { editFactLedgerTool } from "./edit-fact-ledger.js";

export const LEDGER_OPS = [
  "add",
  "update",
  "remove",
  "supersede",
  "resolve",
  "clean",
  "group",
  "importance",
] as const;
export type LedgerOp = (typeof LEDGER_OPS)[number];

/** 原工具名（界面步骤名、撤销标签、诚实检测都认它）。 */
export const LEDGER_OP_TOOL_NAMES: Record<LedgerOp, string> = {
  add: "edit_fact_ledger",
  update: "edit_fact_ledger",
  remove: "edit_fact_ledger",
  supersede: "edit_fact_ledger",
  resolve: "resolve_thread",
  clean: "clean_legacy_threads",
  group: "group_related_leads",
  importance: "set_foreshadowing_importance",
};

const FACT_OPS: readonly LedgerOp[] = ["add", "update", "remove", "supersede"];

const TOOLS: Record<LedgerOp, { readonly execute?: unknown }> = {
  add: editFactLedgerTool,
  update: editFactLedgerTool,
  remove: editFactLedgerTool,
  supersede: editFactLedgerTool,
  resolve: resolveThreadTool,
  clean: cleanLegacyThreadsTool,
  group: groupRelatedLeadsTool,
  importance: setForeshadowingImportanceTool,
};

const inputSchema = z.object({
  // 模型无关：枚举大小写宽容（模型常传 "Add"/"REMOVE"）。
  op: coerceEnum(z.enum(LEDGER_OPS).describe(
    "硬事实：add 新增；update 改（id+text）；remove 删（id）；supersede=某设定从某章起变了（targetText 或 id + chapter）。" +
      "线索：resolve=收口完结的单条线索；clean=清理碎片和字面重复；group=归并讲同一件事的线索；importance=定大伏笔或小线索。",
  )),
  id: blankToUndefined(z.string().optional().describe(
    "update/remove/supersede 的硬事实条目 id（形如 fact-7-0）；importance 的线索 id（先 read_state_overview 取）。别念给用户听。",
  )),
  chapter: coerceNumber(z.number().int().positive().optional().describe(
    "add 时该事实属于第几章；supersede 时=从第几章起失效（通常填用户当前所在章）。",
  )),
  text: blankToUndefined(z.string().optional().describe("add/update 的事实内容（一句话、具体可核对）。")),
  targetText: blankToUndefined(z.string().optional().describe(
    "supersede 时：要取代的那条旧事实的描述/关键词（如『资金被冻结』），系统据此找到它，无需你知道 id。",
  )),
  supersededByFactId: blankToUndefined(z.string().optional().describe("supersede 时可选：被哪条新事实取代（登记演进链）。")),
  query: blankToUndefined(z.string().optional().describe("resolve：要收口的线索标题或关键词。")),
  importance: coerceEnum(z.enum(["major", "minor"]).optional().describe("importance：major=大伏笔，minor=小线索。")),
});

export const manageLedgerTool = createTool({
  id: "manage_ledger",
  description:
    "记账：硬事实的增/删/改/标记取代（只记客观已确认的事实，台词里的威胁猜测不当事实记）；伏笔线索的收口/清理/归并/调大小（op 见参数）。写前自动存档、可撤销。清理和归并只在用户明确要时做，绝不自己顺手跑。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const execute = TOOLS[input.op].execute as ((args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>) | undefined;
    if (!execute) throw new Error(`账本操作「${input.op}」暂不可用。`);
    if (input.op === "resolve" && !input.query) {
      return { ok: false, summary: "要收哪一条？请说出那条线索的标题或关键词。", op: input.op };
    }
    if (input.op === "importance" && (!input.id || !input.importance)) {
      return { ok: false, summary: "调大小要知道是哪一条、调成大伏笔还是小线索。", op: input.op };
    }
    const args: Record<string, unknown> = FACT_OPS.includes(input.op)
      ? {
        op: input.op,
        ...(input.id ? { id: input.id } : {}),
        ...(input.chapter ? { chapter: input.chapter } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.targetText ? { targetText: input.targetText } : {}),
        ...(input.supersededByFactId ? { supersededByFactId: input.supersededByFactId } : {}),
      }
      : input.op === "resolve"
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
