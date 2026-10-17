/**
 * 章节「只读分析」按钮的确定性意图（R3#1）。
 *
 * 内容审阅 / 硬伤检查 是只读分析（不改状态），但靠「发 NL 给模型猜工具」三轮封测都不可靠——模型经常改口或纯文字回答。
 * 这里把这两个按钮的中文意图固化成常量，useChat 收到**完全相同**的文本时直接调对应的确定性 handler
 * （handleDraftAIReview / handleQualityCheck，只读、已渲染进时间线），不再过模型。100% 可靠、且不违反铁律②
 * （铁律②只管「写」按钮不得绕过对话；只读分析确定性直调不算旁路写入）。
 *
 * 注意：只拦**精确等于**按钮常量的文本——用户自己打字「审一下这章」仍走 agent 对话链路（保留上下文交流），
 * 只有点按钮发出的固定文案才被确定性接管。检查机器腔暂不在此（无现成只读 handler），仍走 agent + 诚实守卫兜底。
 *
 * 术语人话化（2026-07-12）：主常量用新口径；LEGACY_* 保留旧会话/旧习惯文案，matcher 新旧都放行。
 */
export const REVIEW_BUTTON_INTENT = "审阅这一章的内容，给我评分和改进建议";
/** @deprecated 旧「审稿」按钮文案；老会话 suggestedAction / 用户习惯仍须命中 */
export const LEGACY_REVIEW_BUTTON_INTENT = "审一下这一章的稿，给我评分和改进建议";

export const QUALITY_BUTTON_INTENT = "对这一章做硬伤检查，列出硬伤";
/** @deprecated 旧「质检」按钮文案 */
export const LEGACY_QUALITY_BUTTON_INTENT = "对这一章做质检，列出硬伤";

// 「✎ 写这一章」按钮 = 写本章草稿这一固定动作，确定性直调 handleGenerateDraft（写的是 drafts/fast 工作稿、
// 可撤销、与 agent 工具读同一份草稿文件，无内存票据接缝），不再靠模型 NL 猜（R5 首次点击常不触发 generate_draft）。
export const DRAFT_BUTTON_INTENT = "写这一章的正文";
// 「定稿」按钮 = 定稿流程入口：结构化动作直达服务端执行 commit_preview 工具（2026-10-10 起，和核账同一通道）。
// 原先发给对话 AI、由它决定调 commit_preview，每次要等它想 30～100 秒（作者自写验收实测）。
// 仍是同一个工具、同一个进程内票据 store，所以不会有 R4 那种 REST 预览的票据接缝（R5 P1-4：REST 路和工具路票据不通）。
export const COMMIT_PREVIEW_BUTTON_INTENT = "预览这一章的定稿改动";
/** 「核账」按钮：拿这一章对前文原文找对不上的地方（只读、确定性直达，不经模型猜）。作者直接打「核账」也走这条。 */
export const CHECK_CONTINUITY_BUTTON_INTENT = "核账：拿这一章对一遍前文，看有没有前后对不上的地方";
/** 正文没改时核账直接给上次结果；作者想多找找就点这个——重新核，上次的问题照样带上（越核越全）。 */
export const CHECK_CONTINUITY_FRESH_INTENT = "再细核一遍：这一章重新对一遍前文";
/** @deprecated 旧「入库」预览按钮文案 */
export const LEGACY_COMMIT_PREVIEW_BUTTON_INTENT = "预览这一章的入库改动";

// 「写这一章」按钮直写时的题材中立默认目标：用户没填方向、也没整理方案时，按现有资料/已写章节自然推进，
// 直接出稿——绝不因「没方向」落到「方案整理失败」旧链路（Kimi/Qwen 两轮真机都中：点按钮→方案整理失败）。
// 题材中立（铁律③）：不预设任何题材/世界观，让引擎据项目真实资料写。
export const DIRECT_WRITE_FALLBACK_GOAL = "依据现有故事资料、已写章节与写作规则，自然承接并写出本章正文。";

/** 「写这一章」按钮解析本章目标：有显式方向/方案就用它（trim），空则用题材中立默认目标，**永不返回空**。 */
export function resolveDirectWriteChapterGoal(explicit: string, fallback: string = DIRECT_WRITE_FALLBACK_GOAL): string {
  return explicit.trim() || fallback;
}

export type DeterministicChapterAction =
  | "ai_review"
  | "quality_check"
  | "generate_draft"
  | "check_continuity"
  | "check_continuity_fresh"
  | "commit_preview";

/** 定稿预览的几种固定说法：按钮、旧按钮、已定稿空态的按钮、核账后的下一步选项「预览第 N 章的定稿改动」。 */
const COMMIT_PREVIEW_TEXTS = new Set(["预览这一章的定稿改动", "预览这一章的入库改动", "生成定稿预览", "预览定稿"]);

/**
 * 文本完全等于某个【固定动作】按钮常量 → 返回其确定性动作；否则 null（交给 agent 对话链路）。
 * 只确定性接管：内容审阅/硬伤检查（只读）、写这一章（写工作稿、无票据接缝）。
 * 定稿预览（2026-10-10 起）也在此：前端发结构化动作，服务端直接跑 commit_preview 工具（票据照登记）；开书资料（开放式多实体）仍走 agent。
 * 新旧意图常量都放行（术语迁移兼容）。
 */
export function matchDeterministicChapterAction(text: string): DeterministicChapterAction | null {
  const trimmed = text.trim();
  if (trimmed === REVIEW_BUTTON_INTENT || trimmed === LEGACY_REVIEW_BUTTON_INTENT) return "ai_review";
  if (trimmed === QUALITY_BUTTON_INTENT || trimmed === LEGACY_QUALITY_BUTTON_INTENT) return "quality_check";
  if (trimmed === DRAFT_BUTTON_INTENT) return "generate_draft";
  if (trimmed === CHECK_CONTINUITY_BUTTON_INTENT || trimmed === "核账") return "check_continuity";
  if (trimmed === CHECK_CONTINUITY_FRESH_INTENT || trimmed === "再细核一遍") return "check_continuity_fresh";
  if (COMMIT_PREVIEW_TEXTS.has(trimmed) || /^(?:预览第\s*\d+\s*章的定稿改动|生成第\s*\d+\s*章定稿预览)$/u.test(trimmed)) return "commit_preview";
  return null;
}

/**
 * 「下一步」结构化动作选项（R4.7）点击后落在对话里的「你：…」一句话——动作本身经 body.action 直达服务端，
 * 这句只是对话里给作者看的回显，文案与选项 intent 同口径。定稿预览那句刻意写成
 * 「预览第 N 章的定稿改动」（matchDeterministicChapterAction 认识的形状），万一有旧路径把它当文本重放也能被接住。
 */
export function userActionChoiceText(action: import("../api/agentChatClient.js").AgentUserAction): string {
  switch (action.toolName) {
    case "commit_preview":
      return `预览第 ${action.chapter} 章的定稿改动`;
    case "check_continuity":
      return action.fresh ? `再细核一遍：重新核第 ${action.chapter} 章的账` : `重新核第 ${action.chapter} 章的账`;
    case "generate_draft":
      return `写第 ${action.chapter} 章的正文`;
    case "commit_apply":
      return `确认定稿第 ${action.chapter} 章`;
    case "prune_snapshots":
      return action.keep ? `确认裁剪操作历史（保留最近 ${action.keep} 条）` : "确认裁剪操作历史";
    case "ledger_decision":
      return action.label ? `确认改账：${action.label}` : "确认改账";
    case "foundation_decision":
      return action.label ? `确认改设定：${action.label}` : "确认改设定";
  }
}
