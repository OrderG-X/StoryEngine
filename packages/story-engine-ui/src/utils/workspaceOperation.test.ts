import { beforeEach, describe, expect, it } from "vitest";

import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceBusy,
  isWorkspaceOperationCurrent,
  retargetWorkspaceOperation,
  resetWorkspaceOperationForTests,
} from "./workspaceOperation.js";

describe("workspace operation ownership", () => {
  beforeEach(() => resetWorkspaceOperationForTests());

  it("atomically rejects a second foreground operation and only lets the owner release busy", () => {
    const first = beginWorkspaceOperation("agent-chat", {
      projectPath: "/books/a",
      chapter: 1,
      sessionId: "session-a",
    });
    expect(first).not.toBeNull();
    const refused = beginWorkspaceOperation("snapshot-restore", {
      projectPath: "/books/a",
      chapter: 1,
      sessionId: "session-a",
    });

    expect(refused).toBeNull();
    expect(isWorkspaceOperationCurrent(first!)).toBe(true);
    expect(isWorkspaceBusy()).toBe(true);
    expect(finishWorkspaceOperation(first!)).toBe(true);
    expect(isWorkspaceBusy()).toBe(false);

    const second = beginWorkspaceOperation("snapshot-restore", {
      projectPath: "/books/a",
      chapter: 1,
      sessionId: "session-a",
    });
    expect(second).not.toBeNull();
    expect(finishWorkspaceOperation(first!)).toBe(false);
    expect(isWorkspaceOperationCurrent(second!)).toBe(true);
  });

  it("checks project, chapter, session, and operation identity", () => {
    const token = beginWorkspaceOperation("agent-chat", {
      projectPath: "/books/a",
      chapter: 3,
      sessionId: "session-a",
    });

    expect(token).not.toBeNull();
    expect(isWorkspaceOperationCurrent({ ...token!, projectPath: "/books/b" })).toBe(false);
    expect(isWorkspaceOperationCurrent({ ...token!, chapter: 4 })).toBe(false);
    expect(isWorkspaceOperationCurrent({ ...token!, sessionId: "session-b" })).toBe(false);
    expect(isWorkspaceOperationCurrent({ ...token!, operationId: `${token!.operationId}-stale` })).toBe(false);
  });

  it("lets the current owner explicitly adopt a new chapter without changing project/session/id", () => {
    const first = beginWorkspaceOperation("agent-chat", {
      projectPath: "/books/a",
      chapter: 3,
      sessionId: "session-a",
    });
    expect(first).not.toBeNull();

    const retargeted = retargetWorkspaceOperation(first!, { chapter: 4 });

    expect(retargeted).toMatchObject({
      projectPath: "/books/a",
      chapter: 4,
      sessionId: "session-a",
      operationId: first!.operationId,
    });
    expect(isWorkspaceOperationCurrent(first!)).toBe(false);
    expect(isWorkspaceOperationCurrent(retargeted!)).toBe(true);
    expect(retargetWorkspaceOperation(retargeted!, { chapter: 3 })).toBeNull();
    expect(isWorkspaceOperationCurrent(retargeted!)).toBe(true);
  });
});
