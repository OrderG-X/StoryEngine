// @vitest-environment node
// 执行器：受理即跑、步骤检查点、取消、纪元、开书对账、接着做、订阅（写作版本 P2a 设计第六节）。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookEpochWrite } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { beforeSend, listAttempts } from "../../lib/operations/attempts.js";
import { __resetExecutionsForTests, currentOperation } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests, operationDir, readOperation, type OperationRecord } from "../../lib/operations/store.js";
import {
  __resetRecipesForTests,
  cancelOperation,
  reconcileOperations,
  registerRecipe,
  resumeOperation,
  submitOperation,
  subscribeOperation,
  type OperationEvent,
  type Recipe,
} from "./executor.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("operations-executor-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "执行器", genre: "悬疑", protagonistName: "林远" }));
});
afterEach(async () => {
  __resetRecipesForTests();
  await rm(root, { recursive: true, force: true });
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

/** 两步的配方：a、b 各记一次调用；hold 给了就在 b 里等它。 */
function twoSteps(options: { readonly hold?: Promise<void>; readonly autoResume?: boolean; readonly failInB?: string; readonly sendInB?: boolean } = {}) {
  const calls = { a: 0, b: 0 };
  const recipe: Recipe<{ readonly n: number }> = {
    kind: "test.two",
    version: 1,
    lane: "foreground",
    ...(options.autoResume ? { autoResume: true } : {}),
    async prepare(_bookDir, input) {
      return { ok: true, params: input.params as { n: number }, writeScope: { chapters: [] }, budget: 4 };
    },
    async run(ctx) {
      const a = await ctx.step("a", { n: ctx.params.n }, async () => {
        calls.a += 1;
        return { doubled: ctx.params.n * 2 };
      });
      const b = await ctx.step("b", { a }, async () => {
        calls.b += 1;
        if (options.sendInB) await beforeSend(currentOperation()!, { provider: "测试", model: "m", quotaGroup: "g" });
        if (options.hold) await options.hold;
        if (options.failInB) throw new Error(options.failInB);
        return { plus: a.doubled + 1 };
      });
      return { schema: "operation-result/1", summary: `算好了：${b.plus}`, body: b };
    },
    stepBudget: () => 2,
  };
  registerRecipe(recipe);
  return calls;
}

const submit = (key = "chat:m1:1", params: unknown = { n: 3 }) =>
  submitOperation(book, { kind: "test.two", params, requestKey: key, issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: key } });

async function settled(opId: string, states: readonly string[] = ["succeeded", "failed", "cancelled", "obsolete", "paused"]): Promise<OperationRecord> {
  for (let i = 0; i < 200; i += 1) {
    const stored = await readOperation(book, opId);
    if (stored.kind === "record" && states.includes(stored.record.state)) return stored.record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("没等到操作结束");
}

describe("受理即跑", () => {
  it("新受理的在后台跑完：succeeded、带结果；每步落检查点；同键重送回原操作、不再跑", async () => {
    const calls = twoSteps();
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error(JSON.stringify(first));
    expect(first).toMatchObject({ existing: false, record: { state: "queued", budget: { limit: 4 } } });
    const done = await settled(first.record.opId);
    expect(done).toMatchObject({ state: "succeeded", runEpoch: 1, result: { schema: "operation-result/1", summary: "算好了：7", body: { plus: 7 } } });
    expect(done.currentStep).toBeUndefined();
    expect((await readdir(join(operationDir(book, first.record.opId), "steps"))).sort()).toEqual(["a.json", "b.json"]);
    expect(await submit()).toMatchObject({ ok: true, existing: true });
    expect(calls).toEqual({ a: 1, b: 1 });
  });

  it("配方出错：failed、一句原因", async () => {
    twoSteps({ failInB: "专员没回话" });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    expect(await settled(first.record.opId)).toMatchObject({ state: "failed", failure: { code: "recipe_failed", message: "专员没回话", retryable: true } });
  });
});

describe("取消", () => {
  it("跑到一半取消：记 cancelled、runEpoch + 1；那一步的输出不落检查点，之后不改回成功", async () => {
    const hold = deferred();
    twoSteps({ hold: hold.promise });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await settled(first.record.opId, ["running"]);
    for (let i = 0; i < 100 && (await readOperation(book, first.record.opId)).kind === "record"; i += 1) {
      const stored = await readOperation(book, first.record.opId);
      if (stored.kind === "record" && stored.record.currentStep === "b") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await cancelOperation(book, first.record.opId)).toMatchObject({ state: "cancelled", runEpoch: 2 });
    hold.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stored = await readOperation(book, first.record.opId);
    expect(stored).toMatchObject({ record: { state: "cancelled", runEpoch: 2 } });
    expect(await readdir(join(operationDir(book, first.record.opId), "steps"))).toEqual(["a.json"]);
  });
});

describe("纪元", () => {
  it("跑的途中书被整本恢复（纪元换了）：结果作废（obsolete），不记成功", async () => {
    const hold = deferred();
    twoSteps({ hold: hold.promise });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await settled(first.record.opId, ["running"]);
    await mkdir(join(book, "store-control"), { recursive: true });
    await writeFile(join(book, "store-control/epoch.json"), bookEpochWrite(new Date()).content);
    hold.resolve();
    expect(await settled(first.record.opId)).toMatchObject({ state: "obsolete", failure: { code: "book_epoch_changed" } });
  });
});

describe("开书对账、接着做", () => {
  /** 模拟进程没了：调度表、执行登记清掉（盘上的记录还是 running）。 */
  function processDied(): void {
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
  }

  it("上一个进程跑到一半：标 paused:interrupted；接着做从停下那步做，做完的步骤零调用，额度加那一步的", async () => {
    const hold = deferred();
    const calls = twoSteps({ hold: hold.promise });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await settled(first.record.opId, ["running"]);
    for (let i = 0; i < 100; i += 1) {
      const stored = await readOperation(book, first.record.opId);
      if (stored.kind === "record" && stored.record.currentStep === "b") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    processDied();
    expect(await reconcileOperations(book)).toEqual({ resumed: [] });
    expect(await readOperation(book, first.record.opId)).toMatchObject({ record: { state: "paused", pauseReason: "interrupted", runEpoch: 2, currentStep: "b" } });
    hold.resolve();
    expect(await resumeOperation(book, first.record.opId)).toMatchObject({ ok: true, record: { state: "running", runEpoch: 3, budget: { limit: 6 } } });
    expect(await settled(first.record.opId)).toMatchObject({ state: "succeeded" });
    expect(calls).toEqual({ a: 1, b: 2 });
  });

  it("有发出去没结算的请求：标 paused:attempt_unknown、那次记成结果不明；接着做时记成作者处理过、不再拦", async () => {
    const hold = deferred();
    twoSteps({ hold: hold.promise, sendInB: true });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    for (let i = 0; i < 200 && (await listAttempts(book, first.record.opId)).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    processDied();
    await reconcileOperations(book);
    const paused = await readOperation(book, first.record.opId);
    expect(paused).toMatchObject({ record: { state: "paused", pauseReason: "attempt_unknown" } });
    const [attempt] = await listAttempts(book, first.record.opId);
    expect(attempt).toMatchObject({ state: "settled", class: "unknown", note: "process_exit" });
    hold.resolve();
    expect(await resumeOperation(book, first.record.opId)).toMatchObject({ ok: true, record: { settledUnknowns: [attempt!.attemptId] } });
    expect(await settled(first.record.opId)).toMatchObject({ state: "succeeded" });
    processDied();
    await reconcileOperations(book);
    expect(await readOperation(book, first.record.opId)).toMatchObject({ record: { state: "succeeded" } });
  });

  it("后台配方登记了自动续：开书时接着跑", async () => {
    const hold = deferred();
    twoSteps({ hold: hold.promise, autoResume: true });
    const first = await submit("background:b1");
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await settled(first.record.opId, ["running"]);
    processDied();
    hold.resolve();
    expect(await reconcileOperations(book)).toEqual({ resumed: [first.record.opId] });
    expect(await settled(first.record.opId)).toMatchObject({ state: "succeeded" });
  });

  it("本进程刚受理、还在跑的：开书对账不碰", async () => {
    const hold = deferred();
    twoSteps({ hold: hold.promise });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await reconcileOperations(book);
    expect((await readOperation(book, first.record.opId))).toMatchObject({ record: { state: expect.stringMatching(/queued|running/u) } });
    hold.resolve();
    expect(await settled(first.record.opId)).toMatchObject({ state: "succeeded" });
  });

  it("配方版本对不上：obsolete", async () => {
    twoSteps({ hold: new Promise(() => undefined) });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await settled(first.record.opId, ["running"]);
    processDied();
    __resetRecipesForTests();
    registerRecipe({ ...({} as Recipe), kind: "test.two", version: 2, lane: "foreground", prepare: async () => ({ ok: false, code: "x", message: "x" }), run: async () => ({ schema: "operation-result/1", summary: "" }), stepBudget: () => 0 });
    await reconcileOperations(book);
    expect(await readOperation(book, first.record.opId)).toMatchObject({ record: { state: "obsolete", failure: { code: "recipe_changed" } } });
  });
});

describe("订阅", () => {
  it("先发快照、再按序发之后的记录；不重复、读快照和挂监听之间结束的也收得到终态", async () => {
    const hold = deferred();
    twoSteps({ hold: hold.promise });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    const events: OperationEvent[] = [];
    const off = await subscribeOperation(book, first.record.opId, (event) => events.push(event));
    hold.resolve();
    await settled(first.record.opId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    off?.();
    expect(events[0]?.type).toBe("snapshot");
    const seqs = events.filter((event) => event.type !== "live").map((event) => (event as { record: OperationRecord }).record.eventSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const last = events.filter((event) => event.type === "record").at(-1) as { record: OperationRecord } | undefined;
    expect(last?.record.state).toBe("succeeded");
    expect(events.some((event) => event.type === "live" && event.event.type === "step")).toBe(true);
  });

  it("记录不在：返回 undefined", async () => {
    expect(await subscribeOperation(book, "op-none", () => undefined)).toBeUndefined();
  });
});
