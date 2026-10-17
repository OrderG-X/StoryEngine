import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateOverview } from "../api/types.js";
import { mockWorkspaceData } from "../mockData.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { streamAgentChat } from "../api/agentChatClient.js";
import { directEditDraft, fetchChapterWorkspace } from "../api/client.js";
import { renameChatSession, saveChatSessionMessages } from "../api/chatSessionsClient.js";
import { useChat, type UseChatParams } from "./useChat.js";
import type { AgentChatHandlers, StreamAgentChatRequest } from "../api/agentChatClient.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, isWorkspaceBusy, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";
import { __resetAutosaveControlForTest, isAutosaveSuspended, suspendAutosave } from "../utils/autosaveControl.js";
import { __setPageReloaderForTest } from "../utils/pageReload.js";
import { __resetRecentWorkspaceUndoForTest, hasRecentWorkspaceUndo, reloadAfterWorkspaceRevisionConflict } from "../utils/workspaceRevisionConflict.js";

// 前端接入：handleSendMessage 把对话交给 Mastra agent SSE。
vi.mock("../api/client.js", () => ({
  directEditDraft: vi.fn(),
  fetchChapterChatStream: vi.fn(async () => undefined),
  fetchChapterWorkspace: vi.fn(),
}));

vi.mock("../api/agentChatClient.js", () => ({
  streamAgentChat: vi.fn(),
}));

vi.mock("../api/chatSessionsClient.js", () => ({
  renameChatSession: vi.fn(),
  saveChatSessionMessages: vi.fn().mockResolvedValue({ ok: true }),
}));

const mockedStreamAgentChat = vi.mocked(streamAgentChat);
const mockedDirectEditDraft = vi.mocked(directEditDraft);
const mockedFetchChapterWorkspace = vi.mocked(fetchChapterWorkspace);
const mockedRenameChatSession = vi.mocked(renameChatSession);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** 给 streamAgentChat 装一个会按脚本回放事件的实现。 */
function scriptAgentStream(script: (handlers: AgentChatHandlers, input: StreamAgentChatRequest) => void): void {
  mockedStreamAgentChat.mockImplementation(async (input, handlers) => {
    script(handlers, input);
  });
}

function makeOverview(title: string): StateOverview {
  return { ...(mockWorkspaceData as unknown as { overview?: StateOverview }).overview, project: { title } } as StateOverview;
}

function resetStore(): void {
  resetWorkspaceOperationForTests();
  useNavigationStore.setState({ projectPath: "/tmp/story-engine-agent", toast: null });
  useWorkspaceStore.setState({
    workspace: { ...mockWorkspaceData, messages: [] },
    chatLoading: false,
    chatError: null,
    pendingDirectEditInstruction: null,
    selectedAdviceCards: [],
    aiFlavorPending: null,
    activeSessionId: "session-a",
    sessions: [{ id: "session-a", name: "新会话", updatedAt: "2026-07-13T00:00:00.000Z" }],
    draftActionLoading: null,
    steeringLoading: false,
  });
}

function messages() {
  return useWorkspaceStore.getState().workspace.messages;
}

function lastAssistant() {
  const list = messages();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "assistant") return list[i];
  }
  return undefined;
}

function buildParams(overrides: Partial<UseChatParams>): UseChatParams {
  return {
    projectPath: "/tmp/story-engine-agent",
    resolveChapterDirection: (value?: unknown) => (typeof value === "string" ? value : ""),
    handleGenerateDraft: async () => undefined,
    handleQualityCheck: async () => undefined,
    handleDraftAIReview: async () => undefined,
    handleGenerateRevisionPreview: async () => undefined,
    handleApplyRevisionPreview: async () => undefined,
    handleGenerateSteering: async () => undefined,
    handleContinueNextChapter: async () => undefined,
    handleCreateRevisionTask: () => undefined,
    applyOverviewToWorkspace: () => undefined,
    refreshWorkspaceFromOverview: () => undefined,
    ...overrides,
  };
}

describe("useChat agent dispatch (Mastra phase 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({
      ok: true,
      index: { sessions: [], activeSessionId: "session-a" },
    });
  });

  it.each(["session-transition", "navigation-transition"] as const)(
    "%s in flight rejects send before append, rename, dispatch, or deterministic handlers",
    async (kind) => {
      const operation = beginWorkspaceOperation(kind, {
        projectPath: "/tmp/story-engine-agent",
        chapter: useWorkspaceStore.getState().workspace.currentChapter.chapterNumber,
        sessionId: "session-a",
      });
      expect(operation).not.toBeNull();
      const handleGenerateDraft = vi.fn(async () => undefined);
      const handleQualityCheck = vi.fn(async () => undefined);
      const handleDraftAIReview = vi.fn(async () => undefined);
      const before = messages();
      const { result } = renderHook(() => useChat(buildParams({
        handleGenerateDraft,
        handleQualityCheck,
        handleDraftAIReview,
      })));

      await act(async () => {
        await result.current.handleSendMessage("帮我写这一章的草稿。");
      });

      expect(messages()).toBe(before);
      expect(mockedRenameChatSession).not.toHaveBeenCalled();
      expect(mockedStreamAgentChat).not.toHaveBeenCalled();
      expect(handleGenerateDraft).not.toHaveBeenCalled();
      expect(handleQualityCheck).not.toHaveBeenCalled();
      expect(handleDraftAIReview).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().toast).toContain("正在进行");
      if (operation) finishWorkspaceOperation(operation);
    },
  );

  it("appends a user message and streams text into one assistant message", async () => {
    scriptAgentStream((handlers) => {
      handlers.onTextDelta("好的，");
      handlers.onTextDelta("我看一下。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("现在写到哪了");
    });

    expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1);
    // 用户消息进对话，body 带 projectPath。
    const [input] = mockedStreamAgentChat.mock.calls[0] as [StreamAgentChatRequest, AgentChatHandlers];
    expect(input.projectPath).toBe("/tmp/story-engine-agent");
    expect(input.messages.at(-1)).toEqual({ role: "user", content: "现在写到哪了" });
    // H3：请求体带用户当前所在章（mockWorkspaceData.currentChapter=3），让后端引导 agent 默认作用于该章。
    expect(input.currentChapter).toBe(3);
    // 用户消息 + 一条 assistant 消息，文本累加进同一条。
    expect(messages().filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages().filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(lastAssistant()?.content).toBe("好的，我看一下。");
  });

  it("drops a late first-message auto-rename response after project/session replacement", async () => {
    const renameGate = deferred<{
      ok: true;
      index: { sessions: readonly { id: string; name: string; updatedAt: string }[]; activeSessionId: string };
    }>();
    mockedRenameChatSession.mockReturnValueOnce(renameGate.promise);
    scriptAgentStream((handlers) => handlers.onDone());
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("第一条消息"); });
    expect(mockedRenameChatSession).toHaveBeenCalledWith(
      "/tmp/story-engine-agent",
      "session-a",
      expect.any(String),
    );

    useNavigationStore.setState({ projectPath: "/tmp/replacement-book" });
    useWorkspaceStore.setState({
      activeSessionId: "session-z",
      sessions: [{ id: "session-z", name: "新书会话", updatedAt: "2026-07-13T00:00:01.000Z" }],
    });
    renameGate.resolve({
      ok: true,
      index: {
        activeSessionId: "session-a",
        sessions: [{ id: "session-a", name: "旧书自动名", updatedAt: "2026-07-13T00:00:02.000Z" }],
      },
    });
    await act(async () => { await Promise.resolve(); });

    expect(useWorkspaceStore.getState().sessions).toEqual([
      expect.objectContaining({ id: "session-z", name: "新书会话" }),
    ]);
  });

  it("tool-call → tool-result projects a completed toolStep + agentCard into the assistant message", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "read_state_overview" });
      handlers.onToolResult({ toolName: "read_state_overview", refreshScope: "full", overview: makeOverview("T") });
      handlers.onTextDelta("当前写到第 2 章。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("现状");
    });

    const assistant = lastAssistant()!;
    expect(assistant.toolSteps).toHaveLength(1);
    expect(assistant.toolSteps![0].status).toBe("completed");
    expect(assistant.agentCards![0].agentName).toBe("stateOverviewReader");
    expect(assistant.agentCards![0].status).toBe("completed");
    expect(assistant.content).toBe("当前写到第 2 章。");
  });

  it("重构 P4：AI 没调工具却说「整理好了」也原样显示（不改写；真相看步骤卡——这里一张卡都没有）", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onTextDelta("已经帮你整理好了。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("把赵叔补进角色资料，顺便写清楚他和陆沉的关系。");
    });

    const assistant = lastAssistant()!;
    expect(assistant.toolSteps ?? []).toHaveLength(0);
    expect(assistant.content).toBe("已经帮你整理好了。");
  });

  it("onToolResult refreshScope=full calls applyOverviewToWorkspace", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Full");
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "read_state_overview", refreshScope: "full", overview });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const refreshWorkspaceFromOverview = vi.fn();
    const { result } = renderHook(() =>
      useChat(buildParams({ applyOverviewToWorkspace, refreshWorkspaceFromOverview })),
    );

    await act(async () => {
      await result.current.handleSendMessage("现状");
    });

    expect(applyOverviewToWorkspace).toHaveBeenCalledTimes(1);
    expect(applyOverviewToWorkspace.mock.calls[0][0]).toBe(overview);
    expect(refreshWorkspaceFromOverview).not.toHaveBeenCalled();
  });

  it("onToolResult for generate_draft loads the real draftBody (not the overview placeholder) into the workspace", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Draft");
    const realDraft = "夜色四合，主角推开祠堂斑驳的木门，借着月光看清了梁上的刻痕。";
    scriptAgentStream((handlers) => {
      handlers.onToolResult({
        toolName: "generate_draft",
        refreshScope: "full",
        overview,
        ok: true,
        draftBody: realDraft,
        draftTitle: "夜探祠堂",
      });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ applyOverviewToWorkspace })));

    await act(async () => {
      await result.current.handleSendMessage("写第一章，主角夜探祠堂");
    });

    // 关键回归：generate_draft 的真正文必须作为第二参（draftContent）传进工作区，flowStatus=draft_ready。
    // 否则 applyOverviewToWorkspace 会用 overview 的占位「还没有载入本章草稿正文」覆盖草稿，
    // autosave 再把占位写回 drafts/fast/chapter-N.md，抹掉 generate_draft 已落盘的真正文（Codex 复验卡住的根因）。
    expect(applyOverviewToWorkspace).toHaveBeenCalledTimes(1);
    const call = applyOverviewToWorkspace.mock.calls[0];
    expect(call[0]).toBe(overview);
    expect(call[1]).toBe(realDraft);
    expect(call[2]).toBe("draft_ready");
    expect(call[3]).toBe("夜探祠堂");
  });

  it("explicitly adopts a generate_draft target chapter and keeps streaming next-chapter support", async () => {
    const overview = makeOverview("Next chapter");
    const body = "第四章的新正文。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft" });
      handlers.onDraftDelta?.({ chapter: 4, text: body });
      handlers.onDraftDelta?.({ chapter: 3, text: "绝不能串回第三章的片段。" });
      handlers.onToolResult({
        toolName: "generate_draft",
        refreshScope: "full",
        overview,
        ok: true,
        chapter: 4,
        draftBody: body,
        draftTitle: "第四章",
      });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ applyOverviewToWorkspace })));

    await act(async () => {
      await result.current.handleSendMessage("继续写下一章");
    });

    expect(useWorkspaceStore.getState().workspace.currentChapter.chapterNumber).toBe(4);
    expect(useWorkspaceStore.getState().workspace.draft.chapterNumber).toBe(4);
    expect(useWorkspaceStore.getState().workspace.draft.content).toBe(body);
    expect(useWorkspaceStore.getState().workspace.draft.content).not.toContain("串回第三章");
    expect(applyOverviewToWorkspace).toHaveBeenCalledWith(overview, body, "draft_ready", "第四章", 4);
  });

  it("a stale agent finally releases its token without clearing loading in the replacement workspace", async () => {
    let release!: () => void;
    mockedStreamAgentChat.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSendMessage("开始一轮慢请求");
    });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    useNavigationStore.setState({ projectPath: null });
    useWorkspaceStore.setState({ chatLoading: true });
    release();
    await act(async () => pending);

    expect(useWorkspaceStore.getState().chatLoading).toBe(true);
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("direct edit drops a late result and does not clear replacement workspace loading", async () => {
    const gate = deferred<{ draftContent: string; reply: string; changeSummary: string }>();
    mockedDirectEditDraft.mockReturnValueOnce(gate.promise as never);
    useWorkspaceStore.setState({ pendingDirectEditInstruction: "把这一段润色得更具体" });
    useWorkspaceStore.getState().updateDraft({ content: "第一章原稿正文。", savedContent: "第一章原稿正文。" });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("确认"); });
    await vi.waitFor(() => expect(mockedDirectEditDraft).toHaveBeenCalled());

    useNavigationStore.setState({ projectPath: null });
    useWorkspaceStore.setState({
      activeSessionId: "session-b",
      draftActionLoading: "replacement-loading",
      workspace: {
        ...useWorkspaceStore.getState().workspace,
        currentChapter: { id: "ch-2", chapterNumber: 2, title: "第二章", status: "current" },
        draft: { chapterNumber: 2, title: "第二章", status: "draft", content: "第二章安全正文。", savedContent: "第二章安全正文。" },
      },
    });
    gate.resolve({ draftContent: "迟到的第一章改稿。", reply: "已修改", changeSummary: "润色" });
    await act(async () => pending);

    expect(useWorkspaceStore.getState().workspace.draft.content).toBe("第二章安全正文。");
    expect(useWorkspaceStore.getState().draftActionLoading).toBe("replacement-loading");
  });

  it("onToolResult for commit_apply loads the committed body with committed flowStatus", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Committed");
    const committedBody = "已经定稿入库的第一章正文，状态应为 committed。";
    scriptAgentStream((handlers) => {
      handlers.onToolResult({
        toolName: "commit_apply",
        refreshScope: "full",
        overview,
        committed: true,
        draftBody: committedBody,
        draftTitle: "夜探祠堂",
      });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ applyOverviewToWorkspace })));

    await act(async () => {
      await result.current.handleSendMessage("确认入库");
    });

    // 入库成功：正文以 committed 状态载入，autosave（draft.status!=="committed" 才写回）不会把已入库章节复活成草稿。
    expect(applyOverviewToWorkspace).toHaveBeenCalledTimes(1);
    const call = applyOverviewToWorkspace.mock.calls[0];
    expect(call[0]).toBe(overview);
    expect(call[1]).toBe(committedBody);
    expect(call[2]).toBe("committed");
    expect(call[3]).toBe("夜探祠堂");
  });

  it("commits full workspace truth when commit_apply succeeds without an overview", async () => {
    const committedBody = "没有 overview 也必须落成 committed 的正文。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      handlers.onToolResult({
        toolName: "commit_apply",
        committed: true,
        draftBody: committedBody,
        draftTitle: "无概览定稿",
      });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ applyOverviewToWorkspace })));

    await act(async () => {
      await result.current.handleSendMessage("确认定稿");
    });

    const state = useWorkspaceStore.getState().workspace;
    expect(applyOverviewToWorkspace).not.toHaveBeenCalled();
    expect(state.flowStatus).toBe("committed");
    expect(state.draft).toMatchObject({
      content: committedBody,
      savedContent: committedBody,
      title: "无概览定稿",
      status: "committed",
    });
    expect(state.currentChapter).toMatchObject({
      hasCommittedChapter: true,
      hasDraftFile: true,
    });
  });

  it("reloads the complete committed chapter snapshot after SSE loses the commit_apply result", async () => {
    const committedBody = "# 磁盘定稿标题\n\n这是已经真正写盘的完整定稿正文，不能只更改顶部状态。";
    useWorkspaceStore.getState().updateDraft({
      content: committedBody,
      savedContent: committedBody,
      title: "磁盘定稿标题",
      status: "draft",
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3,
      messages: [],
      selectedAdviceCardKeys: [],
      flowStatus: "committed",
      draftContent: committedBody,
      draftTitle: "磁盘定稿标题",
      hasDraftFile: true,
      hasCommittedChapter: true,
      revision: 17,
    });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      handlers.onError("SSE disconnected after disk commit", true);
    });
    const applyOverviewToWorkspace = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ applyOverviewToWorkspace })));

    await act(async () => {
      await result.current.handleSendMessage("确认定稿");
    });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.draft.content).toBe(committedBody));

    const state = useWorkspaceStore.getState();
    expect(mockedFetchChapterWorkspace).toHaveBeenCalledWith(
      { projectPath: "/tmp/story-engine-agent", chapter: 3 },
      expect.any(AbortSignal),
    );
    expect(state.workspace.flowStatus).toBe("committed");
    expect(state.workspace.draft).toMatchObject({
      chapterNumber: 3,
      title: "磁盘定稿标题",
      content: committedBody,
      savedContent: committedBody,
      status: "committed",
    });
    expect(state.workspace.currentChapter).toMatchObject({
      chapterNumber: 3,
      title: "磁盘定稿标题",
      hasCommittedChapter: true,
      hasDraftFile: true,
    });
    expect(state.workspaceRevision).toBe(17);
    expect(applyOverviewToWorkspace).not.toHaveBeenCalled();
  });

  it("does not replace an unsaved new draft with an old committed chapter after a non-commit tool error", async () => {
    const unsavedDraft = "这是作者尚未保存的新版本，旧正式稿绝不能因为质检断流把它覆盖。";
    useWorkspaceStore.getState().updateDraft({
      content: unsavedDraft,
      savedContent: "旧的已保存工作稿。",
      title: "作者的新版本",
      status: "draft",
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3,
      messages: [],
      selectedAdviceCardKeys: [],
      flowStatus: "committed",
      draftContent: "# 旧正式稿\n\n历史上早已定稿的旧正文。",
      draftTitle: "旧正式稿",
      hasDraftFile: true,
      hasCommittedChapter: true,
      revision: 8,
    });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "quality_check" });
      handlers.onError("quality stream disconnected", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("检查这版草稿");
    });

    expect(useWorkspaceStore.getState().workspace.draft).toMatchObject({
      content: unsavedDraft,
      title: "作者的新版本",
      status: "draft",
    });
  });

  it("does not reconcile a commit_apply error to unrelated committed bytes", async () => {
    const attemptedDraft = "这是本轮确认定稿时编辑器里的唯一正文。";
    useWorkspaceStore.getState().updateDraft({
      content: attemptedDraft,
      savedContent: attemptedDraft,
      title: "本轮正文",
      status: "draft",
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3,
      messages: [],
      selectedAdviceCardKeys: [],
      flowStatus: "committed",
      draftContent: "# 旧正式稿\n\n不是本轮 commit_apply 捕获的正文。",
      draftTitle: "旧正式稿",
      hasDraftFile: true,
      hasCommittedChapter: true,
      revision: 9,
    });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      handlers.onError("commit stream disconnected", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("确认定稿");
    });

    expect(mockedFetchChapterWorkspace).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().workspace.draft).toMatchObject({
      content: attemptedDraft,
      title: "本轮正文",
      status: "draft",
    });
  });

  it("bounds commit reconciliation so a stalled snapshot read cannot hold the workspace operation forever", async () => {
    vi.useFakeTimers();
    try {
      let reconciliationSignal: AbortSignal | undefined;
      mockedFetchChapterWorkspace.mockImplementation((_input, signal) => {
        reconciliationSignal = signal;
        return new Promise(() => undefined);
      });
      scriptAgentStream((handlers) => {
        handlers.onToolCall({ toolName: "commit_apply" });
        handlers.onError("commit result stream disconnected", true);
      });
      const { result } = renderHook(() => useChat(buildParams({})));

      let pending!: Promise<void>;
      act(() => { pending = result.current.handleSendMessage("确认定稿"); });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(isWorkspaceBusy()).toBe(false);
      expect(reconciliationSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onToolResult for a read-only full refresh preserves the existing draft body (never overwrites with the placeholder)", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const existing = "这是上一步已经生成好的真正文，纯读状态操作绝不能把它冲掉。";
    useWorkspaceStore.getState().updateDraft({ content: existing, savedContent: existing, title: "夜探祠堂" });
    const overview = makeOverview("Read");
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "read_state_overview", refreshScope: "full", overview });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ applyOverviewToWorkspace })));

    await act(async () => {
      await result.current.handleSendMessage("现在写到哪了");
    });

    // read_state_overview 是纯读，但 refreshScope=full。修复前以 applyOverviewToWorkspace(overview) 调用，
    // 工作区草稿被占位覆盖、autosave 抹掉真正文。修复后无 draftBody 时必须回传现有草稿正文，绝不传 undefined。
    expect(applyOverviewToWorkspace).toHaveBeenCalledTimes(1);
    const call = applyOverviewToWorkspace.mock.calls[0];
    expect(call[0]).toBe(overview);
    expect(call[1]).toBe(existing);
  });

  it("onToolResult refreshScope=foundation calls refreshWorkspaceFromOverview", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Foundation");
    scriptAgentStream((handlers) => {
      handlers.onToolResult({
        toolName: "foundation_write",
        refreshScope: "foundation",
        overview,
        snapshotId: "snap-1",
      });
      handlers.onDone();
    });
    const applyOverviewToWorkspace = vi.fn();
    const refreshWorkspaceFromOverview = vi.fn();
    const { result } = renderHook(() =>
      useChat(buildParams({ applyOverviewToWorkspace, refreshWorkspaceFromOverview })),
    );

    await act(async () => {
      await result.current.handleSendMessage("把这条记进资料");
    });

    expect(refreshWorkspaceFromOverview).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceFromOverview.mock.calls[0][0]).toBe(overview);
    expect(applyOverviewToWorkspace).not.toHaveBeenCalled();
  });

  it("onToolResult for check_ai_flavor 把报告挂到这条 assistant 消息上（随消息走，不再落全局 store）", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const report = {
      ok: true,
      summary: "有一处 AI 腔。",
      usedFallback: false,
      violations: [
        { id: "aiflavor-0", text: "心中五味杂陈。", reason: "套路抒情", severity: "high" as const, suggestedFix: "改成具体动作" },
      ],
    };
    scriptAgentStream((handlers) => {
      // check_ai_flavor 只读，无 overview/refreshScope；报告随 project(output:info) 投影挂到这条消息。
      handlers.onToolResult({ toolName: "check_ai_flavor", aiFlavorReport: report });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("帮我体检这章的 AI 味");
    });

    const carried = lastAssistant()?.aiFlavorReport;
    expect(carried).toBeTruthy();
    expect(carried?.violations).toHaveLength(1);
    expect(carried?.violations[0].text).toBe("心中五味杂陈。");
  });

  it("onToolResult for a failed check_ai_flavor (ok:false) 不把报告挂到消息上（失败不当结果）", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolResult({
        toolName: "check_ai_flavor",
        aiFlavorReport: { ok: false, summary: "体检没成。", usedFallback: true, violations: [] },
      });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("体检 AI 味");
    });

    expect(lastAssistant()?.aiFlavorReport).toBeUndefined();
  });

  it("纯 agent 流程：质检工具（只读·无 overview）也把 flowStatus 推进到 quality_checked（A 修复，不再卡在写稿）", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    useWorkspaceStore.setState({
      workspace: { ...useWorkspaceStore.getState().workspace, flowStatus: "draft_ready" },
    });
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "quality_check", ok: true }); // 只读，不带 overview/draftBody
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("帮我质检这章");
    });

    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("quality_checked");
  });

  it("tool-error settles the running toolStep + card to failed (no longer stuck running) and appends a retryable error", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "foundation_write", toolCallId: "c1" });
      handlers.onToolError({
        toolName: "foundation_write",
        toolCallId: "c1",
        message: "落盘失败",
        retryable: true,
      });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("把这条记进资料");
    });

    // 时间线收尾：对应步骤/卡片置 failed，不再卡在 running。
    const assistant = messages().find(
      (m) => m.role === "assistant" && (m.toolSteps?.length ?? 0) > 0,
    )!;
    expect(assistant.toolSteps).toHaveLength(1);
    expect(assistant.toolSteps![0].status).toBe("failed");
    expect(assistant.agentCards).toHaveLength(1);
    expect(assistant.agentCards![0].status).toBe("failed");
    // 没有任何 running 残留。
    expect(assistant.toolSteps!.every((s) => s.status !== "running")).toBe(true);
    expect(assistant.agentCards!.every((c) => c.status !== "running")).toBe(true);

    // 如实回报：追加一条可重试的错误气泡。
    const errorMessages = messages().filter(
      (m) => m.role === "assistant" && m.isErrorNotice,
    );
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0].errorDetail).toContain("落盘失败");
    expect(errorMessages[0].suggestedActions?.some((a) => a.id === "retry-agent")).toBe(true);
  });

  it("onError appends a retryable assistant message", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onError("落盘失败", true);
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("记一下");
    });

    const errorMessages = messages().filter(
      (m) => m.role === "assistant" && m.isErrorNotice,
    );
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0].content).toBe("AI 服务暂时没响应，本次没有改动。");
    expect(errorMessages[0].errorDetail).toContain("落盘失败");
    expect(errorMessages[0].suggestedActions?.some((a) => a.id === "retry-agent")).toBe(true);
  });

  // 重构 P4：回合收尾不再改写 AI 的回复。AI 说什么就显示什么，真相看工具步骤卡。
  it("回合收尾不改写回复：只读预览也照原文显示，步骤卡如实标完成", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "prune_snapshots", toolCallId: "p1" });
      handlers.onToolResult({ toolName: "prune_snapshots", toolCallId: "p1", ok: true, summary: "预览：可裁剪 3 个旧快照。" });
      handlers.onTextDelta("可以裁掉 3 个旧快照，要裁的话点下面的按钮。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("帮我看看能裁剪哪些旧快照");
    });

    const assistant = lastAssistant()!;
    expect(assistant.toolSteps![0]).toMatchObject({ status: "completed" });
    expect(assistant.content).toBe("可以裁掉 3 个旧快照，要裁的话点下面的按钮。");
  });

  /* ---- A-5 「停止」收尾：abort 统一走回合收尾 ---- */

  /** 装一条「发出工具调用后挂起、直到调用方 abort 才干净返回」的流（复刻 streamAgentChat 的 clean-abort 口径）。 */
  function scriptAbortableStream(begin: (handlers: AgentChatHandlers) => void): void {
    mockedStreamAgentChat.mockImplementation(async (_input, handlers, signal) => {
      begin(handlers);
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // 真实 streamAgentChat 对用户主动 abort：不 onError、不 throw，干净返回。
    });
  }

  it("流式出稿中途点「停止」→ running 步骤结算 stopped、flowStatus 复位、已流出内容保留、拉一次磁盘对账", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "已流出的一截新正文。" });
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3, messages: [], selectedAdviceCardKeys: [],
      flowStatus: "draft_ready", draftContent: "短", hasDraftFile: true, hasCommittedChapter: false, revision: 5,
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    // 残留 running → stopped（不是 failed），补 endedAt；金光/字幕随之静止。
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    expect(typeof agentMessage.toolSteps![0].endedAt).toBe("number");
    // 不再卡「正在生成草稿」：编辑器有已流出内容 → draft_ready。
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
    // 已写出的内容保留。
    expect(useWorkspaceStore.getState().workspace.draft.content).toContain("已流出的一截新正文");
    // 写类工具在飞 → 拉了一次磁盘对账（盘上稿更短 → 不覆盖编辑器）。
    expect(mockedFetchChapterWorkspace).toHaveBeenCalledWith(
      { projectPath: "/tmp/story-engine-agent", chapter: 3 },
      expect.any(AbortSignal),
    );
    // 停止不是失败：无错误气泡。
    expect(messages().filter((m) => m.isErrorNotice)).toHaveLength(0);
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
  });

  it("「停止」后盘上稿更完整（服务端停止前已写完）→ 采用盘稿并如实回报", async () => {
    const fullDraftOnDisk = "这是服务端在停止前其实已经写完整的一整章正文，比编辑器里流出的半截要长得多。";
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "半截。" });
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3, messages: [], selectedAdviceCardKeys: [],
      flowStatus: "draft_ready", draftContent: fullDraftOnDisk, draftTitle: "夜探祠堂",
      hasDraftFile: true, hasCommittedChapter: false, revision: 9,
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const state = useWorkspaceStore.getState();
    expect(state.workspace.draft).toMatchObject({
      chapterNumber: 3,
      title: "夜探祠堂",
      content: fullDraftOnDisk,
      savedContent: fullDraftOnDisk, // 编辑器与盘一致，autosave 不会立刻回写
      status: "draft",
    });
    expect(state.workspace.flowStatus).toBe("draft_ready");
    expect(state.workspaceRevision).toBe(9);
    expect(messages().some((m) => m.content.includes("磁盘核对"))).toBe(true);
  });

  it("「停止」后用户又动过编辑器 → 不用盘稿盖掉新编辑", async () => {
    const gate = deferred<{
      chapter: number; messages: []; selectedAdviceCardKeys: [];
      flowStatus: string; draftContent: string; hasDraftFile: boolean; hasCommittedChapter: boolean; revision: number;
    }>();
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "半截。" });
    });
    mockedFetchChapterWorkspace.mockReturnValueOnce(gate.promise as never);
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    act(() => { result.current.stopAgent(); });
    await vi.waitFor(() => expect(mockedFetchChapterWorkspace).toHaveBeenCalled());
    // 对账读盘期间，用户又改了一版。
    act(() => {
      useWorkspaceStore.getState().updateDraft({ content: "用户停止后亲手改的新版本。" });
    });
    gate.resolve({
      chapter: 3, messages: [], selectedAdviceCardKeys: [],
      flowStatus: "draft_ready", draftContent: "盘上其实有一版长得多的完整稿，但绝不能盖掉用户的新编辑。", hasDraftFile: true, hasCommittedChapter: false, revision: 6,
    });
    await act(async () => { await pending; });

    expect(useWorkspaceStore.getState().workspace.draft.content).toBe("用户停止后亲手改的新版本。");
  });

  it("「停止」腰斩 commit_apply 且盘证一致 → 按「其实已入库」整体恢复", async () => {
    const committedBody = "停止前其实已经真正入库定稿的正文。";
    useWorkspaceStore.getState().updateDraft({
      content: committedBody,
      savedContent: committedBody,
      title: "磁盘定稿标题",
      status: "draft",
    });
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply", toolCallId: "c1" });
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3, messages: [], selectedAdviceCardKeys: [],
      flowStatus: "committed", draftContent: committedBody, draftTitle: "磁盘定稿标题",
      hasDraftFile: true, hasCommittedChapter: true, revision: 21,
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("确认定稿"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const state = useWorkspaceStore.getState();
    expect(state.workspace.flowStatus).toBe("committed");
    expect(state.workspace.draft).toMatchObject({ content: committedBody, status: "committed" });
    expect(state.workspace.currentChapter.hasCommittedChapter).toBe(true);
    expect(messages().some((m) => m.content.includes("其实已经定稿"))).toBe(true);
  });

  /* ---- #13（长跑×3）：回合正常收尾后 flowStatus 不得残留 draft_generating ---- */

  it("出稿写了另一章（跨章 tool-result 直接 return）→ 当前章立即退出「正在生成工作稿…」，不挂到回合结束", async () => {
    // 复刻多候选/retarget 用尽的形态：generate_draft 只发 tool-call + 带章号的结果、没有 draft-delta
    // 把 operation 带去那一章 → 跨章分支原本直接 return，flowStatus 卡 draft_generating 到回合结束。
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onToolResult({ toolName: "generate_draft", toolCallId: "g1", ok: true, chapter: 4, summary: "第 4 章已出稿。" });
      handlers.onTextDelta("第 4 章的工作稿已经写好了。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("写第 4 章");
    });

    // 编辑器里本就有第 3 章草稿内容 → 诚实复位成 draft_ready，而不是谎报「正在生成」。
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
    expect(useNavigationStore.getState().toast ?? "").toContain("第 4 章");
  });

  it("出稿阶段（拟章纲 / 写正文）推给稿纸；回合结束清掉", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftPhase?.({ chapter: 3, phase: "plan" });
      await gate;
      handlers.onDraftPhase?.({ chapter: 3, phase: "write" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().draftPhase).toBe("plan"));
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating");
    release();
    await act(async () => { await pending; });
    expect(useWorkspaceStore.getState().draftPhase).toBeNull();
  });

  it("回合正常结束但出稿结果没复位（守卫拦下定稿等中途分支）→ 收尾兜底把 draft_generating 复位，不永久转圈", async () => {
    // 最小复刻：tool-call(generate_draft) 后回合正常收尾（结果事件因故没推进流程态的任何形态）。
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onTextDelta("这章的稿子已经准备好了。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    await act(async () => { await pending; });

    // 回合已结束（chatLoading=false）→ 不允许任何路径把「正在生成工作稿…」留到回合之外。
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
  });

  it("纯读回合点「停止」→ 步骤结算 stopped、不拉磁盘对账、流程态不动", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "read_state_overview", toolCallId: "r1" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("现在写到哪了"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    expect(mockedFetchChapterWorkspace).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("idle");
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
  });

  it("被「停止」腰斩的回合不做诚实盖文——半截流式文本不等于「声称完成」", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onTextDelta("第3章正文已经写好了，接下来");
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3, messages: [], selectedAdviceCardKeys: [],
      hasDraftFile: false, hasCommittedChapter: false, revision: 3,
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    // 不被「操作未完成」盖掉：停止回合的半截文本原样保留。
    expect(agentMessage.content).toBe("第3章正文已经写好了，接下来");
    expect(agentMessage.content).not.toContain("没有检测到");
  });
});

// P2（2026-10-02）agent 路 undo_last_change 真撤销 × autosave：服务端 git 已回退磁盘，但内存里仍是撤销前旧稿；
// 此前靠 350ms autosave 把旧稿 PUT 回去 → 服务端 409 → 「另一窗口」误导 toast → reload 兜底。
// 现在显式：undone=true 即冻结 autosave → 排空在途 → 读磁盘真值接管草稿/revision → 回合收尾整页重载。
describe("useChat agent undo_last_change × autosave（P2）", () => {
  const reloads: number[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetStore();
    __resetAutosaveControlForTest();
    __resetRecentWorkspaceUndoForTest();
    reloads.length = 0;
    __setPageReloaderForTest(() => { reloads.push(Date.now()); });
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
  });
  afterEach(() => {
    __setPageReloaderForTest(null);
    __resetAutosaveControlForTest();
    __resetRecentWorkspaceUndoForTest();
  });

  it("undone=true：先冻结 autosave，再用磁盘真值替掉内存旧稿、对齐 revision，回合收尾整页重载", async () => {
    const staleInMemory = "撤销前内存里那版很长的旧稿，绝不能被 autosave 写回磁盘。";
    const diskAfterUndo = "磁盘回退后的更早版本。";
    useWorkspaceStore.getState().updateDraft({ content: staleInMemory, savedContent: staleInMemory, title: "旧标题", status: "draft" });
    useWorkspaceStore.getState().updateWorkspace({ flowStatus: "draft_ready" });
    useWorkspaceStore.getState().setWorkspaceRevision(12);
    let autosaveSuspendedAtToolResult: boolean | null = null;
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "undo_last_change", toolCallId: "u1" });
      handlers.onToolResult({
        toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销上一步「出稿」。",
        refreshScope: "full", overview: makeOverview("T"),
      });
      // 工具回执一落地就应已冻结（在任何 overview 刷新 / 后续 autosave 之前）。
      autosaveSuspendedAtToolResult = isAutosaveSuspended();
      handlers.onTextDelta("已撤销上一步「出稿」。");
      handlers.onDone();
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3, messages: [], selectedAdviceCardKeys: [],
      flowStatus: "draft_ready", draftContent: diskAfterUndo, draftTitle: "回退后的标题",
      hasDraftFile: true, hasCommittedChapter: false, revision: 7,
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    expect(autosaveSuspendedAtToolResult).toBe(true);
    expect(isAutosaveSuspended()).toBe(true); // 直到 reload 都不解冻
    expect(hasRecentWorkspaceUndo()).toBe(true); // 若服务端此刻仍 409，toast 文案走「撤销」而非「另一窗口」
    expect(mockedFetchChapterWorkspace).toHaveBeenCalledWith(
      { projectPath: "/tmp/story-engine-agent", chapter: 3 },
      expect.any(AbortSignal),
    );
    const state = useWorkspaceStore.getState();
    expect(state.workspace.draft).toMatchObject({
      chapterNumber: 3, title: "回退后的标题", content: diskAfterUndo, savedContent: diskAfterUndo, status: "draft",
    });
    expect(state.workspace.draft.content).not.toContain("旧稿");
    expect(state.workspaceRevision).toBe(7);
    expect(state.workspace.flowStatus).toBe("draft_ready");
    // 回合收尾才重载（agent 收尾文本不被截断），且重载前打了「优先 sessionStorage 对话」标记。
    expect(reloads).toHaveLength(1);
    expect(window.sessionStorage.getItem("se-undo-prefer-session")).toBe("1");
    expect(lastAssistant()?.content).toBe("已撤销上一步「出稿」。");
    // 重载后对话读后端会话文件：重载前必须把整回合（含收尾文字）写回去，否则只剩半截气泡。
    const saved = vi.mocked(saveChatSessionMessages).mock.calls.at(-1)?.[2] as readonly { content?: string }[] | undefined;
    expect(saved?.at(-1)?.content).toBe("已撤销上一步「出稿」。");
  });

  it("undone=true 且磁盘上已无草稿（撤到「还没写过」）→ 正文清空而不是留着内存旧稿", async () => {
    useWorkspaceStore.getState().updateDraft({ content: "内存旧稿", savedContent: "内存旧稿", status: "draft" });
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销上一步「出稿」。" });
      handlers.onDone();
    });
    mockedFetchChapterWorkspace.mockResolvedValue({
      chapter: 3, messages: [], selectedAdviceCardKeys: [], hasDraftFile: false, hasCommittedChapter: false, revision: 2,
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(useWorkspaceStore.getState().workspace.draft.content).toBe("");
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("idle");
    expect(useWorkspaceStore.getState().workspaceRevision).toBe(2);
    expect(reloads).toHaveLength(1);
  });

  it("undone=false（没东西可撤）→ 不冻结、不读盘、不重载", async () => {
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: false, summary: "没有可撤销的改动。" });
      handlers.onTextDelta("当前没有可撤销的改动。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(isAutosaveSuspended()).toBe(false);
    expect(hasRecentWorkspaceUndo()).toBe(false);
    expect(mockedFetchChapterWorkspace).not.toHaveBeenCalled();
    expect(reloads).toHaveLength(0);
  });

  it("读盘失败 → 仍保持冻结并重载（旧稿绝不写回；reload 后从磁盘重建）", async () => {
    useWorkspaceStore.getState().updateDraft({ content: "内存旧稿", savedContent: "内存旧稿", status: "draft" });
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销上一步「出稿」。" });
      handlers.onDone();
    });
    mockedFetchChapterWorkspace.mockRejectedValue(new Error("网络抖动"));
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(isAutosaveSuspended()).toBe(true);
    expect(reloads).toHaveLength(1);
    expect(messages().filter((m) => m.isErrorNotice)).toHaveLength(0);
  });
});

// R7.2（十章验收 3.2）：回合进行中撞 409 不再立刻整页重载——立刻刷会腰斩正在跑的 AI 回合、这轮回复
// 丢失（会话文件里也没有）。现在 App 的冲突兜底带 turnActive=chatLoading：回合中只记「要重载」，
// 回合收尾由 useChat finally 走与 agent 撤销同一段「写回会话文件 → 重载」。
describe("useChat 回合中撞 409（R7.2：回复不丢、重载延到回合收尾）", () => {
  const reloads: number[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetStore();
    __resetAutosaveControlForTest();
    __resetRecentWorkspaceUndoForTest();
    reloads.length = 0;
    __setPageReloaderForTest(() => { reloads.push(Date.now()); });
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
  });
  afterEach(() => {
    __setPageReloaderForTest(null);
    __resetAutosaveControlForTest();
    __resetRecentWorkspaceUndoForTest();
  });

  /** 复刻 App.reconcileWorkspaceConflict 的冲突兜底调用（同一 util、同一 turnActive 口径）。 */
  function triggerConflict409(): void {
    reloadAfterWorkspaceRevisionConflict({
      projectPath: "/tmp/story-engine-agent",
      chapter: 3,
      revision: 6,
      recordRevision: () => undefined,
      suspend: suspendAutosave,
      notify: () => undefined,
      reload: () => reloads.push(Date.now()),
      turnActive: () => useWorkspaceStore.getState().chatLoading,
      notifyDeferred: () => undefined,
    });
  }

  it("回合进行中收到 409：不立刻重载；回合收尾先把含回复的对话写进会话文件，然后再重载；过时建议条被清掉", async () => {
    // 上一回合挂着建议条（如「确认写入资料」）：撤销/回退后已过时，重载后不应再显示。
    useWorkspaceStore.setState({
      workspace: {
        ...mockWorkspaceData,
        messages: [{
          id: "prev-assistant",
          role: "assistant",
          content: "已改好，请确认写入资料。",
          suggestedActions: [{
            id: "confirm-write",
            label: "确认写入资料",
            description: "写入资料",
            permission: "project_config_write",
            requiresConfirmation: true,
            endpoint: "suggestion-1",
          }],
        }],
      },
    });
    scriptAgentStream((handlers) => {
      // 回合进行中（chatLoading=true）：撤销前发出的 autosave PUT 撞上 409（真实链路由 App 的
      // autosave 错误处理触发；这里在回合中直接调同一兜底，等价复刻）。
      triggerConflict409();
      expect(reloads).toHaveLength(0); // 关键：回合中绝不立刻 reload
      expect(isAutosaveSuspended()).toBe(true); // autosave 已冻结，旧内容不再写回
      handlers.onTextDelta("撤销完成，两处都退回去了。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    // 回合正常收尾后才重载（恰好一次），回复没被腰斩。
    expect(reloads).toHaveLength(1);
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
    // 重载前把整回合（含 AI 回复）写回会话文件——这是回复不丢的关键。
    const saved = vi.mocked(saveChatSessionMessages).mock.calls.at(-1)?.[2] as readonly { content?: string; suggestedActions?: unknown }[] | undefined;
    expect(saved?.at(-1)?.content).toBe("撤销完成，两处都退回去了。");
    // 落盘的消息里旧建议条已被剥掉（重载后不再显示）。
    expect((saved ?? []).every((m) => !m.suggestedActions)).toBe(true);
    expect(window.sessionStorage.getItem("se-undo-prefer-session")).toBe("1");
  });

  it("回合进行中收到 409 但用户中途切了书：不重载，解冻 autosave（不留永久停摆）", async () => {
    scriptAgentStream((handlers) => {
      triggerConflict409();
      useNavigationStore.setState({ projectPath: "/tmp/another-book" });
      handlers.onTextDelta("已处理。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    expect(reloads).toHaveLength(0);
    expect(isAutosaveSuspended()).toBe(false);
  });

  it("没有 409 的普通回合：行为不变（不重载、不动会话收尾）", async () => {
    scriptAgentStream((handlers) => {
      handlers.onTextDelta("普通回复。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("现在写到哪了"); });

    expect(reloads).toHaveLength(0);
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
  });
});

// R7.2：请求带上「上一个有写盘回合的首个快照」——服务端 undo 工具优先按它整回合回退。
describe("useChat 请求携带整回合撤销锚点 lastTurnUndoHint（R7.2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
    scriptAgentStream((handlers) => handlers.onDone());
  });

  it("上一回合写了两个快照 → 请求带 { snapshotId: 首个, changes: 2 }", async () => {
    useWorkspaceStore.setState({
      workspace: {
        ...mockWorkspaceData,
        messages: [{
          id: "prev-assistant",
          role: "assistant",
          content: "两处都改好了。",
          turnSnapshots: [
            { toolName: "revise_draft", snapshotId: `${"a".repeat(40)}` },
            { toolName: "foundation_write", snapshotId: `${"b".repeat(40)}` },
          ],
        }],
      },
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    const [input] = mockedStreamAgentChat.mock.calls[0] as [StreamAgentChatRequest, AgentChatHandlers];
    expect(input.lastTurnUndoHint).toEqual({ snapshotId: "a".repeat(40), changes: 2 });
  });

  it("纯聊天会话没有写盘快照 → 不带该字段（服务端走默认逐步回退）", async () => {
    useWorkspaceStore.setState({
      workspace: { ...mockWorkspaceData, messages: [{ id: "prev", role: "assistant", content: "聊聊天。" }] },
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    const [input] = mockedStreamAgentChat.mock.calls[0] as [StreamAgentChatRequest, AgentChatHandlers];
    expect(input.lastTurnUndoHint).toBeUndefined();
  });
});

// 「确认定稿」按钮（2026-10-07 拆补丁塔）：点击发结构化动作，服务端直接执行 commit_apply——
// 不再发文本「确认定稿」让模型猜、过正则意图门。
describe("「确认定稿」按钮 → 结构化动作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "commit_apply", toolCallId: "c1", ok: true, committed: true, summary: "第 3 章已定稿。" });
      handlers.onTextDelta("第 3 章已定稿。");
      handlers.onDone();
    });
  });

  const commitApply = (commitTarget?: { chapter?: number; previewToken?: string }) => ({
    id: "commit-apply",
    label: "确认定稿",
    description: "写入定稿章节",
    permission: "formal_state_write" as const,
    requiresConfirmation: false,
    ...(commitTarget ? { commitTarget } : {}),
  });

  it("带目标章与令牌 → streamAgentChat 收到 action，对话留一条「确认定稿第 N 章」", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));

    act(() => {
      result.current.handleSuggestedAction(commitApply({ chapter: 2, previewToken: "tok" }));
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));

    const request = mockedStreamAgentChat.mock.calls[0]![0];
    expect(request.action).toEqual({ toolName: "commit_apply", chapter: 2, previewToken: "tok" });
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "确认定稿第 2 章" });
    expect(messages().some((m) => m.role === "user" && m.content === "确认定稿第 2 章")).toBe(true);
  });

  it("无目标（诚实更正上的「重新确认定稿」）→ 用当前章，不带令牌（服务端用最近一次预览票据）", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));

    act(() => {
      result.current.handleSuggestedAction(commitApply());
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));

    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual({ toolName: "commit_apply", chapter: 3 });
  });

  it("已有操作在跑 → 不发动作、不追加消息", async () => {
    useWorkspaceStore.setState({ chatLoading: true });
    const before = messages();
    const { result } = renderHook(() => useChat(buildParams({})));

    act(() => {
      result.current.handleSuggestedAction(commitApply({ chapter: 3 }));
    });
    await Promise.resolve();

    expect(mockedStreamAgentChat).not.toHaveBeenCalled();
    expect(messages()).toBe(before);
  });
});

describe("handleSendUserAction：「下一步」选项的结构化动作直达（R4.7）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "commit_preview", toolCallId: "cp1", ok: true });
      handlers.onDone();
    });
  });

  it("选项带的 action 直接进 streamAgentChat 请求体（body.action），对话里留一句作者看得懂的回显", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendUserAction({ toolName: "commit_preview", chapter: 5 });
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));

    const request = mockedStreamAgentChat.mock.calls[0]![0];
    expect(request.action).toEqual({ toolName: "commit_preview", chapter: 5 });
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "预览第 5 章的定稿改动" });
    expect(messages().some((m) => m.role === "user" && m.content === "预览第 5 章的定稿改动")).toBe(true);
  });

  it("出稿类动作把作者带回写作台；已有操作在跑 → 不发动作、不追加消息", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));
    const requestCenterView = vi.fn();
    useNavigationStore.setState({ requestCenterView });

    await act(async () => {
      await result.current.handleSendUserAction({ toolName: "generate_draft", chapter: 6 });
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual({ toolName: "generate_draft", chapter: 6 });
    expect(requestCenterView).toHaveBeenCalledWith("desk");

    mockedStreamAgentChat.mockClear();
    useWorkspaceStore.setState({ chatLoading: true });
    const before = messages();
    await act(async () => {
      await result.current.handleSendUserAction({ toolName: "check_continuity", chapter: 5 });
    });
    expect(mockedStreamAgentChat).not.toHaveBeenCalled();
    expect(messages()).toBe(before);
    expect(useNavigationStore.getState().toast).toContain("正在进行");
  });
});
