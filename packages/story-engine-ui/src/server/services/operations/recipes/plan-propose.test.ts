// @vitest-environment node
// plan.propose（写作版本 P2a 片 2D）：想这一章往哪走按固定步骤跑完（笔记 → 章纲员出 → 核账员核）；受理前挡下没法做的；
// 只读（不落章纲、不进账）；章纲员没想出来 → 没做成、说原因；核账员没核成照给走法；缺得多照冷窗口想并交后台补读。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTruthBasis } from "@actalk/story-core";
import { ensureBookOnCore } from "../../../book/ensure-on-core.js";
import { createStoryProject } from "../../../book/project-store.js";
import type { BrainCallModel } from "../../../editorial/index.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { REREAD_KIND } from "../../../editorial/reread-state.js";
import { seedOperation } from "../../../lib/operations/test-helpers.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, operationDir, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { setReaderBackfillHandler, type ReaderBackfillRequest } from "../../../lib/reader-backfill.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, submitOperation } from "../executor.js";
import { createPlanProposeRecipe, PLAN_PROPOSE_KIND, readPlanProposeParams, type PlanProposeBody, type PlanProposeDeps } from "./plan-propose.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  root = await makeHomeTempDir("plan-propose-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "往哪走", genre: "都市", protagonistName: "许棠" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  setReaderBackfillHandler(undefined);
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const CH1 = "许棠把那封信锁进抽屉，说明天一早去邮局。";
const CH2 = "第二天许棠去了邮局，把信寄给了林溪。林溪下午回电说收到了。";

async function commit(chapter: number, body: string): Promise<void> {
  await mkdir(join(book, "chapters"), { recursive: true });
  await writeFile(join(book, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${body}\n`, "utf-8");
}

const OPTIONS_JSON = JSON.stringify({
  options: [
    { title: "林溪来信", steps: ["邮差送来回信", "许棠拆信", "信里约周末见"], recommended: true },
    { title: "抽屉被撬", steps: ["许棠回家发现抽屉开着", "信不见了", "邻居说看见有人来过"] },
    { title: "去邮局追问", steps: ["许棠又去了邮局"] },
  ],
});
/** 第 5 步（第二种的第二步「信不见了」）和第 2 章对不上。 */
const ONE_PROBLEM = JSON.stringify({ problems: [{ point: 5, conflict: true, earlierQuote: "把信寄给了林溪", earlierChapter: 2, reason: "信已经寄走了" }] });

/** 假专员：json:false 写笔记；json:true 回固定内容（可以抛错）。记下每次调用。 */
function fakeReader(reply: string | Error) {
  const calls: { readonly json: boolean; readonly task: string }[] = [];
  const callModel: BrainCallModel = async (messages, options) => {
    calls.push({ json: options.json, task: messages.at(-1)!.content });
    if (!options.json) return "笔记";
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { callModel, calls, notes: () => calls.filter((call) => !call.json).length, asks: () => calls.filter((call) => call.json) };
}

function useRecipe(deps: Partial<PlanProposeDeps> = {}) {
  const planner = fakeReader(OPTIONS_JSON);
  const reader = fakeReader(ONE_PROBLEM);
  registerRecipe(createPlanProposeRecipe({ plannerCallModel: planner.callModel, readerCallModel: reader.callModel, modelProblem: () => undefined, ...deps }));
  return { planner, reader };
}

let keySeq = 0;
const submit = (params: Record<string, unknown>) => submitOperation(book, {
  kind: PLAN_PROPOSE_KIND,
  params,
  requestKey: `plan-${(keySeq += 1)}`,
  issuedAt: new Date().toISOString(),
  origin: { kind: "button" },
});

async function settled(params: Record<string, unknown>): Promise<OperationRecord> {
  const outcome = await submit(params);
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  await __drainOperationsForTests();
  const stored = await readOperation(book, outcome.record.opId);
  if (stored.kind !== "record") throw new Error("记录没了");
  return stored.record;
}

const bodyOf = (record: OperationRecord): PlanProposeBody => (record.result as { readonly body: PlanProposeBody }).body;

describe("参数", () => {
  it("想法去空白、截长；已给过的走法名去空、去重、截长；章号不对不收", () => {
    expect(readPlanProposeParams({ chapter: 3, idea: `  ${"想".repeat(600)} `, avoid: [" 甲 ", "甲", "", 7, "乙".repeat(50)] })).toEqual({
      chapter: 3,
      idea: "想".repeat(500),
      avoid: ["甲", "乙".repeat(40)],
    });
    expect(readPlanProposeParams({ chapter: 3, idea: "  ", avoid: [] })).toEqual({ chapter: 3 });
    for (const chapter of [0, -1, 2.5, "3", undefined]) expect(readPlanProposeParams({ chapter })).toBeUndefined();
  });
});

describe("受理前挡下没法做的", () => {
  it("章号不对、导入的书还在通读记账、模型没配好都不受理（不留记录，不调模型）", async () => {
    const { planner } = useRecipe({ modelProblem: (_models, task) => (task === "qualityCheck" ? "「核账」还没配模型" : undefined) });
    expect(await submit({ chapter: 0 })).toMatchObject({ ok: false, code: "bad_params" });
    expect(await submit({ chapter: 3 })).toMatchObject({ ok: false, code: "model_missing", message: "「核账」还没配模型" });
    __resetRecipesForTests();
    useRecipe();
    await seedOperation(book, { kind: REREAD_KIND, params: { total: 5, chapters: [3, 4, 5] } });
    expect(await submit({ chapter: 3 })).toMatchObject({ ok: false, code: "rereading" });
    expect((await listOperations(book)).filter((record) => record.kind !== REREAD_KIND)).toEqual([]);
    expect(planner.calls).toHaveLength(0);
  });
});

describe("想走法", () => {
  it("笔记 → 章纲员出 → 核账员核；结果是走法卡那一份，一句结论说有几种对不上；只读（不落章纲、不进账）", async () => {
    await commit(1, CH1);
    await commit(2, CH2);
    const { planner, reader } = useRecipe();
    // 直接写进去的定稿章没有账单（老书）：先接到新核心上，免得开书那一步的导入算进来。
    expect(await ensureBookOnCore(book)).toMatchObject({ ok: true });
    const basis = (await readTruthBasis(book)).digest;
    const record = await settled({ chapter: 3, idea: "让林溪出场", avoid: ["林溪不来"] });
    expect(record.state).toBe("succeeded");
    const body = bodyOf(record);
    expect(body).toMatchObject({ kind: PLAN_PROPOSE_KIND, ok: true, chapter: 3, idea: "让林溪出场", checked: true });
    expect(body.options.map((option) => option.title)).toEqual(["林溪来信", "抽屉被撬", "去邮局追问"]);
    expect(body.options.map((option) => option.problems.length)).toEqual([0, 1, 0]);
    expect(body.summary).toBe("第 3 章想了 3 种走法，在稿纸上挑。其中 1 种和前文有对不上的地方，卡上标了。");
    expect((record.result as { readonly summary?: string }).summary).toBe(body.summary);
    // 笔记在第一步当场补齐，后两步不再补；章纲员拿到作者的想法和已给过的走法。
    expect(planner.notes()).toBe(2);
    expect(reader.notes()).toBe(2);
    expect(planner.asks()).toHaveLength(1);
    expect(planner.asks()[0]!.task).toContain("【作者这章的方向】让林溪出场");
    expect(planner.asks()[0]!.task).toContain("林溪不来");
    expect(reader.asks()).toHaveLength(1);
    expect((await readdir(join(operationDir(book, record.opId), "steps"))).sort()).toEqual(["check.json", "notes.json", "propose.json"]);
    // 真相（账、设定、正文）一样没动；没落章纲、没写工作稿。
    expect((await readTruthBasis(book)).digest).toBe(basis);
    await expect(readdir(join(book, "drafts"))).rejects.toThrow();
  });

  it("新书第一章：没前文可核，核账员不核，结论不提核账", async () => {
    const { reader } = useRecipe();
    const record = await settled({ chapter: 1 });
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record)).toMatchObject({ checked: false });
    expect(bodyOf(record).summary).toBe("第 1 章想了 3 种走法，在稿纸上挑。");
    expect(reader.calls).toHaveLength(0);
  });

  it("核账员没核成：照给走法，结论如实说没核", async () => {
    await commit(1, CH1);
    useRecipe({ readerCallModel: fakeReader(new Error("服务商超时")).callModel });
    const record = await settled({ chapter: 2 });
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record)).toMatchObject({ checked: false });
    expect(bodyOf(record).checkNote).toContain("服务商超时");
    expect(bodyOf(record).summary).toBe("第 2 章想了 3 种走法，在稿纸上挑。核账员这次没核成，挑之前留意前文。");
  });

  it("章纲员两次都没给出能用的走法：没做成，说原因（不出空卡）", async () => {
    await commit(1, CH1);
    const planner = fakeReader("不是 JSON");
    useRecipe({ plannerCallModel: planner.callModel });
    const record = await settled({ chapter: 2 });
    expect(record.state).toBe("failed");
    expect(record.failure).toMatchObject({ code: "not_proposed" });
    expect(record.failure?.message).toMatch(/^第 2 章的走法没想出来：/u);
    expect(planner.asks()).toHaveLength(2);
    expect(record.result).toBeUndefined();
  });

  it("前文缺得多（超过当场补的）：照冷窗口想，交后台补读，不停下等", async () => {
    for (let chapter = 1; chapter <= 12; chapter += 1) await commit(chapter, `第${chapter}章：许棠又去了一趟邮局。`);
    const requests: ReaderBackfillRequest[] = [];
    setReaderBackfillHandler(async (_bookDir, request) => { requests.push(request); });
    const { planner } = useRecipe();
    const record = await settled({ chapter: 13 });
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record).coldNote).toBeTruthy();
    expect(planner.notes()).toBeLessThanOrEqual(10);
    expect(requests).toEqual([expect.objectContaining({ roles: expect.arrayContaining(["planner"]), upTo: 12 })]);
  });
});
