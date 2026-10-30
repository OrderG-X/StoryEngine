import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationViewData } from "../api/agentChatClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import type { ChapterMessage } from "../types.js";
import type { OperationCardData } from "../type-defs/workspace.js";
import { cardOf } from "../utils/messageCards.js";
import { claimOperation, projectOperationEverywhere } from "./operationCards.js";

const client = vi.hoisted(() => ({
  list: vi.fn(),
  follow: vi.fn(),
}));
vi.mock("../api/operationsClient.js", () => ({
  listActiveOperations: client.list,
  followOperationEvents: client.follow,
}));
const disk = vi.hoisted(() => ({ refreshPaper: vi.fn(async () => undefined), overview: vi.fn(async () => ({ marker: "盘上" })), apply: vi.fn() }));
vi.mock("../drafts/draftSync.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../drafts/draftSync.js")>()), refreshPaper: disk.refreshPaper }));
vi.mock("../api/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/client.js")>()), fetchStateOverview: disk.overview }));
vi.mock("./applyOverview.js", () => ({ applyOverviewToWorkspace: disk.apply }));

const { ownerOfOperation, reconnectOperations, stopOperationReconnect } = await import("./operationReconnect.js");

const BOOK = "/books/钟楼";
const OP_A = "op-aaaaaaaaaaaaaaaaaaaa";
const OP_B = "op-bbbbbbbbbbbbbbbbbbbb";

function view(opId: string, overrides: Partial<OperationViewData> = {}): OperationViewData {
  return {
    opId, kind: "inspect.run", mode: "quality", chapter: 3, what: "质检·第 3 章", state: "running", stateText: "在做", allowed: ["cancel"],
    summary: "", conclusion: "", eventSeq: 1, origin: { kind: "chat", messageId: "u1" },
    ...overrides,
  };
}

function opCard(opId: string, state: OperationCardData["state"] = "running"): ChapterMessage["cards"] {
  return [{ type: "operation", op: { opId, kind: "inspect.run", what: "核账·第 2 章", state, stateText: "在做", allowed: [], summary: "", eventSeq: 1 } }];
}

const messages: ChapterMessage[] = [
  { id: "u1", role: "user", content: "质检一下第三章" },
  { id: "a1", role: "assistant", content: "" },
  { id: "u2", role: "user", content: "核一下第二章" },
  { id: "a2", role: "assistant", content: "", cards: opCard(OP_B) },
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useChatStore.setState({ messages, activeSessionId: "s1" });
  useNavigationStore.setState({ projectPath: BOOK });
  client.list.mockReset();
  client.follow.mockReset();
  disk.refreshPaper.mockClear();
  disk.overview.mockClear();
  disk.apply.mockClear();
});
afterEach(() => {
  stopOperationReconnect();
});

describe("ownerOfOperation", () => {
  it("已经挂着这次操作的那条优先；否则是交它的那句话后面那条助手消息", () => {
    expect(ownerOfOperation(messages, view(OP_B, { origin: { kind: "chat", messageId: "u1" } }))).toBe("a2");
    expect(ownerOfOperation(messages, view(OP_A))).toBe("a1");
  });

  it("别的会话里交的、按钮或后台交的：不挂", () => {
    expect(ownerOfOperation(messages, view(OP_A, { origin: { kind: "chat", messageId: "u-别处" } }))).toBeUndefined();
    expect(ownerOfOperation(messages, view(OP_A, { origin: { kind: "background" } }))).toBeUndefined();
    expect(ownerOfOperation(messages, view(OP_A, { origin: { kind: "chat", messageId: "a1" } }))).toBeUndefined();
  });
});

describe("reconnectOperations", () => {
  it("在做的挂回原来那条、卡上还说在做的也问；做完了照实出结论和结果卡（不当这一轮说过）", async () => {
    client.list.mockResolvedValue([view(OP_A)]);
    client.follow.mockImplementation(async (_book: string, opId: string, handlers: { onOperation: (v: OperationViewData) => void; onProgress?: (t: string) => void }) => {
      if (opId === OP_A) {
        handlers.onProgress?.("在看第 3 章");
        handlers.onOperation(view(OP_A, {
          state: "succeeded", allowed: [], eventSeq: 6, summary: "两处要看",
          inspect: { qualityReport: { blocking: [], soft: [] } as never, checkedVersion: "v7" },
        }));
      } else {
        handlers.onOperation(view(OP_B, { state: "cancelled", allowed: [], eventSeq: 3, summary: "停了", what: "核账·第 2 章" }));
      }
    });
    reconnectOperations(BOOK);
    await flush();
    expect(client.follow.mock.calls.map((call) => call[1])).toEqual([OP_A, OP_B]);
    const [, a1, , a2] = useChatStore.getState().messages;
    expect(cardOf(a1!, "operation")?.op).toMatchObject({ opId: OP_A, state: "succeeded", summary: "两处要看" });
    expect(cardOf(a1!, "operation")?.op.announced).toBeUndefined();
    // 结论只在 owner 上（接着做那一轮说了，原来那条不再说一遍）。
    expect(cardOf(a1!, "operation")?.op.conclusion).toBeUndefined();
    expect(cardOf(a1!, "quality")).toMatchObject({ checkedVersion: "v7" });
    expect(cardOf(a2!, "operation")?.op).toMatchObject({ opId: OP_B, state: "cancelled" });
  });

  it("列在做的没成：卡上那几次照样问", async () => {
    client.list.mockRejectedValue(new Error("断了"));
    client.follow.mockResolvedValue(undefined);
    reconnectOperations(BOOK);
    await flush();
    expect(client.follow.mock.calls.map((call) => call[1])).toEqual([OP_B]);
  });

  it("换了会话：旧的订阅停掉，后到的变化不往新会话的卡上写", async () => {
    let late: ((v: OperationViewData) => void) | undefined;
    let signal: AbortSignal | undefined;
    client.list.mockResolvedValue([]);
    client.follow.mockImplementation(async (_book: string, _opId: string, handlers: { onOperation: (v: OperationViewData) => void }, s: AbortSignal) => {
      late = handlers.onOperation;
      signal = s;
    });
    reconnectOperations(BOOK);
    await flush();
    useChatStore.setState({ activeSessionId: "s2" });
    late?.(view(OP_B, { state: "succeeded", eventSeq: 9 }));
    expect(cardOf(useChatStore.getState().messages[3]!, "operation")?.op.state).toBe("running");
    reconnectOperations(BOOK);
    expect(signal?.aborted).toBe(true);
  });
});

describe("重开书接着看定稿", () => {
  const OP_C = "op-cccccccccccccccccccc";
  const checklist = { chapter: 3, canCommit: true };
  const commitView = (overrides: Partial<OperationViewData>): OperationViewData => view(OP_C, { kind: "commit.prepare", mode: undefined, what: "定稿·第 3 章", ...overrides });

  it("还在等作者点的：清单摆回原来那条（能接着点）；关页期间定成了的：挂回执、按盘上重读稿纸和书的状态（只一次）", async () => {
    useChatStore.setState({ messages: [{ id: "u1", role: "user", content: "定稿" }, { id: "a1", role: "assistant", content: "" }], activeSessionId: "s1" });
    let push: ((v: OperationViewData) => void) | undefined;
    client.list.mockResolvedValue([commitView({ state: "waiting_author", allowed: [], eventSeq: 3 })]);
    client.follow.mockImplementation(async (_book: string, _opId: string, handlers: { onOperation: (v: OperationViewData) => void }) => {
      push = handlers.onOperation;
      handlers.onOperation(commitView({ state: "waiting_author", allowed: [], eventSeq: 3, pending: { kind: "commit", actionId: "confirm-commit", decisions: ["commit"], preview: checklist } }));
    });
    reconnectOperations(BOOK);
    await flush();
    const owner = () => useChatStore.getState().messages[1]!;
    expect(cardOf(owner(), "commit-preview")).toEqual({ type: "commit-preview", preview: checklist, opId: OP_C });
    expect(disk.refreshPaper).not.toHaveBeenCalled();

    const done = commitView({ state: "succeeded", allowed: [], eventSeq: 8, commit: { chapter: 3, committed: true, report: { chapter: 3 }, snapshotId: "s-1" } });
    push?.(done);
    push?.({ ...done, eventSeq: 9 });
    await flush();
    expect(cardOf(owner(), "commit-report")).toMatchObject({ report: { chapter: 3 } });
    expect(useNavigationStore.getState().unseenChangesChapter).toBe(3);
    expect(disk.refreshPaper).toHaveBeenCalledTimes(1);
    expect(disk.refreshPaper).toHaveBeenCalledWith({ chapter: 3 });
    expect(disk.apply).toHaveBeenCalledTimes(1);
    expect(disk.apply.mock.calls[0]![0]).toEqual({ marker: "盘上" });
  });
});

describe("作者在卡上接着那一次（点「确认定稿」）", () => {
  it("这一轮那条一开始就挂上（不带按钮、清单）；接着看的订阅后到的结果、回执都落在这一轮，原来那条只留一行状态", async () => {
    const OP_C = "op-cccccccccccccccccccc";
    const checklist = { chapter: 3, canCommit: true };
    const waiting = view(OP_C, { kind: "commit.prepare", mode: undefined, what: "定稿·第 3 章", state: "waiting_author", allowed: [], eventSeq: 3, pending: { kind: "commit", actionId: "confirm-commit", decisions: ["commit"], preview: checklist } });
    useChatStore.setState({ messages: [{ id: "u1", role: "user", content: "定稿" }, { id: "a1", role: "assistant", content: "" }], activeSessionId: "s1" });
    let push: ((v: OperationViewData) => void) | undefined;
    client.list.mockResolvedValue([waiting]);
    client.follow.mockImplementation(async (_book: string, _opId: string, handlers: { onOperation: (v: OperationViewData) => void }) => {
      push = handlers.onOperation;
      handlers.onOperation(waiting);
    });
    reconnectOperations(BOOK);
    await flush();

    useChatStore.getState().appendMessage({ id: "u2", role: "user", content: "确认定稿第 3 章" });
    useChatStore.getState().appendMessage({ id: "a2", role: "assistant", content: "" });
    claimOperation(OP_C, "a2");
    const turn = () => useChatStore.getState().messages.find((message) => message.id === "a2")!;
    const original = () => useChatStore.getState().messages.find((message) => message.id === "a1")!;
    expect(cardOf(turn(), "operation")?.op).toMatchObject({ opId: OP_C, state: "waiting_author", allowed: [] });
    expect(cardOf(turn(), "operation")?.op.pending).toBeUndefined();

    push?.(view(OP_C, { kind: "commit.prepare", mode: undefined, what: "定稿·第 3 章", state: "succeeded", allowed: [], eventSeq: 8, conclusion: "第 3 章已定稿。", commit: { chapter: 3, committed: true, report: { chapter: 3 }, snapshotId: "s-1" } }));
    await flush();
    expect(cardOf(turn(), "commit-report")).toBeDefined();
    expect(turn().turnSnapshots).toEqual([{ toolName: "prepare_commit", snapshotId: "s-1", chapterNumber: 3 }]);
    expect(cardOf(original(), "commit-report")).toBeUndefined();
    expect(original().turnSnapshots).toBeUndefined();
    expect(cardOf(original(), "operation")?.op).toMatchObject({ state: "succeeded" });
    expect(cardOf(original(), "operation")?.op.conclusion).toBeUndefined();
    expect(cardOf(original(), "commit-preview")).toBeDefined();
  });
});

describe("projectOperationEverywhere", () => {
  it("owner 那条出结果卡、记 announced；别的挂着同一次的只换操作卡", () => {
    useChatStore.setState({
      messages: [
        { id: "a1", role: "assistant", content: "", cards: opCard(OP_A) },
        { id: "a2", role: "assistant", content: "", cards: opCard(OP_A, "paused") },
      ],
    });
    projectOperationEverywhere(view(OP_A, {
      state: "succeeded", allowed: [], eventSeq: 4, summary: "没问题", conclusion: "第 3 章硬伤检查：没问题",
      inspect: { qualityReport: { blocking: [], soft: [] } as never },
    }), "a2", { announced: true });
    const [a1, a2] = useChatStore.getState().messages;
    expect(cardOf(a1!, "operation")?.op).toMatchObject({ state: "succeeded" });
    expect(cardOf(a1!, "operation")?.op.announced).toBeUndefined();
    // 结论只在 owner 上（接着做那一轮说了，原来那条不再说一遍）。
    expect(cardOf(a1!, "operation")?.op.conclusion).toBeUndefined();
    expect(cardOf(a1!, "quality")).toBeUndefined();
    expect(cardOf(a2!, "operation")?.op.announced).toBe(true);
    expect(cardOf(a2!, "quality")).toBeDefined();
  });

  it("定稿：清单、回执只挂在 owner 上；别的挂着同一次的只换操作卡", () => {
    useChatStore.setState({
      messages: [
        { id: "a1", role: "assistant", content: "", cards: opCard(OP_A) },
        { id: "a2", role: "assistant", content: "", cards: opCard(OP_A) },
      ],
    });
    projectOperationEverywhere(view(OP_A, { kind: "commit.prepare", mode: undefined, state: "succeeded", allowed: [], eventSeq: 4, commit: { chapter: 3, committed: true, report: { chapter: 3 }, snapshotId: "s-1" } }), "a2");
    const [a1, a2] = useChatStore.getState().messages;
    expect(cardOf(a1!, "operation")?.op.state).toBe("succeeded");
    expect(cardOf(a1!, "commit-report")).toBeUndefined();
    expect(a1!.turnSnapshots).toBeUndefined();
    expect(cardOf(a2!, "commit-report")).toBeDefined();
    expect(a2!.turnSnapshots).toEqual([{ toolName: "prepare_commit", snapshotId: "s-1", chapterNumber: 3 }]);
  });
});
