import type { ChapterWorkflowState } from "../type-defs/workflow.js";

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
 *  - 读类/资料类等不改本章生命周期，返回 current。写稿、检查（核账 / 硬伤检查 / 内容审阅）是操作，见 flowAfterOperation。
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
    case "revise_draft":
      // 改稿：改了正文 → 草稿待打磨。
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
 * 写稿、检查做完了（写作版本 P2a：都是操作，不再是工具结果）：
 * - 写稿换上了工作稿 → 草稿待打磨（重写已定稿的章也一样：工作稿和定稿不一样了）；没换上的（作者期间改过稿、留成候选）不推进。
 * - 硬伤检查 / 内容审阅做完、本章还没定稿 → 已打磨、可考虑定稿。核账、查 AI 味不改本章生命周期。
 * 没做完的不推进。
 */
export function flowAfterOperation(
  operation: { readonly kind: string; readonly mode?: string; readonly state: string; readonly draft?: { readonly applied: boolean } },
  current: ChapterWorkflowState,
): ChapterWorkflowState {
  if (operation.state !== "succeeded") return current;
  if (operation.kind === "draft.change") return operation.draft?.applied ? "draft_ready" : current;
  if (operation.kind !== "inspect.run" || TERMINAL.has(current)) return current;
  return operation.mode === "quality" || operation.mode === "review" ? "quality_checked" : current;
}
