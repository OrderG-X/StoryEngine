import type { ChapterWorkflowState } from "../type-defs/workflow.js";

/**
 * R2 磁盘对账判定（治 A6：SSE 在 commit_apply 的 tool-result 之前断流 → 客户端只收到 error、看起来失败，
 * 但磁盘其实已入库）。纯函数、无副作用：磁盘说本章已入库、而 UI 当前 flowStatus 还没体现 → 应更正为「已入库」。
 */
export function shouldReconcileToCommitted(
  snapshot: { readonly hasCommittedChapter?: boolean },
  flowNow: ChapterWorkflowState,
): boolean {
  const uiThinksCommitted = flowNow === "committed" || flowNow === "ready_for_next";
  return snapshot.hasCommittedChapter === true && !uiThinksCommitted;
}

/** Only accept disk truth that proves it committed the draft captured by this attempt. */
export function shouldReconcileCommitAttempt(
  snapshot: { readonly hasCommittedChapter?: boolean; readonly draftContent?: string },
  flowNow: ChapterWorkflowState,
  attemptedDraftContent: string,
): boolean {
  if (!shouldReconcileToCommitted(snapshot, flowNow)) return false;
  if (typeof snapshot.draftContent !== "string") return false;
  return normalizeCommitProof(snapshot.draftContent) === normalizeCommitProof(attemptedDraftContent);
}

function normalizeCommitProof(content: string): string {
  return content
    .replace(/^\s*#{1,6}\s+[^\n]*(?:\n|$)/u, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

/**
 * 出稿失败收尾：onToolCall(generate_draft) 把 flowStatus 置成「正在生成草稿」(draft_generating)，
 * 但失败路径(onToolError/onError/未捕获兜底)原本不复位 → 标题区卡在「正在生成草稿」=明明失败却谎称在生成
 * （违反诚实铁律）。纯函数判定该复位成什么：
 *   - 只在当前确实卡在 draft_generating 时才动（其它流程态的失败如实保留，不乱改）→ 否则返回 null。
 *   - 已有草稿内容（流式落了一截、或本就有旧草稿）→ draft_ready（有稿待保存，truthful）。
 *   - 一字未出 → idle（回到起点）。
 * 「磁盘其实已入库但断流显失败」的特例另由 shouldReconcileToCommitted 异步兜（会把 draft_ready/idle 再升成 committed）。
 */
export function flowStatusAfterGenerateFailure(
  flowNow: ChapterWorkflowState,
  hasDraftContent: boolean,
): ChapterWorkflowState | null {
  if (flowNow !== "draft_generating") return null;
  return hasDraftContent ? "draft_ready" : "idle";
}

/**
 * 「停止」后磁盘对账判定（治 A-5：出稿/改稿流到一半被 abort，SSE 回执丢了，但服务端可能在停止前
 * 已把完整稿写进 drafts/fast——generate_draft 是落盘工具）。盘上草稿比停止那刻编辑器里的长 →
 * 服务端写完了更全的一版 → 采用盘稿恢复；否则（盘上更短/一致/为空）保留编辑器里已流出的内容。
 * 纯函数、无副作用；调用方负责先确认「停止后用户没再改过编辑器」再采用。
 */
export function shouldAdoptDiskDraftAfterStop(
  snapshot: { readonly draftContent?: string },
  editorContentAtStop: string,
): boolean {
  const disk = snapshot.draftContent?.trim() ?? "";
  if (!disk) return false;
  return disk.length > editorContentAtStop.trim().length;
}
