/**
 * undo_last_change — 对话里「撤销上一步」。
 *
 * 铁律②（唯一控制面=对 AI 说话）+ 封测前真机 E2E：用户对 AI 说「撤销/反悔/回退上一步」，AI 必须真能撤、
 * 或诚实回报撤不了——绝不拿选项卡搪塞（旧行为：读一圈状态后给 suggest_next_steps，根本没撤、也没承认）。
 *
 * 实现：恢复到「上一步写操作前的自动快照」（snapshot.undoLastChange）。每个写工具运行前都建检查点，
 * 故恢复到最近一个 differing 检查点即撤销上一步；连续撤销逐步回退；撤销本身也建快照、可再撤销，历史不丢。
 * 没有可撤销的改动时如实回报（undone:false），绝不谎称已撤销。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { withUiOverviewDetails } from "../../lib/project-io.js";
import { undoLastChange } from "../../lib/snapshot.js";
import { readProjectDirFromContext } from "../request-context.js";

const inputSchema = z.object({});

const outputSchema = z.object({
  ok: z.boolean(),
  undone: z.boolean().describe("是否真的撤销了一步（false=没有可撤销的改动，不是失败）。"),
  summary: z.string().describe("撤销结果的自然语言摘要，供回答用户。"),
  overview: z.unknown().describe("撤销后的 StateOverview，供前端刷新到回退后的状态。"),
  refreshScope: z.literal("full"),
});

export const undoLastChangeTool = createTool({
  id: "undo_last_change",
  description:
    "撤销上一步写操作（恢复到该操作前的自动快照）。当用户说「撤销 / 撤回 / 反悔 / 回退上一步 / 刚才那步不要了 / 取消刚才的入库/改动」时调用。" +
    "用户说一次「撤销上一步」就只调一次——撤一步就停下回报；用户明确要退几步（如「撤销最近三步」）才调几次。" +
    "连续调用会逐步往回退。撤销本身也会建快照、可再被撤销，历史不丢。" +
    "没有可撤销的改动时如实回报（undone:false）、绝不谎称已撤销；想回到更早的某个时间点可让用户用界面的快照列表挑。",
  inputSchema,
  outputSchema,
  execute: async (_input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("undo_last_change 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    const result = await undoLastChange(projectDir);
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 })
      .then((value) => withUiOverviewDetails(projectDir, value))
      .catch(() => undefined);
    if (!result) {
      return {
        ok: true,
        undone: false,
        summary: "没有可撤销的改动了（已经是最初状态）。如果想回到更早的某个时间点，可以在界面的快照列表里挑一个。",
        overview,
        refreshScope: "full" as const,
      };
    }
    return {
      ok: true,
      undone: true,
      summary: `已撤销上一步（${result.undoneLabel}），项目已回到该操作前的状态。只撤了这一步；还要往回退就再说一次，这步撤销本身也可以再撤销。`,
      overview,
      refreshScope: "full" as const,
    };
  },
});
