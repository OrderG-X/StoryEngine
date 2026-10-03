import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetRecentWorkspaceUndoForTest,
  describeWorkspaceRevisionConflict,
  hasRecentWorkspaceUndo,
  markRecentWorkspaceUndo,
  RECENT_UNDO_WINDOW_MS,
  reloadAfterWorkspaceRevisionConflict,
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
