import type { OperationActionData } from "../api/agentChatClient.js";

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
  /** 「重写这一章」「接着往下写」按钮点了交的写稿（rewrite-confirm / continue-confirm，服务端出的，请求号那时就定了）。 */
  readonly operationAction?: OperationActionData;
  /** 「重试这一步」重发的是作者哪句话（写作版本 P2a：沿用那句的消息号和发出时间）。 */
  readonly retryOf?: { readonly messageId: string; readonly issuedAt: string };
}
