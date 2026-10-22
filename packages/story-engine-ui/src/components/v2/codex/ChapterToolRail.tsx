/**
 * 本章工具（按章节进度给写作工具）—— 输入框上方能力条最前面那几个按钮（ChatCapabilityBar 的 leading）。
 *
 * 带 `button` 的是固定动作：点了直接发结构化动作（handleChapterButton），不经模型、也不靠文案认回（重构 P4）。
 * 不带 `button` 的是给 AI 的一句话（先给方案、检查机器腔）：照常发进对话，由 AI 决定怎么做。
 *
 * 纯前端、确定性渲染（不依赖 agent 是否调过 suggest_next_steps）。
 */
import type { ChapterFlowStatus } from "../../../types.js";
import type { ChapterButton } from "../../../utils/chapterButtons.js";

export interface ChapterToolAction {
  readonly key: string;
  readonly label: string;
  /** 不带 button 时：点击后发给 AI 的一句话。带 button 时只做悬停提示。 */
  readonly intent: string;
  /** 固定动作：点了直接发结构化动作。 */
  readonly button?: ChapterButton;
}

export const BEFORE_DRAFT: readonly ChapterToolAction[] = [
  { key: "draft", label: "AI 写这一章", intent: "写这一章的正文（方向框里写了方向就照方向写）", button: "write" },
  { key: "steer", label: "先给方案", intent: "先给这一章一个写作方案，先别直接出正文" },
];

export const HAS_DRAFT: readonly ChapterToolAction[] = [
  // 核账＝写完一章的头一步：拿这一章对前文原文找对不上的地方（作者自己写的章也一样）。
  { key: "continuity", label: "核账", intent: "拿这一章对一遍前文，看有没有前后对不上的地方", button: "check_continuity" },
  { key: "review", label: "内容审阅", intent: "审阅这一章的内容，给评分和改进建议", button: "ai_review" },
  { key: "deai", label: "检查机器腔", intent: "检查这一章的机器腔，把有机器腔的句子列出来" },
  // 定稿按钮 = 定稿流程入口：先出预览；定稿清单里的「确认定稿」才真定稿。
  { key: "commit", label: "定稿", intent: "预览这一章的定稿改动", button: "commit_preview" },
];

export const COMMITTED: readonly ChapterToolAction[] = [
  { key: "next", label: "AI 写下一章", intent: "写下一章的正文", button: "write_next" },
];

/**
 * 按本章 flowStatus 确定性派生该亮哪些工具。题材中立、无副作用。
 * - 还没草稿（idle/steering_ready）：写这一章 / 先给方案
 * - 生成中（draft_generating）：不显（agent 正忙）
 * - 有草稿（draft_ready/quality_checked/commit_preview_ready/waiting_commit_confirmation）：核账/审阅/机器腔/定稿
 * - 已定稿（committed/ready_for_next）：写下一章
 */
export function railActionsForFlow(flowStatus: ChapterFlowStatus): readonly ChapterToolAction[] {
  switch (flowStatus) {
    case "idle":
    case "steering_ready":
      return BEFORE_DRAFT;
    case "draft_generating":
      return [];
    case "committed":
    case "ready_for_next":
      return COMMITTED;
    default:
      return HAS_DRAFT;
  }
}
