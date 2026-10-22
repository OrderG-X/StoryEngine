/**
 * 切章不换对话：对话跟着会话走、不跟章走（重构 P5：对话单独一块 chatStore，切章根本不碰它）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProjectNavigation } from "./useProjectNavigation.js";
import { createStoryProjectFromDraft, fetchStateOverview } from "../api/client.js";
import { fetchChapterPaper, type ChapterPaper } from "../api/workingDraftClient.js";
import { listChatSessions } from "../api/chatSessionsClient.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { ChapterNavItem } from "../types.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, isWorkspaceBusy, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

const saveAll = vi.hoisted(() => ({ flushAllSaves: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; error: string }) }));
vi.mock("../sync/saveAll.js", () => saveAll);
function setAutosaveFlusher(impl: (() => Promise<{ ok: true } | { ok: false; error: string }>) | null): void {
  saveAll.flushAllSaves.mockImplementation(impl ?? (async () => ({ ok: true })));
}

const emptyPaper = (chapter: number): ChapterPaper => ({ chapter, draft: null, committed: null, editedSinceCommit: null });

const recentBooksState = vi.hoisted(() => ({ books: [] as any[] }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* ---- mock 外部 API 与工具 ---- */

vi.mock("../api/workingDraftClient.js", () => ({
  fetchChapterPaper: vi.fn(async (_projectPath: string, chapter: number) => emptyPaper(chapter)),
}));

vi.mock("../api/client.js", () => ({
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

vi.mock("../api/chatSessionsClient.js", () => ({
  listChatSessions: vi.fn(async () => null),
  readChatSession: vi.fn(async () => null),
  saveChatSessionMessages: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../api/stateOverviewAdapter.js", () => ({
  workspaceFromStateOverview: vi.fn(() => mockWorkspaceData),
}));

vi.mock("../utils/routing.js", () => ({
  pushWorkspaceUrlForProject: vi.fn(),
  pushWorkspaceUrlForBook: vi.fn(),
  pushHomeUrl: vi.fn(),
}));

vi.mock("../stores/recentBooksStore.js", () => ({
  useRecentBooksStore: vi.fn((selector: (state: { books: readonly unknown[] }) => unknown) => selector({ books: recentBooksState.books })),
}));

/* ---- 测试章节 ---- */

const ch2: ChapterNavItem = { id: "ch-2", chapterNumber: 2, title: "第二章", status: "planned" };

describe("Task 6: 切章不换 messages（聊天跟着会话走、不跟章走）", () => {
  let setWorkspaceSpy: ReturnType<typeof vi.spyOn>;
  let setMessagesSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWorkspaceOperationForTests();
    recentBooksState.books = [];
    useDraftStore.getState().reset();
    // 设置 navigationStore 有 projectPath（openChapterWorkspace 依赖）
    useNavigationStore.setState({ projectPath: "/tmp/test-book" });
    // 设置 workspace 初始状态，带真实 messages（确保切章前有聊天记录）
    useBookStore.getState().setWorkspace(mockWorkspaceData);
    useChatStore.getState().setMessages([
      { id: "msg-before-chapter-switch", role: "user", content: "切章前这条消息应当保留" },
      { id: "msg-resp", role: "assistant", content: "好的。" },
    ]);
    useChatStore.setState({ chatLoading: false });
    useUiStore.setState({ draftActionLoading: null });
    setAutosaveFlusher(async () => ({ ok: true }));
    // spy 必须在切章调用之前设置
    setWorkspaceSpy = vi.spyOn(useBookStore.getState(), "setWorkspace");
    setMessagesSpy = vi.spyOn(useChatStore.getState(), "setMessages");
  });

  afterEach(() => {
    setAutosaveFlusher(null);
    resetWorkspaceOperationForTests();
    setWorkspaceSpy.mockRestore();
    setMessagesSpy.mockRestore();
    vi.clearAllMocks();
    vi.mocked(fetchChapterPaper).mockImplementation(async (_projectPath: string, chapter: number) => emptyPaper(chapter));
  });

  it("切章不改对话（不调 setMessages）", async () => {
    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    await act(async () => {
      await result.current.openChapterWorkspace(ch2);
    });

    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(2);
    expect(setMessagesSpy).not.toHaveBeenCalled();
  });

  it("切章后 store 里的 messages 与切章前相同（聊天保持不动）", async () => {
    const messagesBefore = useChatStore.getState().messages;

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    await act(async () => {
      await result.current.openChapterWorkspace(ch2);
    });

    // 切章后 store 里 messages 与切章前一致（引用相同）
    expect(useChatStore.getState().messages).toBe(messagesBefore);
  });

  it("切章把那一章盘上的稿子交给稿纸（重构 P5：稿子只有一个主人）", async () => {
    vi.mocked(fetchChapterPaper).mockResolvedValueOnce({
      chapter: 2,
      draft: { chapter: 2, title: "第二章 雨夜", body: "第二章盘上的稿子", version: "v-2" },
      committed: null,
      editedSinceCommit: null,
    } as ChapterPaper);
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.openChapterWorkspace(ch2); });

    expect(fetchChapterPaper).toHaveBeenCalledWith("/tmp/test-book", 2);
    expect(useDraftStore.getState()).toMatchObject({ chapter: 2, body: "第二章盘上的稿子", baseVersion: "v-2" });
    expect(useBookStore.getState().workspace.flowStatus).toBe("draft_ready");
    expect(useBookStore.getState().workspace.currentChapter.title).toBe("第二章 雨夜");
  });

  it("clears old sessions across home and new-book creation, and never keeps chat in browser storage", async () => {
    useNavigationStore.setState({ projectPath: "/tmp/book-a", workspaceReady: true });
    useChatStore.setState({
      sessions: [{ id: "session-a", name: "A", updatedAt: "t" }],
      activeSessionId: "session-a",
      activeArchivedCount: 4,
    });
    useChatStore.getState().setMessages([{ id: "a-message", role: "user", content: "A only" }]);
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    vi.mocked(createStoryProjectFromDraft).mockResolvedValueOnce({ projectDir: "/tmp/book-b", overview });
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.openHome(); });
    expect(useChatStore.getState()).toMatchObject({ activeSessionId: "", activeArchivedCount: 0, sessions: [] });
    await act(async () => { await result.current.handleCreateBook({ title: "B" } as never); });
    expect(useChatStore.getState()).toMatchObject({ activeSessionId: "", activeArchivedCount: 0, sessions: [] });
    expect(useChatStore.getState().messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "a-message" })]),
    );
    // 对话只存会话文件，浏览器里不另存一份（重构 P5）。
    expect(Object.keys(window.sessionStorage).filter((key) => key.startsWith("se-ng-chat-messages:"))).toEqual([]);
  });

  it("新建书引导会话索引并接上全局对话记忆上限（修「首聊不入会话盘 + 上限停 96k 默认」）", async () => {
    useChatStore.setState({ chatHistoryBudget: 96000, sessions: [], activeSessionId: "" });
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    vi.mocked(createStoryProjectFromDraft).mockResolvedValueOnce({ projectDir: "/tmp/book-with-session", overview });
    vi.mocked(listChatSessions).mockResolvedValueOnce({
      ok: true,
      index: { sessions: [{ id: "session-boot", name: "新会话", updatedAt: "t" }], activeSessionId: "session-boot" },
      chatHistoryBudgetTokens: 300000,
    } as never);
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.handleCreateBook({ title: "带会话的新书" } as never); });

    expect(useNavigationStore.getState().projectPath).toBe("/tmp/book-with-session");
    // activeSessionId 必须是引导出的真实会话：空串会让聊天自动保存跳过会话落盘（重启即丢首聊历史）
    expect(useChatStore.getState().activeSessionId).toBe("session-boot");
    expect(useChatStore.getState().sessions).toHaveLength(1);
    // 全局记忆上限接上，不再停留在 store 默认 96k
    expect(useChatStore.getState().chatHistoryBudget).toBe(300000);
  });

  it("clears sessions when opening a non-project recent book", async () => {
    recentBooksState.books = [{
      id: "mock-book", title: "Mock", genre: "测试", currentChapterTitle: "第一章", currentChapterNumber: 1,
      protagonistName: "主角", status: "草稿中", updatedAt: "刚刚", logline: "", writtenChapters: 0,
      totalWords: 0, projectPath: "/mock/book",
    }];
    useChatStore.setState({
      sessions: [{ id: "session-a", name: "A", updatedAt: "t" }],
      activeSessionId: "session-a",
      activeArchivedCount: 2,
    });
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() }, countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.openRecentBook("mock-book"); });

    expect(useChatStore.getState()).toMatchObject({
      sessions: [], activeSessionId: "", activeArchivedCount: 0,
    });
  });

  it("failed old-chapter flush blocks chapter navigation and releases the transition", async () => {
    setAutosaveFlusher(async () => ({ ok: false, error: "disk full" }));
    vi.mocked(fetchChapterPaper).mockClear();
    const chapterBefore = useBookStore.getState().workspace.currentChapter.chapterNumber;
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.openChapterWorkspace(ch2); });

    expect(fetchChapterPaper).not.toHaveBeenCalled();
    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(chapterBefore);
    expect(useNavigationStore.getState().toast).toContain("保存失败");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("failed old-project flush blocks opening another project before any target read", async () => {
    setAutosaveFlusher(async () => ({ ok: false, error: "network down" }));
    vi.mocked(fetchStateOverview).mockClear();
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    let opened = true;
    await act(async () => { opened = await result.current.openProject("/tmp/new-book"); });

    expect(opened).toBe(false);
    expect(fetchStateOverview).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/test-book");
    expect(useNavigationStore.getState().toast).toContain("保存失败");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("failed flush keeps the workspace open instead of returning home", async () => {
    setAutosaveFlusher(async () => ({ ok: false, error: "permission denied" }));
    useNavigationStore.setState({ projectPath: "/tmp/test-book", workspaceReady: true });
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.openHome(); });

    expect(useNavigationStore.getState().projectPath).toBe("/tmp/test-book");
    expect(useNavigationStore.getState().workspaceReady).toBe(true);
    expect(useNavigationStore.getState().toast).toContain("保存失败");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("opening a different book never reuses messages from the old book when backend history is unavailable", async () => {
    useChatStore.getState().setMessages([{ id: "old-book-secret", role: "user", content: "只属于旧书" }]);
    const { result } = renderHook(() => useProjectNavigation({
      bookManagement: { upsertRecentBook: vi.fn() },
      countTextWords: (text) => text.length,
    }));

    await act(async () => { await result.current.openProject("/tmp/different-book"); });

    expect(useChatStore.getState().messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "old-book-secret" })]),
    );
    expect(useChatStore.getState().sessions).toEqual([]);
    expect(useChatStore.getState().activeSessionId).toBe("");
  });

  it("direct generation in flight blocks chapter navigation before reading the target", async () => {
    useChatStore.setState({ activeSessionId: "session-a" });
    useUiStore.setState({ draftActionLoading: "generate-draft" });
    beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: "session-a",
    });
    vi.mocked(fetchChapterPaper).mockClear();

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    await act(async () => {
      await result.current.openChapterWorkspace(ch2);
    });

    expect(fetchChapterPaper).not.toHaveBeenCalled();
    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).not.toBe(2);
    expect(useNavigationStore.getState().toast).toContain("正在进行");
  });

  it("chapter transition owns the slot while fetch is in flight and then switches safely", async () => {
    const gate = deferred<ChapterPaper>();
    vi.mocked(fetchChapterPaper).mockReturnValueOnce(gate.promise as never);

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let transition!: Promise<void>;
    act(() => { transition = result.current.openChapterWorkspace(ch2); });
    await vi.waitFor(() => expect(fetchChapterPaper).toHaveBeenCalled());

    const intruder = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useChatStore.getState().activeSessionId,
    });
    if (intruder) finishWorkspaceOperation(intruder);
    expect(intruder).toBeNull();

    gate.resolve(emptyPaper(2));
    await act(async () => transition);
    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(2);
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("direct generation in flight blocks switching to another project", async () => {
    useChatStore.setState({ activeSessionId: "session-a" });
    useUiStore.setState({ draftActionLoading: "generate-draft" });
    beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: "session-a",
    });
    vi.mocked(fetchStateOverview).mockClear();

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let opened = true;
    await act(async () => {
      opened = await result.current.openProject("/tmp/other-book");
    });

    expect(opened).toBe(false);
    expect(fetchStateOverview).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/test-book");
    expect(useNavigationStore.getState().toast).toContain("正在进行");
  });

  it("project transition owns the slot across overview/session awaits and then releases after sync", async () => {
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    vi.mocked(fetchStateOverview).mockClear();
    const gate = deferred<typeof overview>();
    vi.mocked(fetchStateOverview).mockReturnValueOnce(gate.promise as never);

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );
    let transition!: Promise<boolean>;
    act(() => { transition = result.current.openProject("/tmp/new-book"); });
    await vi.waitFor(() => expect(fetchStateOverview).toHaveBeenCalled());

    const intruder = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useChatStore.getState().activeSessionId,
    });
    if (intruder) finishWorkspaceOperation(intruder);
    expect(intruder).toBeNull();

    gate.resolve(overview);
    await act(async () => transition);
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/new-book");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("book creation owns the transition slot, rejects writer/navigation races, and commits once when the late response arrives", async () => {
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    vi.mocked(fetchStateOverview).mockClear();
    const gate = deferred<{ projectDir: string; overview: typeof overview }>();
    vi.mocked(createStoryProjectFromDraft).mockReturnValueOnce(gate.promise as never);
    vi.mocked(fetchChapterPaper).mockClear();

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let creation!: Promise<void>;
    act(() => { creation = result.current.handleCreateBook({ title: "慢创建" } as never); });
    await vi.waitFor(() => expect(createStoryProjectFromDraft).toHaveBeenCalledTimes(1));

    const writer = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useChatStore.getState().activeSessionId,
    });
    if (writer) finishWorkspaceOperation(writer);
    expect(writer).toBeNull();

    await act(async () => { await result.current.openChapterWorkspace(ch2); });
    expect(fetchChapterPaper).not.toHaveBeenCalledWith("/tmp/test-book", 2);

    gate.resolve({ projectDir: "/tmp/created-book", overview });
    await act(async () => creation);

    expect(useNavigationStore.getState().projectPath).toBe("/tmp/created-book");
    expect(setWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("book creation failure releases the transition slot", async () => {
    const gate = deferred<never>();
    vi.mocked(createStoryProjectFromDraft).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let creation!: Promise<void>;
    act(() => { creation = result.current.handleCreateBook({ title: "失败创建" } as never); });
    await vi.waitFor(() => expect(createStoryProjectFromDraft).toHaveBeenCalledTimes(1));
    const during = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useChatStore.getState().activeSessionId,
    });
    if (during) finishWorkspaceOperation(during);
    expect(during).toBeNull();

    gate.reject(new Error("create failed"));
    await act(async () => creation);

    expect(isWorkspaceBusy()).toBe(false);
    expect(useNavigationStore.getState().toast).toContain("创建失败");
    const after = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/test-book",
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useChatStore.getState().activeSessionId,
    });
    expect(after).not.toBeNull();
    if (after) finishWorkspaceOperation(after);
  });

  it("book creation drops a late response after the origin identity changes", async () => {
    const overview = await vi.mocked(fetchStateOverview)({ projectPath: "/tmp/fixture" } as never);
    const gate = deferred<{ projectDir: string; overview: typeof overview }>();
    vi.mocked(createStoryProjectFromDraft).mockReturnValueOnce(gate.promise as never);
    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let creation!: Promise<void>;
    act(() => { creation = result.current.handleCreateBook({ title: "迟到创建" } as never); });
    await vi.waitFor(() => expect(createStoryProjectFromDraft).toHaveBeenCalledTimes(1));
    useNavigationStore.setState({ projectPath: "/tmp/replacement-book" });
    gate.resolve({ projectDir: "/tmp/late-created-book", overview });
    await act(async () => creation);

    expect(useNavigationStore.getState().projectPath).toBe("/tmp/replacement-book");
    expect(setWorkspaceSpy).not.toHaveBeenCalled();
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("章节稿子读取失败时保留旧工作区，不进入新章节的 ready/save 状态", async () => {
    vi.mocked(fetchChapterPaper).mockRejectedValueOnce(new Error("paper unavailable"));
    useNavigationStore.setState({ workspaceReady: true });
    const workspaceBefore = useBookStore.getState().workspace;

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    await act(async () => {
      await result.current.openChapterWorkspace(ch2);
    });

    expect(setWorkspaceSpy).not.toHaveBeenCalled();
    expect(useBookStore.getState().workspace).toBe(workspaceBefore);
    expect(useNavigationStore.getState().workspaceReady).toBe(true);
  });

  it("打开项目时当前章稿子读取失败应保留旧工作区，不把新项目标记为 ready", async () => {
    vi.mocked(fetchChapterPaper).mockRejectedValueOnce(new Error("paper unavailable"));
    useNavigationStore.setState({ projectPath: "/tmp/old-book", workspaceReady: true });
    const workspaceBefore = useBookStore.getState().workspace;

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let opened = true;
    await act(async () => {
      opened = await result.current.openProject("/tmp/new-book");
    });

    expect(opened).toBe(false);
    expect(setWorkspaceSpy).not.toHaveBeenCalled();
    expect(useBookStore.getState().workspace).toBe(workspaceBefore);
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/old-book");
    expect(useNavigationStore.getState().workspaceReady).toBe(true);
  });

  it("打开项目同步提交阶段抛错时仍清除 loading 并释放 transition", async () => {
    setWorkspaceSpy.mockImplementationOnce(() => { throw new Error("staging failed"); });
    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let opened = true;
    await act(async () => {
      opened = await result.current.openProject("/tmp/staging-error-book");
    });

    expect(opened).toBe(false);
    expect(useNavigationStore.getState().openProjectLoading).toBe(false);
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("打开空书时空稿纸仍可正常进入工作区", async () => {

    const { result } = renderHook(() =>
      useProjectNavigation({
        bookManagement: { upsertRecentBook: vi.fn() },
        countTextWords: (t) => t.split(/\s+/).filter(Boolean).length,
      }),
    );

    let opened = false;
    await act(async () => {
      opened = await result.current.openProject("/tmp/empty-book");
    });

    expect(opened).toBe(true);
    expect(setWorkspaceSpy).toHaveBeenCalled();
    expect(useNavigationStore.getState().projectPath).toBe("/tmp/empty-book");
    expect(useNavigationStore.getState().workspaceReady).toBe(true);
  });
});
