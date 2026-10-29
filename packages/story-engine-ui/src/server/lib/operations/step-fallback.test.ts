// @vitest-environment node
// 换备用、停发和时序（写作版本 P2a 4.2，Astra 第 7 轮第 2、3 条探针改写）：
// - 备用也没成时包的那层带着策略原因：跑飞照样停发、思考超长照样认得出来（章纲员关思考重来见 editorial/planner-fallback.test.ts）；
// - 主模型在这一步拒过，再调直接用备用，不重发拒过的那个；
// - 停发在拿到记录锁后、真 fetch 前都再看一眼：等锁、写 attempt 期间别的调用判了停发，这一笔不发（记 not_sent）。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBookEpoch } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { ModelCallError, StepHaltedError } from "../ai-errors.js";
import { makeHomeTempDir } from "../home-test-tmp.js";
import { __resetCapabilityMemoryForTests, isThinkingTooLong, streamChatModelToText } from "../llm-client.js";
import { createProviderGate, providerGate } from "../provider-gate.js";
import * as attempts from "./attempts.js";
import { __resetExecutionsForTests, currentOperation, haltStep, registerExecution, runInOperation, runInStep, type OperationContext } from "./context.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation, withRecordLock } from "./store.js";


let root: string;
let book: string;
let dataDir: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetCapabilityMemoryForTests();
  root = await makeHomeTempDir("operations-step-fallback-");
  dataDir = await makeHomeTempDir("operations-step-fallback-data-");
  process.env.SE_DATA_DIR = dataDir;
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "换备用", genre: "悬疑", protagonistName: "林远" }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function running(): Promise<OperationContext> {
  const accepted = await acceptOperation(book, {
    requestKey: "chat:m1:1", issuedAt: new Date().toISOString(), kind: "inspect.run", mode: "inspect", params: {}, recipeVersion: 1,
    origin: { kind: "chat", messageId: "m1" }, writeScope: { chapters: [] }, budget: { limit: 20 },
  }, { bookEpoch: () => readBookEpoch(book) });
  if (!accepted.ok || !("record" in accepted)) throw new Error(JSON.stringify(accepted));
  const record = await changeOperation(book, accepted.record.opId, (current) => ({ ...current, state: "running", runEpoch: 1 }));
  const execution = registerExecution(book, accepted.record.opId, 1);
  return { bookDir: book, opId: accepted.record.opId, runEpoch: 1, bookEpoch: record!.bookEpoch, signal: execution.signal, lane: "foreground" };
}

function model(id: string, extra: Record<string, unknown> = {}) {
  return {
    provider: { id, label: id.toUpperCase(), baseUrl: `https://${id}.invalid/v1`, apiKeyStatus: "not_required" },
    profile: { id, provider: id, model: `${id}-model` },
    apiKey: `key-${id}`,
    thinking: false,
    thinkingDialect: "glm",
    ...extra,
  } as unknown as Parameters<typeof streamChatModelToText>[0]["configured"];
}

const encoder = new TextEncoder();
const text = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const thinkingFrame = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] })}\n\n`;
function sse(chunks: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}
/** 一直只吐思考、直到被掐。 */
function thinkingForever(signal: AbortSignal | null | undefined): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(thinkingFrame));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }), { status: 200 });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const inStep = <T>(context: OperationContext, step: string, fn: () => Promise<T>): Promise<T> =>
  runInOperation(context, () => runInStep(step, `1:${step}:1`, fn));

describe("备用也没成：策略原因原样带着", () => {
  it("主 401 → 备用跑飞：包出来的错还是跑飞，这一步停发；同一步再调不 fetch（共 2 次）", async () => {
    const context = await running();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("a.invalid") ? new Response("bad key", { status: 401 }) : sse([text("超出上限的正文"), "data: [DONE]\n\n"]));
    const errors = await inStep(context, "check", async () => {
      const first = await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [], maxContentChars: 2 }).catch((error: unknown) => error);
      const second = await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [], maxContentChars: 2 }).catch((error: unknown) => error);
      return [first, second] as const;
    });
    expect(errors[0]).toMatchObject({ attemptClass: "policy_abort", policy: "runaway" });
    expect((errors[0] as Error).message).toContain("备用模型");
    expect(errors[1]).toBeInstanceOf(StepHaltedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("不在步骤里也认得出备用那次的思考超长", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
      String(url).includes("a.invalid") ? new Response("bad key", { status: 401 }) : thinkingForever(init?.signal));
    const error = await streamChatModelToText({ configured: model("a", { thinking: true, fallback: model("b", { thinking: true }) }), messages: [], maxThinkingMs: 20 }).catch((caught: unknown) => caught);
    expect(isThinkingTooLong(error)).toBe(true);
    expect((error as Error).message).toContain("备用模型");
  });
});

describe("主模型这一步拒过：再调直接用备用", () => {
  it("主 401 换备用成了，同一步再调：只发备用（a、b、b）；换一步重新先试主模型", async () => {
    const context = await running();
    const hosts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      hosts.push(new URL(String(url)).host);
      return String(url).includes("a.invalid") ? new Response("bad key", { status: 401 }) : sse([text("备用写的"), "data: [DONE]\n\n"]);
    });
    await inStep(context, "write", async () => {
      for (let i = 0; i < 2; i += 1) {
        expect((await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).content).toBe("备用写的");
      }
    });
    expect(hosts).toEqual(["a.invalid", "b.invalid", "b.invalid"]);
    await inStep(context, "check", () => streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] }));
    expect(hosts.slice(3)).toEqual(["a.invalid", "b.invalid"]);
  });

  it("主模型没发出去（not_sent）换的备用：不记成拒过，下一次照常先试主模型", async () => {
    const context = await running();
    const hosts: string[] = [];
    let primaryDown = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      hosts.push(new URL(String(url)).host);
      if (String(url).includes("a.invalid") && primaryDown) {
        primaryDown = false;
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      }
      return sse([text("好了"), "data: [DONE]\n\n"]);
    });
    await inStep(context, "write", async () => {
      await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] });
      await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] });
    });
    expect(hosts).toEqual(["a.invalid", "b.invalid", "a.invalid"]);
  });
});

describe("停发在锁里、真发之前再看一眼", () => {
  it("B 等记录锁时 A 422 判了停发：B 拿到锁不落 attempt、不 fetch，抛 StepHaltedError", async () => {
    const context = await running();
    const firstFetched = deferred();
    let endFirst!: () => void;
    const events: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("a.invalid")) {
        events.push("a_fetch");
        firstFetched.resolve();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { endFirst = () => { controller.enqueue(encoder.encode("参数不对")); controller.close(); }; },
        }), { status: 422 });
      }
      events.push("b_fetch");
      return sse([text("B"), "data: [DONE]\n\n"]);
    });
    const bEntered = deferred();
    const gate = createProviderGate({
      beforeSend: (...args) => {
        const pending = attempts.beforeSend(...args);
        if (args[1].model === "b-model") bEntered.resolve();
        return pending;
      },
    });
    vi.spyOn(providerGate, "fetch").mockImplementation(gate.fetch);
    let bResult: unknown;
    await inStep(context, "extend", async () => {
      const a = streamChatModelToText({ configured: model("a"), messages: [] }).catch((error: unknown) => error);
      await firstFetched.promise;
      let b!: Promise<unknown>;
      await withRecordLock(book, context.opId, async () => {
        b = streamChatModelToText({ configured: model("b"), messages: [] }).catch((error: unknown) => error);
        await bEntered.promise;
        events.push("b_waiting_on_record_lock");
        endFirst();
        await a;
        expect(currentOperation()?.step?.halt.failure).toBeInstanceOf(ModelCallError);
        events.push("step_halted");
      });
      bResult = await b;
    });
    expect(events).toEqual(["a_fetch", "b_waiting_on_record_lock", "step_halted"]);
    expect(bResult).toBeInstanceOf(StepHaltedError);
    expect(await attempts.listAttempts(book, context.opId)).toHaveLength(1);
  });

  it("落了 attempt、真发之前这一步判了停发：不 fetch，那笔记 not_sent", async () => {
    const context = await running();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => sse([text("不该发"), "data: [DONE]\n\n"]));
    const gate = createProviderGate({
      beforeSend: async (...args) => {
        const ticket = await attempts.beforeSend(...args);
        haltStep(new ModelCallError("别的调用刚被拒", "rejected", 422));
        return ticket;
      },
    });
    vi.spyOn(providerGate, "fetch").mockImplementation(gate.fetch);
    const error = await inStep(context, "extend", () => streamChatModelToText({ configured: model("a"), messages: [] }).catch((caught: unknown) => caught));
    expect(error).toBeInstanceOf(StepHaltedError);
    expect(fetch).not.toHaveBeenCalled();
    const recorded = await attempts.listAttempts(book, context.opId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ state: "settled", class: "not_sent", counted: false });
  });
});
