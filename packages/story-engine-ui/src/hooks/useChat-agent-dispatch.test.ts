import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateOverview } from "../api/types.js";
import { mockWorkspaceData } from "../mockData.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { streamAgentChat } from "../api/agentChatClient.js";
import { fetchStateOverview } from "../api/client.js";
import { fetchChapterPaper, saveWorkingDraft, type ChapterPaper } from "../api/workingDraftClient.js";
import { renameChatSession } from "../api/chatSessionsClient.js";
import { applyOverviewToWorkspace } from "../workspace/applyOverview.js";
import { __resetDraftSyncForTests } from "../drafts/draftSync.js";
import { isPaperCommitted } from "../drafts/useDraftPreview.js";
import { useChat, type UseChatParams } from "./useChat.js";
import type { AgentChatHandlers, StreamAgentChatRequest } from "../api/agentChatClient.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, isWorkspaceBusy, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

// 前端接入：handleSendMessage 把对话交给 Mastra agent SSE。
vi.mock("../api/client.js", () => ({
  fetchChapterChatStream: vi.fn(async () => undefined),
  fetchStateOverview: vi.fn(),
  restoreSnapshotApi: vi.fn(),
}));

vi.mock("../api/agentChatClient.js", () => ({
  streamAgentChat: vi.fn(),
}));

vi.mock("../api/chatSessionsClient.js", () => ({
  renameChatSession: vi.fn(),
  saveChatSessionMessages: vi.fn().mockResolvedValue({ ok: true }),
}));

// 盘上的稿子（重构 P5）：一个假的「盘」，读存都走它；稿纸 draftStore / draftSync 用真的。
vi.mock("../api/workingDraftClient.js", () => ({
  fetchChapterPaper: vi.fn(),
  saveWorkingDraft: vi.fn(),
}));

// 工作区资料刷新只断言调用参数（它本身另有单测）。
vi.mock("../workspace/applyOverview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/applyOverview.js")>();
  return { ...actual, applyOverviewToWorkspace: vi.fn() };
});

const PROJECT = "/tmp/story-engine-agent";
const mockedStreamAgentChat = vi.mocked(streamAgentChat);
const mockedRenameChatSession = vi.mocked(renameChatSession);
const mockedFetchChapterPaper = vi.mocked(fetchChapterPaper);
const mockedSaveWorkingDraft = vi.mocked(saveWorkingDraft);
const mockedFetchStateOverview = vi.mocked(fetchStateOverview);
const mockedApplyOverview = vi.mocked(applyOverviewToWorkspace);

/** 假盘：章号 → 这一章盘上的稿纸。 */
const disk = new Map<number, ChapterPaper>();
let diskVersion = 0;

function emptyPaper(chapter: number): ChapterPaper {
  return { chapter, draft: null, committed: null, editedSinceCommit: null };
}

/** 往盘上写一版（模拟 AI 出稿 / 改稿 / 定稿 / 撤销后盘上的样子）。 */
function writeDisk(chapter: number, input: { readonly draft?: string | null; readonly title?: string; readonly committed?: string | null }): void {
  diskVersion += 1;
  disk.set(chapter, {
    chapter,
    draft: input.draft == null ? null : { chapter, ...(input.title ? { title: input.title } : {}), body: input.draft, version: `v${diskVersion}` },
    committed: input.committed == null ? null : { ...(input.title ? { title: input.title } : {}), body: input.committed },
    editedSinceCommit: input.committed == null || input.draft == null ? null : input.draft !== input.committed,
  } as ChapterPaper);
}

/** 盘上写好、稿纸也打开这一章（作者正在看它）。 */
function seedPaper(chapter: number, input: Parameters<typeof writeDisk>[1]): void {
  writeDisk(chapter, input);
  useDraftStore.getState().loadPaper(PROJECT, disk.get(chapter)!, `第${chapter}章`);
}

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
  __resetDraftSyncForTests();
  useNavigationStore.setState({ projectPath: PROJECT, toast: null });
  useWorkspaceStore.setState({
    workspace: { ...mockWorkspaceData, messages: [] },
    chatLoading: false,
    chatError: null,
    selectedAdviceCards: [],
    aiFlavorPending: null,
    activeSessionId: "session-a",
    sessions: [{ id: "session-a", name: "新会话", updatedAt: "2026-07-13T00:00:00.000Z" }],
    draftActionLoading: null,
    steeringLoading: false,
  });
  disk.clear();
  diskVersion = 0;
  mockedFetchChapterPaper.mockReset();
  mockedFetchChapterPaper.mockImplementation(async (_projectPath, chapter) => disk.get(chapter) ?? emptyPaper(chapter));
  mockedSaveWorkingDraft.mockReset();
  mockedSaveWorkingDraft.mockImplementation(async (input) => {
    const current = disk.get(input.chapter);
    if ((current?.draft?.version ?? null) !== input.baseVersion) {
      return { ok: false, conflict: true, message: "这一章的稿子在别处改过了。", current: current?.draft ?? null };
    }
    writeDisk(input.chapter, { draft: input.body, ...(input.title ? { title: input.title } : {}), committed: current?.committed?.body ?? null });
    return { ok: true, version: disk.get(input.chapter)!.draft!.version, unchanged: false };
  });
  mockedFetchStateOverview.mockReset();
  mockedFetchStateOverview.mockResolvedValue(makeOverview("盘上"));
  useDraftStore.getState().reset();
  // 作者正在看第 3 章（mockWorkspaceData.currentChapter），盘上已有一版工作稿。
  seedPaper(3, { draft: "第三章原有的工作稿。", title: "第三章" });
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
    projectPath: PROJECT,
    handleApplyRevisionPreview: async () => undefined,
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
      const before = messages();
      const { result } = renderHook(() => useChat(buildParams({})));

      await act(async () => {
        await result.current.handleSendMessage("帮我写这一章的草稿。");
      });

      expect(messages()).toBe(before);
      expect(mockedRenameChatSession).not.toHaveBeenCalled();
      expect(mockedStreamAgentChat).not.toHaveBeenCalled();
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

  it("onToolResult refreshScope=full 刷资料（applyOverviewToWorkspace），稿纸按盘上重读", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Full");
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "read_state_overview", refreshScope: "full", overview });
      handlers.onDone();
    });
    const refreshWorkspaceFromOverview = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ refreshWorkspaceFromOverview })));

    await act(async () => {
      await result.current.handleSendMessage("现状");
    });

    expect(mockedApplyOverview).toHaveBeenCalledTimes(1);
    expect(mockedApplyOverview.mock.calls[0][0]).toBe(overview);
    expect(refreshWorkspaceFromOverview).not.toHaveBeenCalled();
    expect(mockedFetchChapterPaper).toHaveBeenCalledWith(PROJECT, 3);
  });

  it("generate_draft 写完：稿纸换成盘上那一版终稿，流程态 draft_ready", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Draft");
    const realDraft = "夜色四合，主角推开祠堂斑驳的木门，借着月光看清了梁上的刻痕。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: realDraft.slice(0, 10) });
      // 服务端写完落盘，再回结果。
      writeDisk(3, { draft: realDraft, title: "夜探祠堂" });
      handlers.onToolResult({
        toolName: "generate_draft",
        toolCallId: "g1",
        refreshScope: "full",
        overview,
        ok: true,
        draftBody: realDraft,
        draftTitle: "夜探祠堂",
      });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("写第一章，主角夜探祠堂");
    });

    expect(mockedApplyOverview).toHaveBeenCalledWith(overview, { flowStatus: "draft_ready", title: "夜探祠堂" });
    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: realDraft, title: "夜探祠堂", streaming: null });
    // 稿纸与盘一致：不会再回写一遍。
    expect(useDraftStore.getState().savedBody).toBe(realDraft);
  });

  it("出稿流式的字只显示（稿纸只读），不进作者的稿子", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "正在流出来的字" });
      await gate;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toContain("正在流出来的字"));
    expect(useDraftStore.getState().body).toBe("第三章原有的工作稿。");
    release();
    await act(async () => { await pending; });
    expect(useDraftStore.getState().streaming).toBeNull();
  });

  it("explicitly adopts a generate_draft target chapter and keeps streaming next-chapter support", async () => {
    const overview = makeOverview("Next chapter");
    const body = "第四章的新正文。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft" });
      handlers.onDraftDelta?.({ chapter: 4, text: body });
      handlers.onDraftDelta?.({ chapter: 3, text: "绝不能串回第三章的片段。" });
      writeDisk(4, { draft: body, title: "第四章" });
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
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("继续写下一章");
    });

    expect(useWorkspaceStore.getState().workspace.currentChapter.chapterNumber).toBe(4);
    expect(useDraftStore.getState().chapter).toBe(4);
    expect(useDraftStore.getState().body).toBe(body);
    expect(useDraftStore.getState().body).not.toContain("串回第三章");
    expect(mockedApplyOverview).toHaveBeenCalledWith(overview, { flowStatus: "draft_ready", chapter: 4, title: "第四章" });
    // 第三章原稿还在盘上，没被动过。
    expect(disk.get(3)?.draft?.body).toBe("第三章原有的工作稿。");
  });

  it("换到另一章出稿前，先把手上那章没存的字存掉", async () => {
    useDraftStore.getState().edit("作者在第三章刚打的字。");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft" });
      handlers.onDraftDelta?.({ chapter: 4, text: "第四章。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("写第四章");
    });

    expect(disk.get(3)?.draft?.body).toBe("作者在第三章刚打的字。");
  });

  it("a stale agent finally releases its token without clearing loading in the replacement workspace", async () => {
    let release!: () => void;
    mockedStreamAgentChat.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSendMessage("开始一轮慢请求");
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalled());
    useNavigationStore.setState({ projectPath: null });
    useWorkspaceStore.setState({ chatLoading: true });
    release();
    await act(async () => pending);

    expect(useWorkspaceStore.getState().chatLoading).toBe(true);
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("commit_apply 定稿：稿纸按盘上换成已定稿，流程态 committed", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Committed");
    const committedBody = "已经定稿入库的第三章正文。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      writeDisk(3, { draft: committedBody, committed: committedBody, title: "夜探祠堂" });
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
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("确认入库");
    });

    expect(mockedApplyOverview).toHaveBeenCalledWith(overview, { flowStatus: "committed", title: "夜探祠堂" });
    expect(useDraftStore.getState().committed?.body).toBe(committedBody);
    expect(isPaperCommitted()).toBe(true);
  });

  it("commits full workspace truth when commit_apply succeeds without an overview", async () => {
    const committedBody = "没有 overview 也必须落成 committed 的正文。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      writeDisk(3, { draft: committedBody, committed: committedBody, title: "无概览定稿" });
      handlers.onToolResult({
        toolName: "commit_apply",
        committed: true,
        draftBody: committedBody,
        draftTitle: "无概览定稿",
      });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("确认定稿");
    });

    const state = useWorkspaceStore.getState().workspace;
    expect(mockedApplyOverview).not.toHaveBeenCalled();
    expect(state.flowStatus).toBe("committed");
    expect(state.currentChapter).toMatchObject({ hasCommittedChapter: true, hasDraftFile: true });
    expect(useDraftStore.getState()).toMatchObject({ body: committedBody, title: "无概览定稿" });
    expect(isPaperCommitted()).toBe(true);
  });

  it("定稿结果在断流里丢了、盘上其实已定稿 → 按盘上更正成已定稿并说一声", async () => {
    const committedBody = "# 磁盘定稿标题\n\n这是已经真正写盘的完整定稿正文。";
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      writeDisk(3, { draft: committedBody, committed: committedBody, title: "磁盘定稿标题" });
      handlers.onError("SSE disconnected after disk commit", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("确认定稿");
    });

    const state = useWorkspaceStore.getState();
    expect(state.workspace.flowStatus).toBe("committed");
    expect(state.workspace.currentChapter).toMatchObject({ chapterNumber: 3, hasCommittedChapter: true });
    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: committedBody, title: "磁盘定稿标题" });
    expect(useDraftStore.getState().committed?.body).toBe(committedBody);
    expect(mockedFetchStateOverview).toHaveBeenCalledWith({ projectPath: PROJECT, maxTimelineEvents: 8 });
    expect(messages().some((m) => m.content.includes("其实已经定稿"))).toBe(true);
  });

  it("纯读工具断流：不重读盘、作者的稿子原样", async () => {
    const unsavedDraft = "这是作者尚未保存的新版本，质检断流绝不能把它覆盖。";
    useDraftStore.getState().edit(unsavedDraft);
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "quality_check" });
      handlers.onError("quality stream disconnected", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("检查这版草稿");
    });

    expect(useDraftStore.getState().body).toBe(unsavedDraft);
    expect(mockedFetchStateOverview).not.toHaveBeenCalled();
  });

  it("发给 AI 之前先把作者没存的字存上盘（AI 读的是盘上的稿）", async () => {
    useDraftStore.getState().edit("作者刚改的一句。");
    let diskWhenSent: string | undefined;
    scriptAgentStream((handlers) => {
      diskWhenSent = disk.get(3)?.draft?.body;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("帮我看看这一段");
    });

    expect(diskWhenSent).toBe("作者刚改的一句。");
  });

  it("does not reconcile a commit_apply error to unrelated committed bytes", async () => {
    const attemptedDraft = "这是本轮确认定稿时编辑器里的唯一正文。";
    seedPaper(3, { draft: attemptedDraft, committed: "# 旧正式稿\n\n早就定稿的旧正文。", title: "本轮正文" });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply" });
      handlers.onError("commit stream disconnected", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("确认定稿");
    });

    expect(useDraftStore.getState().body).toBe(attemptedDraft);
    expect(useWorkspaceStore.getState().workspace.flowStatus).not.toBe("committed");
    expect(messages().some((m) => m.content.includes("其实已经定稿"))).toBe(false);
  });

  it("bounds commit reconciliation so a stalled paper read cannot hold the workspace operation forever", async () => {
    vi.useFakeTimers();
    try {
      scriptAgentStream((handlers) => {
        handlers.onToolCall({ toolName: "commit_apply" });
        mockedFetchChapterPaper.mockImplementation(() => new Promise(() => undefined));
        handlers.onError("commit result stream disconnected", true);
      });
      const { result } = renderHook(() => useChat(buildParams({})));

      let pending!: Promise<void>;
      act(() => { pending = result.current.handleSendMessage("确认定稿"); });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(isWorkspaceBusy()).toBe(false);
      expect(useWorkspaceStore.getState().chatLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onToolResult for a read-only full refresh preserves the existing draft body", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Read");
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "read_state_overview", refreshScope: "full", overview });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("现在写到哪了");
    });

    expect(useDraftStore.getState().body).toBe("第三章原有的工作稿。");
    expect(useDraftStore.getState().incoming).toBeNull();
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
    const refreshWorkspaceFromOverview = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ refreshWorkspaceFromOverview })));

    await act(async () => {
      await result.current.handleSendMessage("把这条记进资料");
    });

    expect(refreshWorkspaceFromOverview).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceFromOverview.mock.calls[0][0]).toBe(overview);
    expect(mockedApplyOverview).not.toHaveBeenCalled();
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

  it("流式出稿中途点「停止」→ running 步骤结算 stopped、flowStatus 复位、已流出内容留给作者、拉一次盘上对账", async () => {
    seedPaper(3, { draft: "短" });
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "已流出的一截新正文。" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    mockedFetchChapterPaper.mockClear();
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    // 残留 running → stopped（不是 failed），补 endedAt；金光/字幕随之静止。
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    expect(typeof agentMessage.toolSteps![0].endedAt).toBe("number");
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
    // 已写出的内容留给作者（盘上那版更短），稿纸不再只读。
    expect(useDraftStore.getState().body).toContain("已流出的一截新正文");
    expect(useDraftStore.getState().streaming).toBeNull();
    // 写类工具在飞 → 拉了一次盘上对账。
    expect(mockedFetchChapterPaper).toHaveBeenCalledWith(PROJECT, 3);
    // 停止不是失败：无错误气泡。
    expect(messages().filter((m) => m.isErrorNotice)).toHaveLength(0);
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
  });

  it("「停止」后盘上稿更完整（服务端停止前已写完）→ 稿纸换成盘上那版并如实说", async () => {
    const fullDraftOnDisk = "这是服务端在停止前其实已经写完整的一整章正文，比编辑器里流出的半截要长得多。";
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "半截。" });
      writeDisk(3, { draft: fullDraftOnDisk, title: "夜探祠堂" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, title: "夜探祠堂", body: fullDraftOnDisk, savedBody: fullDraftOnDisk });
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
    expect(messages().some((m) => m.content.includes("其实已经写完了"))).toBe(true);
  });

  it("「停止」后对账读盘期间作者又动了稿 → 不用盘稿盖掉新编辑（出提示让作者选）", async () => {
    const gate = deferred<ChapterPaper>();
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onDraftDelta?.({ chapter: 3, text: "半截。" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    mockedFetchChapterPaper.mockReturnValueOnce(gate.promise);
    act(() => { result.current.stopAgent(); });
    await vi.waitFor(() => expect(mockedFetchChapterPaper).toHaveBeenCalled());
    act(() => { useDraftStore.getState().edit("作者停止后亲手改的新版本。"); });
    writeDisk(3, { draft: "盘上其实有一版长得多的完整稿，但绝不能盖掉作者的新编辑。" });
    gate.resolve(disk.get(3)!);
    await act(async () => { await pending; });

    expect(useDraftStore.getState().body).toBe("作者停止后亲手改的新版本。");
    expect(useDraftStore.getState().incoming).not.toBeNull();
  });

  it("「停止」腰斩 commit_apply 且盘上已定稿 → 按「其实已入库」整体恢复", async () => {
    const committedBody = "停止前其实已经真正入库定稿的正文。";
    seedPaper(3, { draft: committedBody, title: "磁盘定稿标题" });
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "commit_apply", toolCallId: "c1" });
      writeDisk(3, { draft: committedBody, committed: committedBody, title: "磁盘定稿标题" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("确认定稿"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const state = useWorkspaceStore.getState();
    expect(state.workspace.flowStatus).toBe("committed");
    expect(isPaperCommitted()).toBe(true);
    expect(state.workspace.currentChapter.hasCommittedChapter).toBe(true);
    expect(messages().some((m) => m.content.includes("其实已经定稿"))).toBe(true);
  });

  /* ---- #13（长跑×3）：回合正常收尾后 flowStatus 不得残留 draft_generating ---- */

  it("出稿写了另一章（跨章 tool-result 直接 return）→ 当前章立即退出「正在生成工作稿…」，不挂到回合结束", async () => {
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

    // 稿纸上本就有第 3 章的稿子 → 诚实复位成 draft_ready，而不是谎报「正在生成」。
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onTextDelta("这章的稿子已经准备好了。");
      await gate;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_generating"));
    release();
    await act(async () => { await pending; });

    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
  });

  it("纯读回合点「停止」→ 步骤结算 stopped、不拉盘上对账、流程态不动", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "read_state_overview", toolCallId: "r1" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    const flowBefore = useWorkspaceStore.getState().workspace.flowStatus;

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("现在写到哪了"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    mockedFetchChapterPaper.mockClear();
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    expect(mockedFetchChapterPaper).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe(flowBefore);
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
  });

  it("被「停止」腰斩的回合不做诚实盖文——半截流式文本不等于「声称完成」", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "generate_draft", toolCallId: "g1" });
      handlers.onTextDelta("第3章正文已经写好了，接下来");
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章"); });
    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(true));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    expect(agentMessage.content).toBe("第3章正文已经写好了，接下来");
    expect(agentMessage.content).not.toContain("没有检测到");
  });
});

// AI 撤销（undo_last_change / manage_snapshots op=undo）：服务端已回退盘上，稿纸按盘上那版直接换上（撤销是作者要的），
// 原地更新、不整页刷新（重构 P5）。旧字写不回去：存稿带版本号，盘上变了旧版本存不进。
describe("useChat agent 撤销：稿纸原地换成盘上那版（重构 P5）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
  });

  it("undone=true：盘上回退后的那版直接换上稿纸，流程态按它算，旧回合的过时建议条剥掉", async () => {
    const diskAfterUndo = "盘上回退后的更早版本。";
    useWorkspaceStore.getState().updateWorkspace({
      flowStatus: "draft_ready",
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
    });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "undo_last_change", toolCallId: "u1" });
      writeDisk(3, { draft: diskAfterUndo, title: "回退后的标题" });
      handlers.onToolResult({
        toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销上一步「出稿」。",
        refreshScope: "full", overview: makeOverview("T"),
      });
      handlers.onTextDelta("已撤销上一步「出稿」。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, title: "回退后的标题", body: diskAfterUndo, savedBody: diskAfterUndo });
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("draft_ready");
    expect(lastAssistant()?.content).toBe("已撤销上一步「出稿」。");
    expect(messages().every((m) => !m.suggestedActions?.some((a) => a.id === "confirm-write"))).toBe(true);
  });

  it("undone=true 且盘上已无草稿（撤到「还没写过」）→ 稿纸清空、流程态 idle", async () => {
    scriptAgentStream((handlers) => {
      disk.set(3, emptyPaper(3));
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销上一步「出稿」。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(useDraftStore.getState().body).toBe("");
    expect(useWorkspaceStore.getState().workspace.flowStatus).toBe("idle");
  });

  it("撤销时作者手上还有没存的字 → 也换成盘上那版（撤销是作者自己要的）", async () => {
    scriptAgentStream((handlers) => {
      useDraftStore.getState().edit("撤销前作者手上没存的字");
      writeDisk(3, { draft: "撤销后盘上那版" });
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(useDraftStore.getState().body).toBe("撤销后盘上那版");
    expect(useDraftStore.getState().incoming).toBeNull();
  });

  it("undone=false（没东西可撤）→ 稿纸不动", async () => {
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: false, summary: "没有可撤销的改动。" });
      handlers.onTextDelta("当前没有可撤销的改动。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(useDraftStore.getState().body).toBe("第三章原有的工作稿。");
  });

  it("读盘失败 → 稿纸原样、回合照常收尾、不冒错误气泡", async () => {
    scriptAgentStream((handlers) => {
      mockedFetchChapterPaper.mockRejectedValue(new Error("网络抖动"));
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销上一步「出稿」。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(useDraftStore.getState().body).toBe("第三章原有的工作稿。");
    expect(messages().filter((m) => m.isErrorNotice)).toHaveLength(0);
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
    expect(isWorkspaceBusy()).toBe(false);
  });
});

// AI 改了这一章、作者手上又有没存的字：不整页刷新、不丢任何一边——稿纸上方出提示让作者选（重构 P5，取代 R7.2 的 409 重载）。
describe("useChat AI 改稿撞上作者没存的字", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
  });

  it("AI 改稿落盘时作者正在打字 → 作者的字留着，盘上那版挂成提示；回复完整", async () => {
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "revise_draft", toolCallId: "r1" });
      useDraftStore.getState().edit("AI 改稿期间作者自己打的字。");
      writeDisk(3, { draft: "AI 改好的新一版。" });
      handlers.onToolResult({ toolName: "revise_draft", toolCallId: "r1", ok: true, summary: "改好了。" });
      handlers.onTextDelta("改好了，换不换你来定。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("把第三章开头改紧一点"); });

    const paper = useDraftStore.getState();
    expect(paper.body).toBe("AI 改稿期间作者自己打的字。");
    expect(paper.incoming).toMatchObject({ cause: "update" });
    expect(lastAssistant()?.content).toBe("改好了，换不换你来定。");
    expect(useWorkspaceStore.getState().chatLoading).toBe(false);
  });

  it("AI 改稿落盘、作者没动稿 → 直接换上新一版", async () => {
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "revise_draft", toolCallId: "r1" });
      writeDisk(3, { draft: "AI 改好的新一版。" });
      handlers.onToolResult({ toolName: "revise_draft", toolCallId: "r1", ok: true, summary: "改好了。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("把第三章开头改紧一点"); });

    expect(useDraftStore.getState()).toMatchObject({ body: "AI 改好的新一版。", incoming: null });
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

describe("handleChapterButton：写作区固定按钮直接发结构化动作（重构 P4）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
    scriptAgentStream((handlers) => handlers.onDone());
  });

  it("「内容审阅」带当前章号发 ai_review 动作；「撤销上一步」发 undo", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));
    const chapter = useWorkspaceStore.getState().workspace.currentChapter.chapterNumber;

    act(() => result.current.handleChapterButton("ai_review"));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual({ toolName: "ai_review", chapter });

    await vi.waitFor(() => expect(useWorkspaceStore.getState().chatLoading).toBe(false));
    act(() => result.current.handleChapterButton("undo"));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(2));
    expect(mockedStreamAgentChat.mock.calls[1]![0].action).toEqual({ toolName: "undo" });
  });

  it("「写这一章」带方向框里的字（原样）作章纲方向", async () => {
    useWorkspaceStore.setState({ steeringDirection: " 林澈夜探旧泵站 " });
    const { result } = renderHook(() => useChat(buildParams({})));
    const chapter = useWorkspaceStore.getState().workspace.currentChapter.chapterNumber;

    act(() => result.current.handleChapterButton("write"));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual({ toolName: "generate_draft", chapter, chapterGoal: "林澈夜探旧泵站" });
  });

  it("作者自己打出和按钮一样的字 → 交给 AI（不带 action），不再被认成按钮", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("预览这一章的定稿改动");
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toBeUndefined();
  });
});
