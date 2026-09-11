import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateOverview } from "../api/types.js";
import { mockWorkspaceData } from "../mockData.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { streamAgentChat } from "../api/agentChatClient.js";
import { directEditDraft, fetchChapterWorkspace } from "../api/client.js";
import { renameChatSession } from "../api/chatSessionsClient.js";
import { useChat, type UseChatParams } from "./useChat.js";
import type { AgentChatHandlers, StreamAgentChatRequest } from "../api/agentChatClient.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, isWorkspaceBusy, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

// 前端接入：handleSendMessage 把对话交给 Mastra agent SSE。
vi.mock("../api/client.js", () => ({
  applyFoundationGapDecisions: vi.fn(),
  directEditDraft: vi.fn(),
  fetchChapterChatStream: vi.fn(async () => undefined),
  fetchChapterWorkspace: vi.fn(),
}));

vi.mock("../api/agentChatClient.js", () => ({
  streamAgentChat: vi.fn(),
}));

vi.mock("../api/chatSessionsClient.js", () => ({
  renameChatSession: vi.fn(),
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
    handleCommitPreview: async () => undefined,
    handleCommitApply: () => undefined,
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

  it("明确执行请求但 agent 没有调用对应工具时，用确定性文案盖掉空口回复", async () => {
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
    expect(assistant.content).toContain("资料写入没有执行");
    expect(assistant.content).toContain("没有检测到写入资料操作");
    expect(assistant.content).not.toContain("foundation_write");
    expect(assistant.content).not.toContain("已经帮你整理好了");
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

  it("foundation write owns the slot and drops a late completion after workspace replacement", async () => {
    const gate = deferred<any>();
    const applyFoundation = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useChat(buildParams({
      handleApplyFoundationGapSuggestionsFromChat: applyFoundation,
    })));

    act(() => {
      result.current.handleSuggestedAction({
        id: "accept-foundation-suggestions",
        label: "确认写入资料",
        description: "写入资料",
        permission: "project_config_write",
        requiresConfirmation: true,
        endpoint: "suggestion-1",
      });
    });
    await vi.waitFor(() => expect(applyFoundation).toHaveBeenCalled());
    const intruder = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/story-engine-agent",
      chapter: useWorkspaceStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: "session-a",
    });
    if (intruder) finishWorkspaceOperation(intruder);
    expect(intruder).toBeNull();

    useNavigationStore.setState({ projectPath: null });
    useWorkspaceStore.setState({
      activeSessionId: "session-b",
      workspace: {
        ...useWorkspaceStore.getState().workspace,
        currentChapter: { id: "ch-2", chapterNumber: 2, title: "第二章", status: "current" },
        messages: [{ id: "replacement-message", role: "user", content: "第二章安全消息" }],
      },
    });
    gate.resolve({ plan: {}, writes: [], skippedWrites: [] });
    await vi.waitFor(() => expect(isWorkspaceBusy()).toBe(false));

    expect(useWorkspaceStore.getState().workspace.messages).toEqual([
      { id: "replacement-message", role: "user", content: "第二章安全消息" },
    ]);
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

  // 复审 P3：useChat finally 里的诚实收尾接线（回合终点 honestyRewritePatch(finished.content,
  // finished.toolSteps) → updateMessage 盖掉假成功）此前零直测。链路：onToolResult(output:info)
  // → toolStep 带 dryRun → finally 探针判「无写背书」→ 正文被确定性失败文案盖掉。
  it("finally 诚实收尾：dry-run 预览态 prune 不背书「已保存」声称 → 盖掉假成功正文", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "prune_snapshots", toolCallId: "p1" });
      handlers.onToolResult({ toolName: "prune_snapshots", toolCallId: "p1", ok: true, dryRun: true, summary: "预览：可裁剪 3 个旧快照。" });
      handlers.onTextDelta("旧快照已裁剪，备份已保存。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("帮我看看能裁剪哪些旧快照");
    });

    const assistant = lastAssistant()!;
    expect(assistant.toolSteps![0]).toMatchObject({ status: "completed", dryRun: true });
    expect(assistant.content).toContain("没有检测到对应写入工具成功执行");
    expect(assistant.content).not.toContain("备份已保存");
  });

  it("finally 诚实收尾：prune 真裁（dryRun:false）背书同一句声称 → 不盖正文", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "prune_snapshots", toolCallId: "p1" });
      handlers.onToolResult({ toolName: "prune_snapshots", toolCallId: "p1", ok: true, dryRun: false, summary: "已裁剪 3 个旧快照。" });
      handlers.onTextDelta("旧快照已裁剪，备份已保存。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("确认裁剪旧快照");
    });

    const assistant = lastAssistant()!;
    expect(assistant.toolSteps![0]).toMatchObject({ status: "completed", dryRun: false });
    expect(assistant.content).toContain("备份已保存");
  });
});
