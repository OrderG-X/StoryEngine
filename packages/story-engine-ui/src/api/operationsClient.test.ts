import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelOperationRequest, followOperationEvents, listActiveOperations } from "./operationsClient.js";
import type { OperationViewData } from "./agentChatClient.js";

const OP_ID = "op-0123456789abcdef0123";

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: OP_ID, kind: "inspect.run", mode: "continuity", chapter: 3, what: "核账·第 3 章", state: "running", stateText: "在做",
    allowed: ["cancel"], summary: "", eventSeq: 1, origin: { kind: "chat", messageId: "u1" },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response;
}

/** 一条 SSE：按给的块推出去（验证跨块的行缓冲、CRLF）。 */
function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listActiveOperations", () => {
  it("按书问在做的；读不出的那条丢掉，不编", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, operations: [view(), { opId: "x" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const operations = await listActiveOperations("/books/钟楼");
    expect(operations.map((item) => item.opId)).toEqual([OP_ID]);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown as [string])[0]), "http://x");
    expect(url.pathname).toBe("/api/operations");
    expect(url.searchParams.get("project")).toBe("/books/钟楼");
    expect(url.searchParams.get("active")).toBe("1");
  });

  it("服务端没成：照它的话抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "这本书打不开。" }, 400)));
    await expect(listActiveOperations("/books/钟楼")).rejects.toThrow("这本书打不开。");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false })));
    await expect(listActiveOperations("/books/钟楼")).rejects.toThrow("读不到在做的操作。");
  });
});

describe("cancelOperationRequest", () => {
  it("POST 带书；停没停成照服务端说的", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, cancelled: false, operation: view({ state: "succeeded", allowed: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await cancelOperationRequest("/books/钟楼", OP_ID);
    expect(result.cancelled).toBe(false);
    expect(result.operation?.state).toBe("succeeded");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/operations/${OP_ID}/cancel`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ project: "/books/钟楼" });
  });

  it("没停成：抛服务端的原因", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "找不到这次操作了。" }, 404)));
    await expect(cancelOperationRequest("/books/钟楼", OP_ID)).rejects.toThrow("找不到这次操作了。");
  });
});

describe("followOperationEvents", () => {
  it("一份当前的 + 跟着变；进度那句单给；心跳、坏的一帧跳过；CRLF、跨块都认", async () => {
    const frames = [
      `event: snapshot\r\ndata: ${JSON.stringify(view())}\r\n\r\n`,
      ": ping\n\n",
      `event: live\ndata: ${JSON.stringify({ type: "progress", text: "核账员在读第 3 章" })}\n\n`,
      "event: record\ndata: {坏的\n\n",
      `event: record\ndata: ${JSON.stringify(view({ state: "succeeded", allowed: [], eventSeq: 5, summary: "没发现对不上的" }))}\n\n`,
    ].join("");
    const mid = Math.floor(frames.length / 2);
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([frames.slice(0, mid), frames.slice(mid)])));
    const seen: OperationViewData[] = [];
    const progress: string[] = [];
    await followOperationEvents("/books/钟楼", OP_ID, { onOperation: (item) => seen.push(item), onProgress: (text) => progress.push(text) }, new AbortController().signal);
    expect(seen.map((item) => [item.state, item.eventSeq])).toEqual([["running", 1], ["succeeded", 5]]);
    expect(progress).toEqual(["核账员在读第 3 章"]);
  });

  it("连不上、不是 200：安静返回（调用方当没再变）", async () => {
    const onOperation = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    await expect(followOperationEvents("/b", OP_ID, { onOperation }, new AbortController().signal)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false }, 404)));
    await expect(followOperationEvents("/b", OP_ID, { onOperation }, new AbortController().signal)).resolves.toBeUndefined();
    expect(onOperation).not.toHaveBeenCalled();
  });
});
