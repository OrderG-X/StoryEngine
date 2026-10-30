// @vitest-environment node
// 导入后通读记账（写作版本 P2a 片 3D，background.reread）：一章一步落账、试满停下、「接着记」不重记、进程没了接着做、
// 进度行和那道闸从操作记录读、最新那次清理时不清、升级前的状态文件转一次。
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bookImportText, projectBook, readChapterLedger, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBookOnCore } from "../../../book/mirror/ensure.js";
import { createStoryProject } from "../../../book/project-store.js";
import { __resetCatchUpQueuesForTests, readReadersCatchUpStatus } from "../../../editorial/catch-up.js";
import { resumeBackgroundReading, type BrainCallModel } from "../../../editorial/index.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { readRereadProgress, readRereadState, REREAD_KIND, rereadBlocker } from "../../../editorial/reread-state.js";
import { awaitsReread, REREAD_ATTEMPTS } from "../../../editorial/reread.js";
import { ModelCallError } from "../../../lib/ai-errors.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests, OperationStopped } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, pruneOperations, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { seedOperation } from "../../../lib/operations/test-helpers.js";
import { setReaderBackfillHandler, type ReaderBackfillRequest } from "../../../lib/reader-backfill.js";
import { coreSnapshotFor } from "../../../lib/snapshot.js";
import { __drainOperationsForTests, __resetRecipesForTests, reconcileOperations, registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import { createBackgroundRereadRecipe, type RereadResultBody } from "./background-reread.js";
import { continueReread, migrateLegacyRereadState } from "./index.js";

const hook = vi.hoisted(() => ({ afterReread: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../../lib/operations/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/operations/command.js")>();
  return {
    ...actual,
    runCommandInOperation: async (...args: Parameters<typeof actual.runCommandInOperation>) => {
      const outcome = await actual.runCommandInOperation(...args);
      if (args[1].name === "ledger.reread") await hook.afterReread?.();
      return outcome;
    },
  };
});

const CHAPTERS = [
  { title: "钟停", body: "钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。" },
  { title: "外乡人", body: "第二天上午，外乡人又来了。老周说他今年七十了。" },
  { title: "还钥匙", body: "沈青禾把钥匙还给了老周。" },
];

const LEDGERS: Record<number, unknown> = {
  1: {
    summary: { text: "沈青禾进了钟楼", quote: "沈青禾推开钟楼的门" },
    presence: [{ name: "沈青禾", nameUsed: "沈青禾", quote: "沈青禾推开钟楼的门" }],
    facts: [{ nature: "hard", subject: "周守义", attribute: "年纪", value: "六十", text: "老周六十岁", quote: "老周没有拦她" }],
    threads: [{ op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟停在三点十五分" }],
  },
  2: {
    summary: { text: "外乡人又来", quote: "外乡人又来了" },
    // 和第 1 章「不会变」的事实对不上：定稿时默认不写、要作者勾；通读没人勾，不写。
    facts: [{ nature: "hard", subject: "周守义", attribute: "年纪", value: "七十", text: "老周七十岁", quote: "老周说他今年七十了" }],
    threads: [{ op: "advance", thread: "T1", note: "外乡人又来", quote: "外乡人又来了" }],
  },
  3: { summary: { text: "钥匙还了", quote: "沈青禾把钥匙还给了老周" } },
};

/** 假记账员：要 JSON 的是交账单（看是哪一章），其余是写笔记。hold 给了就在那一章的账单调用里等它。 */
function fakeKeeper(options: { readonly failChapter?: number; readonly failTimes?: number; readonly error?: () => Error; readonly holdChapter?: number; readonly hold?: Promise<void> } = {}) {
  let failed = 0;
  const ledgerChapters: number[] = [];
  const callModel: BrainCallModel = async (messages, callOptions) => {
    if (!callOptions.json) return "笔记：老周＝周守义。";
    const task = messages.at(-1)?.content ?? "";
    const chapter = [1, 2, 3].find((n) => task.includes(`【第 ${n} 章 正文`)) ?? 0;
    ledgerChapters.push(chapter);
    if (chapter === options.holdChapter && options.hold) await options.hold;
    if (chapter === options.failChapter && failed < (options.failTimes ?? Infinity)) {
      failed += 1;
      throw options.error?.() ?? new Error("服务商 502");
    }
    return JSON.stringify(LEDGERS[chapter] ?? {});
  };
  return { callModel, ledgerChapters };
}

let root: string;
let book: string;
let backfills: ReaderBackfillRequest[];
const previousDataDir = process.env.SE_DATA_DIR;

function resetProcess(): void {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetCatchUpQueuesForTests();
  __resetCatchUpLocksForTests();
  __resetRecipesForTests();
}

beforeEach(async () => {
  resetProcess();
  hook.afterReread = undefined;
  root = await makeHomeTempDir("reread-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "钟楼" }));
  const imported = await runCommand(book, bookImportText, { chapters: CHAPTERS }, { caller: "author", idempotencyKey: "import" });
  if (!imported.ok) throw new Error(imported.message);
  const onCore = await ensureBookOnCore(book, { snapshot: coreSnapshotFor(book) });
  if (!onCore.ok) throw new Error(onCore.reason);
  backfills = [];
  setReaderBackfillHandler(async (_book, request) => { backfills.push(request); });
});
afterEach(async () => {
  setReaderBackfillHandler(undefined);
  __resetRecipesForTests();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function useRecipe(callModel: BrainCallModel, modelProblem: () => string | undefined = () => undefined): void {
  registerRecipe(createBackgroundRereadRecipe({ callModel, modelProblem }));
}

const rereads = async (): Promise<readonly OperationRecord[]> =>
  (await listOperations(book)).filter((record) => record.kind === REREAD_KIND).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** 等这本书的通读都停下，返回全部记录（先交的在前）。 */
async function quiet(): Promise<readonly OperationRecord[]> {
  for (let i = 0; i < 200; i += 1) {
    await __drainOperationsForTests();
    const records = await rereads();
    if (records.length > 0 && records.every((record) => record.state !== "queued" && record.state !== "running")) return records;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("通读没停下");
}

async function start(total = 3): Promise<void> {
  const outcome = await submitOperation(book, { kind: REREAD_KIND, params: { total }, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString(), origin: { kind: "button" } });
  expect(outcome).toMatchObject({ ok: true });
}

describe("通读记账", () => {
  it("从第 1 章起一章一步落账：账单换成通读记的，后一章推进前一章的线索；会改前文不会变的事实不写；记完交后台补读", async () => {
    const keeper = fakeKeeper();
    useRecipe(keeper.callModel);
    await start();
    const [record] = await quiet();
    expect(record).toMatchObject({ state: "succeeded", params: { total: 3, chapters: [1, 2, 3] } });
    expect(record!.appliedEffects?.map((effect) => effect.stepId)).toEqual(["apply:1:0", "apply:2:0", "apply:3:0"]);
    const body = (record!.result as { body: RereadResultBody }).body;
    expect(body.total).toBe(3);
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    for (const chapter of [1, 2, 3]) expect((await readChapterLedger(book, chapter))?.origin).toBe("reread");
    expect((await readChapterLedger(book, 2))?.entries.some((entry) => entry.kind === "fact")).toBe(false);
    const view = await projectBook(book);
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", lastTouchedAt: 2 });
    expect(view.facts.find((fact) => fact.subject === "周守义")?.value).toBe("六十");
    expect(await readRereadState(book)).toMatchObject({ status: "done", done: 3, total: 3 });
    expect(await rereadBlocker(book, "核账")).toBeUndefined();
    expect((await readReadersCatchUpStatus(book)).reread).toBeUndefined();
    await vi.waitFor(() => expect(backfills).toEqual([{ upTo: 3 }]));
  });

  it("一章试满还不成：这次没成、记原因，进度行和那道闸都说停在哪章；开书不自动重试；「接着记」交一次新的，前面的不重记", async () => {
    useRecipe(fakeKeeper({ failChapter: 2 }).callModel);
    await start();
    const [failed] = await quiet();
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed!.failure?.message).toContain("502");
    expect(await readRereadState(book)).toMatchObject({ status: "stopped", done: 1, total: 3 });
    expect(await rereadBlocker(book, "定稿")).toContain("停在了第 2 章");
    const status = await readReadersCatchUpStatus(book);
    expect(status.reread).toMatchObject({ status: "stopped", done: 1, total: 3 });
    expect(status.reread?.stoppedReason).toContain("502");
    expect(status.roles.find((role) => role.role === "ledger")).toMatchObject({ reading: false, done: 1, total: 3 });

    // 停下的开书时不自动重试，也不交补读（一直失败的话每次开书都白花调用）。
    await resumeBackgroundReading(book);
    expect(await reconcileOperations(book)).toEqual({ resumed: [] });
    expect(backfills).toEqual([]);

    __resetRecipesForTests();
    const good = fakeKeeper();
    useRecipe(good.callModel);
    expect(await continueReread(book)).toEqual({ ok: true, status: "running" });
    const records = await quiet();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ state: "succeeded", params: { total: 3, chapters: [2, 3] } });
    expect(good.ledgerChapters).toEqual([2, 3]);
    expect(await readRereadState(book)).toMatchObject({ status: "done", done: 3 });
    expect(await continueReread(book)).toEqual({ ok: true, status: "done" });
  });

  it("被拒（422）这类再发也一样的：这章只发一次就停下，不试满三次（写作版本 P2a 4.2）", async () => {
    const rejected = fakeKeeper({ failChapter: 2, error: () => new ModelCallError("模型请求失败：422", "rejected", 422) });
    useRecipe(rejected.callModel);
    await start();
    await quiet();
    expect(rejected.ledgerChapters).toEqual([1, 2]);
    expect(await readRereadState(book)).toMatchObject({ status: "stopped", done: 1 });
  });

  it("产物不能用（空回复）可以再试：最多试满三次；偶尔失败一两次照记", async () => {
    const empty = fakeKeeper({ failChapter: 2, error: () => new ModelCallError("模型什么也没回", "unusable", undefined, "empty") });
    useRecipe(empty.callModel);
    await start();
    await quiet();
    expect(empty.ledgerChapters.filter((chapter) => chapter === 2)).toHaveLength(REREAD_ATTEMPTS);

    __resetRecipesForTests();
    useRecipe(fakeKeeper({ failChapter: 3, failTimes: REREAD_ATTEMPTS - 1 }).callModel);
    expect(await continueReread(book)).toMatchObject({ ok: true });
    await quiet();
    expect(await readRereadState(book)).toMatchObject({ status: "done", done: 3 });
  });

  it("只记导入已写的书时那份空账单：老格式书导入的账（origin 也是 import，带着老账）、定稿过的、记过的都不记", () => {
    expect(awaitsReread({ origin: "import", entries: [] })).toBe(true);
    expect(awaitsReread({ origin: "import", entries: [{} as never] })).toBe(false);
    expect(awaitsReread({ origin: "commit", entries: [] })).toBe(false);
    expect(awaitsReread({ origin: "reread", entries: [] })).toBe(false);
  });

  it("模型没配好：也受理，跑起来如实没成（进度行挂着原因，账没记全的书不放行）", async () => {
    useRecipe(fakeKeeper().callModel, () => "「核账」还没配模型，没法用；去 设置 → 模型 配好再来一次。");
    await start();
    await quiet();
    expect(await readRereadState(book)).toMatchObject({ status: "stopped", done: 0, stoppedReason: "「核账」还没配模型，没法用；去 设置 → 模型 配好再来一次。" });
    expect(await rereadBlocker(book, "核账")).toContain("停在了第 1 章");
  });
});

describe("进度从操作记录读", () => {
  it("在记：记账员那一行按记了几章显示；估还要多久按相邻两章落账的间隔；四个动作都挡住", async () => {
    await seedOperation(book, {
      kind: REREAD_KIND,
      params: { total: 3, chapters: [1, 2, 3] },
      state: "running",
      patch: {
        appliedEffects: [
          { stepId: "apply:1:0", command: "ledger.reread", version: 2, at: "2026-10-19T08:00:00.000Z", paths: [] },
          { stepId: "apply:2:1", command: "ledger.reread", version: 3, at: "2026-10-19T08:05:00.000Z", paths: [] },
        ],
      },
    });
    const status = await readReadersCatchUpStatus(book);
    expect(status.reading).toBe(true);
    expect(status.roles.find((role) => role.role === "ledger")).toEqual({ role: "ledger", reading: true, done: 2, total: 3 });
    expect(status.reread).toEqual({ status: "running", done: 2, total: 3, etaMinutes: 5 });
    expect(await rereadBlocker(book, "核账")).toContain("记完 2/3 章，大约还要 5 分钟");
  });

  it("停着（额度到了）：说清为什么停；「接着记」接着做这一次，不另起", async () => {
    const paused = await seedOperation(book, { kind: REREAD_KIND, params: { total: 3, chapters: [1, 2, 3] }, state: "paused", patch: { pauseReason: "budget" } });
    expect(await readRereadState(book)).toMatchObject({ status: "stopped", done: 0, stoppedReason: "这次能用的调用次数用完了" });
    useRecipe(fakeKeeper().callModel);
    expect(await continueReread(book)).toEqual({ ok: true, status: "running" });
    await quiet();
    expect((await rereads()).map((record) => record.opId)).toEqual([paused.opId]);
  });

  it("最新那次清理时不清（只清别的文件）：停着的过了三十天照样挡着；更早的照常换墓碑", async () => {
    const older = await seedOperation(book, { kind: REREAD_KIND, params: { total: 3, chapters: [1, 2, 3] }, state: "failed", patch: { failure: { code: "reread_failed", message: "服务商 502", retryable: true } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latest = await seedOperation(book, { kind: REREAD_KIND, params: { total: 3, chapters: [1, 2, 3] }, state: "failed", patch: { failure: { code: "reread_failed", message: "服务商 503", retryable: true } } });
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    await pruneOperations(book, () => "", later, undefined, new Set([REREAD_KIND]));
    expect((await readOperation(book, older.opId)).kind).toBe("tombstone");
    expect((await readOperation(book, latest.opId)).kind).toBe("record");
    expect(await rereadBlocker(book, "定稿")).toContain("服务商 503");
  });
});

describe("进程没了", () => {
  it("一章落了账、记检查点之前断了：接着做照回执算上这章，不把自己刚落的账当成书变了（Astra 第 13 轮第 2 条）", async () => {
    const keeper = fakeKeeper();
    useRecipe(keeper.callModel);
    hook.afterReread = async () => {
      hook.afterReread = undefined;
      throw new OperationStopped("operation_stopped", "进程没了");
    };
    await start();
    const [interrupted] = await quiet();
    expect(interrupted).toMatchObject({ state: "paused", pauseReason: "interrupted" });
    expect((await readChapterLedger(book, 1))?.entries.length).toBeGreaterThan(0);
    expect(await resumeOperation(book, interrupted!.opId)).toMatchObject({ ok: true });
    const [record] = await quiet();
    expect(record).toMatchObject({ state: "succeeded" });
    const onDisk = await Promise.all([1, 2, 3].map(async (n) => (await readChapterLedger(book, n))?.entries.length ?? 0));
    expect(((record!.result as { body?: RereadResultBody } | undefined)?.body)?.recorded).toBe(onDisk.reduce((sum, n) => sum + n, 0));
    // 第 1 章的账单只交过一次（读那一步落了检查点，接着做零调用）。
    expect(keeper.ledgerChapters.filter((chapter) => chapter === 1)).toHaveLength(1);
  });

  it("开书对账自动接着做：记完的章零调用，从停下那章接着记", async () => {
    const first = fakeKeeper({ holdChapter: 2, hold: new Promise<void>(() => undefined) });
    useRecipe(first.callModel);
    await start();
    await vi.waitFor(() => expect(first.ledgerChapters).toEqual([1, 2]), { timeout: 5_000 });
    const opId = (await rereads())[0]!.opId;
    // 进程没了：调度表、执行登记、补读队列和锁都清空；旧 worker 卡着永远不回。
    resetProcess();
    const second = fakeKeeper();
    useRecipe(second.callModel);
    expect(await reconcileOperations(book)).toEqual({ resumed: [opId] });
    const [record] = await quiet();
    expect(record).toMatchObject({ opId, state: "succeeded" });
    expect(second.ledgerChapters).toEqual([2, 3]);
    expect((await readRereadProgress(book))?.status).toBe("done");
  });
});

describe("升级前的状态文件", () => {
  const legacyFile = () => join(book, "agents", "ledger", "reread.json");
  const writeLegacy = async (status: string) => {
    await mkdir(join(book, "agents", "ledger"), { recursive: true });
    await writeFile(legacyFile(), JSON.stringify({ schema: "reread/1", status, run: "r1", total: 3, done: 1 }));
  };

  it("没记完的：开书时转成一次通读记账、删掉文件；已经记完的直接删", async () => {
    useRecipe(fakeKeeper().callModel);
    await writeLegacy("stopped");
    await migrateLegacyRereadState(book);
    expect(existsSync(legacyFile())).toBe(false);
    const [record] = await quiet();
    expect(record).toMatchObject({ state: "succeeded", params: { total: 3, chapters: [1, 2, 3] } });

    await writeLegacy("done");
    await migrateLegacyRereadState(book);
    expect(existsSync(legacyFile())).toBe(false);
    expect(await rereads()).toHaveLength(1);
  });
});
