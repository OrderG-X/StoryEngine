import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMessage } from "../types.js";

const projectKey = "/Users/author/tmp/story-engine-chat-refresh";
const storageKey = `se-ng-chat-messages:${projectKey}`;

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

  it("hydrates project-scoped chat messages when the project key becomes available after reload", async () => {
    const persistedMessages: readonly ChapterMessage[] = [
      { id: "user-refresh", role: "user", content: "把苏晓薇当前目标改成保护主角" },
      { id: "assistant-refresh", role: "assistant", content: "已更新苏晓薇的角色资料。" },
    ];
    window.sessionStorage.setItem(storageKey, JSON.stringify(persistedMessages));
    const { setProjectKey, useWorkspaceStore } = await import("./workspaceStore.js");

    useWorkspaceStore.getState().setWorkspace({
      ...useWorkspaceStore.getState().workspace,
      messages: [{ id: "assistant-workflow-idle-1", role: "assistant", content: "我已读取当前故事状态。" }],
    });
    setProjectKey(projectKey);

    expect(useWorkspaceStore.getState().workspace.messages).toEqual(persistedMessages);
  });

  it("persists replacement chat messages written through updateWorkspace", async () => {
    const replacementMessages: readonly ChapterMessage[] = [
      { id: "user-replacement", role: "user", content: "主角名字改成林远" },
      { id: "assistant-replacement", role: "assistant", content: "已把主角名改为林远。" },
    ];
    const { setProjectKey, useWorkspaceStore, flushPendingMessageSave } = await import("./workspaceStore.js");

    setProjectKey(projectKey);
    useWorkspaceStore.getState().updateWorkspace({ messages: replacementMessages });
    // 写入已节流（见下一段 describe）：落盘前必须冲盘，否则读到的是旧值。
    flushPendingMessageSave();

    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]")).toEqual(replacementMessages);
  });
});

describe("消息持久化节流（流式逐 token 整历史 JSON.stringify 不卡主线程）", () => {
  const msgs = (n: number): ChapterMessage[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, role: "user", content: `第${i}条` }) as ChapterMessage);

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续写入被合并：节流窗口内不落盘，到点只写最终状态", async () => {
    const { setProjectKey, useWorkspaceStore } = await import("./workspaceStore.js");
    setProjectKey(projectKey);
    for (let i = 1; i <= 20; i += 1) {
      useWorkspaceStore.getState().updateWorkspace({ messages: msgs(i) });
    }
    // 20 次写入只排了一个计时器；窗口内 sessionStorage 仍是空的（不能读到半截中间态）
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    vi.advanceTimersByTime(250);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]")).toEqual(msgs(20));
  });

  it("flushPendingMessageSave 同步落盘，撤销重载前必须调它", async () => {
    const { setProjectKey, useWorkspaceStore, flushPendingMessageSave } = await import("./workspaceStore.js");
    setProjectKey(projectKey);
    useWorkspaceStore.getState().updateWorkspace({ messages: msgs(3) });
    flushPendingMessageSave();
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]")).toEqual(msgs(3));
    // 冲盘后计时器已取消 + 待写值已清：推进时间不再重复写
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]")).toEqual(msgs(3));
  });

  it("冲盘后节流照常工作（下一次写入重新排期）", async () => {
    const { setProjectKey, useWorkspaceStore, flushPendingMessageSave } = await import("./workspaceStore.js");
    setProjectKey(projectKey);
    useWorkspaceStore.getState().updateWorkspace({ messages: msgs(2) });
    flushPendingMessageSave();
    useWorkspaceStore.getState().updateWorkspace({ messages: msgs(5) });
    vi.advanceTimersByTime(250);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]")).toEqual(msgs(5));
  });

  it("切项目前把上一项目的待写尾巴落盘（写的是它自己的 key，不污染新项目）", async () => {
    const { setProjectKey, useWorkspaceStore } = await import("./workspaceStore.js");
    setProjectKey(projectKey);
    useWorkspaceStore.getState().updateWorkspace({ messages: msgs(2) });
    const otherKey = "/Users/author/tmp/other-project";
    setProjectKey(otherKey); // 内部先 flush 旧 key，再切
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]")).toEqual(msgs(2));
    expect(window.sessionStorage.getItem(`se-ng-chat-messages:${otherKey}`)).toBeNull();
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
    store.setPendingDirectEditInstruction("改这段");
    expect(useWorkspaceStore.getState().draftCandidates).not.toBeNull();

    useWorkspaceStore.getState().resetTransientWorkspaceState();

    const s = useWorkspaceStore.getState();
    expect(s.draftCandidates).toBeNull();
    expect(s.commitPreviewReport).toBeNull();
    expect(s.draftAIReview).toBeNull();
    expect(s.activeRevisionTask).toBeNull();
    expect(s.activeRevisionPreview).toBeNull();
    expect(s.steeringDraft).toBeNull();
    expect(s.pendingDirectEditInstruction).toBeNull();
  });
});
