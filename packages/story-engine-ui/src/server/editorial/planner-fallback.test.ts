// @vitest-environment node
// 章纲员「光想不写」关思考重来认得出换了备用的那次（写作版本 P2a 4.2，Astra 第 7 轮第 2 条探针改写）：
// 主模型 401 → 备用思考超长 → 关思考重来；在操作的步骤里重来只发备用，不重发拒过的主模型。真模型客户端、真闸，只换 fetch 和设置。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readBookEpoch } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { __resetCapabilityMemoryForTests } from "../lib/llm-client.js";
import { __resetExecutionsForTests, registerExecution, runInOperation, runInStep, type OperationContext } from "../lib/operations/context.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation } from "../lib/operations/store.js";

const settings = vi.hoisted(() => ({ load: vi.fn(), assignments: vi.fn() }));
vi.mock("../lib/model-settings.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), loadModelSettingsV0: settings.load }));
vi.mock("../lib/task-assignments.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), readTaskAssignments: settings.assignments }));
const { callConfiguredPlannerModel } = await import("./planner.js");

let root: string;
let book: string;
let dataDir: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetCapabilityMemoryForTests();
  root = await makeHomeTempDir("planner-fallback-");
  dataDir = await makeHomeTempDir("planner-fallback-data-");
  process.env.SE_DATA_DIR = dataDir;
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "章纲换备用", genre: "悬疑", protagonistName: "林远" }));
  settings.load.mockResolvedValue({
    passed: true, available: true, status: "loaded", configPath: "test", issues: [],
    summary: {
      available: true, status: "loaded", configPath: "test", defaultProvider: "a", defaultProfile: "a",
      providers: [
        { id: "a", type: "openai-compatible", baseUrl: "https://a.invalid/v1", apiKeyStatus: "not_required" },
        { id: "b", type: "openai-compatible", baseUrl: "https://b.invalid/v1", apiKeyStatus: "not_required" },
      ],
      profiles: [{ id: "a", provider: "a", model: "a-model" }, { id: "b", provider: "b", model: "b-model" }],
      taskProfiles: { chapterSteering: "a" }, issueCount: 0, highRiskIssueCount: 0,
    },
  });
  settings.assignments.mockResolvedValue({ file: { version: 1, tasks: { chapterSteering: { profileId: "a", thinking: true } }, fallbackProfileId: "b" }, corrupt: false });
  // 章纲员「光想不写」上限 150 秒：测试里缩成 10 毫秒。
  const native = setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => native(fn, ms === 150_000 ? 10 : ms, ...rest)) as typeof setTimeout);
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
    requestKey: "chat:m1:1", issuedAt: new Date().toISOString(), kind: "plan.propose", mode: "plan", params: {}, recipeVersion: 1,
    origin: { kind: "chat", messageId: "m1" }, writeScope: { chapters: [] }, budget: { limit: 20 },
  }, { bookEpoch: () => readBookEpoch(book) });
  if (!accepted.ok || !("record" in accepted)) throw new Error(JSON.stringify(accepted));
  const record = await changeOperation(book, accepted.record.opId, (current) => ({ ...current, state: "running", runEpoch: 1 }));
  const execution = registerExecution(book, accepted.record.opId, 1);
  return { bookDir: book, opId: accepted.record.opId, runEpoch: 1, bookEpoch: record!.bookEpoch, signal: execution.signal, lane: "foreground" };
}

const encoder = new TextEncoder();
const text = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
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
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] })}\n\n`));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }), { status: 200 });
}

/** 主模型一律 401；备用第一次只思考不出字，之后正常写。返回发往哪几台。 */
function stubModels(): string[] {
  const hosts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const host = new URL(String(url)).host;
    hosts.push(host);
    if (host === "a.invalid") return new Response("bad key", { status: 401 });
    return hosts.filter((item) => item === "b.invalid").length === 1 ? thinkingForever(init?.signal) : sse([text("关思考拟好了"), "data: [DONE]\n\n"]);
  });
  return hosts;
}

it("在步骤里：主 401 → 备用思考超长 → 关思考重来只发备用（a、b、b 共 3 次）", async () => {
  const hosts = stubModels();
  const context = await running();
  const result = await runInOperation(context, () => runInStep("plan", "1:plan:1", () => callConfiguredPlannerModel([{ role: "user", content: "拟" }], { json: true })));
  expect(result).toBe("关思考拟好了");
  expect(hosts).toEqual(["a.invalid", "b.invalid", "b.invalid"]);
});

it("不在操作里（还没迁进操作的旧入口）：照样认得出、关思考重来成了；没有步骤记忆，重来时先试一次主模型", async () => {
  const hosts = stubModels();
  expect(await callConfiguredPlannerModel([{ role: "user", content: "拟" }], { json: true })).toBe("关思考拟好了");
  expect(hosts).toEqual(["a.invalid", "b.invalid", "a.invalid", "b.invalid"]);
});
