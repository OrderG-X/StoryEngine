import { describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./workspaceStore.js";

describe("workspaceStore 会话状态", () => {
  it("setSessions / setActiveSessionId / setActiveArchivedCount", () => {
    const s = useWorkspaceStore.getState();
    s.setSessions([{ id: "a", name: "A", updatedAt: "t" }], "a");
    expect(useWorkspaceStore.getState().activeSessionId).toBe("a");
    s.setActiveArchivedCount(3);
    expect(useWorkspaceStore.getState().activeArchivedCount).toBe(3);
  });
});
