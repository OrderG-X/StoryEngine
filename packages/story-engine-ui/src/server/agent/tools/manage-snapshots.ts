/**
 * manage_snapshots —— 存档管理一个入口（2026-10-12 编辑部 R3b·对话 AI 瘦身）。
 *
 * 原来 undo_last_change / prune_snapshots 两个工具各占一份说明和参数。现在对话 AI 只看这一个，
 * 按 op 转给原来的工具执行——快照、撤销标签、裁剪授权守卫都是原工具的：
 * - undo：恢复到上一步写操作前的自动快照，连续撤销逐步回退，撤销本身也可再撤销；
 * - prune：两步哲学照旧——模型调用永远只预览（dry-run），真裁只认界面「确认裁剪」按钮的
 *   结构化动作（user-actions 直接执行原 prune_snapshots 工具，不经这里），裁前自动备份到项目目录外。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { coerceEnum, coerceNumber } from "./lenient-args.js";
import { pruneSnapshotsTool } from "./prune-snapshots.js";
import { undoLastChangeTool } from "./undo-last-change.js";

export const SNAPSHOT_OPS = ["undo", "prune"] as const;
export type SnapshotOp = (typeof SNAPSHOT_OPS)[number];

/** 原工具名（界面步骤名、撤销标签、按钮直达都认它）。 */
export const SNAPSHOT_OP_TOOL_NAMES: Record<SnapshotOp, string> = {
  undo: "undo_last_change",
  prune: "prune_snapshots",
};

const TOOLS: Record<SnapshotOp, { readonly execute?: unknown }> = {
  undo: undoLastChangeTool,
  prune: pruneSnapshotsTool,
};

const inputSchema = z.object({
  op: coerceEnum(z.enum(SNAPSHOT_OPS).describe(
    "undo=撤销上一步写操作；prune=把太长的操作历史裁到最近 keep 条（只预览，用户点「确认裁剪」按钮才真裁）。",
  )),
  keep: coerceNumber(z.number().int().nonnegative().optional().describe(
    "prune：保留最近多少条快照；省略或 0=默认 200。用户没提数量就别填。",
  )),
});

export const manageSnapshotsTool = createTool({
  id: "manage_snapshots",
  description:
    "管理存档：撤销=回退上一步写操作（用户说一次撤销就只调一次；没有可撤销的会如实说）；裁剪=把太长的操作历史折到最近 keep 条（正文资料不动，裁前自动备份）。你调用裁剪永远只预览，别说成已裁剪。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const execute = TOOLS[input.op].execute as ((args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>) | undefined;
    if (!execute) throw new Error(`存档操作「${input.op}」暂不可用。`);
    // 不透传 confirm：真裁只认按钮（原工具内部核对用户确认标记，模型自带的一律走预览）。
    const args: Record<string, unknown> = input.op === "prune" && input.keep ? { keep: input.keep } : {};
    const output = await execute(args, context);
    return output && typeof output === "object" && !Array.isArray(output)
      ? { ...(output as Record<string, unknown>), op: input.op }
      : output;
  },
});
