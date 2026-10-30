/**
 * change_history —— 撤销上一步、裁剪操作历史（写作版本 P2a 片 4C；收编 manage_snapshots）。和别的提交工具一样只交意图：
 * 宽进归一 → 交给执行器（history.change）→ 回受理回执，受理了这一轮就停。撤的是最近一次还没撤的改动；后来又改过的停下等作者点
 * 「全撤」，接着它写的东西还在就如实说撤不了。裁剪是作者的决定：交出去只算好，作者点「确认裁剪」才裁。整本恢复只在操作历史里点。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceEnum, coerceNumber } from "../../lib/lenient-args.js";
import { submitOperation } from "../../services/operations/executor.js";
import { HISTORY_CHANGE_KIND } from "../../services/operations/recipes/history-change.js";
import { readMessageRefFromContext, readProjectDirFromContext } from "../request-context.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const inputSchema = z.object({
  op: coerceEnum(z.enum(["undo", "prune"]).describe(
    "undo=撤销上一步（最近一次还没撤的改动）；prune=把太长的操作历史裁到最近 keep 条（作者点「确认裁剪」才裁）。",
  )),
  keep: coerceNumber(z.number().int().nonnegative().optional().describe("prune：保留最近多少条存档；省略或 0=默认 200。作者没提数量就别填。")),
});

export const changeHistoryTool = createTool({
  id: "change_history",
  description:
    "撤销上一步（作者说撤销 / 反悔 / 刚才那步不要了），或裁剪太长的操作历史（作者明说要裁时）。作者说一次撤销就只交一次。" +
    "撤的是最近一次还没撤的改动；作者要回到更早的某个时间点，请作者在顶栏「历史」里挑存档恢复。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：撤了什么、要作者点的卡都由系统接着说，你不用再说，绝不说『已撤销』『已裁剪』。一条作者消息只交一件事。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const outcome = await submitOperation(bookDir, {
      kind: HISTORY_CHANGE_KIND,
      mode: input.op,
      params: input.op === "prune" && input.keep ? { keep: input.keep } : {},
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId },
    });
    return receiptOf(outcome, "chat", { kind: HISTORY_CHANGE_KIND, mode: input.op });
  },
});
