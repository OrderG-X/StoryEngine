import type { ChapterWorkflowState, SuggestedAction } from "../types.js";
import type { DraftAIReviewReport } from "../api/types.js";

export function workflowPromptText(state: ChapterWorkflowState): string {
  const prompts: Record<ChapterWorkflowState, string> = {
    idle: "我已读取当前故事状态。你可以说说这章想写什么，比如角色行动、场景、情节转折。",
    steering_ready: "方案已整理好。说「写吧」开始生成，或继续补充你的想法。",
    draft_generating: "正在生成工作稿…",
    draft_ready: "工作稿已生成。看看左侧工作稿，说「硬伤检查」检查穿帮，或告诉我要改哪里。",
    quality_checked: "硬伤检查通过。说「定稿预览」查看定稿后会怎么变化，或让 AI 做内容审阅。",
    commit_preview_ready: "定稿预览已生成。说「确认定稿」即可写入已定稿版，可在操作历史撤销。",
    waiting_commit_confirmation: "定稿预览已生成。说「确认定稿」即可写入，写入前会自动存档，可撤销。",
    committed: "本章已定稿。说「下一章」继续。",
    ready_for_next: "可以进入下一章。说「下一章」或告诉我新章节想写什么。",
  };
  return prompts[state];
}

export function actionsForWorkflowState(state: ChapterWorkflowState): readonly SuggestedAction[] {
  const disabledReasons: Record<ChapterWorkflowState, Partial<Record<string, string>>> = {
    idle: {
      "quality-check": "请先生成工作稿。",
      "ai-review": "请先生成工作稿。",
      "commit-preview": "请先生成工作稿并完成硬伤检查。",
      "commit-apply": "必须先生成定稿预览。",
      "continue-next": "本章尚未定稿。",
    },
    steering_ready: {
      "quality-check": "请先生成工作稿。",
      "ai-review": "请先生成工作稿。",
      "commit-preview": "请先生成工作稿并完成硬伤检查。",
      "commit-apply": "必须先生成定稿预览。",
      "continue-next": "本章尚未定稿。",
    },
    draft_generating: {
      "generate-steering": "工作稿生成中。",
      "generate-draft": "工作稿生成中。",
      "quality-check": "工作稿生成中。",
      "ai-review": "工作稿生成中。",
      "commit-preview": "工作稿生成中。",
      "commit-apply": "工作稿生成中。",
      "continue-next": "工作稿生成中。",
    },
    draft_ready: {
      "commit-preview": "建议先做硬伤检查，再生成定稿预览。",
      "commit-apply": "必须先生成定稿预览。",
      "continue-next": "本章尚未定稿。",
    },
    quality_checked: {
      "commit-apply": "必须先生成定稿预览。",
      "continue-next": "本章尚未定稿。",
    },
    commit_preview_ready: {
      "quality-check": "定稿预览已生成，如需重新做硬伤检查请先回到工作稿。",
      "ai-review": "定稿预览已生成，如需内容审阅请先回到工作稿。",
      "continue-next": "本章尚未定稿。",
    },
    waiting_commit_confirmation: {
      "quality-check": "定稿预览已生成，如需重新做硬伤检查请先回到工作稿。",
      "ai-review": "定稿预览已生成，如需内容审阅请先回到工作稿。",
      "continue-next": "本章尚未定稿。",
    },
    committed: {
      "generate-draft": "本章已定稿，如需继续请进入下一章。",
      "quality-check": "本章已定稿。",
      "ai-review": "本章已定稿。",
      "commit-preview": "本章已定稿。",
      "commit-apply": "本章已定稿。",
    },
    ready_for_next: {
      "quality-check": "请先生成下一章工作稿。",
      "ai-review": "请先生成下一章工作稿。",
      "commit-preview": "请先生成下一章工作稿。",
      "commit-apply": "必须先生成定稿预览。",
    },
  };
  return ["generate-steering", "generate-draft", "quality-check", "ai-review", "commit-preview", "commit-apply", "continue-next"]
    .map((id) => withDisabledReason(suggestedAction(id), disabledReasons[state][id]));
}

export function suggestedAction(id: SuggestedAction["id"]): SuggestedAction {
  const actions: Record<string, SuggestedAction> = {
    "generate-steering": {
      id: "generate-steering",
      label: "生成本章方案",
      description: "读取当前状态，生成本章写作方案和本章目标预览。",
      permission: "safe_read",
      requiresConfirmation: false,
      endpoint: "/api/chapter-steering",
    },
    "generate-draft": {
      id: "generate-draft",
      label: "生成工作稿",
      description: "调用模型生成正文，只写 drafts/fast，不更新正式状态。",
      permission: ["model_call", "draft_write"],
      requiresConfirmation: true,
      endpoint: "/api/draft/stream",
    },
    "generate-draft-direct": {
      id: "generate-draft-direct",
      label: "直接按当前输入写工作稿",
      description: "跳过本章方案确认，调用模型写入 drafts/fast；不会更新正式状态。",
      permission: ["model_call", "draft_write"],
      requiresConfirmation: true,
      endpoint: "/api/draft/stream",
    },
    "quality-check": {
      id: "quality-check",
      label: "硬伤检查",
      description: "只读取当前工作稿并检查问题，不做真实修补。",
      permission: "safe_read",
      requiresConfirmation: false,
      endpoint: "/api/draft/quality",
    },
    "ai-review": {
      id: "ai-review",
      label: "内容审阅",
      description: "调用 AI 审查剧情、人物、节奏、文风和连续性，只给建议不改正文。",
      permission: "model_call",
      requiresConfirmation: true,
      endpoint: "/api/draft/ai-review",
    },
    "revision-preview": {
      id: "revision-preview",
      label: "准备修改方案",
      description: "调用 AI 生成局部修订预览，不写工作稿。",
      permission: "model_call",
      requiresConfirmation: true,
      endpoint: "/api/draft/revision/preview",
    },
    "revision-apply": {
      id: "revision-apply",
      label: "应用到工作稿",
      description: "只替换工作稿中的对应片段，不写入已定稿版。",
      permission: "draft_write",
      requiresConfirmation: true,
      endpoint: "/api/draft/revision/apply",
    },
    "commit-preview": {
      id: "commit-preview",
      label: "生成定稿预览",
      description: "生成定稿预览，不写已定稿版。",
      permission: "safe_read",
      requiresConfirmation: false,
      endpoint: "/api/commit/preview",
    },
    "commit-apply": {
      id: "commit-apply",
      label: "确认定稿",
      description: "写入定稿章节，写入前自动存档，可在操作历史撤销。",
      permission: "formal_state_write",
      requiresConfirmation: false,
      endpoint: "/api/commit/apply",
    },
    "continue-next": {
      id: "continue-next",
      label: "继续下一章",
      description: "切换到下一章准备状态，只读取状态，不写文件。",
      permission: "safe_read",
      requiresConfirmation: false,
    },
  };
  return actions[id] ?? actions["generate-steering"];
}

function withDisabledReason(action: SuggestedAction, disabledReason: string | undefined): SuggestedAction {
  return disabledReason ? { ...action, disabledReason } : action;
}

export function suggestedActionForPendingAction(action: { readonly type: string }): SuggestedAction {
  switch (action.type) {
    case "generate_steering":
      return suggestedAction("generate-steering");
    case "generate_draft":
      return suggestedAction("generate-draft-direct");
    case "quality_check":
      return suggestedAction("quality-check");
    case "ai_review":
      return suggestedAction("ai-review");
    case "revision_preview":
      return suggestedAction("revision-preview");
    case "revision_apply":
      return suggestedAction("revision-apply");
    case "commit_preview":
      return suggestedAction("commit-preview");
    case "commit_apply":
      return suggestedAction("commit-apply");
    case "continue_next":
      return suggestedAction("continue-next");
    default:
      return suggestedAction("generate-steering");
  }
}

export function verdictLabel(verdict: DraftAIReviewReport["verdict"]): string {
  const labels: Record<DraftAIReviewReport["verdict"], string> = {
    ready_to_commit: "内容审阅通过",
    needs_minor_revision: "建议小修",
    needs_major_revision: "建议大修",
    blocked: "暂不建议定稿",
  };
  return labels[verdict];
}

export function ensureWorkflowPrompt<T extends { readonly suggestedActions?: readonly SuggestedAction[]; readonly id?: string; readonly role?: string; readonly content?: string }>(messages: readonly T[], state: ChapterWorkflowState): readonly T[] {
  if (messages.some((message) => message.suggestedActions?.length)) return messages;
  return [...messages, createWorkflowMessage(state) as T];
}

export function createWorkflowMessage(state: ChapterWorkflowState, content?: string) {
  return {
    id: `assistant-workflow-${state}-${Date.now()}`,
    role: "assistant" as const,
    content: content ?? workflowPromptText(state),
    suggestedActions: actionsForWorkflowState(state),
  };
}

export function describePendingChapterAction(action: { readonly type: string; readonly direction?: string; readonly chapterGoal?: string }): string {
  switch (action.type) {
    case "generate_steering":
      return `我会先按这个方向整理本章方案：${action.direction}`;
    case "generate_draft":
      return "我会按当前本章方案生成正文工作稿，正文会写入左侧工作稿区。";
    case "quality_check":
      return "我会检查当前工作稿的设定、逻辑和穿帮风险。";
    case "ai_review":
      return "我会调用 AI 做内容审阅，检查剧情、人物、节奏、文风和连续性，只给建议，不改工作稿。";
    case "revision_preview":
      return "我会基于当前修订任务生成局部修订草案，只给原文和修订后的对比，不改工作稿。";
    case "revision_apply":
      return "我会把当前修改方案应用到工作稿，只修改工作稿，不写入已定稿版。";
    case "commit_preview":
      return "我会生成定稿预览，让你看到定稿后会怎么变化。";
    case "commit_apply":
      return "我会直接定稿，把本章写入已定稿版；写入前会自动存档，可撤销。";
    case "continue_next":
      return "我会进入下一章工作区，继续下一章规划。";
    default:
      return "正在执行操作。";
  }
}
