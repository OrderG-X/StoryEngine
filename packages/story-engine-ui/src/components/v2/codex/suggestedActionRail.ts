import type { ChapterMessage } from "../../../types.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";

/**
 * 「建议动作」条数据（A-6 修复）：把消息上的 suggestedActions 从死渲染面救活。
 *
 * 此前 codex 壳里只有错误卡的 retry-agent 有入口，诚实补丁的「重新确认定稿」、资料写入结果上的
 * 「撤销本次修改」、待确认写入的「确认写入资料/确认删除」全都挂在消息上却零渲染，作者只能照文字重打指令。
 *
 * 取数口径：**最后一轮**（最后一条用户消息之后）所有 assistant 消息携带的动作——
 * 回合一翻新动作自动换位，旧回合的动作不再残留误导。按 id+endpoint 去重、保持时间正序。
 * retry-agent 除外：它在气泡内错误卡（AgentErrorCard）已有就地入口。
 * 纯函数、无 React 依赖。
 */

/** 在气泡内已有就地入口、不进建议条的动作 id。 */
const RAIL_EXCLUDED_ACTION_IDS: ReadonlySet<string> = new Set(["retry-agent"]);

export function latestTurnSuggestedActions(messages: readonly ChapterMessage[]): readonly SuggestedAction[] {
  // 先定回合边界：最后一条用户消息之后 = 最后一轮。
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      turnStart = i + 1;
      break;
    }
  }
  const collected: SuggestedAction[] = [];
  const seen = new Set<string>();
  // 正序扫最后一轮的 assistant 消息：按 id+endpoint 去重（动作由同一构建器产出，重复项内容一致）。
  for (let i = turnStart; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const action of message.suggestedActions ?? []) {
      if (RAIL_EXCLUDED_ACTION_IDS.has(action.id)) continue;
      const key = `${action.id}::${action.endpoint ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(action);
    }
  }
  return collected;
}
