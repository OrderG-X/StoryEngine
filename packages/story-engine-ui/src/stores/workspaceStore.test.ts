import { beforeEach, describe, expect, it, vi } from "vitest";

describe("workspaceStore chat message persistence", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it("does not seed the initial workspace chat with mockData demo messages", async () => {
    const { useWorkspaceStore } = await import("./workspaceStore.js");

    const messages = useWorkspaceStore.getState().workspace.messages;

    // The end-of-world demo seed (msg-001/msg-002, "地下车库/无线电") must never
    // become the global store's initial chat history, or it leaks into real projects.
    expect(messages.some((m) => m.id === "msg-001" || m.id === "msg-002")).toBe(false);
    expect(messages.some((m) => m.content.includes("地下车库") || m.content.includes("无线电"))).toBe(false);
  });

  it("对话不在浏览器里另存一份（重构 P5：只存项目里的会话文件）", async () => {
    const { useWorkspaceStore } = await import("./workspaceStore.js");
    useWorkspaceStore.getState().updateWorkspace({ messages: [{ id: "user-1", role: "user", content: "写第一章" }] });
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("resetTransientWorkspaceState（M7 切项目清残留临时态，防跨书串写）", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it("清掉 draftCandidates 等所有「操作在飞」临时态（防 A 书候选稿挂到 B 书）", async () => {
    const { useWorkspaceStore } = await import("./workspaceStore.js");
    const store = useWorkspaceStore.getState();
    // 模拟 A 书残留的在飞态。
    store.setDraftCandidates([{ chapter: 1, title: "A书候选稿", content: "A书正文" }] as never);
    store.setCommitPreviewReport({} as never);
    store.setDraftAIReview({} as never);
    store.setActiveRevisionTask({} as never);
    store.setActiveRevisionPreview({} as never);
    store.setSteeringDraft({} as never);
    expect(useWorkspaceStore.getState().draftCandidates).not.toBeNull();

    useWorkspaceStore.getState().resetTransientWorkspaceState();

    const s = useWorkspaceStore.getState();
    expect(s.draftCandidates).toBeNull();
    expect(s.commitPreviewReport).toBeNull();
    expect(s.draftAIReview).toBeNull();
    expect(s.activeRevisionTask).toBeNull();
    expect(s.activeRevisionPreview).toBeNull();
    expect(s.steeringDraft).toBeNull();
  });
});
