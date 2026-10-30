// @vitest-environment node
// 后台补读的卷笔记和额度（Astra P2a 第 9 轮第 4、5 条）：只缺卷笔记也受理；额度按规划的上界算、走真实调用路径不会停在额度上；
// 接着做时额度加这一步的最坏值 + 按冻结的模型重算的兼容余量。模型走真实的 llm-client（fetch 换成本地回包）。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoryProject } from "../../../book/project-store.js";
import { ensureReaderWindow, PLANNER_ROLE, readerNotesStatus } from "../../../editorial/index.js";
import { __resetCatchUpQueuesForTests } from "../../../editorial/catch-up.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetCapabilityMemoryForTests, freezeModelChoices, frozenCompatAllowance } from "../../../lib/llm-client.js";
import { listAttempts } from "../../../lib/operations/attempts.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, type OperationRecord } from "../../../lib/operations/store.js";
import { BACKFILL_KIND, setReaderBackfillHandler } from "../../../lib/reader-backfill.js";
import { __drainOperationsForTests, __resetRecipesForTests, resumeOperation } from "../executor.js";
import { backfillStepSends } from "../budgets.js";
import { __drainBackfillSubmissionsForTests, registerBuiltInRecipes, submitBackfill } from "./index.js";

const hooks = vi.hoisted(() => ({ load: vi.fn(), assignments: vi.fn() }));
vi.mock("../../../lib/model-settings.js", async (original) => ({ ...(await original<Record<string, unknown>>()), loadModelSettingsV0: hooks.load }));
vi.mock("../../../lib/task-assignments.js", async (original) => ({ ...(await original<Record<string, unknown>>()), readTaskAssignments: hooks.assignments }));

const settings = () => ({
  passed: true, available: true, status: "loaded", configPath: "fixture", issues: [],
  summary: {
    available: true, status: "loaded", configPath: "fixture", defaultProvider: "a", defaultProfile: "a",
    providers: [{ id: "a", type: "openai-compatible", baseUrl: "https://backfill-budget.invalid/v1", apiKeyStatus: "not_required" }],
    profiles: [{ id: "a", provider: "a", model: "a-model" }],
    taskProfiles: { fastDraft: "a", qualityCheck: "a", chapterSteering: "a" },
    issueCount: 0, highRiskIssueCount: 0,
  },
});
const sse = (content: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
const LONG_NOTE = "记".repeat(2000);

let root: string;
let book: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  hooks.load.mockResolvedValue(settings());
  hooks.assignments.mockResolvedValue({ file: null, corrupt: false });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("没接网"); });
  __resetCapabilityMemoryForTests();
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpQueuesForTests();
  __resetCatchUpLocksForTests();
  root = await makeHomeTempDir("backfill-budget-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "补卷", genre: "悬疑", protagonistName: "林远" }));
});
afterEach(async () => {
  setReaderBackfillHandler(undefined);
  __resetRecipesForTests();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function commitChapters(from: number, to: number): Promise<void> {
  await mkdir(join(book, "chapters"), { recursive: true });
  for (let chapter = from; chapter <= to; chapter += 1) {
    await writeFile(join(book, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n第${chapter}章的正文。\n`, "utf-8");
  }
}

const backfills = async (): Promise<readonly OperationRecord[]> =>
  (await listOperations(book)).filter((record) => record.kind === BACKFILL_KIND).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

async function quiet(): Promise<readonly OperationRecord[]> {
  for (let i = 0; i < 200; i += 1) {
    const submitted = await __drainBackfillSubmissionsForTests();
    const ran = await __drainOperationsForTests();
    if (!submitted && !ran) {
      const records = await backfills();
      if (records.length > 0 && records.every((record) => record.state !== "queued" && record.state !== "running")) return records;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("后台补读没停下");
}

describe("卷笔记缺口和额度上界", () => {
  it("章笔记都齐、只缺卷笔记（缓存丢了）：照样受理，范围是最后那一章，补完前台读完全书不用再建卷", async () => {
    await commitChapters(1, 120);
    // 章笔记按大窗口写齐（不建卷），默认窗口下就要卷笔记了。
    await ensureReaderWindow({ projectDir: book, role: PLANNER_ROLE, upTo: 120, callModel: async () => LONG_NOTE, maxChars: 1_000_000 });
    const status = await readerNotesStatus({ projectDir: book, role: PLANNER_ROLE, upTo: 120 });
    expect(status).toMatchObject({ readable: 120, valid: 120 });
    expect(status.volumesMissing).toBeGreaterThan(0);
    vi.mocked(globalThis.fetch).mockImplementation(async () => sse(LONG_NOTE));
    registerBuiltInRecipes();
    await submitBackfill(book, { roles: [PLANNER_ROLE.id], upTo: 120 });
    const [record] = await quiet();
    expect(record).toMatchObject({ state: "succeeded", params: { ranges: [{ role: PLANNER_ROLE.id, from: 120, to: 120 }] } });
    expect((await listAttempts(book, record!.opId)).length).toBeGreaterThan(0);
    expect((await readerNotesStatus({ projectDir: book, role: PLANNER_ROLE, upTo: 120 })).volumesMissing).toBe(0);
    const after = await ensureReaderWindow({ projectDir: book, role: PLANNER_ROLE, upTo: 120, callModel: async () => { throw new Error("不该再调"); }, maxVolumeBuilds: 0 });
    expect(after).toMatchObject({ missing: 0, volumesBuilt: 0 });
  }, 60_000);

  it("200 章只缺第 200 章笔记、旧卷缓存全丢：走真实调用路径一次补完，不停在额度上，实际发送不超额度", async () => {
    await commitChapters(1, 200);
    await ensureReaderWindow({ projectDir: book, role: PLANNER_ROLE, upTo: 199, callModel: async () => LONG_NOTE, maxChars: 1_000_000 });
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async () => sse(LONG_NOTE));
    registerBuiltInRecipes();
    await submitBackfill(book, { roles: [PLANNER_ROLE.id], upTo: 200 });
    const [record] = await quiet();
    expect(record).toMatchObject({ state: "succeeded", params: { ranges: [{ role: PLANNER_ROLE.id, from: 200, to: 200 }] } });
    const used = (await listAttempts(book, record!.opId)).length;
    expect(used).toBe(fetch.mock.calls.length);
    expect(used).toBeLessThanOrEqual(record!.budget.limit);
    const rest = await ensureReaderWindow({ projectDir: book, role: PLANNER_ROLE, upTo: 200, callModel: async () => { throw new Error("不该再调"); } });
    expect(rest).toMatchObject({ missing: 0, built: 0, volumesBuilt: 0 });
  }, 120_000);

  it("接着做：额度加停下那一步的最坏值 + 按冻结的模型重算的兼容余量（进程重来、学到的忘了也算上）", async () => {
    await commitChapters(1, 1);
    registerBuiltInRecipes();
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("断流")); } })));
    await submitBackfill(book, { roles: ["checker"], upTo: 1 });
    const [paused] = await quiet();
    expect(paused).toMatchObject({ state: "paused" });
    __resetCapabilityMemoryForTests();
    const compatibility = await frozenCompatAllowance(await freezeModelChoices(), ["qualityCheck"]);
    expect(compatibility).toBeGreaterThan(0);
    vi.mocked(globalThis.fetch).mockImplementation(async () => sse("笔记"));
    const resumed = await resumeOperation(book, paused!.opId);
    if (!resumed.ok) throw new Error("没接着做");
    expect(resumed.record.budget.limit - paused!.budget.limit).toBe(backfillStepSends(1) + compatibility);
    const [done] = await quiet();
    expect(done).toMatchObject({ state: "succeeded" });
  });
});
