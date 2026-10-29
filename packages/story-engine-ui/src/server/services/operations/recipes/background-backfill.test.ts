// @vitest-environment node
// 后台补读（写作版本 P2a，background.backfill）：冻结范围、一章一步、按角色排、停着的等作者、追新、前面改过重排、进程没了接着做、书删了不建幽灵目录。
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoryProject } from "../../../book/project-store.js";
import { buildColdReaderWindow, CHECKER_ROLE, ensureReaderWindow, LEDGER_ROLE, PLANNER_ROLE, readReadersCatchUpStatus, type BrainCallModel } from "../../../editorial/index.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, operationDir, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { BACKFILL_KIND, requestReaderBackfill, setReaderBackfillHandler } from "../../../lib/reader-backfill.js";
import { __resetCatchUpQueuesForTests } from "../../../editorial/catch-up.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { __drainOperationsForTests, __resetRecipesForTests, reconcileOperations, registerRecipe, resumeOperation } from "../executor.js";
import { backfillStepSends } from "../budgets.js";
import { createBackgroundBackfillRecipe, type BackfillResultBody } from "./background-backfill.js";
import { __drainBackfillSubmissionsForTests, submitBackfill } from "./index.js";

let root: string;
let book: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("backfill-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "补读", genre: "悬疑", protagonistName: "林远" }));
});
afterEach(async () => {
  setReaderBackfillHandler(undefined);
  __resetRecipesForTests();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const chapterPath = (dir: string, chapter: number) => join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`);
async function commitChapters(from: number, to: number, text = (chapter: number) => `第${chapter}章的正文。`): Promise<void> {
  await mkdir(join(book, "chapters"), { recursive: true });
  for (let chapter = from; chapter <= to; chapter += 1) await writeFile(chapterPath(book, chapter), `# 第${chapter}章\n\n${text(chapter)}\n`, "utf-8");
}
const notes = async (role: string) => (await readdir(join(book, "agents", role, "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();

/** 假专员：写笔记就回「第 N 章笔记」，记下每次调用、同时在飞的最多几个；hold 给了就在第 holdAt 次调用里等它。 */
function fakeReader(options: { readonly holdAt?: number; readonly hold?: Promise<void>; readonly onCall?: (count: number) => Promise<void> | void } = {}) {
  let count = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const callModel: BrainCallModel = async (messages) => {
    count += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await options.onCall?.(count);
      if (options.hold && count === options.holdAt) await options.hold;
      return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1] ?? "?"}章笔记`;
    } finally {
      inFlight -= 1;
    }
  };
  return { callModel, calls: () => count, maxInFlight: () => maxInFlight };
}

function useRecipe(callModel: BrainCallModel, modelProblem: () => string | undefined = () => undefined): void {
  registerRecipe(createBackgroundBackfillRecipe({ callModel, modelProblem }));
  setReaderBackfillHandler(submitBackfill);
}

const backfills = async (): Promise<readonly OperationRecord[]> =>
  (await listOperations(book)).filter((record) => record.kind === BACKFILL_KIND).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** 等这本书的后台补读都停下：提交都交完、操作（连收尾里接着交的）都跑完，返回全部记录。 */
async function quiet(): Promise<readonly OperationRecord[]> {
  for (let i = 0; i < 100; i += 1) {
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("受理：冻结每个角色还差的章", () => {
  it("读齐了的角色不进范围；三个都齐了不受理；还没定稿的书不受理；模型没配好不受理", async () => {
    const reader = fakeReader();
    useRecipe(reader.callModel);
    await submitBackfill(book, { upTo: 3 });
    expect(await backfills()).toEqual([]); // 一章定稿都没有
    await commitChapters(1, 3);
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 3 });
    const first = await quiet();
    expect(first[0]).toMatchObject({ state: "succeeded", params: { ranges: [{ role: CHECKER_ROLE.id, from: 1, to: 3 }] }, origin: { kind: "background" } });
    expect(first).toHaveLength(1); // 跑完按核账员再看一眼：读齐了，不受理，不空转
    // 再交三个角色：核账员读齐了，只冻结另外两个。
    await submitBackfill(book, { upTo: 3 });
    const records = await quiet();
    expect(records[1]).toMatchObject({ state: "succeeded", params: { ranges: [{ role: LEDGER_ROLE.id, from: 1, to: 3 }, { role: PLANNER_ROLE.id, from: 1, to: 3 }] } });
    expect(records[1]!.budget.limit).toBe(2 * 3 * backfillStepSends(1)); // 两个角色各 3 章，10 章以内用不到卷笔记
    expect(records).toHaveLength(2);
    // 又定稿一章：只冻结新的那章。
    await commitChapters(4, 4);
    await submitBackfill(book, { upTo: 4 });
    const more = await quiet();
    expect(more[2]).toMatchObject({ state: "succeeded", params: { ranges: [{ role: CHECKER_ROLE.id, from: 4, to: 4 }, { role: LEDGER_ROLE.id, from: 4, to: 4 }, { role: PLANNER_ROLE.id, from: 4, to: 4 }] } });
    expect(more).toHaveLength(3);
    for (const role of [CHECKER_ROLE, LEDGER_ROLE, PLANNER_ROLE]) expect(await notes(role.id)).toEqual(["0001.json", "0002.json", "0003.json", "0004.json"]);
    // 没配模型：不受理，不留一条注定失败的记录。
    __resetRecipesForTests();
    useRecipe(reader.callModel, () => "「核账」还没配模型");
    await commitChapters(5, 5);
    await submitBackfill(book, { upTo: 5 });
    expect(await backfills()).toHaveLength(3);
  });
});

describe("跑：一章一步、按角色先后、同时只一个调用在飞", () => {
  it("每章一个步骤检查点；补完进度行消失；结果写清各角色读到哪", async () => {
    await commitChapters(1, 3);
    const reader = fakeReader();
    useRecipe(reader.callModel);
    await submitBackfill(book, { roles: [PLANNER_ROLE.id, CHECKER_ROLE.id], upTo: 3 });
    const records = await quiet();
    const [record] = records;
    expect(record).toMatchObject({ state: "succeeded" });
    expect((record!.result as { body: BackfillResultBody }).body).toEqual({ readThrough: { planner: 3, checker: 3 }, progressed: true, restart: false, stuck: [] });
    expect((await readdir(join(operationDir(book, record!.opId), "steps"))).sort()).toEqual(["checker_1.json", "checker_2.json", "checker_3.json", "planner_1.json", "planner_2.json", "planner_3.json"]);
    // 跑完按这两个角色再看一眼：都读齐了，不受理；没点名的记账员不顺手补。
    expect(records).toHaveLength(1);
    expect(reader.calls()).toBe(6);
    expect(reader.maxInFlight()).toBe(1);
    expect((await readReadersCatchUpStatus(book)).reading).toBe(false);
  });

  it("在读时进度行从操作记录出：当前那个角色读到当前章的前一章", async () => {
    await commitChapters(1, 4);
    const hold = deferred();
    const reader = fakeReader({ holdAt: 3, hold: hold.promise });
    useRecipe(reader.callModel);
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 4 });
    await vi.waitFor(() => expect(reader.calls()).toBe(3), { timeout: 5_000 });
    expect((await readReadersCatchUpStatus(book)).roles.find((role) => role.role === CHECKER_ROLE.id)).toEqual({ role: CHECKER_ROLE.id, reading: true, done: 2, total: 4 });
    hold.resolve();
    await quiet();
  });
});

describe("按角色排（Astra P2a 第 8 轮第 2、6 条）", () => {
  it("正在补的角色不另起一份；别的角色另起一份、同一条补读队上排着（同时只一个调用在飞）；正在补的那个角色读的途中新定稿的章，跑完再看一眼时补上", async () => {
    await commitChapters(1, 3);
    const hold = deferred();
    const reader = fakeReader({ holdAt: 1, hold: hold.promise });
    useRecipe(reader.callModel);
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 3 });
    await vi.waitFor(() => expect(reader.calls()).toBe(1), { timeout: 5_000 });
    // 核账员正在补：再要核账员不另起；要章纲员（出稿要它读到第 3 章）另起一份，不被吞掉。
    await commitChapters(4, 4);
    await Promise.all([submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 4 }), submitBackfill(book, { roles: [PLANNER_ROLE.id], upTo: 3 })]);
    expect((await backfills()).map((record) => record.params)).toEqual([
      { ranges: [{ role: CHECKER_ROLE.id, from: 1, to: 3 }] },
      { ranges: [{ role: PLANNER_ROLE.id, from: 1, to: 3 }] },
    ]);
    const status = await readReadersCatchUpStatus(book);
    expect(status.roles.find((role) => role.role === PLANNER_ROLE.id)).toMatchObject({ reading: true, done: 0 });
    hold.resolve();
    const records = await quiet();
    // 核账员跑完再看一眼：补上读的途中定稿的第 4 章；章纲员那份冻结的是第 1～3 章，跑完再看一眼补第 4 章。
    // （后两份谁先受理看前两份谁先跑完，不定先后。）
    expect(records.map((record) => [record.state, record.params])).toEqual(expect.arrayContaining([
      ["succeeded", { ranges: [{ role: CHECKER_ROLE.id, from: 1, to: 3 }] }],
      ["succeeded", { ranges: [{ role: PLANNER_ROLE.id, from: 1, to: 3 }] }],
      ["succeeded", { ranges: [{ role: CHECKER_ROLE.id, from: 4, to: 4 }] }],
      ["succeeded", { ranges: [{ role: PLANNER_ROLE.id, from: 4, to: 4 }] }],
    ]));
    expect(records).toHaveLength(4);
    expect(reader.maxInFlight()).toBe(1);
    for (const role of [CHECKER_ROLE, PLANNER_ROLE]) expect(await notes(role.id)).toHaveLength(4);
    expect(await notes(LEDGER_ROLE.id)).toHaveLength(0); // 没人要记账员读，不顺手补
  });

  it.each(["attempt_unknown", "budget"] as const)("停着的（%s）等作者处理：它那个角色不自动另起一份重发；别的角色照常交；进度行如实标停着", async (reason) => {
    await commitChapters(1, 3);
    const stuck = deferred();
    const blocked = fakeReader({ holdAt: 2, hold: stuck.promise });
    useRecipe(blocked.callModel);
    requestReaderBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 3 });
    await vi.waitFor(() => expect(blocked.calls()).toBe(2), { timeout: 5_000 });
    const pausedId = (await backfills())[0]!.opId;
    // 进程没了，开书对账判它停着（结果不明 / 额度到了）。
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    __resetCatchUpQueuesForTests();
    __resetCatchUpLocksForTests();
    const { changeOperation } = await import("../../../lib/operations/store.js");
    await changeOperation(book, pausedId, (current) => ({ ...current, state: "paused", pauseReason: reason, runEpoch: current.runEpoch + 1 }));
    __resetRecipesForTests();
    const fresh = fakeReader();
    useRecipe(fresh.callModel);
    // 又定稿一章，开书 / 冷窗口核账交三个角色补到第 4 章。
    await commitChapters(4, 4);
    await submitBackfill(book, { upTo: 4 });
    const records = await quiet();
    expect(records.find((record) => record.opId === pausedId)).toMatchObject({ state: "paused", pauseReason: reason });
    expect(records.filter((record) => record.opId !== pausedId).map((record) => record.params)).toEqual([
      { ranges: [{ role: LEDGER_ROLE.id, from: 1, to: 4 }, { role: PLANNER_ROLE.id, from: 1, to: 4 }] },
    ]);
    expect(fresh.calls()).toBe(8); // 只有记账员、章纲员各 4 章；核账员一次都没重发
    expect((await readReadersCatchUpStatus(book)).roles.find((role) => role.role === CHECKER_ROLE.id)).toEqual({ role: CHECKER_ROLE.id, reading: false, done: 1, total: 4, paused: reason });
    // 前台也不替它当场补（Astra P2a 第 9 轮第 3 条）：核账员缺 3 章，maxCatchUp 10 也一次不发，带上停着的那份；冷窗口如实标。
    const before = fresh.calls();
    const ready = await ensureReaderWindow({ projectDir: book, role: CHECKER_ROLE, upTo: 4, callModel: fresh.callModel, maxCatchUp: 10 });
    expect(ready).toMatchObject({ missing: 3, built: 0, pausedBackfill: { opId: pausedId, reason } });
    expect((await buildColdReaderWindow({ projectDir: book, role: CHECKER_ROLE, upTo: 4 })).coverage.pausedBackfill).toBe(pausedId);
    expect(fresh.calls()).toBe(before);
    // 作者点「接着做」：那份补读自己不被自己挡，接着读完，跑完再看一眼补上新定稿的第 4 章。
    stuck.resolve();
    expect(await resumeOperation(book, pausedId)).toMatchObject({ ok: true });
    await quiet();
    expect(await notes(CHECKER_ROLE.id)).toHaveLength(4);
    expect(fresh.calls()).toBe(before + 3);
  });
});

describe("途中前面的章改了", () => {
  it("要重写的不止这一章：这次停在半路（restart），收尾后按新的范围重交，最后都对得上现在的正文", async () => {
    await commitChapters(1, 4);
    const reader = fakeReader({
      onCall: async (count) => {
        // 写第 3 章笔记那一下，作者改了第 1 章。
        if (count === 3) await writeFile(chapterPath(book, 1), "# 第1章\n\n第1章改过的正文。\n", "utf-8");
      },
    });
    useRecipe(reader.callModel);
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 4 });
    const records = await quiet();
    expect((records[0]!.result as { body: BackfillResultBody }).body).toMatchObject({ restart: true });
    expect(records[1]).toMatchObject({ state: "succeeded", params: { ranges: [{ role: CHECKER_ROLE.id, from: 1, to: 4 }] } });
    expect(await notes(CHECKER_ROLE.id)).toHaveLength(4);
    // 再交一次：都对得上，不受理。
    const count = records.length;
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 4 });
    expect(await backfills()).toHaveLength(count);
  });

  it("某章定稿读不到：这个角色停在它前一章，不空转", async () => {
    await commitChapters(1, 3);
    useRecipe(fakeReader({
      onCall: async (count) => {
        if (count === 1) await rm(chapterPath(book, 2));
      },
    }).callModel);
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 3 });
    const records = await quiet();
    expect((records[0]!.result as { body: BackfillResultBody }).body).toMatchObject({ readThrough: { checker: 1 }, stuck: [CHECKER_ROLE.id] });
    // 跑完再看一眼：第 2 章还读不到，不受理（不会对着读不到的那章一直交）。
    expect(records).toHaveLength(1);
  });
});

describe("进程没了", () => {
  it("开书对账自动接着做：做完的章零调用，从停下那章接着读", async () => {
    await commitChapters(1, 4);
    const hold = deferred();
    const first = fakeReader({ holdAt: 3, hold: hold.promise });
    useRecipe(first.callModel);
    await submitBackfill(book, { roles: [CHECKER_ROLE.id], upTo: 4 });
    await vi.waitFor(() => expect(first.calls()).toBe(3), { timeout: 5_000 });
    const opId = (await backfills())[0]!.opId;
    // 进程没了：调度表、执行登记、补读队列和锁都清空；旧 worker 卡着永远不回。
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    __resetCatchUpQueuesForTests();
    __resetCatchUpLocksForTests();
    __resetRecipesForTests();
    const second = fakeReader();
    useRecipe(second.callModel);
    expect(await reconcileOperations(book)).toEqual({ resumed: [opId] });
    const records = await quiet();
    expect(records.find((record) => record.opId === opId)).toMatchObject({ state: "succeeded" });
    expect(second.calls()).toBe(2); // 核账员第 3、4 章；跑完再看一眼都读齐了
    expect(await notes(CHECKER_ROLE.id)).toHaveLength(4);
  });
});

describe("书删了（挪进回收站）", () => {
  it("读到一半书被挪走：不在原处建出幽灵目录，这次不再调模型", async () => {
    await commitChapters(1, 4);
    const moved = `${book}-trashed`;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reader = fakeReader({
      onCall: async (count) => {
        if (count === 2) await rename(book, moved);
      },
    });
    useRecipe(reader.callModel);
    await submitBackfill(book, { upTo: 4 });
    await vi.waitFor(() => expect(reader.calls()).toBe(2), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(book)).toBe(false);
    expect(reader.calls()).toBe(2);
    const stored = await readOperation(moved, (await listOperations(moved))[0]!.opId);
    expect(stored.kind).toBe("record");
    await rm(moved, { recursive: true, force: true });
  });
});
