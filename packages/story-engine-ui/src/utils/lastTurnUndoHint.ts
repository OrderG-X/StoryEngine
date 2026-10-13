/**
 * 「撤销上一步」的整回合锚点（R7.2·报告 3.2）。
 *
 * 作者说「撤销上一步」，指的是上一回合 AI 做的全部改动；而服务端默认按「最近一个写盘工具步」回退，
 * 一回合改两处时只退回最后一处（一处撤了、一处还在）。前端每回合已经在 assistant 消息上记了
 * turnSnapshots（该回合每次写盘前的 git 快照，[0] = 回合第一次写盘前 = 整块回退点，与块级
 * 「撤销到此」同一锚点）。发送请求时把它带给后端，undo 工具优先整回合回退。
 *
 * 纯函数、无副作用。取「最后一个带写盘快照的回合」——中间隔了纯聊天回合照常往前找。
 */
import type { ChapterMessage } from "../types.js";

export interface LastTurnUndoHint {
  /** 上一个有写盘回合的 turnSnapshots[0]（该回合第一次写盘前的 git 快照 id）。 */
  readonly snapshotId: string;
  /** 该回合写盘改动的处数（turnSnapshots 条数），供回执「只撤了最后 1 处」时说清 N。 */
  readonly changes: number;
}

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/u;

/** 从对话消息里取上一个有写盘回合的首个快照；没有（纯聊天/新会话/旧数据 id 不合法）返回 undefined。 */
export function lastTurnUndoHintFromMessages(messages: readonly ChapterMessage[]): LastTurnUndoHint | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const snapshots = message.turnSnapshots ?? [];
    const first = snapshots[0];
    // 只认合法的 git commit id：旧会话里的异常数据不当作锚点，往前继续找。
    if (first && COMMIT_ID_PATTERN.test(first.snapshotId)) {
      return { snapshotId: first.snapshotId, changes: snapshots.length };
    }
  }
  return undefined;
}
