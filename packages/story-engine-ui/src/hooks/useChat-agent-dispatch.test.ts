import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateOverview } from "../api/types.js";
import { mockWorkspaceData } from "../mockData.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { streamAgentChat } from "../api/agentChatClient.js";
import { fetchStateOverview, restoreSnapshotApi } from "../api/client.js";
import { fetchChapterPaper, saveWorkingDraft, type ChapterPaper } from "../api/workingDraftClient.js";
import { renameChatSession } from "../api/chatSessionsClient.js";
import { applyOverviewToWorkspace } from "../workspace/applyOverview.js";
import { __resetDraftSyncForTests, editDraft, flushDraftSave, openPaper } from "../drafts/draftSync.js";
import { isPaperCommitted } from "../drafts/useDraftPreview.js";
import { useChat, type UseChatParams } from "./useChat.js";
import type { AgentChatHandlers, StreamAgentChatRequest } from "../api/agentChatClient.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, isWorkspaceBusy, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";
import { cardOf, hasCard } from "../utils/messageCards.js";
import { draftChoiceAction } from "../utils/workflowHelpers.js";
import { cancelOperationRequest, listActiveOperations } from "../api/operationsClient.js";
import { newDraftAction, newInspectAction, type OperationViewData } from "../api/agentChatClient.js";

// 前端接入：handleSendMessage 把对话交给 Mastra agent SSE。
vi.mock("../api/client.js", () => ({
  fetchChapterChatStream: vi.fn(async () => undefined),
  fetchStateOverview: vi.fn(),
  restoreSnapshotApi: vi.fn(),
}));

vi.mock("../api/agentChatClient.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/agentChatClient.js")>(),
  streamAgentChat: vi.fn(),
}));

// 停掉在做的操作（写作版本 P2a）走操作接口，只断言调用。
vi.mock("../api/operationsClient.js", () => ({
  cancelOperationRequest: vi.fn(async () => ({ cancelled: true })),
  listActiveOperations: vi.fn(async () => []),
  followOperationEvents: vi.fn(async () => undefined),
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
  useDraftStore.getState().loadPaper(PROJECT, disk.get(chapter)!);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
  useBookStore.setState({
    workspace: mockWorkspaceData,
  });
  useChatStore.setState({
    messages: [],
    chatLoading: false,
    chatError: null,
    activeSessionId: "session-a",
    sessions: [{ id: "session-a", name: "新会话", updatedAt: "2026-07-13T00:00:00.000Z" }],
  });
  useUiStore.setState({
    aiFlavorPending: null,
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
  return useChatStore.getState().messages;
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
    refreshWorkspaceFromOverview: () => undefined,
    ...overrides,
  };
}

const DRAFT_OP = "op-draft56789abcdef0123";

/** 这一轮交上的写稿操作（draft.change）此刻的样子。 */
function draftView(overrides: Partial<OperationViewData> = {}): OperationViewData {
  return {
    opId: DRAFT_OP, kind: "draft.change", mode: "write", chapter: 3, what: "写第 3 章", state: "running", stateText: "在做",
    allowed: ["cancel"], summary: "", conclusion: "", eventSeq: 1, origin: { kind: "chat", messageId: "user-x" }, ...overrides,
  };
}

/** 写稿做完、换上了工作稿。 */
function draftDone(chapter: number, title?: string): OperationViewData {
  return draftView({ chapter, state: "succeeded", stateText: "做完了", allowed: [], eventSeq: 9, draft: { chapter, applied: true, ...(title ? { title } : {}) } });
}

/** 写稿操作的一段正文流。 */
function draftDelta(text: string, streamSeq: number, extra: { readonly replace?: true; readonly base?: true; readonly exec?: string } = {}) {
  const { exec = "exec-1", ...flags } = extra;
  return { opId: DRAFT_OP, event: { type: "draft-delta" as const, exec, streamSeq, text, ...flags } };
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
        chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
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

  it("作者给当前章挑过走法：请求带上那条走法原文（说「照甲写」时 AI 才知道甲是什么）；没挑不带", async () => {
    scriptAgentStream((handlers) => handlers.onDone());
    const brainstorm = { chapter: 3, idea: "别急着揭底", checked: true, options: [{ title: "老民警", steps: ["去派出所", "只漏出名字"], threads: [], problems: [] }] };
    useChatStore.setState({ messages: [{ id: "d", role: "assistant", content: "", cards: [{ type: "directions", brainstorm, picked: 0 }] }] });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("照甲写，改一处");
    });
    const [picked] = mockedStreamAgentChat.mock.calls[0] as [StreamAgentChatRequest, AgentChatHandlers];
    expect(picked.pickedDirection).toEqual({ chapter: 3, text: "老民警：1. 去派出所 2. 只漏出名字\n作者要走法时说：别急着揭底" });

    useChatStore.setState({ messages: [{ id: "e", role: "assistant", content: "", cards: [{ type: "directions", brainstorm }] }] });
    await act(async () => {
      await result.current.handleSendMessage("写这一章");
    });
    const [unpicked] = mockedStreamAgentChat.mock.calls[1] as [StreamAgentChatRequest, AgentChatHandlers];
    expect(unpicked.pickedDirection).toBeUndefined();
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
    useChatStore.setState({
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

    expect(useChatStore.getState().sessions).toEqual([
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

  it("写稿操作做完：稿纸换成盘上那一版终稿，流程态 draft_ready", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const realDraft = "夜色四合，主角推开祠堂斑驳的木门，借着月光看清了梁上的刻痕。";
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.(draftDelta(realDraft.slice(0, 10), 1));
      // 服务端写完落盘，再报做完。
      writeDisk(3, { draft: realDraft, title: "夜探祠堂" });
      handlers.onOperation?.(draftDone(3, "夜探祠堂"));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("写第一章，主角夜探祠堂");
    });

    expect(mockedApplyOverview).toHaveBeenCalledWith(expect.anything(), { flowStatus: "draft_ready", chapter: 3, title: "夜探祠堂" });
    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: realDraft, title: "夜探祠堂", streaming: null });
    // 稿纸与盘一致：不会再回写一遍。
    expect(useDraftStore.getState().savedBody).toBe(realDraft);
    expect(cardOf(lastAssistant()!, "operation")?.op).toMatchObject({ opId: DRAFT_OP, state: "succeeded" });
  });

  it("改稿操作（片 2C）：不流正文、不进「正在生成」；停着等作者时卡上摆改法；换上了稿纸按盘上重读、高亮改后那句", async () => {
    const pending = { kind: "revise" as const, actionId: "confirm:1", decisions: ["apply", "again"], revise: { round: 1, changes: [{ from: "第三章原有的工作稿。", to: "第三章改过的稿。" }], failed: [] } };
    const editView = (overrides: Partial<OperationViewData>) => draftView({ mode: "revise", what: "改稿·第 3 章", ...overrides });
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(editView({}));
      expect(useBookStore.getState().workspace.flowStatus).not.toBe("draft_generating");
      handlers.onOperation?.(editView({ state: "waiting_author", stateText: "等你定", eventSeq: 4, pending }));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      await result.current.handleSendMessage("把这句改顺一点");
    });
    expect(cardOf(lastAssistant()!, "operation")?.op).toMatchObject({ state: "waiting_author", pending });
    expect(useDraftStore.getState().body).toBe("第三章原有的工作稿。");

    // 作者点「换上」：新一轮接着做，做完了按盘上重读。
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(editView({ eventSeq: 5 }));
      writeDisk(3, { draft: "第三章改过的稿。", title: "第三章" });
      handlers.onOperation?.(editView({ state: "succeeded", stateText: "做完了", allowed: [], eventSeq: 9, draft: { chapter: 3, applied: true, changes: [{ from: "第三章原有的工作稿。", to: "第三章改过的稿。" }] } }));
      handlers.onDone();
    });
    await act(async () => {
      await result.current.handleSendUserAction({ kind: "resume", opId: DRAFT_OP, answer: { actionId: "confirm:1", decision: "apply" } });
    });
    expect(messages().filter((message) => message.role === "user").at(-1)?.content).toBe("换上");
    expect(useDraftStore.getState()).toMatchObject({ body: "第三章改过的稿。", streaming: null });
    expect(useUiStore.getState().revisionHighlightTexts).toEqual(["第三章改过的稿。"]);
    // 等作者的改法、按钮、结论只挂在新一轮那条上（老的那条只留一行状态）。
    const carrying = messages().filter((message) => cardOf(message, "operation")?.op.opId === DRAFT_OP);
    expect(carrying.map((message) => cardOf(message, "operation")?.op.pending)).toEqual([undefined, undefined]);
    expect(cardOf(carrying[0]!, "operation")?.op).toMatchObject({ state: "succeeded", allowed: [], summary: "" });
  });

  it("出稿流式的字只显示（稿纸只读），不进作者的稿子", async () => {
    const gate = deferred<void>();
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.(draftDelta("正在流出来的字", 1));
      await gate.promise;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toContain("正在流出来的字"));
    expect(useDraftStore.getState().body).toBe("第三章原有的工作稿。");
    gate.resolve();
    await act(async () => { await pending; });
    expect(useDraftStore.getState().streaming).toBeNull();
  });

  it("正文流按号拼：replace 换掉已流出的新写的字，迟到的旧号丢掉；一步重做（换了执行）之前流的作废", async () => {
    const gate = deferred<void>();
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.(draftDelta("前面写好的。\n\n重演的一段", 1));
      handlers.onOperationLive?.(draftDelta("前面写好的。\n\n", 2, { replace: true }));
      handlers.onOperationLive?.(draftDelta("新的一段", 3));
      handlers.onOperationLive?.(draftDelta("迟到的旧片段", 2));
      await gate.promise;
      handlers.onOperationLive?.({ opId: DRAFT_OP, event: { type: "step", step: "write:1", exec: "exec-2" } });
      handlers.onOperationLive?.(draftDelta("重做的一版", 1, { exec: "exec-2" }));
      handlers.onOperationLive?.(draftDelta("旧执行迟到的", 4));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    let afterRedo = "";
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toContain("新的一段"));
    expect(useDraftStore.getState().streaming).not.toContain("重演的一段");
    expect(useDraftStore.getState().streaming).not.toContain("迟到的旧片段");
    const unsubscribe = useDraftStore.subscribe((state) => { if (state.streaming) afterRedo = state.streaming; });
    gate.resolve();
    await act(async () => { await pending; });
    unsubscribe();
    expect(afterRedo).toBe("重做的一版");
  });

  it("别的操作的正文流不进稿纸", async () => {
    const gate = deferred<void>();
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.({ ...draftDelta("别的操作的字", 1), opId: "op-other0123456789abcd" });
      handlers.onOperationLive?.(draftDelta("这次的字", 1));
      await gate.promise;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toBe("这次的字"));
    gate.resolve();
    await act(async () => { await pending; });
  });

  it("写的是另一章：稿纸、当前章、这轮对话都换到那章；第三章原稿不动", async () => {
    const body = "第四章的新正文。";
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4, what: "写第 4 章" }));
      handlers.onOperationLive?.(draftDelta(body, 1));
      writeDisk(4, { draft: body, title: "第四章" });
      handlers.onOperation?.(draftDone(4, "第四章"));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("继续写下一章");
    });

    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(4);
    expect(useDraftStore.getState()).toMatchObject({ chapter: 4, body });
    // 这一轮对话归第四章：之后在第四章接着聊，它不收进「别的章的对话」。
    expect(useChatStore.getState().messages.find((message) => message.role === "user" && message.content === "继续写下一章")?.chapter).toBe(4);
    expect(mockedApplyOverview).toHaveBeenCalledWith(expect.anything(), { flowStatus: "draft_ready", chapter: 4, title: "第四章" });
    expect(disk.get(3)?.draft?.body).toBe("第三章原有的工作稿。");
  });

  it("换到另一章出稿前，先把手上那章没存的字存掉", async () => {
    useDraftStore.getState().edit("作者在第三章刚打的字。");
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4 }));
      handlers.onOperationLive?.(draftDelta("第四章。", 1));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("写第四章");
    });

    expect(disk.get(3)?.draft?.body).toBe("作者在第三章刚打的字。");
  });

  it("AI 写另一章、手上那章存不上：稿纸和当前章都留在原章，马上退出「正在生成」，下一句话还是指原章（第 4 轮复核 R8）", async () => {
    editDraft("第三章没存上的字。");
    mockedSaveWorkingDraft.mockRejectedValue(new Error("存稿失败"));
    const gate = deferred<void>();
    mockedStreamAgentChat.mockImplementationOnce(async (_input, handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4 }));
      handlers.onOperationLive?.(draftDelta("第四章 AI 在写。", 1));
      handlers.onOperation?.(draftDone(4));
      await gate.promise;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("继续写下一章"); });
    await vi.waitFor(() => expect(useBookStore.getState().workspace.flowStatus).toBe("draft_ready"));
    gate.resolve();
    await act(async () => { await pending; });
    scriptAgentStream((handlers) => handlers.onDone());
    await act(async () => { await result.current.handleSendMessage("改一下我眼前这一章"); });

    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "第三章没存上的字。" });
    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(3);
    expect(mockedStreamAgentChat.mock.calls.at(-1)?.[0].currentChapter).toBe(3);
  });

  it("AI 换到另一章时那章读不出来：稿纸留在原章，读盘那会儿打的字照样存上（第 5 轮 S1）", async () => {
    const entered = deferred<void>();
    const fetched = deferred<ChapterPaper>();
    mockedFetchChapterPaper.mockImplementationOnce(async () => { entered.resolve(); return fetched.promise; });
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4 }));
      handlers.onOperationLive?.(draftDelta("第四章流式稿。", 1));
      handlers.onOperation?.(draftDone(4));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      const turn = result.current.handleSendMessage("写第四章");
      await entered.promise;
      editDraft("读第四章时在第三章新打的字。");
      fetched.reject(new Error("读盘失败"));
      await turn;
    });
    await act(async () => { await flushDraftSave(); });
    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "读第四章时在第三章新打的字。" });
    expect(disk.get(3)?.draft?.body).toBe("读第四章时在第三章新打的字。");
    expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(3);
  });

  it("换章之后才处理的做完又发起重读：回合等它读完才收尾（第 5 轮 S2）", async () => {
    const entered = deferred<void>();
    const first = deferred<ChapterPaper>();
    const secondEntered = deferred<void>();
    const second = deferred<ChapterPaper>();
    mockedFetchChapterPaper
      .mockImplementationOnce(async () => { entered.resolve(); return first.promise; })
      .mockImplementationOnce(async () => { secondEntered.resolve(); return second.promise; });
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4 }));
      handlers.onOperationLive?.(draftDelta("已经出完第四章。", 1));
      writeDisk(4, { draft: "第四章成稿。" });
      handlers.onOperation?.(draftDone(4));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    let finished = false;
    let turn!: Promise<void>;
    await act(async () => {
      turn = result.current.handleSendMessage("写第四章").then(() => { finished = true; });
      await entered.promise;
      first.resolve(emptyPaper(4));
      await secondEntered.promise;
      for (let n = 0; n < 30; n++) await Promise.resolve();
    });
    expect(finished).toBe(false);
    expect(isWorkspaceBusy()).toBe(true);
    await act(async () => { second.resolve(disk.get(4)!); await turn; });
    expect(useDraftStore.getState()).toMatchObject({ chapter: 4, body: "第四章成稿。" });
    expect(isWorkspaceBusy()).toBe(false);
  });

  it("换章读盘超过收尾时限：回合交还后旧的读盘回来，不再换稿纸（第 5 轮 S3）", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const fetched = deferred<ChapterPaper>();
    mockedFetchChapterPaper.mockImplementationOnce(async () => { entered.resolve(); return fetched.promise; });
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4 }));
      handlers.onOperationLive?.(draftDelta("旧书第四章。", 1));
      handlers.onOperation?.(draftDone(4));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    try {
      await act(async () => {
        const turn = result.current.handleSendMessage("写第四章");
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5001);
        await turn;
      });
      expect(isWorkspaceBusy()).toBe(false);
      await act(async () => {
        fetched.resolve({ ...emptyPaper(4), draft: { chapter: 4, body: "迟到的第四章。", version: "late-v1" } });
        for (let n = 0; n < 30; n++) await Promise.resolve();
      });
      expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "第三章原有的工作稿。", streaming: null });
      expect(useBookStore.getState().workspace.currentChapter.chapterNumber).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("换章还没换完写稿就没成：不再换过去、不再摆出流式稿、不谎报写完（第 5 轮 S4）", async () => {
    const entered = deferred<void>();
    const fetched = deferred<ChapterPaper>();
    mockedFetchChapterPaper.mockImplementationOnce(async () => { entered.resolve(); return fetched.promise; });
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView({ chapter: 4 }));
      handlers.onOperationLive?.(draftDelta("失败前的半章。", 1));
      handlers.onOperation?.(draftView({ chapter: 4, state: "failed", stateText: "没做成", allowed: [], eventSeq: 4, summary: "生成失败", failure: { message: "生成失败", retryable: true } }));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      const turn = result.current.handleSendMessage("写第四章");
      await entered.promise;
      fetched.resolve(emptyPaper(4));
      await turn;
    });
    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: "第三章原有的工作稿。", streaming: null });
    expect(messages().some((message) => message.content.includes("其实已经写完了"))).toBe(false);
    expect(cardOf(lastAssistant()!, "operation")?.op).toMatchObject({ state: "failed" });
  });

  it("回合收尾后迟到的重读：作者其间存好的新字不被旧读数盖回去（第 6 轮 T1）", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const late = deferred<ChapterPaper>();
    const old = disk.get(3)!;
    mockedFetchChapterPaper.mockImplementationOnce(async () => { entered.resolve(); return late.promise; });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "revise_draft", toolCallId: "t1" });
      handlers.onToolResult({ toolName: "revise_draft", toolCallId: "t1", chapter: 3, ok: true });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    try {
      await act(async () => {
        const turn = result.current.handleSendMessage("改一个字");
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5001);
        await turn;
      });
      expect(isWorkspaceBusy()).toBe(false);
      const unique = "作者回合结束后刚存好的一句。";
      await act(async () => { editDraft(unique); expect(await flushDraftSave()).toEqual({ ok: true }); });
      await act(async () => { late.resolve(old); for (let n = 0; n < 30; n++) await Promise.resolve(); });
      expect(useDraftStore.getState()).toMatchObject({ body: unique, savedBody: unique, incoming: null });
      expect(disk.get(3)?.draft?.body).toBe(unique);
    } finally {
      vi.useRealTimers();
    }
  });

  it("存稿在路上时作者把字改回原样再换章：等那笔回来、原样再存一笔才换（第 6 轮 T2）", async () => {
    const original = useDraftStore.getState().body;
    const entered = deferred<void>();
    const pending = deferred<void>();
    const ordinarySave = mockedSaveWorkingDraft.getMockImplementation()!;
    mockedSaveWorkingDraft.mockImplementationOnce(async (...args) => { entered.resolve(); await pending.promise; return ordinarySave(...args); });
    editDraft("");
    const saving = flushDraftSave();
    await entered.promise;
    editDraft(original);
    const switching = openPaper(PROJECT, 4);
    for (let n = 0; n < 30; n++) await Promise.resolve();
    expect(useDraftStore.getState().chapter).toBe(3);
    pending.resolve();
    await Promise.all([saving, switching]);
    expect(useDraftStore.getState().chapter).toBe(4);
    expect(disk.get(3)?.draft?.body).toBe(original);
  });

  it("写稿调用后连接断了、没有工具结果：步骤不再一直转（第 6 轮 T3）", async () => {
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "change_draft", toolCallId: "t3" });
      handlers.onError("连接中断，没有工具结果", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => { await result.current.handleSendMessage("写这一章"); });
    const step = messages().flatMap((message) => message.toolSteps ?? []).find((item) => item.id === "t3");
    expect(step).toMatchObject({ status: "stopped", detail: expect.stringContaining("没收到") });
    expect(useChatStore.getState().chatLoading).toBe(false);
  });

  it("写稿前作者自己存了字、写稿没成：不说「其实已经写完了」（第 6 轮 T4）", async () => {
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onOperation?.(draftView());
      editDraft("模型还没写，作者自己补的字。");
      await flushDraftSave();
      handlers.onOperation?.(draftView({ state: "failed", stateText: "没做成", allowed: [], eventSeq: 3, summary: "模型失败，没生成正文", failure: { message: "模型失败，没生成正文", retryable: true } }));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => { await result.current.handleSendMessage("重写"); });
    expect(useDraftStore.getState().body).toBe("模型还没写，作者自己补的字。");
    expect(messages().some((message) => message.content.includes("其实已经写完"))).toBe(false);
  });

  it("「撤销到此」恢复途中开不了新的一轮：新话不会被撤销截掉（第 6 轮 T10）", async () => {
    const target = { id: "old-assistant", role: "assistant" as const, content: "旧回合已写好", turnSnapshots: [{ toolName: "generate_draft", snapshotId: "old-snapshot" }] };
    useChatStore.getState().setMessages([{ id: "old-user", role: "user", content: "旧需求" }, target]);
    const restoreEntered = deferred<void>();
    const restoreDone = deferred<void>();
    vi.mocked(restoreSnapshotApi).mockImplementationOnce(async () => { restoreEntered.resolve(); await restoreDone.promise; });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      const undo = result.current.undoToTurn(target);
      await restoreEntered.promise;
      expect(isWorkspaceBusy()).toBe(true);
      await result.current.handleSendMessage("撤销之后的新需求");
      restoreDone.resolve();
      await undo;
    });
    expect(mockedStreamAgentChat).not.toHaveBeenCalled();
    expect(isWorkspaceBusy()).toBe(false);
    expect(messages().some((message) => message.id === "old-assistant")).toBe(false);
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
    useChatStore.setState({ chatLoading: true });
    release();
    await act(async () => pending);

    expect(useChatStore.getState().chatLoading).toBe(true);
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

    const state = useBookStore.getState().workspace;
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

    const state = useBookStore.getState();
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
      handlers.onToolCall({ toolName: "run_check" });
      handlers.onError("check stream disconnected", true);
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
    expect(useBookStore.getState().workspace.flowStatus).not.toBe("committed");
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
      expect(useChatStore.getState().chatLoading).toBe(false);
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

  it("改设定的结果不带概况（重构 P9）：回合里重读一份概况再刷资料，设定本跟着重读", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Reread");
    mockedFetchStateOverview.mockResolvedValueOnce(overview);
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "foundation_write", refreshScope: "foundation", snapshotId: "snap-2" });
      handlers.onDone();
    });
    const refreshWorkspaceFromOverview = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ refreshWorkspaceFromOverview })));

    await act(async () => {
      await result.current.handleSendMessage("给许棠补两栏");
    });

    expect(mockedFetchStateOverview).toHaveBeenCalledWith({ projectPath: PROJECT, maxTimelineEvents: 8 });
    expect(refreshWorkspaceFromOverview).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceFromOverview.mock.calls[0][0]).toBe(overview);
    expect(mockedApplyOverview).not.toHaveBeenCalled();
  });

  it("确认改账的结果也不带概况：同样重读一份刷资料；只读工具不重读", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const overview = makeOverview("Ledger");
    mockedFetchStateOverview.mockResolvedValueOnce(overview);
    scriptAgentStream((handlers) => {
      handlers.onToolResult({ toolName: "read_foundation" });
      handlers.onToolResult({ toolName: "manage_ledger", refreshScope: "full", snapshotId: "snap-3" });
      handlers.onDone();
    });
    const refreshWorkspaceFromOverview = vi.fn();
    const { result } = renderHook(() => useChat(buildParams({ refreshWorkspaceFromOverview })));

    await act(async () => {
      await result.current.handleSendMessage("确认改账");
    });

    expect(mockedFetchStateOverview).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceFromOverview).toHaveBeenCalledWith(overview);
  });

  const OP = "op-0123456789abcdef0123";
  const opView = (overrides: Partial<OperationViewData> = {}): OperationViewData => ({
    opId: OP, kind: "inspect.run", mode: "flavor", chapter: 3, what: "查 AI 味·第 3 章", state: "running", stateText: "在做",
    allowed: ["cancel"], summary: "", conclusion: "", eventSeq: 1, origin: { kind: "chat", messageId: "user-x" }, ...overrides,
  });
  const flavorReport = {
    ok: true,
    summary: "有一处 AI 腔。",
    usedFallback: false,
    violations: [{ id: "aiflavor-0", text: "心中五味杂陈。", reason: "套路抒情", severity: "high" as const, suggestedFix: "改成具体动作" }],
  };

  it("检查做完（操作事件）→ 结果卡挂在这条助手消息上、带查的版本；这一轮说了结论，操作卡记下不再重复", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(opView());
      handlers.onOperationProgress?.({ opId: OP, text: "在查第 3 章" });
      handlers.onOperation?.(opView({ state: "succeeded", stateText: "做完了", allowed: [], summary: "有一处 AI 腔。", eventSeq: 3, inspect: { aiFlavorReport: flavorReport, checkedVersion: "v1" } }));
      handlers.onTextDelta("有一处 AI 腔。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      await result.current.handleSendMessage("帮我查这章的 AI 味");
    });
    const message = lastAssistant()!;
    expect(cardOf(message, "ai-flavor")).toMatchObject({ checkedVersion: "v1", report: { violations: [{ text: "心中五味杂陈。" }] } });
    expect(cardOf(message, "operation")?.op).toMatchObject({ opId: OP, state: "succeeded", announced: true });
  });

  it("检查没做成：不挂结果卡，操作卡如实是没做成", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(opView({ state: "failed", stateText: "没做成", allowed: [], summary: "模型没回", eventSeq: 2, failure: { message: "模型没回", retryable: true } }));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      await result.current.handleSendMessage("查 AI 味");
    });
    expect(cardOf(lastAssistant()!, "ai-flavor")).toBeUndefined();
    expect(cardOf(lastAssistant()!, "operation")?.op).toMatchObject({ state: "failed", summary: "模型没回" });
  });

  it.each([
    ["针对当前章", 3, "quality_checked"],
    ["针对别的章", 8, "draft_ready"],
  ] as const)("硬伤检查做完（%s）→ 流程态 %s", async (_label, chapter, expected) => {
    window.localStorage.setItem("chatBrain", "agent");
    useBookStore.setState({ workspace: { ...useBookStore.getState().workspace, flowStatus: "draft_ready" } });
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(opView({ mode: "quality", chapter, what: `硬伤检查·第 ${chapter} 章`, state: "succeeded", allowed: [], eventSeq: 2 }));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      await result.current.handleSendMessage("帮我查硬伤");
    });
    expect(useBookStore.getState().workspace.flowStatus).toBe(expected);
  });

  it("对话流断了、这一轮交的操作还在做：不说「没做完」、不给重试，接着订阅它", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(opView());
      handlers.onError("network error", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      await result.current.handleSendMessage("查 AI 味");
    });
    // 不另记一句「还在做」：卡自己跟着变。
    const last = lastAssistant()!;
    expect(hasCard(last, "operation")).toBe(true);
    expect(hasCard(last, "error")).toBe(false);
    expect(last.suggestedActions ?? []).toEqual([]);
    expect(useChatStore.getState().messages.some((item) => item.content.includes("还在做"))).toBe(false);
    expect(vi.mocked(listActiveOperations)).toHaveBeenCalledWith(PROJECT, expect.anything());
  });

  it("关页 / 刷新掐断的流：不记错误卡", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onTextDelta("好的，");
      window.dispatchEvent(new Event("pagehide"));
      handlers.onError("network error", true);
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    try {
      await act(async () => {
        await result.current.handleSendMessage("帮我看看这章");
      });
    } finally {
      window.dispatchEvent(new Event("pageshow"));
    }
    expect(messages().some((m) => hasCard(m, "error"))).toBe(false);
  });

  it("在做的时候点停止：交给服务端停掉这次操作（不掐断这一轮，等它如实收尾）", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const gate = deferred<void>();
    let aborted = false;
    mockedStreamAgentChat.mockImplementation(async (_input, handlers, signal) => {
      signal?.addEventListener("abort", () => { aborted = true; });
      handlers.onOperation?.(opView());
      await gate.promise;
      handlers.onOperation?.(opView({ state: "cancelled", stateText: "停掉了", allowed: [], eventSeq: 4 }));
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.handleSendMessage("查 AI 味");
      await Promise.resolve();
    });
    act(() => result.current.stopAgent());
    expect(vi.mocked(cancelOperationRequest)).toHaveBeenCalledWith(PROJECT, OP);
    expect(aborted).toBe(false);
    gate.resolve();
    await act(async () => {
      await sending;
    });
    expect(cardOf(lastAssistant()!, "operation")?.op.state).toBe("cancelled");
  });

  it("tool-error settles the running toolStep + card to failed (no longer stuck running) and appends a retryable error", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "read_state_overview", toolCallId: "c1" });
      handlers.onToolError({
        toolName: "read_state_overview",
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
      (m) => m.role === "assistant" && hasCard(m, "error"),
    );
    expect(errorMessages).toHaveLength(1);
    expect(cardOf(errorMessages[0], "error")?.detail).toContain("落盘失败");
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
      (m) => m.role === "assistant" && hasCard(m, "error"),
    );
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0].content).toBe("AI 服务暂时没响应，这一步没做完。");
    expect(cardOf(errorMessages[0], "error")?.detail).toContain("落盘失败");
    expect(errorMessages[0].suggestedActions?.some((a) => a.id === "retry-agent")).toBe(true);
  });

  it("稿已经换上、之后那步超时：说正文在稿纸上不用重来，不给「重试这一步」，也不再「核对盘上」（作者长篇实跑 2026-10-26）", async () => {
    window.localStorage.setItem("chatBrain", "agent");
    const realDraft = "窄道上只容一辆车，崔头领勒住马，抬手叫后头的车停下。";
    scriptAgentStream((handlers) => {
      handlers.onOperation?.(draftView());
      writeDisk(3, { draft: realDraft, title: "窄道" });
      handlers.onOperation?.(draftDone(3, "窄道"));
      handlers.onTextDelta("第 3 章写好了。");
      handlers.onError("上游流式输出中断：90 秒没有新内容", true, "timeout");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => {
      await result.current.handleSendMessage("写第三章");
    });

    const errorMessages = messages().filter((m) => m.role === "assistant" && hasCard(m, "error"));
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0].content).toBe("正文已经写进稿纸，不用重来；之后那步服务商太久没有反应，没做完。");
    expect(errorMessages[0].suggestedActions?.some((a) => a.id === "retry-agent")).toBeFalsy();
    expect(messages().some((m) => m.content.includes("核对盘上"))).toBe(false);
    expect(useDraftStore.getState().body).toBe(realDraft);
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

  /** 写稿操作在流正文、点「停止」交给服务端停（假的停止接口一调就放行），服务端报停掉了再收尾。 */
  function scriptCancellableDraft(begin: (handlers: AgentChatHandlers) => void, beforeCancelled?: () => void): void {
    const cancelled = deferred<void>();
    vi.mocked(cancelOperationRequest).mockImplementationOnce(async () => { cancelled.resolve(); return { cancelled: true }; });
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      begin(handlers);
      await cancelled.promise;
      beforeCancelled?.();
      handlers.onOperation?.(draftView({ state: "cancelled", stateText: "停掉了", allowed: [], eventSeq: 6 }));
      handlers.onDone();
    });
  }

  it("写稿中途点「停止」→ 交服务端停掉；流程态复位、已流出的字留给作者、按盘上重读", async () => {
    seedPaper(3, { draft: "短" });
    scriptCancellableDraft((handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.(draftDelta("已流出的一截新正文。", 1));
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toContain("已流出的一截新正文"));
    expect(useBookStore.getState().workspace.flowStatus).toBe("draft_generating");
    mockedFetchChapterPaper.mockClear();
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    expect(vi.mocked(cancelOperationRequest)).toHaveBeenCalledWith(PROJECT, DRAFT_OP);
    expect(cardOf(lastAssistant()!, "operation")?.op.state).toBe("cancelled");
    expect(useBookStore.getState().workspace.flowStatus).toBe("draft_ready");
    // 已写出的内容留给作者（盘上那版更短），稿纸不再只读。
    expect(useDraftStore.getState().body).toContain("已流出的一截新正文");
    expect(useDraftStore.getState().streaming).toBeNull();
    expect(mockedFetchChapterPaper).toHaveBeenCalledWith(PROJECT, 3);
    // 停止不是失败：无错误气泡。
    expect(messages().filter((m) => hasCard(m, "error"))).toHaveLength(0);
    expect(useChatStore.getState().chatLoading).toBe(false);
  });

  it("停掉时盘上那版比流出来的长：用盘上的，不拿半截盖", async () => {
    const onDisk = "盘上这一版比流出来的半截长得多，作者之前就写好了这么多。";
    seedPaper(3, { draft: onDisk });
    scriptCancellableDraft((handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.(draftDelta("半截。", 1));
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("重写第三章"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toBe("半截。"));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    expect(useDraftStore.getState()).toMatchObject({ chapter: 3, body: onDisk, savedBody: onDisk, streaming: null });
  });

  it("接着写中途「停止」：本来写好的那段原样留着（不当新写的换引号、去星号），新写的那截接在后面", async () => {
    const mine = "我写的\"直引号\"、“弯引号”和**星号**。";
    seedPaper(3, { draft: mine });
    scriptCancellableDraft((handlers) => {
      handlers.onOperation?.(draftView({ mode: "continue" }));
      handlers.onOperationLive?.(draftDelta(`${mine}\n\n`, 1, { base: true }));
      handlers.onOperationLive?.(draftDelta("接着写的\"一截\"。", 2));
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("接着往下写"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toContain("接着写的“一截”"));
    expect(useDraftStore.getState().streaming?.startsWith(mine)).toBe(true);
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });
    expect(useDraftStore.getState().body).toBe(`${mine}\n\n接着写的“一截”。`);
  });

  it("停掉后读盘期间作者又动了稿 → 不用盘稿盖掉新编辑（出提示让作者选）", async () => {
    const gate = deferred<ChapterPaper>();
    scriptCancellableDraft((handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.(draftDelta("半截。", 1));
    }, () => { mockedFetchChapterPaper.mockReturnValueOnce(gate.promise); });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章，主角夜探祠堂"); });
    await vi.waitFor(() => expect(useDraftStore.getState().streaming).toBe("半截。"));
    mockedFetchChapterPaper.mockClear();
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
    await vi.waitFor(() => expect(useChatStore.getState().chatLoading).toBe(true));
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const state = useBookStore.getState();
    expect(state.workspace.flowStatus).toBe("committed");
    expect(isPaperCommitted()).toBe(true);
    expect(state.workspace.currentChapter.hasCommittedChapter).toBe(true);
    expect(messages().some((m) => m.content.includes("其实已经定稿"))).toBe(true);
  });

  it("别的章的只读结果（核账回执这类）：不说「写的是第 N 章」，也不动当前章", async () => {
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "run_check", toolCallId: "r1" });
      handlers.onToolResult({ toolName: "run_check", toolCallId: "r1", ok: true, chapter: 7, summary: "交了。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    await act(async () => {
      await result.current.handleSendMessage("核一下第 7 章");
    });
    expect(useNavigationStore.getState().toast ?? "").not.toContain("第 7 章");
  });

  it("写稿的步骤（拟章纲 / 写正文）推给稿纸；回合结束清掉", async () => {
    const gate = deferred<void>();
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onOperation?.(draftView());
      handlers.onOperationLive?.({ opId: DRAFT_OP, event: { type: "step", step: "plan", exec: "exec-0" } });
      await gate.promise;
      handlers.onOperationLive?.({ opId: DRAFT_OP, event: { type: "step", step: "write:1", exec: "exec-1" } });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useUiStore.getState().draftPhase).toBe("plan"));
    expect(useBookStore.getState().workspace.flowStatus).toBe("draft_generating");
    gate.resolve();
    await act(async () => { await pending; });
    expect(useUiStore.getState().draftPhase).toBeNull();
  });

  it("回合正常结束、写稿操作还没报停下：收尾兜底把 draft_generating 复位，不永久转圈", async () => {
    const gate = deferred<void>();
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onOperation?.(draftView());
      await gate.promise;
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写这一章"); });
    await vi.waitFor(() => expect(useBookStore.getState().workspace.flowStatus).toBe("draft_generating"));
    gate.resolve();
    await act(async () => { await pending; });

    expect(useChatStore.getState().chatLoading).toBe(false);
    expect(useBookStore.getState().workspace.flowStatus).toBe("draft_ready");
  });

  it("纯读回合点「停止」→ 步骤结算 stopped、不拉盘上对账、流程态不动", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "read_state_overview", toolCallId: "r1" });
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    const flowBefore = useBookStore.getState().workspace.flowStatus;

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("现在写到哪了"); });
    await vi.waitFor(() => expect(useChatStore.getState().chatLoading).toBe(true));
    mockedFetchChapterPaper.mockClear();
    act(() => { result.current.stopAgent(); });
    await act(async () => { await pending; });

    const agentMessage = messages().find((m) => (m.toolSteps?.length ?? 0) > 0)!;
    expect(agentMessage.toolSteps![0].status).toBe("stopped");
    expect(mockedFetchChapterPaper).not.toHaveBeenCalled();
    expect(useBookStore.getState().workspace.flowStatus).toBe(flowBefore);
    expect(useChatStore.getState().chatLoading).toBe(false);
  });

  it("被「停止」腰斩的回合不做诚实盖文——半截流式文本不等于「声称完成」", async () => {
    scriptAbortableStream((handlers) => {
      handlers.onToolCall({ toolName: "change_draft", toolCallId: "g1" });
      handlers.onTextDelta("第3章正文已经写好了，接下来");
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    let pending!: Promise<void>;
    act(() => { pending = result.current.handleSendMessage("写第三章"); });
    await vi.waitFor(() => expect(useChatStore.getState().chatLoading).toBe(true));
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
    useBookStore.getState().updateWorkspace({ flowStatus: "draft_ready" });
    useChatStore.getState().setMessages([{
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
    }]);
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
    expect(useBookStore.getState().workspace.flowStatus).toBe("draft_ready");
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
    expect(useBookStore.getState().workspace.flowStatus).toBe("idle");
  });

  it("撤销请求发出后作者又打了字 → 字留着，盘上那版挂成提示（第 4 轮复核 R7）", async () => {
    // 存稿防抖不在这条测的范围里：机器忙时真时钟可能先让它到点（撞版本另存，提示条就成了「撞了」）。
    vi.useFakeTimers();
    scriptAgentStream((handlers) => {
      editDraft("撤销请求发出后作者刚打的字");
      writeDisk(3, { draft: "撤销后盘上那版" });
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));
    try {
      await act(async () => { await result.current.handleSendMessage("撤销"); });

      expect(useDraftStore.getState()).toMatchObject({ body: "撤销请求发出后作者刚打的字", incoming: { cause: "update", body: "撤销后盘上那版" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("存稿明确失败后撤销 → 没存上的字不被盘上旧稿盖掉（第 4 轮复核 R7）", async () => {
    editDraft("还没存上、只在稿纸上的字");
    mockedSaveWorkingDraft.mockRejectedValue(new Error("磁盘故障"));
    scriptAgentStream((handlers) => {
      writeDisk(3, { draft: "撤销后盘上那版" });
      handlers.onToolResult({ toolName: "undo_last_change", toolCallId: "u1", ok: true, undone: true, summary: "已撤销。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销"); });

    expect(useDraftStore.getState().body).toBe("还没存上、只在稿纸上的字");
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
    expect(messages().filter((m) => hasCard(m, "error"))).toHaveLength(0);
    expect(useChatStore.getState().chatLoading).toBe(false);
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
    vi.useFakeTimers(); // 同上一组：存稿防抖不在这条测的范围里
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "revise_draft", toolCallId: "r1" });
      useDraftStore.getState().edit("AI 改稿期间作者自己打的字。");
      writeDisk(3, { draft: "AI 改好的新一版。" });
      handlers.onToolResult({ toolName: "revise_draft", toolCallId: "r1", ok: true, summary: "改好了。" });
      handlers.onTextDelta("改好了，换不换你来定。");
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    try {
      await act(async () => { await result.current.handleSendMessage("把第三章开头改紧一点"); });

      const paper = useDraftStore.getState();
      expect(paper.body).toBe("AI 改稿期间作者自己打的字。");
      expect(paper.incoming).toMatchObject({ cause: "update" });
      expect(lastAssistant()?.content).toBe("改好了，换不换你来定。");
      expect(useChatStore.getState().chatLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("作者在回合里打了字、停笔过了存稿时间 → 回合里照存；AI 那版换不上留成候选，回执到了稿纸出提示，作者的字不丢（写作版本 P1b）", async () => {
    mockedStreamAgentChat.mockImplementation(async (_input, handlers) => {
      handlers.onToolCall({ toolName: "revise_draft", toolCallId: "r1" });
      editDraft("作者停笔了一会儿的字。");
      await new Promise((resolve) => setTimeout(resolve, 800));
      // 服务端：AI 写完时版本对不上，没换上、留成候选。
      disk.set(3, { ...disk.get(3)!, pending: { kind: "candidate", id: "3-cand", body: "AI 改好的新一版。", sha: "sha", reason: "draft_moved" } });
      handlers.onToolResult({ toolName: "revise_draft", toolCallId: "r1", ok: false, summary: "第 3 章 AI 这版没换上。" });
      handlers.onDone();
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("把第三章开头改紧一点"); });

    const paper = useDraftStore.getState();
    expect(disk.get(3)?.draft?.body).toBe("作者停笔了一会儿的字。");
    expect(paper.body).toBe("作者停笔了一会儿的字。");
    expect(paper.savedBody).toBe("作者停笔了一会儿的字。");
    expect(paper.incoming).toMatchObject({ cause: "candidate", body: "AI 改好的新一版。" });
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
    useBookStore.setState({ workspace: mockWorkspaceData });
    useChatStore.setState({
      messages: [{
        id: "prev-assistant",
        role: "assistant",
        content: "两处都改好了。",
        turnSnapshots: [
          { toolName: "revise_draft", snapshotId: `${"a".repeat(40)}` },
          { toolName: "foundation_write", snapshotId: `${"b".repeat(40)}` },
        ],
      }],
    });
    const { result } = renderHook(() => useChat(buildParams({})));

    await act(async () => { await result.current.handleSendMessage("撤销上一步"); });

    const [input] = mockedStreamAgentChat.mock.calls[0] as [StreamAgentChatRequest, AgentChatHandlers];
    expect(input.lastTurnUndoHint).toEqual({ snapshotId: "a".repeat(40), changes: 2 });
  });

  it("纯聊天会话没有写盘快照 → 不带该字段（服务端走默认逐步回退）", async () => {
    useBookStore.setState({ workspace: mockWorkspaceData });
    useChatStore.setState({ messages: [{ id: "prev", role: "assistant", content: "聊聊天。" }] });
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
    useChatStore.setState({ chatLoading: true });
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

// 「重写这一章」「接着往下写」（写作版本 P2a）：服务端没受理写稿时出的按钮带着整份写稿动作（请求号那时就定了），点了原样交上去；
// 存盘读回的按钮点的时候再核一遍，不对就说失效、不交。
describe("「重写这一章」「接着往下写」按钮 → 原样交写稿动作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
    scriptAgentStream((handlers) => handlers.onDone());
  });

  it("重写：交的就是按钮上那份（请求号不变），对话留「重写第 3 章」，回写作台", async () => {
    const requestCenterView = vi.fn();
    useNavigationStore.setState({ requestCenterView });
    const stored = newDraftAction("write", { chapter: 3, rewrite: true, direction: "林澈夜探旧泵站" });
    const { result } = renderHook(() => useChat(buildParams({})));
    act(() => result.current.handleSuggestedAction(draftChoiceAction({ label: "重写第 3 章", mode: "write", action: stored })));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual(stored);
    expect(messages().some((m) => m.role === "user" && m.content === "重写第 3 章")).toBe(true);
    expect(requestCenterView).toHaveBeenCalledWith("desk");
  });

  it("接着往下写：对话留「第 3 章接着往下写」", async () => {
    const stored = newDraftAction("continue", { chapter: 3 });
    const { result } = renderHook(() => useChat(buildParams({})));
    act(() => result.current.handleSuggestedAction(draftChoiceAction({ label: "接着往下写", mode: "continue", action: stored })));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(messages().some((m) => m.role === "user" && m.content === "第 3 章接着往下写")).toBe(true);
  });

  it("存盘读回的动作坏了：说失效、不交", async () => {
    const broken = { ...newDraftAction("write", { chapter: 3 }), params: "第三章" } as unknown as ReturnType<typeof newDraftAction>;
    const { result } = renderHook(() => useChat(buildParams({})));
    act(() => result.current.handleSuggestedAction(draftChoiceAction({ label: "重写第 3 章", mode: "write", action: broken })));
    await Promise.resolve();
    expect(mockedStreamAgentChat).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("失效");
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
      await result.current.handleSendUserAction(newDraftAction("write", { chapter: 6 }));
    });
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toMatchObject({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 6 } });
    expect(requestCenterView).toHaveBeenCalledWith("desk");

    mockedStreamAgentChat.mockClear();
    useChatStore.setState({ chatLoading: true });
    const before = messages();
    await act(async () => {
      await result.current.handleSendUserAction(newInspectAction("continuity", 5));
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

  it("「内容审阅」带当前章号交一次检查（请求号、交的时间按钮出的时候给）；「撤销上一步」发 undo", async () => {
    const { result } = renderHook(() => useChat(buildParams({})));
    const chapter = useBookStore.getState().workspace.currentChapter.chapterNumber;

    act(() => result.current.handleChapterButton("review"));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual({
      kind: "new", type: "inspect.run", mode: "review", params: { chapter }, requestKey: expect.any(String), issuedAt: expect.any(String),
    });

    await vi.waitFor(() => expect(useChatStore.getState().chatLoading).toBe(false));
    act(() => result.current.handleChapterButton("undo"));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(2));
    expect(mockedStreamAgentChat.mock.calls[1]![0].action).toEqual({ toolName: "undo" });
  });

  it("「写这一章」带方向框里的字（原样）作章纲方向", async () => {
    useUiStore.setState({ steeringDirection: " 林澈夜探旧泵站 " });
    const { result } = renderHook(() => useChat(buildParams({})));
    const chapter = useBookStore.getState().workspace.currentChapter.chapterNumber;

    act(() => result.current.handleChapterButton("write"));
    await vi.waitFor(() => expect(mockedStreamAgentChat).toHaveBeenCalledTimes(1));
    expect(mockedStreamAgentChat.mock.calls[0]![0].action).toEqual({
      kind: "new", type: "draft.change", mode: "write", params: { chapter, direction: "林澈夜探旧泵站" }, requestKey: expect.any(String), issuedAt: expect.any(String),
    });
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

describe("迟到的旧读数不盖后来已经显示的新稿（第 7 轮 U1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
    mockedRenameChatSession.mockResolvedValue({ ok: true, index: { sessions: [], activeSessionId: "session-a" } });
  });

  it("前一轮的重读迟到：后一轮 AI 写成、已经显示的新稿不退回旧版", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const late = deferred<ChapterPaper>();
    const old = disk.get(3)!;
    mockedFetchChapterPaper.mockImplementationOnce(async () => { entered.resolve(); return late.promise; });
    scriptAgentStream((handlers) => {
      handlers.onToolCall({ toolName: "revise_draft", toolCallId: "u1-old" });
      handlers.onToolResult({ toolName: "revise_draft", toolCallId: "u1-old", chapter: 3, ok: true });
      handlers.onDone();
    });
    const { result, unmount } = renderHook(() => useChat(buildParams({})));
    try {
      await act(async () => {
        const turn = result.current.handleSendMessage("第一轮改稿");
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5001);
        await turn;
      });
      expect(isWorkspaceBusy()).toBe(false);
      const latest = "第二轮真正写成且已经显示的新稿。";
      scriptAgentStream((handlers) => {
        handlers.onToolCall({ toolName: "revise_draft", toolCallId: "u1-new" });
        writeDisk(3, { draft: latest, title: "第三章" });
        handlers.onToolResult({ toolName: "revise_draft", toolCallId: "u1-new", chapter: 3, ok: true });
        handlers.onDone();
      });
      await act(async () => { await result.current.handleSendMessage("第二轮改稿"); });
      expect(useDraftStore.getState().body).toBe(latest);
      await act(async () => {
        late.resolve(old);
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
      expect(useDraftStore.getState().body).toBe(latest);
      expect(useDraftStore.getState().baseVersion).toBe(disk.get(3)!.draft!.version);
    } finally {
      unmount();
      __resetDraftSyncForTests();
      vi.useRealTimers();
    }
  });
});
