import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listChatSessions,
  archiveChatSession,
  readChatSession,
  saveChatSessionMessages,
  setChatSessionSaveSkippedNotifier,
  __resetChatSessionsClientForTests,
} from "./chatSessionsClient.js";

afterEach(() => {
  __resetChatSessionsClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chatSessionsClient", () => {
  it("list 命中 GET /api/chat-sessions?list=1", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, index: { sessions: [], activeSessionId: "x" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await listChatSessions("/p");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    expect(calls[0][0]).toContain("/api/chat-sessions?list=1");
    expect(r.index.activeSessionId).toBe("x");
  });

  it("archive 用 PUT + action:archive", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, archivedCount: 5, tokensBefore: 100, tokensAfter: 40 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await archiveChatSession("/p", "sid");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).action).toBe("archive");
    expect(r.archivedCount).toBe(5);
  });

  // UI 审计 T1 / A-1：未登记 epoch 的会话（本次运行从未成功加载）save 必须短路——
  // 但绝不静默：console.warn 之外还要发一次性 UI 信号（autosave 350ms 防抖会反复撞短路，按会话去重不刷屏）。
  it("未登记 epoch：save 短路不发 PUT，UI 信号每会话只报一次", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const notifier = vi.fn();
    setChatSessionSaveSkippedNotifier(notifier);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const messages = [{ id: "u-1", role: "user", content: "第一句" }];
    await saveChatSessionMessages("/p-unregistered", "s-x", messages);
    await saveChatSessionMessages("/p-unregistered", "s-x", messages);
    await saveChatSessionMessages("/p-unregistered", "s-x", messages);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith({ projectPath: "/p-unregistered", id: "s-x" });
    expect(warnSpy).toHaveBeenCalled();
  });

  // 同一短链路在 epoch 登记后必须真正落盘——这正是 handleCreateBook 补 readChatSession 的意义。
  it("readChatSession 登记 epoch 后：save 真发 PUT 并带 windowEpoch，无告警信号", async () => {
    const session = { id: "s-y", name: "默认会话", messages: [], archivedCount: 0, createdAt: "t", updatedAt: "t", windowEpoch: 3 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, session }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const notifier = vi.fn();
    setChatSessionSaveSkippedNotifier(notifier);

    await readChatSession("/p-registered", "s-y");
    await saveChatSessionMessages("/p-registered", "s-y", [{ id: "u-1", role: "user", content: "第一句" }]);

    const putCalls = (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][]).filter(([, init]) => init?.method === "PUT");
    expect(putCalls).toHaveLength(1);
    const body = JSON.parse(String(putCalls[0][1]?.body));
    expect(body).toMatchObject({ action: "save", projectPath: "/p-registered", id: "s-y", windowEpoch: 3 });
    expect(body.messages).toHaveLength(1);
    expect(notifier).not.toHaveBeenCalled();
  });
});
