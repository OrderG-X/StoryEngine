import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChatSessionBar } from "./ChatSessionBar.js";
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, isWorkspaceBusy, resetWorkspaceOperationForTests } from "../../../utils/workspaceOperation.js";
import { setAutosaveFlusher } from "../../../utils/autosaveControl.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const sessionApi = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  readChatSession: vi.fn(),
  setActiveChatSession: vi.fn(),
  renameChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  listChatSessions: vi.fn(),
  saveChatHistoryBudget: vi.fn(),
}));

vi.mock("../../../api/chatSessionsClient.js", () => sessionApi);

afterEach(() => {
  cleanup();
  setAutosaveFlusher(null);
});

describe("ChatSessionBar workspace busy barrier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceOperationForTests();
    setAutosaveFlusher(async () => ({ ok: true }));
    useNavigationStore.setState({ projectPath: "/tmp/story-project", toast: null });
    useWorkspaceStore.setState({
      chatLoading: false,
      draftActionLoading: "generate-draft",
      steeringLoading: false,
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", name: "当前会话", updatedAt: new Date().toISOString() }],
    });
    beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/story-project",
      chapter: useWorkspaceStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: "session-a",
    });
    sessionApi.createChatSession.mockResolvedValue({
      session: { id: "session-b", name: "B", messages: [], archivedCount: 0, createdAt: "t", updatedAt: "t" },
      index: { activeSessionId: "session-b", sessions: [] },
    });
    sessionApi.listChatSessions.mockResolvedValue({
      index: { activeSessionId: "session-a", sessions: useWorkspaceStore.getState().sessions },
    });
  });

  it("does not create or switch sessions during direct draft generation", () => {
    render(<ChatSessionBar />);

    const newSession = screen.getByRole("button", { name: /新会话/u });
    expect(newSession).toBeDisabled();
    fireEvent.click(newSession);
    expect(sessionApi.createChatSession).not.toHaveBeenCalled();
  });

  it("session switch owns the slot while the atomic set-active response is in flight", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({
      draftActionLoading: null,
      activeSessionId: "session-a",
      sessions: [
        { id: "session-a", name: "会话 A", updatedAt: new Date().toISOString() },
        { id: "session-b", name: "会话 B", updatedAt: new Date().toISOString() },
      ],
    });
    const switchGate = deferred<{
      session: { id: string; name: string; messages: readonly []; archivedCount: number };
      index: { activeSessionId: string; sessions: readonly { id: string; name: string; updatedAt: string }[] };
    }>();
    sessionApi.setActiveChatSession.mockReturnValueOnce(switchGate.promise);
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getByRole("button", { name: /会话 B/u }));
    await waitFor(() => expect(sessionApi.setActiveChatSession).toHaveBeenCalled());

    const intruder = beginWorkspaceOperation("agent-chat", {
      projectPath: "/tmp/story-project",
      chapter: useWorkspaceStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: "session-a",
    });
    if (intruder) finishWorkspaceOperation(intruder);
    expect(intruder).toBeNull();

    switchGate.resolve({
      session: { id: "session-b", name: "B", messages: [], archivedCount: 0 },
      index: { activeSessionId: "session-b", sessions: useWorkspaceStore.getState().sessions },
    });
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("new-session creation owns the slot until the new session is fully loaded", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({ draftActionLoading: null });
    const createGate = deferred<{
      session: { id: string; name: string; messages: readonly []; archivedCount: number };
      index: { activeSessionId: string; sessions: readonly [] };
    }>();
    sessionApi.createChatSession.mockReturnValueOnce(createGate.promise);
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /新会话/u }));
    await waitFor(() => expect(sessionApi.createChatSession).toHaveBeenCalled());

    const intruder = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/story-project",
      chapter: useWorkspaceStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: "session-a",
    });
    if (intruder) finishWorkspaceOperation(intruder);
    expect(intruder).toBeNull();

    createGate.resolve({
      session: { id: "session-b", name: "B", messages: [], archivedCount: 0 },
      index: { activeSessionId: "session-b", sessions: [] },
    });
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("awaits the old-session flush before creating and activating a new session", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({ draftActionLoading: null });
    const flushGate = deferred<void>();
    setAutosaveFlusher(async () => {
      await flushGate.promise;
      return { ok: true };
    });
    sessionApi.createChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [], archivedCount: 0 },
      index: { activeSessionId: "session-b", sessions: [] },
    });
    render(<ChatSessionBar />);

    fireEvent.click(screen.getByRole("button", { name: /新会话/u }));
    await Promise.resolve();
    expect(sessionApi.createChatSession).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activeSessionId).toBe("session-a");

    flushGate.resolve();
    await waitFor(() => expect(sessionApi.createChatSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
  });

  it("failed old-session flush blocks switching and leaves the original session visible", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({
      draftActionLoading: null,
      activeSessionId: "session-a",
      sessions: [
        { id: "session-a", name: "会话 A", updatedAt: new Date().toISOString() },
        { id: "session-b", name: "会话 B", updatedAt: new Date().toISOString() },
      ],
    });
    setAutosaveFlusher(async () => ({ ok: false, error: "save failed" }));
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getByRole("button", { name: /会话 B/u }));

    await waitFor(() => expect(useNavigationStore.getState().toast).toContain("保存失败"));
    expect(sessionApi.readChatSession).not.toHaveBeenCalled();
    expect(sessionApi.setActiveChatSession).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activeSessionId).toBe("session-a");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("failed flush blocks session deletion before the delete request", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({
      draftActionLoading: null,
      activeSessionId: "session-a",
      sessions: [
        { id: "session-a", name: "会话 A", updatedAt: new Date().toISOString() },
        { id: "session-b", name: "会话 B", updatedAt: new Date().toISOString() },
      ],
    });
    setAutosaveFlusher(async () => ({ ok: false, error: "save failed" }));
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[1]!);

    await waitFor(() => expect(useNavigationStore.getState().toast ?? "").toContain("保存失败"));
    expect(sessionApi.deleteChatSession).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activeSessionId).toBe("session-a");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("drops a late rename response after the project/session list has changed", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({ draftActionLoading: null });
    const renameGate = deferred<{ index: { activeSessionId: string; sessions: readonly { id: string; name: string; updatedAt: string }[] } }>();
    sessionApi.renameChatSession.mockReturnValueOnce(renameGate.promise);
    render(<ChatSessionBar />);

    fireEvent.click(screen.getByRole("button", { name: "重命名会话" }));
    const input = screen.getByDisplayValue("当前会话");
    fireEvent.change(input, { target: { value: "A renamed" } });
    fireEvent.blur(input);
    await waitFor(() => expect(sessionApi.renameChatSession).toHaveBeenCalledTimes(1));

    useNavigationStore.setState({ projectPath: "/tmp/other-project" });
    useWorkspaceStore.setState({
      activeSessionId: "session-z",
      sessions: [{ id: "session-z", name: "B session", updatedAt: new Date().toISOString() }],
    });
    renameGate.resolve({
      index: {
        activeSessionId: "session-a",
        sessions: [{ id: "session-a", name: "A renamed", updatedAt: new Date().toISOString() }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorkspaceStore.getState().activeSessionId).toBe("session-z");
    expect(useWorkspaceStore.getState().sessions).toEqual([
      expect.objectContaining({ id: "session-z", name: "B session" }),
    ]);
  });

  it("successful create commits its session+index response without a second read", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({ draftActionLoading: null });
    sessionApi.createChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [], archivedCount: 0, createdAt: "t", updatedAt: "t" },
      index: { activeSessionId: "session-b", sessions: [{ id: "session-b", name: "B", updatedAt: "t" }] },
    });
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /新会话/u }));
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(sessionApi.readChatSession).not.toHaveBeenCalled();
  });

  it("successful switch commits its session+index response without a second read", async () => {
    resetWorkspaceOperationForTests();
    const sessions = [
      { id: "session-a", name: "A", updatedAt: "t" },
      { id: "session-b", name: "B", updatedAt: "t" },
    ];
    useWorkspaceStore.setState({ draftActionLoading: null, activeSessionId: "session-a", sessions });
    sessionApi.setActiveChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [{ id: "b", role: "user", content: "B truth" }], archivedCount: 2 },
      index: { activeSessionId: "session-b", sessions },
    });
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getByRole("button", { name: /^B$/u }));
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(sessionApi.readChatSession).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspace.messages).toEqual([expect.objectContaining({ id: "b" })]);
  });

  it("successful delete commits its active session+index response without a second read", async () => {
    resetWorkspaceOperationForTests();
    const sessions = [
      { id: "session-a", name: "A", updatedAt: "t" },
      { id: "session-b", name: "B", updatedAt: "t" },
    ];
    useWorkspaceStore.setState({ draftActionLoading: null, activeSessionId: "session-a", sessions });
    sessionApi.deleteChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [{ id: "b", role: "user", content: "B truth" }], archivedCount: 0 },
      index: { activeSessionId: "session-b", sessions: [sessions[1]] },
    });
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(sessionApi.readChatSession).not.toHaveBeenCalled();
  });

  it("reconciles disk truth after a create response is lost", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({ draftActionLoading: null });
    const sessions = [{ id: "session-b", name: "B", updatedAt: "t" }];
    sessionApi.createChatSession.mockRejectedValueOnce(new Error("response lost"));
    sessionApi.listChatSessions.mockResolvedValueOnce({ index: { activeSessionId: "session-b", sessions } });
    sessionApi.readChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [{ id: "b", role: "user", content: "disk truth" }], archivedCount: 1 },
    });
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /新会话/u }));

    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(useWorkspaceStore.getState().workspace.messages).toEqual([expect.objectContaining({ id: "b" })]);
    expect(useNavigationStore.getState().toast).toContain("磁盘上的实际内容");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("reconciles disk truth after a switch response is lost", async () => {
    resetWorkspaceOperationForTests();
    const sessions = [
      { id: "session-a", name: "A", updatedAt: "t" },
      { id: "session-b", name: "B", updatedAt: "t" },
    ];
    useWorkspaceStore.setState({ draftActionLoading: null, activeSessionId: "session-a", sessions });
    sessionApi.setActiveChatSession.mockRejectedValueOnce(new Error("response lost"));
    sessionApi.listChatSessions.mockResolvedValueOnce({ index: { activeSessionId: "session-b", sessions } });
    sessionApi.readChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [{ id: "b", role: "user", content: "disk truth" }], archivedCount: 1 },
    });
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getByRole("button", { name: /^B$/u }));

    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(useWorkspaceStore.getState().workspace.messages).toEqual([expect.objectContaining({ id: "b" })]);
    expect(useNavigationStore.getState().toast).toContain("磁盘上的实际内容");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("reconciles disk truth after a delete response is lost", async () => {
    resetWorkspaceOperationForTests();
    const sessions = [
      { id: "session-a", name: "A", updatedAt: "t" },
      { id: "session-b", name: "B", updatedAt: "t" },
    ];
    useWorkspaceStore.setState({ draftActionLoading: null, activeSessionId: "session-a", sessions });
    sessionApi.deleteChatSession.mockRejectedValueOnce(new Error("response lost"));
    sessionApi.listChatSessions.mockResolvedValueOnce({
      index: { activeSessionId: "session-b", sessions: [sessions[1]] },
    });
    sessionApi.readChatSession.mockResolvedValueOnce({
      session: { id: "session-b", name: "B", messages: [{ id: "b", role: "user", content: "disk truth" }], archivedCount: 0 },
    });
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /历史/u }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);

    await waitFor(() => expect(useWorkspaceStore.getState().activeSessionId).toBe("session-b"));
    expect(useWorkspaceStore.getState().sessions).toEqual([sessions[1]]);
    expect(useNavigationStore.getState().toast).toContain("磁盘上的实际内容");
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("reports uncertain state when mutation response and reconciliation both fail", async () => {
    resetWorkspaceOperationForTests();
    useWorkspaceStore.setState({ draftActionLoading: null });
    sessionApi.createChatSession.mockRejectedValueOnce(new Error("response lost"));
    sessionApi.listChatSessions.mockRejectedValueOnce(new Error("reconcile failed"));
    render(<ChatSessionBar />);
    fireEvent.click(screen.getByRole("button", { name: /新会话/u }));

    await waitFor(() => expect(useNavigationStore.getState().toast).toContain("状态不确定"));
    expect(isWorkspaceBusy()).toBe(false);
  });
});
