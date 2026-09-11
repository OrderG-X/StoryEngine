/**
 * ChapterToolRail —— 进度卡（AiFlow 四步）下方的「本章工具条」。
 *
 * 治 B1：agent 工具箱里写完后的审稿 / 去AI味 / 质检 / 入库等，此前对用户隐形（只能打字唤起、记不得有），
 * 这里按「本章所处阶段」确定性地把当下该用的工具列成可点按钮。点一下 = 给 agent 发一句预置中文意图
 * （onSendMessage），仍走「对话是唯一控制面」——不绕过 agent 直调引擎、不碰工具注册（数量以注册处为准，这里不写死）。
 *
 * 纯前端、确定性渲染（不依赖 agent 是否调过 suggest_next_steps）；样式在 codex.css，作用域 .codex-app。
 */
import type { ChapterFlowStatus } from "../../../types.js";
import { COMMIT_PREVIEW_BUTTON_INTENT, DRAFT_BUTTON_INTENT, QUALITY_BUTTON_INTENT, REVIEW_BUTTON_INTENT } from "../../../utils/chapterActionIntents.js";

export interface ChapterToolAction {
  readonly key: string;
  readonly label: string;
  /** 点击后发给 agent 的中文意图（措辞贴近 story-agent 各工具的用户触发语）。 */
  readonly intent: string;
}

export const BEFORE_DRAFT: readonly ChapterToolAction[] = [
  { key: "draft", label: "✎ 写这一章", intent: DRAFT_BUTTON_INTENT },
  { key: "steer", label: "◇ 先给方案", intent: "先给这一章一个写作方案，先别直接出正文" },
];

export const HAS_DRAFT: readonly ChapterToolAction[] = [
  { key: "review", label: "◈ 内容审阅", intent: REVIEW_BUTTON_INTENT },
  // 措辞要落在 check_ai_flavor 守卫上、且不是问句：旧「查…有没有…」会被当提问旁路掉、点了没兜底。
  // 新旧术语双写：机器腔 = AI 味（honesty 守卫新旧词都认）。
  { key: "deai", label: "✦ 检查机器腔", intent: "检查这一章的机器腔，把有机器腔的句子列出来" },
  { key: "quality", label: "✓ 硬伤检查", intent: QUALITY_BUTTON_INTENT },
  // 定稿按钮 = 定稿流程入口，确定性走预览（commit_preview）；预览卡再引导「确认定稿」走 commit_apply。
  { key: "commit", label: "↻ 定稿", intent: COMMIT_PREVIEW_BUTTON_INTENT },
];

export const COMMITTED: readonly ChapterToolAction[] = [
  // 含换章触发词「继续写」+ 直接出稿措辞；避开「方案/思路」等 WRITING_PLAN_ONLY 词，否则守卫会把它当「只讨论」放过。
  { key: "next", label: "→ 写下一章", intent: "继续写下一章的正文，现在就动笔直接出稿" },
];

/**
 * 按本章 flowStatus 确定性派生该亮哪些工具。题材中立、无副作用。
 * - 还没草稿（idle/steering_ready）：写本章 / 先给方案
 * - 生成中（draft_generating）：不显（agent 正忙）
 * - 有草稿（draft_ready/quality_checked/commit_preview_ready/waiting_commit_confirmation）：审稿/去AI味/质检/入库
 * - 已入库（committed/ready_for_next）：写下一章
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

export function ChapterToolRail({ flowStatus, onSendMessage, disabled }: {
  readonly flowStatus: ChapterFlowStatus;
  readonly onSendMessage?: (content: string) => void;
  readonly disabled?: boolean;
}) {
  if (!onSendMessage) return null;
  const actions = railActionsForFlow(flowStatus);
  if (actions.length === 0) return null;
  return (
    <div className="chapter-tool-rail" role="group" aria-label="本章可用工具">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className="ctr-btn"
          disabled={disabled}
          title={action.intent}
          onClick={() => onSendMessage(action.intent)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
