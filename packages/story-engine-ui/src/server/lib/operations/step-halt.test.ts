// @vitest-environment node
// 一步里出过被拒 / 结果不明 / 跑飞，这一步不再物理发送（写作版本 P2a 4.2 的兜底，Astra 第 6 轮第 3 条）：
// 上层哪个循环 catch 了再调，也只到 beforeSend 为止。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBookEpoch } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { ModelCallError, StepHaltedError } from "../ai-errors.js";
import { makeHomeTempDir } from "../home-test-tmp.js";
import { __resetCapabilityMemoryForTests, canCallAgain, canFallBack, streamChatModelToText } from "../llm-client.js";
import { listAttempts } from "./attempts.js";
import { __resetExecutionsForTests, registerExecution, runInOperation, runInStep, type OperationContext } from "./context.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation } from "./store.js";

let root: string;
let book: string;
let dataDir: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetCapabilityMemoryForTests();
  root = await makeHomeTempDir("operations-step-halt-");
  dataDir = await makeHomeTempDir("operations-step-halt-data-");
  process.env.SE_DATA_DIR = dataDir;
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "兜底", genre: "悬疑", protagonistName: "林远" }));
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

function sse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}
const text = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/** 在这次操作的一步里跑（每次调用是一个新的步骤执行）。 */
const inStep = <T>(context: OperationContext, step: string, fn: () => Promise<T>): Promise<T> =>
  runInOperation(context, () => runInStep(step, `1:${step}:1`, fn));

describe("一步里被拒过，这一步不再发", () => {
  it("422 之后同一步再调：不 fetch、抛 StepHaltedError（不能再发、不换备用）、不落 attempt；换一步照常发", async () => {
    const context = await running();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("参数不对", { status: 422 }));
    const errors = await inStep(context, "extend", async () => {
      const first = await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] }).catch((error: unknown) => error);
      const second = await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] }).catch((error: unknown) => error);
      return [first, second] as const;
    });
    expect(errors[0]).toBeInstanceOf(ModelCallError);
    expect((errors[0] as ModelCallError).attemptClass).toBe("rejected");
    expect(errors[1]).toBeInstanceOf(StepHaltedError);
    expect(canCallAgain(errors[1])).toBe(false);
    expect(canFallBack(errors[1])).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await listAttempts(book, context.opId)).toHaveLength(1);

    await inStep(context, "deai", () => streamChatModelToText({ configured: model("a"), messages: [] }).catch(() => undefined));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("产物不能用（空回复）不拦：同一步可以再发一次", async () => {
    const context = await running();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => sse(["data: [DONE]\n\n"]));
    await inStep(context, "extend", async () => {
      for (let i = 0; i < 2; i += 1) {
        const error = await streamChatModelToText({ configured: model("a"), messages: [] }).catch((caught: unknown) => caught);
        expect((error as ModelCallError).attemptClass).toBe("unusable");
      }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("主模型 401 换备用成了：不拦；主、备都 401：这一步不再发", async () => {
    const context = await running();
    let backupOk = true;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("a.invalid") || !backupOk ? new Response("bad key", { status: 401 }) : sse([text("备用写的"), "data: [DONE]\n\n"]));
    await inStep(context, "write", async () => {
      expect((await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).content).toBe("备用写的");
      expect((await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).content).toBe("备用写的");
    });
    expect(fetch).toHaveBeenCalledTimes(4);

    backupOk = false;
    await inStep(context, "check", async () => {
      await expect(streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).rejects.toThrow("备用模型");
      await expect(streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).rejects.toBeInstanceOf(StepHaltedError);
    });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("不在步骤里（对话 AI 那一轮、设置里测连接）：不记、不拦", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("参数不对", { status: 422 }));
    for (let i = 0; i < 2; i += 1) {
      await expect(streamChatModelToText({ configured: model("a"), messages: [] })).rejects.not.toBeInstanceOf(StepHaltedError);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
