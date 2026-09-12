/**
 * UI 审计 T1 / A-1 验收测试：新建书首开期间聊天必须落盘。
 *
 * 根因：handleCreateBook 只调 listChatSessions，从不 readChatSession → 活跃会话的 windowEpoch
 * 未登记 → saveChatSessionMessages / beacon 因「本次运行未成功加载过该会话」双双短路，
 * 聊了一整场一个字都不落盘（真机实测会话文件 messages=0）。
 *
 * 与 useProjectNavigation.sessions.test.tsx 的差别：这里**不 mock chatSessionsClient**，
 * 用真实客户端 + fetch 桩，端到端验证「建书 → 发消息 → autosave 终末一步真调 PUT save」。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProjectNavigation } from "./useProjectNavigation.js";
import { createStoryProjectFromDraft, fetchStateOverview } from "../api/client.js";
import {
  saveChatSessionMessages,
  setChatSessionSaveSkippedNotifier,
  __resetChatSessionsClientForTests,
} from "../api/chatSessionsClient.js";
import { setProjectKey, useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData, mockSidebarData } from "../mockData.js";
import { resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";
import { setAutosaveFlusher } from "../utils/autosaveControl.js";
import { resetWorkspaceRevisionTrackerForTests } from "../utils/workspaceRevisionTracker.js";

vi.mock("../api/client.js", () => ({
  fetchChapterWorkspace: vi.fn(async () => null),
  fetchStateOverview: vi.fn(async () => ({
    project: { title: "测试书", genre: "测试", currentChapter: 1 },
    storyStatus: {},
    characters: { knownCharacters: [] },
    world: { activeLocations: [], importantFacts: [] },
    timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
    hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
    threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, keyOpenItems: [] },
    arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
    maintenance: {
      diagnosticsAvailable: false,
      cleanupVisibleCount: 0,
      markDoneCandidateCount: 0,
      mergeDisabled: true,
      dropDisabled: true,
      confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
    },
    uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
  })),
  createStoryProjectFromDraft: vi.fn(),
}));

vi.mock("../api/stateOverviewAdapter.js", () => ({
  sidebarFromStateOverview: vi.fn(() => mockSidebarData),
  workspaceFromStateOverview: vi.fn(() => mockWorkspaceData),
}));

vi.mock("../utils/routing.js", () => ({
  pushWorkspaceUrlForProject: vi.fn(),
  pushWorkspaceUrlForBook: vi.fn(),
  pushHomeUrl: vi.fn(),
}));

vi.mock("../utils/undoReloadFlag.js", () => ({
  consumeUndoReloadPreferSession: vi.fn(() => false),
}));

vi.mock("../stores/recentBooksStore.js", () => ({
  useRecentBooksStore: vi.fn((selector: (state: { books: readonly unknown[] }) => unknown) => selector({ books: [] })),
}));

const SESSION = { id: "s-boot", name: "默认会话", messages: [], archivedCount: 0, createdAt: "t", updatedAt: "t", windowEpoch: 0 };
const INDEX = { sessions: [{ id: "s-boot", name: "默认会话", updatedAt: "t" }], activeSessionId: "s-boot" };

/** fetch 桩：list/read 走 GET，save 走 PUT；readOk=false 时读会话直接 500（readChatSession 抛错）。 */
function stubChatSessionsFetch(options: { readonly readOk?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("list=1")) {
      return new Response(JSON.stringify({ ok: true, index: INDEX, chatHistoryBudgetTokens: 300000 }), { status: 200 });
    }
    if (url.includes("session=")) {
      if (options.readOk === false) {
        return new Response(JSON.stringify({ ok: false, error: "disk io error" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, session: SESSION }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: `unrouted ${url}` }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function putBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][])
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe("UI审计 T1：新建书首开期间聊天落盘", () => {
  beforeEach(() => {
    resetWorkspaceOperationForTests();
    resetWorkspaceRevisionTrackerForTests();
    __resetChatSessionsClientForTests();
    window.sessionStorage.clear();
    setProjectKey("/tmp/test-book");
    useNavigationStore.setState({ projectPath: "/tmp/test-book", toast: null });
    useWorkspaceStore.getState().setWorkspace(mockWorkspaceData);
    useWorkspaceStore.setState({ chatLoading: false, steeringLoading: false, draftActionLoading: null, sessions: [], activeSessionId: "" });
    setAutosaveFlusher(async () => ({ ok: true }));
    vi.mocked(createStoryProjectFromDraft).mockReset();
  });

  afterEach(() => {
    setAutosaveFlusher(null);
    setChatSessionSaveSkippedNotifier(null);
    __resetChatSessionsClientForTests();
    resetWorkspaceOperationForTests();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    setProjectKey(null);
  });

  it("建书→发消息→autosave 终末一步真调 PUT save（epoch 已由 handleCreateBook 登记）", async () => {
    const fetchMock = stubChatSessionsFetch();
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    vi.mocked(createStoryProjectFromDraft).mockResolvedValueOnce({ projectDir: "/tmp/t1-persist-book", overview });
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.handleCreateBook({ title: "落盘验证书" } as never); });

    // 开书成功、会话索引接上
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/t1-persist-book");
    expect(useWorkspaceStore.getState().activeSessionId).toBe("s-boot");
    // 建书过程必须真的读过活跃会话（epoch 登记的来源；只 list 不读就是本次 bug）
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("session="))).toBe(true);
    expect(useNavigationStore.getState().toast).toContain("已创建并打开");
    expect(useNavigationStore.getState().toast).not.toContain("初始化失败");

    // 模拟用户聊了一回合：消息进 store（autosave 要持久化的对象就是它）
    useWorkspaceStore.getState().updateWorkspace({
      messages: [
        { id: "user-1", role: "user", content: "主角叫林晚" },
        { id: "assistant-1", role: "assistant", content: "好，已记住。" },
      ],
    });

    // autosave 链路的终末一步（App.tsx persistCapturedAutosavePayload 的 saveSession）
    await saveChatSessionMessages("/tmp/t1-persist-book", "s-boot", useWorkspaceStore.getState().workspace.messages);

    const saves = putBodies(fetchMock).filter((body) => body.action === "save");
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ projectPath: "/tmp/t1-persist-book", id: "s-boot", windowEpoch: 0 });
    expect(saves[0]?.messages).toHaveLength(2);
  });

  it("会话读取失败：不阻塞开书但有可见信号（toast），且后续 save 短路只报一次 UI 信号", async () => {
    const fetchMock = stubChatSessionsFetch({ readOk: false });
    const notifier = vi.fn();
    setChatSessionSaveSkippedNotifier(notifier);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    vi.mocked(createStoryProjectFromDraft).mockResolvedValueOnce({ projectDir: "/tmp/t1-readfail-book", overview });
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.handleCreateBook({ title: "读失败书" } as never); });

    // 开书不被阻塞，但 toast 如实告警（且不被成功 toast 盖掉）
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/t1-readfail-book");
    expect(useNavigationStore.getState().toast).toContain("聊天会话初始化失败");

    // epoch 未登记 → autosave 终末一步短路：不发 PUT，但发一次性 UI 信号（不随每次 autosave 刷屏）
    await saveChatSessionMessages("/tmp/t1-readfail-book", "s-boot", [{ id: "user-1", role: "user", content: "第一句" }]);
    await saveChatSessionMessages("/tmp/t1-readfail-book", "s-boot", [{ id: "user-1", role: "user", content: "第一句" }]);

    expect(putBodies(fetchMock).filter((body) => body.action === "save")).toHaveLength(0);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith({ projectPath: "/tmp/t1-readfail-book", id: "s-boot" });
    warnSpy.mockRestore();
  });
});
