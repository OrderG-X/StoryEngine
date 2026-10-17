import type { ChapterWorkflowState } from "../type-defs/workflow.js";

/**
 * 出稿失败收尾：onToolCall(generate_draft) 把 flowStatus 置成「正在生成草稿」(draft_generating)，
 * 但失败路径(onToolError/onError/未捕获兜底)原本不复位 → 标题区卡在「正在生成草稿」=明明失败却谎称在生成
 * （违反诚实铁律）。纯函数判定该复位成什么：
 *   - 只在当前确实卡在 draft_generating 时才动（其它流程态的失败如实保留，不乱改）→ 否则返回 null。
 *   - 已有草稿内容（流式落了一截、或本就有旧草稿）→ draft_ready（有稿待保存，truthful）。
 *   - 一字未出 → idle（回到起点）。
 * 「盘上其实已入库但断流显失败」的特例另由 useChat 的回合收尾重读盘上真值兜（会把 draft_ready/idle 再升成 committed）。
 */
export function flowStatusAfterGenerateFailure(
  flowNow: ChapterWorkflowState,
  hasDraftContent: boolean,
): ChapterWorkflowState | null {
  if (flowNow !== "draft_generating") return null;
  return hasDraftContent ? "draft_ready" : "idle";
}
