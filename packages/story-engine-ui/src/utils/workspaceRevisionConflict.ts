export function reloadAfterWorkspaceRevisionConflict(input: {
  readonly projectPath: string;
  readonly chapter: number;
  readonly revision: number;
  readonly recordRevision: (projectPath: string, chapter: number, revision: number) => void;
  readonly suspend: () => void;
  readonly notify: () => void;
  readonly reload: () => void;
}): void {
  input.recordRevision(input.projectPath, input.chapter, input.revision);
  // 先冻结，确保 reload 触发的 pagehide/beforeunload 不会把冲突的旧内存再次 PUT 回去。
  input.suspend();
  input.notify();
  input.reload();
}

/* ---------------------------------------------------------------------------
 * 409 冲突的成因标记 + 文案（P2·2026-10-02）
 *
 * 旧文案一律说「检测到另一窗口已保存更新」。但本页 agent 刚做完 undo_last_change（git 回退磁盘、revision 倒退）
 * 也会让下一笔 autosave 撞 409——用户明明只开了一个窗口，却被告知「另一窗口」，误导。
 * 撤销路径现已显式 suspend→refetch→reload、正常不会再撞 409；这里是兜底：撤销后短窗口内撞到的冲突按「撤销」解释。
 * ------------------------------------------------------------------------- */

/** 撤销标记有效窗口：reload 前这段时间内的 409 都归因于撤销。 */
export const RECENT_UNDO_WINDOW_MS = 30_000;
let recentUndoAt: number | null = null;

/** agent undo_last_change 真撤销 / 块级撤销 restore 之后调用。 */
export function markRecentWorkspaceUndo(now: number = Date.now()): void {
  recentUndoAt = now;
}

export function hasRecentWorkspaceUndo(now: number = Date.now()): boolean {
  return recentUndoAt !== null && now - recentUndoAt <= RECENT_UNDO_WINDOW_MS;
}

/** 仅供单测。 */
export function __resetRecentWorkspaceUndoForTest(): void {
  recentUndoAt = null;
}

export type WorkspaceRevisionConflictCause = "undo" | "external";

export function workspaceRevisionConflictCause(now: number = Date.now()): WorkspaceRevisionConflictCause {
  return hasRecentWorkspaceUndo(now) ? "undo" : "external";
}

/** 给用户看的冲突说明：撤销导致的不再说「另一窗口」；来源不明时也不断言「另一窗口」，只说磁盘更新。 */
export function describeWorkspaceRevisionConflict(cause: WorkspaceRevisionConflictCause): string {
  if (cause === "undo") {
    return "刚才的撤销已把磁盘回退到更早版本，正在按磁盘版本重新加载；页面上的旧内容没有覆盖它。";
  }
  return "磁盘上的工作区已被更新（另一窗口保存或刚做过撤销），正在重新加载磁盘版本；本次旧版本没有覆盖它。";
}
