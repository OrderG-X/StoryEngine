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
  /** 「确认改账」按钮带的裁定草案（ledger-confirm 专用，manage_ledger 提的）。 */
  readonly ledgerTarget?: { readonly key: string; readonly decisions: readonly unknown[]; readonly label?: string } & ProposalBasis;
  /** 「重写这一章」「接着往下写」按钮的目标（rewrite-confirm / continue-confirm，generate_draft 遇到有稿的章时给的）。 */
  readonly rewriteTarget?: { readonly chapter: number; readonly chapterGoal?: string; readonly continueDraft?: boolean };
  /** 「确认改设定」按钮带的写入（foundation-confirm 专用，foundation_write 被拦下的那次）。 */
  readonly foundationTarget?: { readonly key: string; readonly input: Readonly<Record<string, unknown>>; readonly label?: string } & ProposalBasis;
}

/**
 * AI 提议按钮带的依据（写作版本 P1a）：basis = 提议时书的样子（摘要），作者点了服务端拿它核，变了就不执行。
 * basisFrom = 这次提议的工具自己写之前的样子（foundation_write 先写 AI 那批再提按钮）；一轮几个按钮合成一个时，
 * 后一个的 basisFrom 接得上前一个的 basis 才换成后一个的依据，接不上就留前一个的（点了如实说过期）。
 */
export interface ProposalBasis {
  readonly basis?: string;
  readonly basisFrom?: string;
}

/** 「确认定稿」结构化动作的目标章与预览令牌（令牌让服务重启后仍能凭「这版草稿已预览」放行）。 */
export interface CommitConfirmTarget {
  readonly chapter?: number;
  readonly previewToken?: string;
  /** 作者在账本清单上去掉的条目 id（定稿时不写）。 */
  readonly excluded?: readonly string[];
  /** 作者在账本清单上改的「第几天」。 */
  readonly dayOverride?: number;
  /** 作者在账本清单上改的「到第几天」（这一章跨天）。 */
  readonly dayEndOverride?: number;
}
