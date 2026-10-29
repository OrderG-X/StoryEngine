// @vitest-environment node
// inspect.run（写作版本 P2a）：核账 / 硬伤检查 / 内容审阅 / 查 AI 味按固定步骤跑完；受理前挡下没法做的；
// 正文冻结（接着做照冻结那份）；核账笔记一步、核一步，缺得多照冷窗口核并交后台补读；停掉不留检查点。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftVersionOf, readDraftStamp } from "@actalk/story-core";
import { createStoryProject } from "../../../book/project-store.js";
import { CHECKER_ROLE, type BrainCallModel } from "../../../editorial/index.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { REREAD_STATE_SCHEMA, writeRereadState } from "../../../editorial/reread-state.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation, listOperations, operationDir, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { BACKFILL_KIND, setReaderBackfillHandler } from "../../../lib/reader-backfill.js";
import { defaultDraftPath } from "../../../lib/project-io.js";
import { pauseOperation } from "../../../lib/operations/fence.js";
import { __drainOperationsForTests, __resetRecipesForTests, cancelOperation, registerRecipe, resumeOperation, submitOperation, type OperationResult } from "../executor.js";
import { READER_CHECK_SENDS, READER_NOTES_SENDS, SINGLE_CALL_SENDS } from "../budgets.js";
import type { ContinuityCheckOutput, FlavorOutput, QualityCheckOutput, ReviewOutput } from "../../inspect-service.js";
import { createInspectRunRecipe, INSPECT_KIND, type InspectDeps } from "./inspect-run.js";

let root: string;
let book: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  root = await makeHomeTempDir("inspect-run-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "核一下", genre: "悬疑", protagonistName: "林舟" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  setReaderBackfillHandler(undefined);
  __resetRecipesForTests();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const CH1 = "林舟把怀表锁进了柜台下的抽屉。周婶说她明天一早来取伞。";
const DRAFT = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。";

async function commit(chapter: number, body: string): Promise<void> {
  await mkdir(join(book, "chapters"), { recursive: true });
  await writeFile(join(book, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${body}\n`, "utf-8");
}
async function draft(chapter: number, body: string): Promise<void> {
  await mkdir(join(book, "drafts", "fast"), { recursive: true });
  await writeFile(defaultDraftPath(book, chapter), `# 第${chapter}章 · 开门\n\n${body}\n`, "utf-8");
}

/** 假核账员：写笔记回一句；「盯东西」那遍看到「表盖还开着」报一处确定的；自复核都判 sure。记下调用次数，hold 给了就在核的那几遍里等它。 */
function fakeReader(options: { readonly hold?: Promise<void> } = {}) {
  let notes = 0;
  let checks = 0;
  const callModel: BrainCallModel = async (messages, call) => {
    if (!call.json) {
      notes += 1;
      return "笔记";
    }
    checks += 1;
    if (options.hold) await options.hold;
    const last = messages.at(-1)!.content;
    if (last.includes("你刚才核完报了")) {
      const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
    }
    if (last.includes("这一遍只盯东西") && last.includes("表盖还开着")) {
      return JSON.stringify({
        checks: [],
        contradictions: [{ quote: "他从工作台上拿起那块怀表，表盖还开着。", earlierQuote: "林舟把怀表锁进了柜台下的抽屉。", earlierChapter: 1, reason: "怀表位置对不上", confidence: "sure" }],
      });
    }
    return JSON.stringify({ checks: [], contradictions: [] });
  };
  return { callModel, notes: () => notes, checks: () => checks };
}

function useRecipe(deps: Partial<InspectDeps> = {}): void {
  registerRecipe(createInspectRunRecipe({ readerCallModel: fakeReader().callModel, modelProblem: () => undefined, ...deps }));
}

let keySeq = 0;
const submit = (mode: string, params: Record<string, unknown>) => submitOperation(book, {
  kind: INSPECT_KIND,
  mode,
  params,
  requestKey: `inspect-${(keySeq += 1)}`,
  issuedAt: new Date().toISOString(),
  origin: { kind: "button" },
});

async function accepted(mode: string, params: Record<string, unknown>): Promise<OperationRecord> {
  const outcome = await submit(mode, params);
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  return outcome.record;
}

async function settled(opId: string): Promise<OperationRecord> {
  await __drainOperationsForTests();
  const stored = await readOperation(book, opId);
  if (stored.kind !== "record") throw new Error("记录没了");
  return stored.record;
}

const resultOf = <T>(record: OperationRecord): OperationResult & { readonly body: T } => record.result as OperationResult & { readonly body: T };
const checkpoints = async (opId: string) => (await readdir(join(operationDir(book, opId), "steps")).catch(() => [] as string[])).sort();

describe("受理前挡下没法做的", () => {
  it("没正文、章号不对、不认识的检查、模型没配好都不受理（不留记录）", async () => {
    useRecipe({ modelProblem: (_models, task) => (task === "draftReview" ? "「审稿」还没配模型" : undefined) });
    await commit(1, CH1);
    expect(await submit("continuity", { chapter: 2 })).toMatchObject({ ok: false, code: "no_text", message: "第 2 章还没有正文，没法核账。" });
    expect(await submit("quality", { chapter: 1 })).toMatchObject({ ok: false, code: "no_text" }); // 硬伤检查只看工作稿
    expect(await submit("continuity", { chapter: 0 })).toMatchObject({ ok: false, code: "bad_params" });
    expect(await submit("continuity", { chapter: "二" })).toMatchObject({ ok: false, code: "bad_params" });
    expect(await submit("polish", { chapter: 1 })).toMatchObject({ ok: false, code: "bad_params" });
    await draft(2, DRAFT);
    expect(await submit("review", { chapter: 2 })).toMatchObject({ ok: false, code: "model_missing", message: "「审稿」还没配模型" });
    expect(await listOperations(book)).toEqual([]);
  });

  it("导入的书还在通读记账：核账不受理，硬伤检查照做", async () => {
    useRecipe();
    await commit(1, CH1);
    await draft(2, DRAFT);
    const now = new Date().toISOString();
    await writeRereadState(book, { schema: REREAD_STATE_SCHEMA, status: "running", run: "r1", total: 2, done: 0, recorded: 0, skipped: 0, startedAt: now, updatedAt: now, resumedAt: now, doneAtResume: 0 });
    const blocked = await submit("continuity", { chapter: 2 });
    expect(blocked).toMatchObject({ ok: false, code: "rereading" });
    expect((await submit("quality", { chapter: 2 })).ok).toBe(true);
  });
});

describe("核账（continuity）", () => {
  it("冻结 → 补笔记 → 核：结果是原来核账卡的形状，额度 = 补笔记 + 核", async () => {
    const reader = fakeReader();
    useRecipe({ readerCallModel: reader.callModel });
    await commit(1, CH1);
    await draft(2, DRAFT);
    const record = await accepted("continuity", { chapter: 2 });
    expect(record.mode).toBe("continuity");
    expect(record.writeScope).toEqual({ chapters: [] });
    expect(record.budget.limit).toBe(READER_NOTES_SENDS + READER_CHECK_SENDS);
    const done = await settled(record.opId);
    expect(done.state).toBe("succeeded");
    const { summary, body } = resultOf<ContinuityCheckOutput>(done);
    expect(body).toMatchObject({ ok: true, chapter: 2, source: "draft", reused: false });
    expect(body.sure.map((issue) => issue.quote)).toEqual(["他从工作台上拿起那块怀表，表盖还开着。"]);
    expect(body.checkedVersion).toBe(draftVersionOf(`# 第2章 · 开门\n\n${DRAFT}\n`, await readDraftStamp(book, 2)));
    expect(summary).toBe(body.headline);
    expect(reader.notes()).toBe(1); // 第 1 章的笔记在 notes 那步写的
    expect(await checkpoints(record.opId)).toEqual(["check.json", "freeze.json", "notes.json"]);

    // 正文、前文都没改：再核一次直接用上次的结果，不调模型。
    const before = reader.checks();
    const again = await settled((await accepted("continuity", { chapter: 2 })).opId);
    expect(resultOf<ContinuityCheckOutput>(again).body).toMatchObject({ reused: true });
    expect(reader.checks()).toBe(before);
    // 「再细核一遍」重新核。
    const fresh = await settled((await accepted("continuity", { chapter: 2, fresh: true })).opId);
    expect(resultOf<ContinuityCheckOutput>(fresh).body).toMatchObject({ reused: false });
    expect(reader.checks()).toBeGreaterThan(before);
  });

  it("没有工作稿就核定稿正文（不带版本号）", async () => {
    useRecipe();
    await commit(1, CH1);
    await commit(2, DRAFT);
    const done = await settled((await accepted("continuity", { chapter: 2 })).opId);
    const { body } = resultOf<ContinuityCheckOutput>(done);
    expect(body).toMatchObject({ ok: true, source: "committed" });
    expect(body.checkedVersion).toBeUndefined();
  });

  it("前文缺的笔记超过当场上限：不当场补（0 次笔记调用），照冷窗口核、如实写范围，交后台补读（点名核账员），不停下等", async () => {
    const reader = fakeReader();
    useRecipe({ readerCallModel: reader.callModel });
    const requests: unknown[] = [];
    setReaderBackfillHandler(async (_bookDir, request) => { requests.push(request); });
    for (let chapter = 1; chapter <= 12; chapter += 1) await commit(chapter, "林舟照常开门。");
    await draft(13, "林舟把怀表拿出来。");
    const done = await settled((await accepted("continuity", { chapter: 13 })).opId);
    expect(done.state).toBe("succeeded");
    const result = resultOf<ContinuityCheckOutput>(done);
    expect(result.body.coverage).toEqual({ mode: "cold", notedThrough: 0, rawFrom: 5, rawTo: 12 });
    expect(result.coverage).toEqual(result.body.coverage);
    expect(result.summary).toContain("核账员还没读完全书（第 0 / 12 章）");
    expect(reader.notes()).toBe(0);
    expect(requests).toEqual([{ roles: [CHECKER_ROLE.id], upTo: 12 }]);
    expect((await listOperations(book)).filter((item) => item.kind === BACKFILL_KIND)).toEqual([]); // 处理函数是假的：没交真的补读
  });

  it("核账员的后台补读停着等作者（结果不明）：缺 3 章也不当场补（0 次笔记调用），照冷窗口核，回执说补读停着", async () => {
    const reader = fakeReader();
    useRecipe({ readerCallModel: reader.callModel });
    setReaderBackfillHandler(async () => undefined);
    for (let chapter = 1; chapter <= 3; chapter += 1) await commit(chapter, CH1);
    await draft(4, DRAFT);
    const parked = await acceptOperation(book, {
      requestKey: "backfill-parked", issuedAt: new Date().toISOString(), kind: BACKFILL_KIND, params: { ranges: [{ role: CHECKER_ROLE.id, from: 1, to: 3 }] },
      recipeVersion: 1, origin: { kind: "background" }, writeScope: { chapters: [] }, budget: { limit: 3 },
    }, { bookEpoch: async () => "e" });
    if (!parked.ok || !("record" in parked)) throw new Error("没受理");
    await changeOperation(book, parked.record.opId, (current) => ({ ...current, state: "paused", pauseReason: "attempt_unknown", runEpoch: current.runEpoch + 1 }));

    const done = await settled((await accepted("continuity", { chapter: 4 })).opId);
    expect(done.state).toBe("succeeded");
    const result = resultOf<ContinuityCheckOutput>(done);
    expect(result.body.coverage).toMatchObject({ mode: "cold", notedThrough: 0, pausedBackfill: parked.record.opId });
    expect(result.summary).toContain("后台补读停着，等你处理后才接着读");
    expect(reader.notes()).toBe(0);
  });

  it("交后台补读不带着核账那次操作的身份（另起的那次在操作外受理）", async () => {
    const { currentOperation } = await import("../../../lib/operations/context.js");
    useRecipe();
    const seen: unknown[] = [];
    setReaderBackfillHandler(async () => { seen.push(currentOperation()); });
    for (let chapter = 1; chapter <= 12; chapter += 1) await commit(chapter, "林舟照常开门。");
    await draft(13, "林舟把怀表拿出来。");
    await settled((await accepted("continuity", { chapter: 13 })).opId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([undefined]);
  });

  it("暂停后作者改了稿再接着做：照冻结的那份核（版本号是开工时那版），冻结、补笔记两步不重做", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const reader = fakeReader({ hold });
    useRecipe({ readerCallModel: reader.callModel });
    await commit(1, CH1);
    await draft(2, DRAFT);
    const frozenVersion = draftVersionOf(`# 第2章 · 开门\n\n${DRAFT}\n`, await readDraftStamp(book, 2));
    const record = await accepted("continuity", { chapter: 2 });
    for (let i = 0; i < 200 && reader.checks() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const running = await readOperation(book, record.opId);
    if (running.kind !== "record") throw new Error("记录没了");
    expect(running.record.currentStep).toBe("check");
    expect(await pauseOperation(book, record.opId, running.record.runEpoch, "interrupted")).toMatchObject({ state: "paused" });
    release();
    await __drainOperationsForTests();
    expect(await checkpoints(record.opId)).toEqual(["freeze.json", "notes.json"]); // 核那步被停：不存
    await draft(2, "林舟一早开门。怀表好好地锁在抽屉里。");
    const notesBefore = reader.notes();
    expect((await resumeOperation(book, record.opId)).ok).toBe(true);
    const done = await settled(record.opId);
    expect(done.state).toBe("succeeded");
    const { body } = resultOf<ContinuityCheckOutput>(done);
    expect(body.checkedVersion).toBe(frozenVersion);
    expect(body.sure.map((issue) => issue.quote)).toEqual(["他从工作台上拿起那块怀表，表盖还开着。"]);
    expect(reader.notes()).toBe(notesBefore);
    expect(done.budget.limit).toBe(READER_NOTES_SENDS + 2 * READER_CHECK_SENDS); // 接着做加上核那步的最坏值
  });

  it("停掉：记成 cancelled，核那步不存、核账记忆不写", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const reader = fakeReader({ hold });
    useRecipe({ readerCallModel: reader.callModel });
    await commit(1, CH1);
    await draft(2, DRAFT);
    const record = await accepted("continuity", { chapter: 2 });
    for (let i = 0; i < 200 && reader.checks() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await cancelOperation(book, record.opId)).toMatchObject({ cancelled: true });
    release();
    const done = await settled(record.opId);
    expect(done.state).toBe("cancelled");
    expect(await checkpoints(record.opId)).toEqual(["freeze.json", "notes.json"]);
    expect(await readdir(join(book, "continuity-checks")).catch(() => [] as string[])).toEqual([]);
  });

  it("补笔记的模型调用失败：这次如实失败（一句原因），不当成核过", async () => {
    useRecipe({ readerCallModel: async () => { throw new Error("服务商 500"); } });
    await commit(1, CH1);
    await draft(2, DRAFT);
    const done = await settled((await accepted("continuity", { chapter: 2 })).opId);
    expect(done.state).toBe("failed");
    expect(done.failure?.message).toBe("核账员读前文没成：服务商 500");
    expect(done.result).toBeUndefined();
  });
});

describe("硬伤检查、内容审阅、查 AI 味", () => {
  it("硬伤检查：确定性、额度 0，结果是原来质检卡的形状", async () => {
    useRecipe();
    await draft(1, "短。");
    const record = await accepted("quality", { chapter: 1 });
    expect(record.budget.limit).toBe(0);
    const done = await settled(record.opId);
    const { body, summary } = resultOf<QualityCheckOutput>(done);
    expect(body).toMatchObject({ chapter: 1, ok: true, passed: false, partialMiss: true });
    expect(body.errorIssueCount).toBeGreaterThan(0);
    expect(summary).toMatch(/^第 1 章硬伤检查：/u);
  });

  it("内容审阅：照冻结的全文审（带章名行），作者的方向带进去；模型不可用如实标没审成", async () => {
    const prompts: string[] = [];
    const review = JSON.stringify({ passed: true, score: 82, verdict: "ready_to_commit", summary: "可定稿。", strengths: [], issues: [], suggestedRevisions: [], continuityNotes: [], styleNotes: [], characterNotes: [], pacingNotes: [], readerHookNotes: [], shouldCommit: true, blockingReasons: [] });
    useRecipe({ reviewCallModel: async (prompt) => { prompts.push(prompt); return review; } });
    await draft(1, DRAFT);
    const record = await accepted("review", { chapter: 1, userDirection: "  节奏再快些 ", chapterGoal: "" });
    expect(record.params).toEqual({ mode: "review", chapter: 1, userDirection: "节奏再快些" });
    expect(record.budget.limit).toBe(SINGLE_CALL_SENDS);
    const done = await settled(record.opId);
    expect(resultOf<ReviewOutput>(done).body).toMatchObject({ ok: true, usedFallback: false, chapter: 1 });
    expect(resultOf<ReviewOutput>(done).summary).toBe("第 1 章内容审阅：可以定稿。");
    expect(prompts[0]).toContain("表盖还开着");
    expect(prompts[0]).toContain("节奏再快些");

    __resetRecipesForTests();
    useRecipe({ reviewCallModel: async () => { throw new Error("连不上"); } });
    const failed = await settled((await accepted("review", { chapter: 1 })).opId);
    expect(failed.state).toBe("succeeded");
    expect(resultOf<ReviewOutput>(failed).body).toMatchObject({ ok: false, usedFallback: true });
  });

  it("查 AI 味：挑出的句子在冻结的正文里", async () => {
    useRecipe({ flavorCallModel: async () => JSON.stringify({ summary: "一处", violations: [{ text: "仿佛那一刻，他的心中五味杂陈。", reason: "套路抒情", severity: "high", suggestedFix: "改具体动作" }] }) });
    await draft(1, "仿佛那一刻，他的心中五味杂陈。窗外下着雨。");
    const record = await accepted("flavor", { chapter: 1 });
    expect(record.budget.limit).toBe(SINGLE_CALL_SENDS);
    const done = await settled(record.opId);
    const { body } = resultOf<FlavorOutput>(done);
    expect(body.chapter).toBe(1);
    expect(body.violations.map((item) => item.text)).toContain("仿佛那一刻，他的心中五味杂陈。");
  });
});
