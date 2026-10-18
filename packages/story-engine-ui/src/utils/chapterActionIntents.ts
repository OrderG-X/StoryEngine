/**
 * 结构化动作的对话回显文案，以及「写这一章」的默认目标。
 *
 * 重构 P4 起：按钮直接发结构化动作（utils/chapterButtons.ts），输入框的字一律交给 AI——
 * 不再拿「文字等于按钮文案」认回按钮动作（原 matchDeterministicChapterAction 和那一串按钮文案常量已删）。
 */

// 「写这一章」按钮直写时的题材中立默认目标：用户没填方向、也没整理方案时，按现有资料/已写章节自然推进，
// 直接出稿——绝不因「没方向」落到「方案整理失败」旧链路（Kimi/Qwen 两轮真机都中：点按钮→方案整理失败）。
// 题材中立（铁律③）：不预设任何题材/世界观，让引擎据项目真实资料写。
export const DIRECT_WRITE_FALLBACK_GOAL = "依据现有故事资料、已写章节与写作规则，自然承接并写出本章正文。";

/** 「写这一章」按钮解析本章目标：有显式方向/方案就用它（trim），空则用题材中立默认目标，**永不返回空**。 */
export function resolveDirectWriteChapterGoal(explicit: string, fallback: string = DIRECT_WRITE_FALLBACK_GOAL): string {
  return explicit.trim() || fallback;
}

/**
 * 结构化动作（按钮、「下一步」选项）点击后落在对话里的「你：…」一句话——动作本身经 body.action 直达服务端，
 * 这句只是对话里给作者看的回显。
 */
export function userActionChoiceText(
  action: import("../api/agentChatClient.js").AgentUserAction,
  /** 「写这一章」照作者挑中的走法写时，那种走法的名字（回显里写明照哪种写）。 */
  directionTitle?: string,
): string {
  switch (action.toolName) {
    case "commit_preview":
      return `预览第 ${action.chapter} 章的定稿改动`;
    case "check_continuity":
      return action.fresh ? `再核一遍第 ${action.chapter} 章的账` : `核第 ${action.chapter} 章的账`;
    case "generate_draft":
      return directionTitle ? `照「${directionTitle}」写第 ${action.chapter} 章的正文` : `写第 ${action.chapter} 章的正文`;
    case "commit_apply":
      return `确认定稿第 ${action.chapter} 章`;
    case "prune_snapshots":
      return action.keep ? `确认裁剪操作历史（保留最近 ${action.keep} 条）` : "确认裁剪操作历史";
    case "ledger_decision":
      return action.label ? `确认改账：${action.label}` : "确认改账";
    case "foundation_decision":
      return action.label ? `确认改设定：${action.label}` : "确认改设定";
    case "ai_review":
      return `审阅第 ${action.chapter} 章的内容`;
    case "quality_check":
      return `对第 ${action.chapter} 章做硬伤检查`;
    case "undo":
      return "撤销上一步";
    case "revise_draft":
      return action.fixes.length === 1
        ? `改第 ${action.chapter} 章这一处：「${action.fixes[0]!.targetText}」`
        : `改掉第 ${action.chapter} 章这 ${action.fixes.length} 处`;
    case "brainstorm_chapter":
      return action.avoid?.length
        ? `第 ${action.chapter} 章再来几种走法${action.idea ? `：${action.idea}` : ""}`
        : `想想第 ${action.chapter} 章往哪走${action.idea ? `：${action.idea}` : ""}`;
  }
}
