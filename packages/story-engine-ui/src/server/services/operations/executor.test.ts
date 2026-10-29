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
import { SETTLED_STATES, untilOperation } from "../../lib/operations/test-helpers.js";
import {
  __resetRecipesForTests,
  cancelOperation,
  OperationObsolete,
  reconcileOperations,
  recipeFor,
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
function twoSteps(options: { readonly hold?: Promise<void>; readonly autoResume?: boolean; readonly failInB?: string; readonly sendInB?: boolean; readonly inB?: () => void } = {}) {
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
        options.inB?.();
        if (options.hold) await options.hold;
        if (options.failInB) throw new Error(options.failInB);
        return { plus: a.doubled + 1 };
      });
      return { schema: "operation-result/1", summary: `算好了：${b.plus}`, body: b };
    },
    stepBudget: () => 2,
    modelTasks: () => [],
  };
  registerRecipe(recipe);
  return calls;
}

const submit = (key = "chat:m1:1", params: unknown = { n: 3 }) =>
  submitOperation(book, { kind: "test.two", params, requestKey: key, issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: key } });

function settled(opId: string, states: readonly string[] = SETTLED_STATES): Promise<OperationRecord> {
  return untilOperation(book, opId, (record) => states.includes(record.state));
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
    await untilOperation(book, first.record.opId, (record) => record.state === "running" && record.currentStep === "b");
    expect(await cancelOperation(book, first.record.opId)).toMatchObject({ cancelled: true, record: { state: "cancelled", runEpoch: 2 } });
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
  /** 模拟进程没了：调度表、执行登记清掉（盘上的记录还是 running）。得等配方停在 b 里再「死」：不然还活着的执行再写一笔记录，又登记回调度表。 */
  function processDied(): void {
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
  }

  it("上一个进程跑到一半：标 paused:interrupted；接着做从停下那步做，做完的步骤零调用，额度加那一步的", async () => {
    const hold = deferred();
    const inB = deferred();
    const calls = twoSteps({ hold: hold.promise, inB: inB.resolve });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await inB.promise;
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
    const inB = deferred();
    twoSteps({ hold: hold.promise, autoResume: true, inB: inB.resolve });
    const first = await submit("background:b1");
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await inB.promise;
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
    const inB = deferred();
    twoSteps({ hold: new Promise(() => undefined), inB: inB.resolve });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await inB.promise;
    processDied();
    __resetRecipesForTests();
    registerRecipe({ ...({} as Recipe), kind: "test.two", version: 2, lane: "foreground", prepare: async () => ({ ok: false, code: "x", message: "x" }), run: async () => ({ schema: "operation-result/1", summary: "" }), stepBudget: () => 0 });
    await reconcileOperations(book);
    expect(await readOperation(book, first.record.opId)).toMatchObject({ record: { state: "obsolete", failure: { code: "recipe_changed" } } });
  });
});

describe("配方换过版本（Astra P2a 第 10 轮第 5 条）", () => {
  async function pausedUnderV1(): Promise<string> {
    const inB = deferred();
    twoSteps({ hold: new Promise(() => undefined), inB: inB.resolve });
    const first = await submit();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await inB.promise;
    // 当上一个进程没了。
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    await reconcileOperations(book);
    expect(await readOperation(book, first.record.opId)).toMatchObject({ record: { state: "paused", recipeVersion: 1 } });
    __resetRecipesForTests();
    twoSteps();
    registerRecipe({ ...(recipeFor("test.two") as Recipe), version: 2 });
    return first.record.opId;
  }

  it("停着的旧版本：开书对账就作废，卡上不再给「接着做」", async () => {
    const opId = await pausedUnderV1();
    await reconcileOperations(book);
    expect(await readOperation(book, opId)).toMatchObject({ record: { state: "obsolete", failure: { code: "recipe_changed" } } });
  });

  it("手动「接着做」：不拿新步骤解释旧检查点，作废、如实说要重新来", async () => {
    const opId = await pausedUnderV1();
    await expect(resumeOperation(book, opId)).resolves.toMatchObject({ ok: false, code: "obsolete" });
    expect(await readOperation(book, opId)).toMatchObject({ record: { state: "obsolete", failure: { code: "recipe_changed" } } });
  });
});

describe("等作者点按钮（设计 6.6）", () => {
  /** 改一版 → 等作者（换上 / 再改一版）→ 换上；再改一版就改下一版再等。chapters 给了就占那几章的写位。 */
  function confirmRecipe(chapters: readonly number[] = [3]) {
    const calls = { revise: 0, apply: 0 };
    registerRecipe<{ readonly n: number }>({
      kind: "test.confirm",
      version: 1,
      lane: "foreground",
      async prepare(_bookDir, input) {
        return { ok: true, params: input.params as { n: number }, writeScope: { chapters: [...chapters] }, budget: 2 };
      },
      async run(ctx) {
        for (let round = 1; ; round += 1) {
          const draft = await ctx.step(`revise:${round}`, { round }, async () => {
            calls.revise += 1;
            return `第 ${round} 版`;
          });
          const { decision } = await ctx.waitForAuthor({ actionId: `confirm:${round}`, kind: "revise_confirm", decisions: ["apply", "again"], preview: { after: draft } });
          if (decision === "again") continue;
          if (ctx.params.n < 0) throw new OperationObsolete("draft_moved", "稿子在这期间改过，没换上。");
          await ctx.apply("apply", { draft }, async () => {
            calls.apply += 1;
          });
          return { schema: "operation-result/1", summary: `换上了${draft}` };
        }
      },
      stepBudget: () => 1,
      modelTasks: () => [],
    });
    return calls;
  }

  const submitConfirm = async (key = "button:c1", n = 1): Promise<string> => {
    const outcome = await submitOperation(book, { kind: "test.confirm", params: { n }, requestKey: key, issuedAt: new Date().toISOString(), origin: { kind: "button", messageId: key } });
    if (!outcome.ok || !("record" in outcome)) throw new Error(JSON.stringify(outcome));
    return outcome.record.opId;
  };
  const waiting = (opId: string) => untilOperation(book, opId, (record) => [...SETTLED_STATES, "waiting_author"].includes(record.state));

  it("走到等作者：停在 waiting_author、记下按钮和要给作者看的、不占写位；点了「换上」从头接着跑、前面的步骤零调用", async () => {
    const calls = confirmRecipe();
    const opId = await submitConfirm();
    const parked = await waiting(opId);
    expect(parked).toMatchObject({ state: "waiting_author", runEpoch: 2, pendingActions: [{ actionId: "confirm:1", kind: "revise_confirm", decisions: ["apply", "again"], preview: { after: "第 1 版" } }] });
    // 等作者时不占写位：同一章能另交一次。
    const other = await submitConfirm("button:c2");
    expect(await waiting(other)).toMatchObject({ state: "waiting_author" });
    await cancelOperation(book, other);

    await expect(resumeOperation(book, opId, { actionId: "confirm:1", decision: "apply" })).resolves.toMatchObject({ ok: true });
    expect(await settled(opId)).toMatchObject({ state: "succeeded", result: { summary: "换上了第 1 版" } });
    expect(calls).toEqual({ revise: 2, apply: 1 }); // 第 1 版只改了一次（另一次是被停掉的那个操作改的）
  });

  it("「再改一版」：改下一版、再等；同一个按钮再点同一个决定回放、点别的 decision_conflict；不在待办里的按钮 unknown_action", async () => {
    confirmRecipe();
    const opId = await submitConfirm();
    await waiting(opId);
    await resumeOperation(book, opId, { actionId: "confirm:1", decision: "again" });
    const second = await untilOperation(book, opId, (record) => record.state === "waiting_author" && record.pendingActions.some((action) => action.actionId === "confirm:2"));
    expect(second.pendingActions.map((action) => [action.actionId, action.decisionHash !== undefined])).toEqual([["confirm:1", true], ["confirm:2", false]]);
    await expect(resumeOperation(book, opId, { actionId: "confirm:1", decision: "again" })).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(resumeOperation(book, opId, { actionId: "confirm:1", decision: "apply" })).resolves.toMatchObject({ ok: false, code: "decision_conflict" });
    await expect(resumeOperation(book, opId, { actionId: "confirm:9", decision: "apply" })).resolves.toMatchObject({ ok: false, code: "unknown_action" });
    await expect(resumeOperation(book, opId, { actionId: "confirm:2", decision: "discard" })).resolves.toMatchObject({ ok: false, code: "bad_decision" });
    await expect(resumeOperation(book, opId)).resolves.toMatchObject({ ok: false, code: "unknown_action" });
    await resumeOperation(book, opId, { actionId: "confirm:2", decision: "apply" });
    expect(await settled(opId)).toMatchObject({ state: "succeeded", result: { summary: "换上了第 2 版" } });
  });

  it("划掉几处（定论卡那种）：只认卡上有的键，配方拿到排好的划法；同一个按钮换划法 decision_conflict、同一划法回放", async () => {
    const seen: (readonly string[])[] = [];
    registerRecipe<Record<string, never>>({
      kind: "test.strike",
      version: 1,
      lane: "foreground",
      async prepare(_bookDir, input) {
        return { ok: true, params: input.params as Record<string, never>, writeScope: { chapters: [] }, budget: 0 };
      },
      async run(ctx) {
        const { decision, excluded } = await ctx.waitForAuthor({ actionId: "confirm", kind: "settle_confirm", decisions: ["apply"], preview: { edits: 3 }, excludable: ["e1", "e2", "e3"] });
        seen.push(excluded);
        return { schema: "operation-result/1", summary: `${decision}：划掉 ${excluded.join("、") || "没有"}` };
      },
      stepBudget: () => 0,
      modelTasks: () => [],
    });
    const outcome = await submitOperation(book, { kind: "test.strike", params: {}, requestKey: "button:s1", issuedAt: new Date().toISOString(), origin: { kind: "button", messageId: "s1" } });
    if (!outcome.ok || !("record" in outcome)) throw new Error(JSON.stringify(outcome));
    const opId = outcome.record.opId;
    expect(await waiting(opId)).toMatchObject({ pendingActions: [{ actionId: "confirm", excludable: ["e1", "e2", "e3"] }] });
    await expect(resumeOperation(book, opId, { actionId: "confirm", decision: "apply", excluded: ["e9"] })).resolves.toMatchObject({ ok: false, code: "bad_decision" });
    await expect(resumeOperation(book, opId, { actionId: "confirm", decision: "apply", excluded: ["e3", "e1", "e3"] })).resolves.toMatchObject({ ok: true });
    expect(await settled(opId)).toMatchObject({ state: "succeeded", result: { summary: "apply：划掉 e1、e3" } });
    expect(seen).toEqual([["e1", "e3"]]);
    await expect(resumeOperation(book, opId, { actionId: "confirm", decision: "apply", excluded: ["e1", "e3"] })).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(resumeOperation(book, opId, { actionId: "confirm", decision: "apply" })).resolves.toMatchObject({ ok: false, code: "decision_conflict" });
  });

  it("点了以后这一章被别的占着：target_busy，决定不落、还在等；配方核不过底版抛 OperationObsolete → obsolete、说哪样变了", async () => {
    confirmRecipe();
    const opId = await submitConfirm("button:c1", -1);
    await waiting(opId);
    const hold = deferred();
    twoSteps({ hold: hold.promise });
    registerRecipe({ ...(recipeFor("test.two") as Recipe), prepare: async (_bookDir, input) => ({ ok: true, params: input.params, writeScope: { chapters: [3] }, budget: 4 }) });
    const busy = await submit("chat:busy");
    if (!busy.ok || !("record" in busy)) throw new Error("没受理");
    await expect(resumeOperation(book, opId, { actionId: "confirm:1", decision: "apply" })).resolves.toMatchObject({ ok: false, code: "target_busy" });
    expect(await readOperation(book, opId)).toMatchObject({ record: { state: "waiting_author", pendingActions: [{ actionId: "confirm:1" }] } });
    expect((await readOperation(book, opId) as { record: OperationRecord }).record.pendingActions[0]!.decisionHash).toBeUndefined();
    hold.resolve();
    await settled(busy.record.opId);
    await resumeOperation(book, opId, { actionId: "confirm:1", decision: "apply" });
    expect(await settled(opId)).toMatchObject({ state: "obsolete", failure: { code: "draft_moved", message: "稿子在这期间改过，没换上。" } });
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
    // 盘上先换成终态、通知在落盘（目录 fsync）之后才发：等通知到，不按固定毫秒猜
    const deadline = Date.now() + 10_000;
    while (!events.some((event) => event.type === "record" && event.record.state === "succeeded") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
