import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetRecentWorkspaceUndoForTest,
  describeDeferredWorkspaceRevisionConflict,
  describeWorkspaceRevisionConflict,
  hasPendingRevisionReload,
  hasRecentWorkspaceUndo,
  markRecentWorkspaceUndo,
  RECENT_UNDO_WINDOW_MS,
  reloadAfterWorkspaceRevisionConflict,
  takePendingRevisionReload,
  workspaceRevisionConflictCause,
} from "./workspaceRevisionConflict.js";

describe("reloadAfterWorkspaceRevisionConflict", () => {
  it("records disk truth, suspends autosave, notifies, then reloads without attempting another write", () => {
    const events: string[] = [];
    const write = vi.fn();

    reloadAfterWorkspaceRevisionConflict({
      projectPath: "/books/a",
      chapter: 2,
      revision: 9,
      recordRevision: (projectPath, chapter, revision) => events.push(`record:${projectPath}:${chapter}:${revision}`),
      suspend: () => events.push("suspend"),
      notify: () => events.push("notify"),
      reload: () => events.push("reload"),
    });

    expect(events).toEqual(["record:/books/a:2:9", "suspend", "notify", "reload"]);
    expect(write).not.toHaveBeenCalled();
  });
});

// R7.2（十章验收 3.2）：回合进行中撞 409 不立刻 reload——立刻刷会腰斩正在跑的 AI 回合、这轮回复丢失。
// 改为记 pendingRevisionReload，由回合收尾走「写回会话文件 → 重载」；没有回合在跑时行为不变。
describe("reloadAfterWorkspaceRevisionConflict 延迟重载（R7.2）", () => {
  afterEach(() => { __resetRecentWorkspaceUndoForTest(); });

  it("回合进行中（turnActive=true）：冻结 + 记 pending + 延迟提示，不 reload；take 读出即清（一次性）", () => {
    const events: string[] = [];
    reloadAfterWorkspaceRevisionConflict({
      projectPath: "/books/a",
      chapter: 2,
      revision: 9,
      recordRevision: () => events.push("record"),
      suspend: () => events.push("suspend"),
      notify: () => events.push("notify"),
      reload: () => events.push("reload"),
      turnActive: () => true,
      notifyDeferred: () => events.push("notify-deferred"),
    });

    expect(events).toEqual(["record", "suspend", "notify-deferred"]);
    expect(hasPendingRevisionReload()).toBe(true);
    expect(takePendingRevisionReload()).toEqual({ projectPath: "/books/a", chapter: 2, revision: 9 });
    expect(hasPendingRevisionReload()).toBe(false);
    expect(takePendingRevisionReload()).toBeNull();
  });

  it("已挂起待重载时（回合收尾在写回会话），迟到的第二笔 409 由调用方并入 pending 而非立刻刷", () => {
    reloadAfterWorkspaceRevisionConflict({
      projectPath: "/books/a",
      chapter: 2,
      revision: 9,
      recordRevision: () => undefined,
      suspend: () => undefined,
      notify: () => undefined,
      reload: () => undefined,
      turnActive: () => true,
    });
    // App 的 turnActive 口径：chatLoading 已 false（回合刚结束）但 pending 仍挂起 → 照样走延迟路。
    const events: string[] = [];
    reloadAfterWorkspaceRevisionConflict({
      projectPath: "/books/a",
      chapter: 2,
      revision: 10,
      recordRevision: () => undefined,
      suspend: () => events.push("suspend"),
      notify: () => events.push("notify"),
      reload: () => events.push("reload"),
      turnActive: () => hasPendingRevisionReload(),
      notifyDeferred: () => events.push("notify-deferred"),
    });
    expect(events).toEqual(["suspend", "notify-deferred"]); // 没有立刻 reload，只是并入待重载
  });

  it("没有回合在跑（turnActive=false / 缺省）→ 行为不变：notify 后立刻 reload、不留 pending", () => {
    for (const turnActive of [undefined, () => false]) {
      const events: string[] = [];
      reloadAfterWorkspaceRevisionConflict({
        projectPath: "/books/a",
        chapter: 2,
        revision: 9,
        recordRevision: () => events.push("record"),
        suspend: () => events.push("suspend"),
        notify: () => events.push("notify"),
        reload: () => events.push("reload"),
        ...(turnActive ? { turnActive } : {}),
      });
      expect(events).toEqual(["record", "suspend", "notify", "reload"]);
      expect(takePendingRevisionReload()).toBeNull();
    }
  });

  it("延迟文案不说「正在重新加载」，改说「回复写完会自动刷新」；撤销成因不提另一窗口", () => {
    const undoText = describeDeferredWorkspaceRevisionConflict("undo");
    expect(undoText).toContain("自动按磁盘版本刷新");
    expect(undoText).not.toContain("正在重新加载");
    expect(undoText).not.toContain("另一窗口");
    const externalText = describeDeferredWorkspaceRevisionConflict("external");
    expect(externalText).toContain("自动按磁盘版本刷新");
    expect(externalText).not.toContain("另一窗口已保存更新");
  });
});

// P2（2026-10-02）：撤销导致的 409 不再被说成「另一窗口已保存更新」。
describe("workspaceRevisionConflictCause / describeWorkspaceRevisionConflict", () => {
  afterEach(() => { __resetRecentWorkspaceUndoForTest(); });

  it("刚做过撤销（窗口内）→ cause=undo，文案说撤销、不提另一窗口", () => {
    markRecentWorkspaceUndo(1_000);
    expect(hasRecentWorkspaceUndo(1_000 + RECENT_UNDO_WINDOW_MS)).toBe(true);
    expect(workspaceRevisionConflictCause(1_500)).toBe("undo");
    const text = describeWorkspaceRevisionConflict("undo");
    expect(text).toContain("撤销");
    expect(text).not.toContain("另一窗口");
  });

  it("窗口外或从未撤销 → cause=external；文案不再断言「检测到另一窗口已保存更新」", () => {
    expect(workspaceRevisionConflictCause()).toBe("external");
    markRecentWorkspaceUndo(1_000);
    expect(hasRecentWorkspaceUndo(1_000 + RECENT_UNDO_WINDOW_MS + 1)).toBe(false);
    expect(workspaceRevisionConflictCause(1_000 + RECENT_UNDO_WINDOW_MS + 1)).toBe("external");
    const text = describeWorkspaceRevisionConflict("external");
    expect(text).not.toContain("检测到另一窗口已保存更新");
    expect(text).toContain("重新加载");
  });
});
