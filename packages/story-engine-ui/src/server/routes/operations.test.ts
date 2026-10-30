// @vitest-environment node
// 操作的出口：列表、停掉、订阅（写作版本 P2a 设计 6.7）。
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../lib/operations/context.js";
import { __resetLiveForTests } from "../lib/operations/live.js";
import { __resetOperationStoreForTests, isTerminal, listOperations } from "../lib/operations/store.js";
import { untilOperation } from "../lib/operations/test-helpers.js";
import type { Middleware } from "../lib/project-io.js";
import { __resetRecipesForTests, registerRecipe, submitOperation } from "../services/operations/executor.js";
import { registerOperationsRoutes } from "./operations.js";
import { callRoute } from "./test-helpers.js";

let root: string;
let book: string;
let release: () => void;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("operations-route-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "出口", genre: "悬疑", protagonistName: "林远" }));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  release = open;
  registerWaitRecipe(gate);
});
afterEach(async () => {
  release();
  // 等在跑的都结束再删书（不然配方收尾写记录时目录被删一半）。
  for (let i = 0; i < 200; i += 1) {
    if ((await listOperations(book)).every((record) => isTerminal(record.state))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  __resetRecipesForTests();
  await rm(root, { recursive: true, force: true });
});

/** 一个停在「wait」那步、等 gate 开的配方。 */
function registerWaitRecipe(gate: Promise<void>): void {
  registerRecipe<{ readonly secret: string }>({
    kind: "test.wait",
    version: 1,
    lane: "foreground",
    async prepare(_bookDir, input) {
      return { ok: true, params: input.params as { secret: string }, writeScope: { chapters: [] }, budget: 1 };
    },
    async run(ctx) {
      await ctx.step("wait", {}, async () => {
        ctx.progress("在等");
        await gate;
        return {};
      });
      return { schema: "operation-result/1", summary: `等完了，/Users/someone/书 里没动` };
    },
    stepBudget: () => 1,
    modelTasks: () => [],
  });
}

async function submit(key: string): Promise<string> {
  const outcome = await submitOperation(book, { kind: "test.wait", params: { secret: "参数原文" }, requestKey: key, issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: key } });
  if (!outcome.ok || !("record" in outcome)) throw new Error(JSON.stringify(outcome));
  return outcome.record.opId;
}

async function until(opId: string, state: string, step?: string): Promise<void> {
  await untilOperation(book, opId, (record) => record.state === state && (step === undefined || record.currentStep === step));
}

/** SSE 用的假响应：记下写出的事件，结束时 resolve。 */
function sseCall(url: string) {
  const handlers: Middleware[] = [];
  registerOperationsRoutes({ use: (handler) => handlers.push(handler) });
  const req = Object.assign(Readable.from([]), { method: "GET", url }) as IncomingMessage;
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((resolve) => { ended = resolve; });
  const res = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader: () => res,
    writeHead(status: number) { res.statusCode = status; res.headersSent = true; return res; },
    write(chunk: string) { chunks.push(chunk); return true; },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      res.writableEnded = true;
      ended();
      return res;
    },
  });
  const handled = Promise.resolve(handlers[0]!(req, res as unknown as ServerResponse, () => undefined));
  const events = () => {
    const out: { event: string; data: Record<string, unknown> }[] = [];
    for (const block of chunks.join("").split("\n\n")) {
      const event = /^event: (.+)$/mu.exec(block)?.[1];
      const data = /^data: (.+)$/mu.exec(block)?.[1];
      if (event && data) out.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
    return out;
  };
  return { res, done, handled, events, raw: () => chunks.join("") };
}

describe("GET /api/operations", () => {
  it("列出这本书的操作，不带参数原文；active=1 只要没结束的", async () => {
    const running = await submit("chat:m1");
    const stopped = await submit("chat:m2");
    await until(running, "running");
    await callRoute(registerOperationsRoutes, "POST", `/api/operations/${stopped}/cancel`, { project: book });
    const all = await callRoute(registerOperationsRoutes, "GET", `/api/operations?project=${encodeURIComponent(book)}`);
    expect(all.statusCode).toBe(200);
    const operations = all.payload.operations as Record<string, unknown>[];
    expect(operations.map((view) => view.opId).sort()).toEqual([running, stopped].sort());
    expect(JSON.stringify(all.payload)).not.toContain("参数原文");
    expect(operations[0]).not.toHaveProperty("requestHash");
    const active = await callRoute(registerOperationsRoutes, "GET", `/api/operations?project=${encodeURIComponent(book)}&active=1`);
    expect((active.payload.operations as Record<string, unknown>[]).map((view) => view.opId)).toEqual([running]);
  });

  it("上个进程留下的「在做」：先对账，报停着、给接着做，不报还在做", async () => {
    const opId = await submit("chat:m1");
    // 等它进了那一步、停在 gate 上（之后不再写记录），再当这个进程没了：不然它迟到的那笔写又把自己登记回调度表。
    await until(opId, "running", "wait");
    // 当这个进程没了、换了一个新进程：调度表、对账记忆都清掉（盘上的记录还是 running）。
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    __resetRecipesForTests();
    registerWaitRecipe(new Promise(() => undefined));
    const active = await callRoute(registerOperationsRoutes, "GET", `/api/operations?project=${encodeURIComponent(book)}&active=1`);
    expect(active.payload.operations).toEqual([expect.objectContaining({ opId, state: "paused", allowed: ["resume", "cancel"] })]);
  });

  it("号不对 → 404；没给书 → 400", async () => {
    expect((await callRoute(registerOperationsRoutes, "POST", "/api/operations/op-NOT-HEX/cancel", { project: book })).statusCode).toBe(404);
    expect((await callRoute(registerOperationsRoutes, "POST", "/api/operations/op-0123456789abcdef0123/cancel", { project: book })).statusCode).toBe(404);
    expect((await callRoute(registerOperationsRoutes, "GET", "/api/operations")).statusCode).toBe(400);
  });
});

describe("POST /api/operations/:id/cancel", () => {
  it("在跑的停掉；再停一次如实说没停（已经结束）", async () => {
    const opId = await submit("chat:m1");
    await until(opId, "running");
    const first = await callRoute(registerOperationsRoutes, "POST", `/api/operations/${opId}/cancel`, { project: book });
    expect(first.payload).toMatchObject({ ok: true, cancelled: true, operation: { state: "cancelled", summary: "这次停掉了。" } });
    const again = await callRoute(registerOperationsRoutes, "POST", `/api/operations/${opId}/cancel`, { project: book });
    expect(again.payload).toMatchObject({ ok: true, cancelled: false, operation: { state: "cancelled" } });
  });
});

describe("GET /api/operations/:id/events", () => {
  it("先快照、再实时事件和记录；结束了发完终态就关；给作者看的字洗掉本地路径", async () => {
    const opId = await submit("chat:m1");
    await until(opId, "running");
    const call = sseCall(`/api/operations/${opId}/events?project=${encodeURIComponent(book)}`);
    await call.handled;
    expect(call.events()[0]).toMatchObject({ event: "snapshot", data: { opId, state: "running" } });
    release();
    await call.done;
    const events = call.events();
    const last = events.at(-1)!;
    expect(last).toMatchObject({ event: "record", data: { state: "succeeded" } });
    expect(String(last.data.summary)).not.toContain("/Users/");
    expect(call.raw()).not.toContain("参数原文");
  });

  it("订阅时已经结束：只发快照就关", async () => {
    const opId = await submit("chat:m1");
    await until(opId, "running");
    release();
    await until(opId, "succeeded");
    const call = sseCall(`/api/operations/${opId}/events?project=${encodeURIComponent(book)}`);
    await call.handled;
    await call.done;
    expect(call.events().map((event) => event.event)).toEqual(["snapshot"]);
  });

  it("客户端断开 → 退订（之后的事件不再写）", async () => {
    const opId = await submit("chat:m1");
    await until(opId, "running");
    const call = sseCall(`/api/operations/${opId}/events?project=${encodeURIComponent(book)}`);
    await call.handled;
    const before = call.events().length;
    call.res.emit("close");
    release();
    await until(opId, "succeeded");
    expect(call.events().length).toBe(before);
  });

  it("没有这次操作 → 404", async () => {
    const call = sseCall(`/api/operations/op-0123456789abcdef0123/events?project=${encodeURIComponent(book)}`);
    await call.handled;
    expect(call.res.statusCode).toBe(404);
  });
});
