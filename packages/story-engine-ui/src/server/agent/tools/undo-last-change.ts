/**
 * undo_last_change — 对话里「撤销上一步」。
 *
 * 铁律②（唯一控制面=对 AI 说话）+ 封测前真机 E2E：用户对 AI 说「撤销/反悔/回退上一步」，AI 必须真能撤、
 * 或诚实回报撤不了——绝不拿选项卡搪塞（旧行为：读一圈状态后给 suggest_next_steps，根本没撤、也没承认）。
 *
 * 实现：恢复到「上一步写操作前的自动快照」（snapshot.undoLastChange）。每个写工具运行前都建检查点，
 * 故恢复到最近一个 differing 检查点即撤销上一步；连续撤销逐步回退；撤销本身也建快照、可再撤销，历史不丢。
 * 没有可撤销的改动时如实回报（undone:false），绝不谎称已撤销。
 *
 * R4.2（验收 3.2）：回执必须写清**实际退回了什么**——恢复是把状态整个搬回存档点，超出「这一步」的
 * 后续写入也会一并退回；旧回执只说「只撤了这一步」，模型顺着编了句「第 5 章草稿没受影响」（假的）。
 * 现在 summary 列出退回清单（路径→人话），「这步之后写的」单独说明，并指明去「历史」页找回。
 *
 * R7.2（十章验收 3.2）：作者说「撤销上一步」指上一回合的全部改动。前端请求带「上一个有写盘回合的
 * 首个快照」（turnSnapshots[0]）时优先整回合回退；带不了/锚点失效时按原逻辑撤最后一个工具步，
 * 回执明说「上一回合改了 N 处，这次只退回了最后 1 处」，绝不留给模型编「都撤干净了」的空间。
 */
import { buildStateOverview } from "../../book/state-overview.js";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { withUiOverviewDetails } from "../../lib/project-io.js";
import { buildRestoreReceipt } from "../../lib/snapshot-changes.js";
import { undoLastChange } from "../../lib/snapshot.js";
import { readCharacterNameById } from "../presence/entity-labels.js";
import { readLastTurnUndoHintFromContext, readProjectDirFromContext } from "../request-context.js";

const inputSchema = z.object({});

const outputSchema = z.object({
  ok: z.boolean(),
  undone: z.boolean().describe("是否真的撤销了一步（false=没有可撤销的改动，不是失败）。"),
  summary: z.string().describe("撤销结果的自然语言摘要，供回答用户：撤了哪一步、实际退回了什么、去哪找回。"),
  overview: z.unknown().describe("撤销后的 StateOverview，供前端刷新到回退后的状态。"),
  refreshScope: z.literal("full"),
});

export const undoLastChangeTool = createTool({
  id: "undo_last_change",
  description:
    "撤销上一步写操作。用户说一次撤销就只调一次，明确要退几步才调几次。没有可撤销的就如实说（undone:false）。回执会列出实际退回的内容，回报时只说回执里列出的，别自己补。",
  inputSchema,
  outputSchema,
  execute: async (_input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("undo_last_change 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    // R7.2：前端带的「上一个有写盘回合的首个快照」——优先整回合回退（一回合改两处也全撤）。
    const turnHint = readLastTurnUndoHintFromContext(context);
    const result = await undoLastChange(projectDir, turnHint);
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 })
      .then((value) => withUiOverviewDetails(projectDir, value))
      .catch(() => undefined);
    if (!result) {
      return {
        ok: true,
        undone: false,
        summary: "没有可撤销的改动了（已经是最初状态）。如果想回到更早的某个时间点，可以在顶栏「历史」里挑一个存档恢复。",
        overview,
        refreshScope: "full" as const,
      };
    }
    // 路径→人话要认角色名；认不出（书读不了）就用空表，短语退到「角色卡资料」，绝不吐裸 id。
    const nameById = await readCharacterNameById(projectDir).catch(() => new Map<string, string>());
    let summary = buildRestoreReceipt({
      title: `已撤销上一步（${result.undoneLabel}）。`,
      reverted: result.reverted,
      revertedLater: result.revertedLater,
      nameById,
    });
    // 做不到整回合撤时如实说清（R7.2）：hint 说上一回合改了 N 处而本次只退回 1 处，绝不留给模型
    // 顺着「已撤销」编「都撤干净了」的空间。再说一次「撤销上一步」即可接着整回合回退（锚点仍在）。
    if (!result.viaTurnHint && turnHint && turnHint.changes > 1) {
      summary += `\n注意：上一回合共改了 ${turnHint.changes} 处，这次只退回了最后 1 处；要整回合回退，再说一次「撤销上一步」。`;
    }
    return {
      ok: true,
      undone: true,
      summary,
      overview,
      refreshScope: "full" as const,
    };
  },
});
