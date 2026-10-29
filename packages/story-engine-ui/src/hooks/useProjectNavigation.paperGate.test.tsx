// @vitest-environment jsdom
/**
 * 换书、回书架、换章：等的这会儿作者在原来那章又打了字，换稿纸之前先存完（第 5 轮复核 S6/S7）。真 hook、真存稿调度，服务端用替身。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProjectNavigation } from "./useProjectNavigation.js";
import { fetchStateOverview, importBookProject } from "../api/client.js";
import { fetchChapterPaper, saveWorkingDraft, type ChapterPaper } from "../api/workingDraftClient.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import { resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";
import { __resetDraftSyncForTests, editDraft, flushDraftSave } from "../drafts/draftSync.js";
import { saveChatNow } from "../sync/chatSync.js";

const emptyPaper = (chapter: number): ChapterPaper => ({ chapter, draft: null, committed: null, editedSinceCommit: null });

const recentBooksState = vi.hoisted(() => ({ books: [] as unknown[] }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* ---- mock 外部 API 与工具 ---- */

vi.mock("../api/workingDraftClient.js", () => ({
  saveWorkingDraft: vi.fn(async () => ({ ok: true, version: "v2", unchanged: false })),
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
    uiHints: { warnings: [] },
  })),
  createStoryProjectFromDraft: vi.fn(),
  importBookProject: vi.fn(),
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

vi.mock("../sync/chatSync.js", () => ({ saveChatNow: vi.fn(async () => ({ ok: true })), markChatLoaded() {} }));
beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceOperationForTests();
  __resetDraftSyncForTests();
  vi.mocked(saveWorkingDraft).mockImplementation(async () => ({ ok: true, version: "v2", unchanged: false }));
  useNavigationStore.setState({ projectPath: "/virtual-old-book", workspaceReady: true });
  useBookStore.getState().setWorkspace(mockWorkspaceData);
  useChatStore.setState({ chatLoading: false, messages: [], activeSessionId: "old-session" });
  useDraftStore.getState().loadPaper("/virtual-old-book", { ...emptyPaper(3), draft: { chapter: 3, body: "旧书原稿。", version: "v1" }, draftVersion: "v1" });
});
afterEach(() => { __resetDraftSyncForTests(); resetWorkspaceOperationForTests(); vi.restoreAllMocks(); });
const navParams = () => ({ bookManagement: { upsertRecentBook: vi.fn() }, countTextWords: (s: string) => s.length });

it("换书读新书那会儿又打的字：先存进旧书再换（第 5 轮 S6）", async () => {
  const entered = deferred<void>();
  const loading = deferred<unknown>();
  const normalOverview = vi.mocked(fetchStateOverview).getMockImplementation()!;
  vi.mocked(fetchStateOverview).mockImplementationOnce(async () => { entered.resolve(); await loading.promise; return normalOverview({ projectPath: "/virtual-new-book" }); });
  const { result, unmount } = renderHook(() => useProjectNavigation(navParams()));
  const unique = "换书加载时新写且尚未保存的句子。";
  await act(async () => {
    const switching = result.current.openProject("/virtual-new-book", { updateUrl: false });
    await entered.promise;
    editDraft(unique);
    loading.resolve({});
    expect(await switching).toBe(true);
    await flushDraftSave();
  });
  unmount();
  expect(useDraftStore.getState().projectPath).toBe("/virtual-new-book");
  expect(vi.mocked(saveWorkingDraft).mock.calls.some(([input]) => input.projectPath === "/virtual-old-book" && input.body === unique)).toBe(true);
});

it("回书架等对话存盘时又打的字：先存上再回（第 5 轮 S7）", async () => {
  const entered = deferred<void>();
  const chat = deferred<{ ok: true }>();
  vi.mocked(saveChatNow).mockImplementationOnce(async () => { entered.resolve(); return chat.promise; });
  const { result, unmount } = renderHook(() => useProjectNavigation(navParams()));
  const unique = "等聊天存盘时继续打的唯一句子。";
  await act(async () => {
    const switching = result.current.openHome({ updateUrl: false });
    await entered.promise;
    for (let n = 0; n < 12; n++) await Promise.resolve();
    editDraft(unique);
    chat.resolve({ ok: true });
    expect(await switching).toBe(true);
    await flushDraftSave();
  });
  unmount();
  expect(useDraftStore.getState().projectPath).toBeNull();
  expect(vi.mocked(saveWorkingDraft).mock.calls.some(([input]) => input.body === unique)).toBe(true);
});

it("换书时那会儿打的字存不上：留在旧书，字还在稿纸上", async () => {
  const entered = deferred<void>();
  const loading = deferred<unknown>();
  const normalOverview = vi.mocked(fetchStateOverview).getMockImplementation()!;
  vi.mocked(fetchStateOverview).mockImplementationOnce(async () => { entered.resolve(); await loading.promise; return normalOverview({ projectPath: "/virtual-new-book" }); });
  vi.mocked(saveWorkingDraft).mockRejectedValue(new Error("写盘失败"));
  const { result, unmount } = renderHook(() => useProjectNavigation(navParams()));
  await act(async () => {
    const switching = result.current.openProject("/virtual-new-book", { updateUrl: false });
    await entered.promise;
    editDraft("存不上的新句。");
    loading.resolve({});
    expect(await switching).toBe(false);
  });
  unmount();
  expect(useDraftStore.getState()).toMatchObject({ projectPath: "/virtual-old-book", chapter: 3, body: "存不上的新句。" });
  expect(useNavigationStore.getState().projectPath).toBe("/virtual-old-book");
});

it("点了换章、那章读不出来：在写作台里说清楚，还在原来那章（第 6 轮 T8）", async () => {
  useNavigationStore.setState({ toast: null, openProjectError: null });
  vi.mocked(fetchChapterPaper).mockRejectedValueOnce(new Error("目标章读取失败"));
  const { result, unmount } = renderHook(() => useProjectNavigation(navParams()));
  await act(async () => { await result.current.openChapterWorkspace({ id: "ch-4", chapterNumber: 4, title: "第四章", status: "planned" }); });
  unmount();
  expect(useNavigationStore.getState().toast ?? "").toContain("目标章读取失败");
  expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "旧书原稿。" });
  expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(mockWorkspaceData.currentChapter.chapterNumber);
});

it("导入好了、头一章读不出来：如实说没打开（不拿空稿冒充），留在原处，书架上有它（第 6 轮 T11）", async () => {
  useNavigationStore.setState({ toast: null, openProjectError: null });
  const overview = await fetchStateOverview({ projectPath: "/virtual-imported-book" });
  vi.mocked(importBookProject).mockResolvedValueOnce({ projectDir: "/virtual-imported-book", overview, chapters: 3 } as Awaited<ReturnType<typeof importBookProject>>);
  vi.mocked(fetchChapterPaper).mockRejectedValueOnce(new Error("导入书的首章读取失败"));
  const params = navParams();
  const { result, unmount } = renderHook(() => useProjectNavigation(params));
  let error = "";
  await act(async () => {
    try { await result.current.handleImportBook({ title: "导入书", files: [{ name: "导入书.txt", text: "# 第一章\n\n已有的正文。" }], include: [true] } as Parameters<typeof result.current.handleImportBook>[0]); }
    catch (thrown) { error = String(thrown); }
  });
  unmount();
  expect(error).toContain("首章读取失败");
  expect(error).toContain("先没打开");
  expect(useNavigationStore.getState().projectPath).toBe("/virtual-old-book");
  expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "旧书原稿。" });
  expect(params.bookManagement.upsertRecentBook).toHaveBeenCalled();
});

it("点开的就是手上这章、读的期间又存过：迟到的旧读数不盖刚存的字", async () => {
  const entered = deferred<void>();
  const late = deferred<ChapterPaper>();
  vi.mocked(fetchChapterPaper).mockImplementationOnce(async () => { entered.resolve(); return late.promise; });
  const { result, unmount } = renderHook(() => useProjectNavigation(navParams()));
  await act(async () => {
    const opening = result.current.openChapterWorkspace({ id: "ch-3", chapterNumber: 3, title: "第三章", status: "current" });
    await entered.promise;
    editDraft("读的期间存好的新字。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    late.resolve({ ...emptyPaper(3), draft: { chapter: 3, body: "旧书原稿。", version: "v1" }, draftVersion: "v1" });
    await opening;
  });
  unmount();
  expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "读的期间存好的新字。", savedBody: "读的期间存好的新字。", baseVersion: "v2" });
});
