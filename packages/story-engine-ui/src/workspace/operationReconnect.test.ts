import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationViewData } from "../api/agentChatClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import type { ChapterMessage } from "../types.js";
import type { OperationCardData } from "../type-defs/workspace.js";
import { cardOf } from "../utils/messageCards.js";
import { projectOperationEverywhere } from "./operationCards.js";

const client = vi.hoisted(() => ({
  list: vi.fn(),
  follow: vi.fn(),
}));
vi.mock("../api/operationsClient.js", () => ({
  listActiveOperations: client.list,
  followOperationEvents: client.follow,
}));

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
});
