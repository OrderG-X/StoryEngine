// 关窗前：上一笔明确没存上就拦下离页（第 4 轮复核 R10）。真 App 装的离页事件 + 真 draftSync；界面、导航、聊天、服务端用最小替身。
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { useDraftStore } from "./stores/draftStore.js";
import { useNavigationStore } from "./stores/navigationStore.js";
import { __resetDraftSyncForTests, editDraft, flushDraftSave } from "./drafts/draftSync.js";
import { saveWorkingDraft } from "./api/workingDraftClient.js";

vi.mock("./hooks/useBookManagement.js", () => ({ useBookManagement: () => ({}) }));
vi.mock("./hooks/useProjectNavigation.js", () => ({ useProjectNavigation: () => ({ openHome() {}, openProject() {}, openRecentBook() {} }) }));
vi.mock("./hooks/useWorkflowActions.js", () => ({ useWorkflowActions: () => ({}) }));
vi.mock("./hooks/useChat.js", () => ({ useChat: () => ({}) }));
vi.mock("./components/v2/ImmersiveAppShell.js", () => ({ default: () => null }));
vi.mock("./components/v2/codex/SettingsModal.js", () => ({ SettingsModal: () => null }));
vi.mock("./components/v2/AppToast.js", () => ({ AppToast: () => null }));
vi.mock("./api/chatSessionsClient.js", () => ({ setChatSessionSaveSkippedNotifier() {} }));
vi.mock("./sync/chatSync.js", () => ({ saveChatNow: async () => ({ ok: true }), scheduleChatSave() {}, saveChatKeepalive() {} }));
vi.mock("./api/workingDraftClient.js", () => ({ saveWorkingDraft: vi.fn() }));

afterEach(() => {
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
  vi.mocked(saveWorkingDraft).mockReset();
});

function openPaper(): void {
  __resetDraftSyncForTests();
  useNavigationStore.setState({ workspaceReady: false, projectPath: "/virtual-book", settingsOpen: false });
  useDraftStore.getState().loadPaper("/virtual-book", { chapter: 1, draft: { chapter: 1, body: "原稿。", version: "v1" }, committed: null, editedSinceCommit: null, draftVersion: "v1" });
}

async function leave(): Promise<Event> {
  const event = new Event("beforeunload", { cancelable: true });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

it("上一笔没存上：拦下离页，马上再正常存一次", async () => {
  vi.mocked(saveWorkingDraft).mockRejectedValue(new Error("写盘失败"));
  openPaper();
  const app = render(createElement(App));
  await act(async () => {
    editDraft("没存上的新句。");
    expect((await flushDraftSave()).ok).toBe(false);
  });
  const calls = vi.mocked(saveWorkingDraft).mock.calls.length;
  const event = await leave();
  app.unmount();
  expect(event.defaultPrevented).toBe(true);
  expect(vi.mocked(saveWorkingDraft).mock.calls.length).toBeGreaterThan(calls);
  expect(vi.mocked(saveWorkingDraft).mock.calls.at(-1)?.[1]).toBeUndefined();
});

it("只是还没到存的时候：不拦，keepalive 发出最后一笔", async () => {
  vi.mocked(saveWorkingDraft).mockResolvedValue({ ok: true, version: "v2", unchanged: false });
  openPaper();
  const app = render(createElement(App));
  act(() => editDraft("刚打的字。"));
  const event = await leave();
  app.unmount();
  expect(event.defaultPrevented).toBe(false);
  expect(vi.mocked(saveWorkingDraft).mock.calls.at(-1)?.[1]).toEqual({ keepalive: true });
});

it("没存上之后的重试还在路上：再关一次照样拦（第 5 轮 S5）", async () => {
  let done!: () => void;
  const retry = new Promise<Awaited<ReturnType<typeof saveWorkingDraft>>>((resolve) => { done = () => resolve({ ok: true, version: "v2", unchanged: false }); });
  vi.mocked(saveWorkingDraft).mockRejectedValueOnce(new Error("写盘失败")).mockImplementation(() => retry);
  openPaper();
  const app = render(createElement(App));
  await act(async () => {
    editDraft("唯一的新字。");
    expect((await flushDraftSave()).ok).toBe(false);
  });
  const first = await leave();
  const second = await leave();
  expect(first.defaultPrevented).toBe(true);
  expect(second.defaultPrevented).toBe(true);
  await act(async () => { done(); await flushDraftSave(); });
  const third = await leave();
  app.unmount();
  expect(third.defaultPrevented).toBe(false);
});

it("清空的那笔还在路上、作者又改回原文再关窗：keepalive 补发原文（第 7 轮 U2）", async () => {
  let done!: () => void;
  const pending = new Promise<Awaited<ReturnType<typeof saveWorkingDraft>>>((resolve) => { done = () => resolve({ ok: true, version: "v2", unchanged: false }); });
  vi.mocked(saveWorkingDraft).mockImplementation(() => pending);
  openPaper();
  const app = render(createElement(App));
  let saving!: Promise<unknown>;
  await act(async () => {
    editDraft("");
    saving = flushDraftSave();
    await Promise.resolve();
    editDraft("原稿。");
  });
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  const last = vi.mocked(saveWorkingDraft).mock.calls.at(-1)!;
  // 和在路上那笔同一个底版、序号更大：服务端认出是同一窗口接着写的（routes/draft-safety.test.ts 测服务端那一半）。
  expect(last[0]).toMatchObject({ body: "原稿。", baseVersion: "v1" });
  expect(last[0].seq).toBeGreaterThan(vi.mocked(saveWorkingDraft).mock.calls[0]![0].seq!);
  expect(last[1]).toEqual({ keepalive: true });
  await act(async () => { done(); await saving; });
  app.unmount();
});
