export type DevApiPermission =
  | "safe_read"
  | "model_call"
  | "draft_write"
  | "project_config_write"
  | "formal_state_write"
  | "destructive_write"
  | "local_side_effect";

export type ChapterWorkflowState =
  | "idle"
  | "steering_ready"
  | "draft_generating"
  | "draft_ready"
  | "quality_checked"
  | "commit_preview_ready"
  | "waiting_commit_confirmation"
  | "committed"
  | "ready_for_next";

export type ChapterFlowStatus = ChapterWorkflowState;
export type ThemeMode = "dark" | "light";

export interface SuggestedAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly permission: DevApiPermission | readonly DevApiPermission[];
  readonly requiresConfirmation: boolean;
  readonly endpoint?: string;
  readonly disabledReason?: string;
  /** 「确认定稿」按钮的目标（commit-apply 专用）：缺省 = 用户当前章 + 服务端最近一次有效预览票据。 */
  readonly commitTarget?: CommitConfirmTarget;
  /** 「确认裁剪」按钮的参数（prune-confirm 专用）：保留最近多少条，缺省=引擎默认。 */
  readonly pruneTarget?: { readonly keep?: number };
}

/** 「确认定稿」结构化动作的目标章与预览令牌（令牌让服务重启后仍能凭「这版草稿已预览」放行）。 */
export interface CommitConfirmTarget {
  readonly chapter?: number;
  readonly previewToken?: string;
  /** 作者在账本清单上去掉的条目 id（定稿时不写）。 */
  readonly excluded?: readonly string[];
}
