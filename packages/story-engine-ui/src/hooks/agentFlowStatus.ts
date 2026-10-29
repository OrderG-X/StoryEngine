import type { ChapterWorkflowState } from "../type-defs/workflow.js";
import { flowStatusAfterGenerateFailure } from "./reconcileChapterState.js";

/**
 * agentFlowStatusForTool — 纯 agent 流程里，据「刚完成的工具」把本章流程状态推进到对应阶段。
 *
 * 背景（2026-06-18 核查）：flowStatus 的中间阶段（steering_ready/quality_checked/
 * waiting_commit_confirmation 等）原本只有老 chip 路径（useWorkflowActions）才设，纯对话流程
 * 只能到 draft_ready/committed → 顶部流程地图半死。本函数让对话流程也能走完整 理解→写稿→打磨→入库。
 *
 * 题材中立、纯逻辑、无副作用：给 (toolName, info, current) → 下一个 flowStatus（不该推进就原样返回 current）。
 *  - ok===false（工具失败）不推进——绝不把失败当进度。
 *  - 已入库（committed/ready_for_next）后，打磨/预览类工具不再把状态往回拨。
 *  - 读类/资料类等不改本章生命周期，返回 current。检查（核账 / 硬伤检查 / 内容审阅）是操作，见 flowAfterOperation。
 */

const TERMINAL: ReadonlySet<ChapterWorkflowState> = new Set<ChapterWorkflowState>(["committed", "ready_for_next"]);

export function agentFlowStatusForTool(
  toolName: string,
  info: { readonly committed?: boolean; readonly ok?: boolean },
  current: ChapterWorkflowState,
): ChapterWorkflowState {
  const failed = info.ok === false;
  switch (toolName) {
    case "generate_chapter_steering":
      // 理解/构思：给了本章方向方案 → 进入「可以写稿」。
      return failed ? current : "steering_ready";
    case "generate_draft":
    case "revise_draft":
      // 写稿：出/改了正文 → 草稿待打磨。
      return failed ? current : "draft_ready";
    case "commit_preview":
      // 入库前一步：预览生成 → 等你确认入库。
      return failed || TERMINAL.has(current) ? current : "waiting_commit_confirmation";
    case "commit_apply":
      // 入库：真入库成功（committed=true 且未失败）才标已入库；失败/未入库保持原状（不推进）。
      // committed=true 本就蕴含成功，这里显式 && !failed 是为与其它分支一致 + 防御工具偶发字段不一致。
      return info.committed && !failed ? "committed" : current;
    default:
      return current;
  }
}

/**
 * nextFlowAfterToolResult — onToolResult 用：在 agentFlowStatusForTool 之上多管一件事——
 * 出稿工具返回 ok=false（守卫拒绝这类「诚实失败」走的是 tool-result，不是 tool-error）时，
 * flowStatus 还卡在 onToolCall 乐观置的 draft_generating，而 agentFlowStatusForTool 对失败一律返回
 * current=原样保留=继续卡在「正在生成草稿」（Codex 复测命中：「继续写下一章」被 25ms 守卫拒、标题/输入框卡死）。
 * 这里据当前章是否已有草稿内容把它复位（draft_ready/idle），绝不停在生成态谎报。其余一切照旧委托。
 */
export function nextFlowAfterToolResult(
  toolName: string,
  info: { readonly committed?: boolean; readonly ok?: boolean },
  current: ChapterWorkflowState,
  hasDraftContent: boolean,
): ChapterWorkflowState {
  if (toolName === "generate_draft" && info.ok === false) {
    const unstuck = flowStatusAfterGenerateFailure(current, hasDraftContent);
    if (unstuck) return unstuck;
  }
  return agentFlowStatusForTool(toolName, info, current);
}

/**
 * 检查做完了（写作版本 P2a：检查是操作，不再是工具结果）：硬伤检查 / 内容审阅做完、本章还没定稿 → 已打磨、可考虑定稿。
 * 核账、查 AI 味不改本章生命周期；没做完的不推进。
 */
export function flowAfterOperation(
  operation: { readonly kind: string; readonly mode?: string; readonly state: string },
  current: ChapterWorkflowState,
): ChapterWorkflowState {
  if (operation.kind !== "inspect.run" || operation.state !== "succeeded" || TERMINAL.has(current)) return current;
  return operation.mode === "quality" || operation.mode === "review" ? "quality_checked" : current;
}
