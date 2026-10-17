import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMessage } from "../types.js";

const msgs: ChapterMessage[] = [
  { id: "u1", role: "user", content: "你好" },
  { id: "a1", role: "assistant", content: "在的" },
];

describe("chatStore 初始对话", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it("初始对话是空的，不带演示书的种子消息", async () => {
    const { useChatStore } = await import("./chatStore.js");
    const messages = useChatStore.getState().messages;
    // 演示种子（msg-001/msg-002，「地下车库/无线电」）绝不能成为初始对话，否则会漏进真书。
    expect(messages.some((m) => m.id === "msg-001" || m.id === "msg-002")).toBe(false);
    expect(messages.some((m) => m.content.includes("地下车库") || m.content.includes("无线电"))).toBe(false);
  });

  it("对话不在浏览器里另存一份（重构 P5：只存项目里的会话文件）", async () => {
    const { useChatStore } = await import("./chatStore.js");
    useChatStore.getState().setMessages([{ id: "user-1", role: "user", content: "写第一章" }]);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("chatStore clearChat / undoClearChat", () => {
  beforeEach(async () => {
    const { useChatStore } = await import("./chatStore.js");
    useChatStore.getState().setMessages(msgs);
    if (useChatStore.getState().clearedChatBackup) useChatStore.getState().undoClearChat();
  });

  it("清空：messages 置空，并备份原对话以供撤销", async () => {
    const { useChatStore } = await import("./chatStore.js");
    useChatStore.getState().clearChat();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().clearedChatBackup).toEqual(msgs);
  });

  it("撤销：恢复刚才清空的对话，备份清掉", async () => {
    const { useChatStore } = await import("./chatStore.js");
    useChatStore.getState().clearChat();
    useChatStore.getState().undoClearChat();
    expect(useChatStore.getState().messages).toEqual(msgs);
    expect(useChatStore.getState().clearedChatBackup).toBeNull();
  });

  it("已经是空对话 → 清空是 no-op，不产生可撤销备份", async () => {
    const { useChatStore } = await import("./chatStore.js");
    useChatStore.getState().setMessages([]);
    useChatStore.getState().clearChat();
    expect(useChatStore.getState().clearedChatBackup).toBeNull();
  });

  it("清空后继续对话（append）→ 撤销入口消失（备份清掉）", async () => {
    const { useChatStore } = await import("./chatStore.js");
    useChatStore.getState().clearChat();
    expect(useChatStore.getState().clearedChatBackup).not.toBeNull();
    useChatStore.getState().appendMessage({ id: "u2", role: "user", content: "继续" });
    expect(useChatStore.getState().clearedChatBackup).toBeNull();
  });
});

describe("chatStore 会话状态", () => {
  it("setSessions / setActiveSessionId / setActiveArchivedCount", async () => {
    const { useChatStore } = await import("./chatStore.js");
    const s = useChatStore.getState();
    s.setSessions([{ id: "a", name: "A", updatedAt: "t" }], "a");
    expect(useChatStore.getState().activeSessionId).toBe("a");
    s.setActiveArchivedCount(3);
    expect(useChatStore.getState().activeArchivedCount).toBe(3);
  });
});
