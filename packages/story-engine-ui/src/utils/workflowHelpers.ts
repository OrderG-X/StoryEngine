import type { CommitConfirmTarget, SuggestedAction } from "../types.js";

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
    "commit-preview": {
      id: "commit-preview",
      label: "生成定稿预览",
      description: "生成定稿预览，不写已定稿版。",
      permission: "safe_read",
      requiresConfirmation: false,
    },
    "commit-apply": {
      id: "commit-apply",
      label: "确认定稿",
      description: "写入定稿章节，写入前自动存档，可在操作历史撤销。",
      permission: "formal_state_write",
      requiresConfirmation: false,
    },
    "prune-confirm": {
      id: "prune-confirm",
      label: "确认裁剪",
      description: "把操作历史裁到预览里说的条数；裁前完整历史自动备份到项目目录外。",
      permission: "destructive_write",
      requiresConfirmation: false,
    },
    "ledger-confirm": {
      id: "ledger-confirm",
      label: "确认改账",
      description: "按 AI 提的改账方案记下（改前自动存档，可在操作历史撤销）。",
      permission: "formal_state_write",
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
    "foundation-confirm": {
      id: "foundation-confirm",
      label: "确认改设定",
      description: "按 AI 提的改动改资料（改前自动存档，可在操作历史撤销）。",
      permission: "project_config_write",
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

/**
 * 「确认定稿」按钮（预览卡 / 建议条 / 诚实更正都用它）：点了发结构化动作、由服务端直接执行定稿，
 * 不经模型、不靠文本意图词表（2026-10-07）。
 */
export function commitConfirmAction(target?: CommitConfirmTarget): SuggestedAction {
  return { ...suggestedAction("commit-apply"), ...(target ? { commitTarget: target } : {}) };
}

/** 「确认裁剪」按钮：点了发结构化动作、由服务端直接真裁（裁剪快照预览之后出现）。 */
export function pruneConfirmAction(target?: { readonly keep?: number }): SuggestedAction {
  return { ...suggestedAction("prune-confirm"), pruneTarget: { ...(target?.keep ? { keep: target.keep } : {}) } };
}

/** 「确认改账」按钮：点了发结构化动作、由服务端按作者档记下裁定（manage_ledger 提议之后出现）。 */
export function ledgerConfirmAction(target: { readonly key: string; readonly decisions: readonly unknown[]; readonly label?: string }): SuggestedAction {
  return { ...suggestedAction("ledger-confirm"), ledgerTarget: { key: target.key, decisions: [...target.decisions], ...(target.label ? { label: target.label } : {}) } };
}

/** 「重写这一章」按钮：有稿的章 AI 不覆盖，作者点了才由服务端整章重写（重构 P4）。 */
export function rewriteConfirmAction(target: { readonly chapter: number; readonly chapterGoal?: string }): SuggestedAction {
  return {
    ...suggestedAction("rewrite-confirm"),
    label: `重写第 ${target.chapter} 章`,
    rewriteTarget: { chapter: target.chapter, ...(target.chapterGoal ? { chapterGoal: target.chapterGoal } : {}) },
  };
}

/** 「接着往下写」按钮：有稿没定稿的章，从最后一句接着写（P13）。 */
export function continueConfirmAction(target: { readonly chapter: number; readonly chapterGoal?: string }): SuggestedAction {
  return {
    ...suggestedAction("continue-confirm"),
    rewriteTarget: { chapter: target.chapter, ...(target.chapterGoal ? { chapterGoal: target.chapterGoal } : {}), continueDraft: true },
  };
}

/** 「确认改设定」按钮：删角色、覆盖已确立设定是作者档，作者点了才由服务端执行（重构 P4）。 */
export function foundationConfirmAction(target: { readonly key: string; readonly input: Readonly<Record<string, unknown>>; readonly label?: string }): SuggestedAction {
  const base = suggestedAction("foundation-confirm");
  return {
    ...base,
    ...(target.label ? { description: `${target.label}（改前自动存档，可在操作历史撤销）。` } : {}),
    foundationTarget: { key: target.key, input: { ...target.input }, ...(target.label ? { label: target.label } : {}) },
  };
}
