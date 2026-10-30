import type { OperationActionData } from "../api/agentChatClient.js";
import type { SuggestedAction } from "../types.js";

export function suggestedAction(id: SuggestedAction["id"]): SuggestedAction {
  const actions: Record<string, SuggestedAction> = {
    "generate-steering": {
      id: "generate-steering",
      label: "生成本章方案",
      description: "读取当前状态，生成本章写作方案和本章目标预览。",
      permission: "safe_read",
      requiresConfirmation: false,
      endpoint: "/api/agent/chat",
    },
    "generate-draft": {
      id: "generate-draft",
      label: "生成工作稿",
      description: "调用模型生成正文，只写 drafts/fast，不更新正式状态。",
      permission: ["model_call", "draft_write"],
      requiresConfirmation: true,
      endpoint: "/api/agent/chat",
    },
    "generate-draft-direct": {
      id: "generate-draft-direct",
      label: "直接按当前输入写工作稿",
      description: "跳过本章方案确认，调用模型写入 drafts/fast；不会更新正式状态。",
      permission: ["model_call", "draft_write"],
      requiresConfirmation: true,
      endpoint: "/api/agent/chat",
    },
    "quality-check": {
      id: "quality-check",
      label: "硬伤检查",
      description: "只读取当前工作稿并检查问题，不做真实修补。",
      permission: "safe_read",
      requiresConfirmation: false,
      endpoint: "/api/agent/chat",
    },
    "ai-review": {
      id: "ai-review",
      label: "内容审阅",
      description: "调用 AI 审查剧情、人物、节奏、文风和连续性，只给建议不改正文。",
      permission: "model_call",
      requiresConfirmation: true,
      endpoint: "/api/agent/chat",
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
    "prune-confirm": {
      id: "prune-confirm",
      label: "确认裁剪",
      description: "把操作历史裁到预览里说的条数；裁前完整历史自动备份到项目目录外。",
      permission: "destructive_write",
      requiresConfirmation: false,
    },
    "rewrite-confirm": {
      id: "rewrite-confirm",
      label: "重写这一章",
      description: "整章重写（重写前自动存档，可在操作历史撤销）。",
      permission: ["model_call", "draft_write"],
      requiresConfirmation: false,
    },
    "continue-confirm": {
      id: "continue-confirm",
      label: "接着往下写",
      description: "从工作稿最后一句接着写，已写的字不动（写前自动存档，可在操作历史撤销）。",
      permission: ["model_call", "draft_write"],
      requiresConfirmation: false,
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

/** 「确认裁剪」按钮：点了发结构化动作、由服务端直接真裁（裁剪快照预览之后出现）。 */
export function pruneConfirmAction(target?: { readonly keep?: number }): SuggestedAction {
  return { ...suggestedAction("prune-confirm"), pruneTarget: { ...(target?.keep ? { keep: target.keep } : {}) } };
}

/** 把作者档按钮挂进这一轮的建议条。同一种按钮一轮只摆一个（定稿、裁剪这类）：后来的换掉先前的。 */
export function withAuthorButton(actions: readonly SuggestedAction[] | undefined, button: SuggestedAction): SuggestedAction[] {
  return [...(actions ?? []).filter((action) => action.id !== button.id), button];
}

/**
 * 「重写这一章」「接着往下写」按钮：有稿的章 AI 不覆盖，作者点了才交（重构 P4、P13）。按钮字和点了交的写稿都是服务端出的
 * （change_draft 没受理时带的 rewriteChoices），接着写的是 continue-confirm，别的是 rewrite-confirm。
 */
export function draftChoiceAction(choice: { readonly label: string; readonly mode: string; readonly action: OperationActionData }): SuggestedAction {
  return {
    ...suggestedAction(choice.mode === "continue" ? "continue-confirm" : "rewrite-confirm"),
    label: choice.label,
    operationAction: choice.action,
  };
}

