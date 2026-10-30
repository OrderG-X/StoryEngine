import type { ChapterMessage } from "../../../types.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";
import { isRestoreNote } from "../../../utils/restoreNote.js";

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
  // 先定回合边界：最后一条用户消息之后 = 最后一轮；之后在操作历史里恢复过，那一轮的动作也不再算。
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" || isRestoreNote(messages[i])) {
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

/** 建议条最多露几个（再多就是整张流程菜单，和下面的快捷条重复，作者反而不知道点哪个）。 */
export const RAIL_MAX_VISIBLE = 3;

/** 作者档确认按钮：AI 只提议、作者点了服务端才执行，AI 的话里会叫作者「点按钮」，所以有「下一步」选项时也得在。 */
const AUTHOR_CONFIRM_ACTION_IDS: ReadonlySet<string> = new Set([
  "rewrite-confirm",
  "continue-confirm",
]);

/**
 * 建议条实际显示的动作：只留现在能点的（禁用的是「现在还不能做」，摆出来只是噪音），最多 3 个。
 * 通用流程菜单是按写作进度从前往后排的，超出时留最后几个（往前推进的那几步）。
 * besideNextStep：这一轮已有「下一步」选项，只留作者档确认按钮（其余和选项重复）。
 */
export function visibleRailActions(actions: readonly SuggestedAction[], besideNextStep = false): readonly SuggestedAction[] {
  const enabled = actions.filter((action) => !action.disabledReason && (!besideNextStep || AUTHOR_CONFIRM_ACTION_IDS.has(action.id)));
  return enabled.length > RAIL_MAX_VISIBLE ? enabled.slice(-RAIL_MAX_VISIBLE) : enabled;
}
