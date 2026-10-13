export function reloadAfterWorkspaceRevisionConflict(input: {
  readonly projectPath: string;
  readonly chapter: number;
  readonly revision: number;
  readonly recordRevision: (projectPath: string, chapter: number, revision: number) => void;
  readonly suspend: () => void;
  readonly notify: () => void;
  readonly reload: () => void;
  /**
   * R7.2：是否有 AI 回合正在跑。true 时不立刻 reload——立刻刷会腰斩正在跑的回合、这轮回复丢失
   * （会话文件里也没有）。改为记 pendingRevisionReload，由 useChat 的回合收尾走
   * 「写回会话文件 → 重载」同一段（autosave 在此期间保持冻结，旧内容不会写回磁盘）。
   */
  readonly turnActive?: () => boolean;
  /** 延迟重载时的用户提示（「等回复写完会自动刷新」）；缺省复用 notify。 */
  readonly notifyDeferred?: () => void;
}): void {
  input.recordRevision(input.projectPath, input.chapter, input.revision);
  // 先冻结，确保 reload 触发的 pagehide/beforeunload 不会把冲突的旧内存再次 PUT 回去。
  input.suspend();
  if (input.turnActive?.()) {
    setPendingRevisionReload({ projectPath: input.projectPath, chapter: input.chapter, revision: input.revision });
    (input.notifyDeferred ?? input.notify)();
    return;
  }
  input.notify();
  input.reload();
}

/* ---------------------------------------------------------------------------
 * 延迟的冲突重载（R7.2·报告 3.2）
 *
 * 回合进行中，一笔撤销前就发出的 autosave PUT 撞上 409（服务端 git 回退把工作区文件的 revision
 * 倒退了）。立刻整页 reload 会把还在跑的 AI 回合拦腰截断——这轮回复既不在页面上、也没写进会话文件。
 * 这里只记下「回合收尾要重载」；useChat 回合 finally 消费它，走与 agent 撤销同一段
 * 「先把整回合对话写回会话文件 → 再 reload」。模块态随整页 reload 重置。
 * ------------------------------------------------------------------------- */

export interface PendingRevisionReload {
  readonly projectPath: string;
  readonly chapter: number;
  readonly revision: number;
}

let pendingRevisionReload: PendingRevisionReload | null = null;

/** 回合进行中撞 409 时记下「回合收尾要重载」（take 消费；也可置 null 清掉）。 */
export function setPendingRevisionReload(info: PendingRevisionReload | null): void {
  pendingRevisionReload = info;
}

/** 读出并清掉待重载标记（回合收尾调用一次；null = 没有挂起的冲突重载）。 */
export function takePendingRevisionReload(): PendingRevisionReload | null {
  const info = pendingRevisionReload;
  pendingRevisionReload = null;
  return info;
}

/** 是否已有挂起的冲突重载（回合收尾会 reload）——迟到的第二笔 409 应并入 pending，而不是抢在收尾前立刻刷。 */
export function hasPendingRevisionReload(): boolean {
  return pendingRevisionReload !== null;
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
  pendingRevisionReload = null;
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

/** 延迟重载的说明（R7.2）：回合进行中撞 409，先等这轮回复写完、再自动刷新。 */
export function describeDeferredWorkspaceRevisionConflict(cause: WorkspaceRevisionConflictCause): string {
  if (cause === "undo") {
    return "刚才的撤销已把磁盘回退到更早版本；等这轮回复写完会自动按磁盘版本刷新，页面上的旧内容不会覆盖它。";
  }
  return "磁盘上的工作区已被更新；等这轮回复写完会自动按磁盘版本刷新，本次旧版本不会覆盖它。";
}
