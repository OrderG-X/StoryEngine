// @vitest-environment node
// 对话里交的操作怎么收尾（写作版本 P2a 契约第三、四节）：run_check 只回受理回执；服务端订阅、把记录转进对话、按结构化结果出结论和下一步；
// 作者断开只是不再转发；按钮交的新操作、「接着做」「不要了」走同一套；read_operation、每轮开头的「最近的操作」只读记录。
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { draftSave, parseDraftFile, readDraftState, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../lib/operations/context.js";
import { __resetLiveForTests } from "../lib/operations/live.js";
import { __resetOperationStoreForTests, changeOperation, readOperation, type OperationRecord } from "../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, submitOperation, type OperationResult, type Recipe } from "../services/operations/executor.js";
import { INSPECT_KIND } from "../services/operations/recipes/inspect-run.js";
import { buildOperationSummary, operationSummaryText } from "../services/operations/summary.js";
import { finishOperationTurn, followOperation, runOperationAction } from "./operation-turn.js";
import { buildProjectRequestContext } from "./request-context.js";
import { runCheckTool, type SubmitReceipt } from "./tools/op-tools.js";
import { readOperationTool, type ReadOperationOutput } from "./tools/read-operation.js";
import { checkChapterAction, type OperationAction } from "./user-actions.js";
import { newDraftAction } from "./next-steps.js";
import { createDraftChangeRecipe } from "../services/operations/recipes/draft-change.js";
import { fakeDraftDeps, writerOf } from "../services/operations/recipes/draft-change-kit.js";

let root: string;
let book: string;
const previousDataDir = process.env.SE_DATA_DIR;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("operation-turn-");
  process.env.SE_DATA_DIR = join(root, "data");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "收尾", genre: "悬疑", protagonistName: "林舟" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  if (previousDataDir === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

/** 假的检查配方（不调模型）：result 给了就照它收，fail 给了就抛，hold 给了就在步骤里等。 */
function fakeInspect(options: { readonly result?: OperationResult; readonly fail?: string; readonly hold?: Promise<void> } = {}) {
  const calls = { run: 0 };
  const recipe: Recipe<{ readonly chapter: number }> = {
    kind: INSPECT_KIND,
    version: 1,
    lane: "foreground",
    async prepare(_bookDir, input) {
      const params = input.params as { chapter: number };
      return { ok: true, params, ...(input.mode !== undefined ? { mode: input.mode } : {}), writeScope: { chapters: [] }, budget: 2 };
    },
    async run(ctx) {
      calls.run += 1;
      await ctx.step("check", { chapter: ctx.params.chapter }, async () => {
        if (options.hold) await options.hold;
        if (options.fail) throw new Error(options.fail);
        return { done: true };
      });
      return options.result ?? { schema: "operation-result/1", summary: "核好了。" };
    },
    stepBudget: () => 1,
    modelTasks: () => [],
  };
  registerRecipe(recipe);
  return calls;
}

const CLEAN: OperationResult = { schema: "operation-result/1", summary: "第 1 章没核出对不上的。", body: { ok: true, sure: [], headline: "第 1 章前后对得上。" } };

function collector() {
  const events: { readonly event: string; readonly data: unknown }[] = [];
  return {
    events,
    sendEvent: (event: string, data: unknown) => { events.push({ event, data }); },
    text: () => events.filter((item) => item.event === "text-delta").map((item) => (item.data as { text: string }).text).join(""),
    choices: () => events
      .filter((item) => item.event === "tool-result" && (item.data as { toolName?: string }).toolName === "suggest_next_steps")
      .flatMap((item) => ((item.data as { output: { choices: { label: string; action?: unknown }[] } }).output.choices)),
    operationStates: () => events
      .filter((item) => item.event === "operation" && (item.data as { operation?: unknown }).operation)
      .map((item) => (item.data as { operation: { state: string } }).operation.state),
  };
}

const scrubber = () => ({ push: (text: string) => text, flush: () => "" });

let seq = 0;
async function submitted(mode = "continuity", chapter = 1): Promise<OperationRecord> {
  seq += 1;
  const outcome = await submitOperation(book, {
    kind: INSPECT_KIND,
    mode,
    params: { chapter },
    requestKey: `chat:m${seq}`,
    issuedAt: new Date().toISOString(),
    origin: { kind: "chat", messageId: `m${seq}`, chapter },
  });
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  return outcome.record;
}

async function stored(opId: string): Promise<OperationRecord> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record;
}

describe("订阅、转发、收尾", () => {
  it("对话交的核账做完：先发一份当前记录、再发之后的，到做完为止；结论按结果出，下一步推荐「预览定稿」", async () => {
    const gate = deferred();
    fakeInspect({ result: CLEAN, hold: gate.promise });
    const record = await submitted();
    const out = collector();
    const following = followOperation({ bookDir: book, opId: record.opId, sendEvent: out.sendEvent, signal: new AbortController().signal });
    gate.resolve();
    const last = await following;
    expect(last?.state).toBe("succeeded");
    expect(out.events[0]).toMatchObject({ event: "operation", data: { type: "snapshot" } });
    expect(out.operationStates().at(-1)).toBe("succeeded");

    await finishOperationTurn({ record: last!, projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber() });
    expect(out.text()).toBe("第 1 章前后对得上。");
    expect(out.choices().map((choice) => choice.label)).toEqual(["预览定稿", expect.any(String)]);
  });

  it("作者断开了：不再转发、马上返回；操作照跑完", async () => {
    const gate = deferred();
    const calls = fakeInspect({ result: CLEAN, hold: gate.promise });
    const record = await submitted();
    const out = collector();
    const disconnect = new AbortController();
    const following = followOperation({ bookDir: book, opId: record.opId, sendEvent: out.sendEvent, signal: disconnect.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    disconnect.abort();
    const last = await following;
    expect(last?.state === "succeeded").toBe(false);
    const sent = out.events.length;
    gate.resolve();
    await __drainOperationsForTests();
    expect((await stored(record.opId)).state).toBe("succeeded");
    expect(out.events.length).toBe(sent);
    expect(calls.run).toBe(1);
  });

  it("没做成：说原因，给「再来一次」（交一次新的同样检查）", async () => {
    fakeInspect({ fail: "模型没回话" });
    const record = await submitted("review", 1);
    await __drainOperationsForTests();
    const failed = await stored(record.opId);
    expect(failed.state).toBe("failed");
    const out = collector();
    await finishOperationTurn({ record: failed, projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber() });
    expect(out.text()).toBe("内容审阅·第 1 章没做成：模型没回话");
    const [again] = out.choices();
    expect(again).toMatchObject({ label: "再来一次", action: { kind: "new", type: INSPECT_KIND, mode: "review", params: { chapter: 1 } } });
  });

  it("核账没核成（结果 ok:false）：只给「再核一遍」和写下一章，不推荐定稿", async () => {
    fakeInspect({ result: { schema: "operation-result/1", summary: "核账员没读完前文。", body: { ok: false, summary: "这次没核成：核账员没读完前文。" } } });
    const record = await submitted();
    await __drainOperationsForTests();
    const out = collector();
    await finishOperationTurn({ record: await stored(record.opId), projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber() });
    expect(out.text()).toBe("这次没核成：核账员没读完前文。");
    expect(out.choices().map((choice) => choice.label)).not.toContain("预览定稿");
    expect(out.choices()[0]).toMatchObject({ label: "再核一遍", action: { kind: "new", mode: "continuity" } });
  });

  it("停着的说为什么停、点卡上的按钮；停掉的说停掉了；还在做的什么都不说", async () => {
    fakeInspect({ result: CLEAN });
    const record = await submitted("quality", 2);
    await __drainOperationsForTests();
    const base = await stored(record.opId);
    const say = async (patch: Partial<OperationRecord>): Promise<string> => {
      const out = collector();
      await finishOperationTurn({ record: { ...base, ...patch } as OperationRecord, projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber() });
      return out.text();
    };
    expect(await say({ state: "paused", pauseReason: "budget" })).toBe("硬伤检查·第 2 章停下了：这次能用的调用次数用完了：点卡上的「接着做」接着，或「不要了」。");
    expect(await say({ state: "cancelled" })).toBe("硬伤检查·第 2 章停掉了。");
    expect(await say({ state: "waiting_author" })).toBe("硬伤检查·第 2 章在等你点卡上的按钮。");
    expect(await say({ state: "running" })).toBe("");
  });
});

describe("查完稿子又改过（Astra P2a 第 10 轮第 4 条）", () => {
  it("结论后面说清是改稿前那一版，核账只给「再核一遍」；read_operation、最近的操作也标；没改过不标", async () => {
    const current = (await readDraftState(book, 1)).version!;
    fakeInspect({ result: { ...CLEAN, body: { ok: true, sure: [], headline: "第 1 章前后对得上。", source: "draft", checkedVersion: "改稿前那一版" } } });
    const record = await submitted();
    await __drainOperationsForTests();
    const out = collector();
    await finishOperationTurn({ record: await stored(record.opId), projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber() });
    expect(out.text()).toBe("第 1 章前后对得上。（这是改稿前那一版的结论：查完之后稿子又改过。）");
    expect(out.choices().map((choice) => choice.label)).toEqual(["再核一遍"]);
    await expect(readOp({ opId: record.opId })).resolves.toMatchObject({ ok: true, draftChanged: true });
    expect(operationSummaryText(await buildOperationSummary(book))).toContain("（查的是改稿前那一版，稿子之后改过）");

    __resetRecipesForTests();
    fakeInspect({ result: { schema: "operation-result/1", summary: "第 1 章硬伤检查：没有硬伤。", body: { source: "draft", checkedVersion: current } } });
    const same = await submitted("quality", 1);
    await __drainOperationsForTests();
    const quiet = collector();
    await finishOperationTurn({ record: await stored(same.opId), projectDir: book, sendEvent: quiet.sendEvent, scrubber: scrubber() });
    expect(quiet.text()).toBe("第 1 章硬伤检查：没有硬伤。");
    await expect(readOp({ opId: same.opId })).resolves.not.toHaveProperty("draftChanged");
  });
});

describe("按钮交的操作", () => {
  const button = (): OperationAction => checkChapterAction(1);

  it("新操作：受理、订阅、收尾；同一个按钮点两次只做一次", async () => {
    const calls = fakeInspect({ result: CLEAN });
    const action = button();
    const first = collector();
    await runOperationAction({ action, projectDir: book, sendEvent: first.sendEvent, scrubber: scrubber(), signal: new AbortController().signal });
    expect(first.text()).toBe("第 1 章前后对得上。");
    const second = collector();
    await runOperationAction({ action, projectDir: book, sendEvent: second.sendEvent, scrubber: scrubber(), signal: new AbortController().signal });
    expect(calls.run).toBe(1);
    expect(second.operationStates()).toEqual(["succeeded"]);
  });

  it("「不要了」：停掉、不再接着做；已经结束的说不用停；「接着做」没停着的如实说", async () => {
    const gate = deferred();
    fakeInspect({ result: CLEAN, hold: gate.promise });
    const record = await submitted();
    const signal = new AbortController().signal;
    const cancel = collector();
    await runOperationAction({ action: { kind: "cancel", opId: record.opId }, projectDir: book, sendEvent: cancel.sendEvent, scrubber: scrubber(), signal });
    expect(cancel.text()).toBe("核账·第 1 章停掉了，不再接着做。");
    gate.resolve();
    await __drainOperationsForTests();
    expect((await stored(record.opId)).state).toBe("cancelled");

    const again = collector();
    await runOperationAction({ action: { kind: "cancel", opId: record.opId }, projectDir: book, sendEvent: again.sendEvent, scrubber: scrubber(), signal });
    expect(again.text()).toBe("核账·第 1 章已经结束了，不用停。");
    const resume = collector();
    await runOperationAction({ action: { kind: "resume", opId: record.opId }, projectDir: book, sendEvent: resume.sendEvent, scrubber: scrubber(), signal });
    expect(resume.text()).toBe("这次没有停着，不用接着做。");
  });

  it("「接着做」：停着的从停下那一步接着跑完，收尾照常", async () => {
    const gate = deferred();
    fakeInspect({ result: CLEAN, hold: gate.promise });
    const record = await submitted();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 当软件关过：记录停着、在跑的那次作废（runEpoch + 1）。
    await changeOperation(book, record.opId, (current) => ({ ...current, state: "paused", pauseReason: "interrupted", runEpoch: current.runEpoch + 1 }));
    gate.resolve();
    await __drainOperationsForTests();
    expect((await stored(record.opId)).state).toBe("paused");
    const out = collector();
    await runOperationAction({ action: { kind: "resume", opId: record.opId }, projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber(), signal: new AbortController().signal });
    expect((await stored(record.opId)).state).toBe("succeeded");
    expect(out.text()).toBe("第 1 章前后对得上。");
  });
});

describe("写稿按钮（draft.change）", () => {
  const prose = Array(6).fill("林舟沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。").join("\n\n");

  it("受理、订阅（正文流转进对话）、收尾：一句结论、工作稿换上", async () => {
    registerRecipe(createDraftChangeRecipe(fakeDraftDeps({
      writer: async ({ onDelta }) => ({
        async generateDraft() {
          onDelta?.("林舟沿着河岸走了很久。");
          return { content: prose };
        },
      }),
    })));
    const out = collector();
    await runOperationAction({ action: newDraftAction("write", { chapter: 1 }), projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber(), signal: new AbortController().signal });
    expect(out.operationStates().at(-1)).toBe("succeeded");
    const live = out.events.filter((item) => item.event === "operation" && (item.data as { type?: string }).type === "live").map((item) => (item.data as { event: { type: string } }).event.type);
    expect(live).toContain("draft-delta");
    expect(out.text()).toContain("第 1 章");
    expect((await readDraftState(book, 1)).version).not.toBeNull();
  });

  it("选中改写：改法摆出来停着等作者；「不要了」说这版不要了、稿子没动", async () => {
    const before = (await readDraftState(book, 1)).version;
    expect(await runCommand(book, draftSave, { chapter: 1, body: "他推开门。", baseVersion: before, title: "" }, { caller: "author" })).toMatchObject({ ok: true });
    registerRecipe(createDraftChangeRecipe(fakeDraftDeps({ fixCallModel: async () => JSON.stringify({ beforeText: "他推开门。", afterText: "他轻轻推开门。", changeSummary: "放轻动作" }) })));
    const signal = new AbortController().signal;
    const out = collector();
    const action: OperationAction = { kind: "new", type: "draft.change", mode: "revise", params: { mode: "revise", chapter: 1, edits: [{ targetText: "他推开门。", revisionGoal: "放轻动作" }], preview: true }, requestKey: "revise-1", issuedAt: new Date().toISOString() };
    await runOperationAction({ action, projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber(), signal });
    expect(out.operationStates().at(-1)).toBe("waiting_author");
    expect(out.text()).toBe("改法在卡上：点「换上」才换进稿子。");
    const opId = (out.events.find((item) => item.event === "operation")!.data as { operation: { opId: string } }).operation.opId;
    const cancel = collector();
    await runOperationAction({ action: { kind: "cancel", opId }, projectDir: book, sendEvent: cancel.sendEvent, scrubber: scrubber(), signal });
    expect(cancel.text()).toBe("改稿·第 1 章：这版不要了，稿子没动。");
    expect(parseDraftFile(await readFile(join(book, "drafts", "fast", "chapter-0001.md"), "utf-8")).body.trim()).toBe("他推开门。");
  });

  it("没受理（前一章没定稿）：照原因说，下一步给「先定稿第 1 章」「仍要先写第 2 章」，不给「再写一次」", async () => {
    registerRecipe(createDraftChangeRecipe(fakeDraftDeps({ writerClient: writerOf(prose) })));
    const out = collector();
    await runOperationAction({ action: newDraftAction("write", { chapter: 2 }), projectDir: book, sendEvent: out.sendEvent, scrubber: scrubber(), signal: new AbortController().signal });
    expect(out.text()).toContain("第 1 章还没定稿");
    expect(out.choices().map((choice) => choice.label)).toEqual(["先定稿第 1 章", "仍要先写第 2 章"]);
    expect(out.choices()[1]?.action).toMatchObject({ type: "draft.change", params: { chapter: 2, allowWriteAhead: true } });
  });
});

function toolContext(messageId?: string): ToolExecutionContext {
  const requestContext = buildProjectRequestContext(book, 1, ["帮我核一下第一章"], undefined, undefined, messageId ? { messageId, issuedAt: new Date().toISOString() } : undefined);
  return { requestContext } as unknown as ToolExecutionContext;
}

const runCheck = (input: Record<string, unknown>, context: ToolExecutionContext) =>
  (runCheckTool as unknown as { execute: (input: unknown, context: ToolExecutionContext) => Promise<SubmitReceipt> }).execute(input, context);
const readOp = (input: Record<string, unknown>) =>
  (readOperationTool as unknown as { execute: (input: unknown, context: ToolExecutionContext) => Promise<ReadOperationOutput> }).execute(input, toolContext());

describe("run_check：只交、只回受理回执", () => {
  it("受理：回操作号和一句「交出去了」；同一条消息再交（同样的、别的）都回原来那次，不另开", async () => {
    const calls = fakeInspect({ result: CLEAN });
    const context = toolContext("msg-1");
    const first = await runCheck({ mode: "continuity" }, context);
    expect(first).toMatchObject({ ok: true, accepted: true, kind: INSPECT_KIND, mode: "continuity", chapter: 1, summary: "交出去了：核账·第 1 章。" });
    const again = await runCheck({ mode: "continuity" }, context);
    expect(again).toMatchObject({ ok: true, accepted: true, existing: true, opId: first.opId, summary: "核账·第 1 章已经交过了，接着看原来那次。" });
    const other = await runCheck({ mode: "review" }, context);
    expect(other).toMatchObject({ ok: true, existing: true, opId: first.opId, mode: "continuity" });
    expect(other.summary).toBe("这条消息已经交过别的事（核账·第 1 章），一条消息只做一件：这件没交，接着看原来那次。");
    await __drainOperationsForTests();
    expect(calls.run).toBe(1);
  });

  it("没带消息号、没有书：不交、如实说", async () => {
    fakeInspect();
    await expect(runCheck({ mode: "quality" }, toolContext())).resolves.toMatchObject({ ok: false, code: "no_message_ref" });
    await expect(runCheck({ mode: "quality" }, { requestContext: undefined } as unknown as ToolExecutionContext)).resolves.toMatchObject({ ok: false, code: "no_book" });
  });

  it("审稿重点不是作者原话：不带上、说清楚，照样交", async () => {
    fakeInspect({ result: CLEAN });
    const receipt = await runCheck({ mode: "review", focus: "重点看人物弧光" }, toolContext("msg-2"));
    expect(receipt).toMatchObject({ ok: true, accepted: true });
    expect(receipt.summary).toContain("审稿重点不是作者原话，这次没带上。");
    const record = await stored(receipt.opId!);
    expect(record.params).toEqual({ chapter: 1 });
  });

  it("模型多传的退化参数（空串、\"False\"）在边界里归一", async () => {
    fakeInspect({ result: CLEAN });
    const receipt = await runCheck({ mode: "continuity", chapter: "", fresh: "False", focus: "" }, toolContext("msg-3"));
    expect(receipt).toMatchObject({ ok: true, chapter: 1 });
    expect((await stored(receipt.opId!)).params).toEqual({ chapter: 1 });
  });
});

describe("read_operation 和每轮开头的「最近的操作」：只读记录", () => {
  it("查得到的给状态和结论；号不对、不给号都如实", async () => {
    fakeInspect({ result: CLEAN });
    const record = await submitted();
    await __drainOperationsForTests();
    await expect(readOp({ opId: record.opId })).resolves.toMatchObject({ ok: true, what: "核账·第 1 章", summary: "核账·第 1 章：第 1 章没核出对不上的。", operation: { state: "succeeded" } });
    await expect(readOp({ opId: "op-不存在" })).resolves.toMatchObject({ ok: false, code: "absent" });
    const recent = await readOp({});
    expect(recent).toMatchObject({ ok: true, recent: { operations: [{ opId: record.opId, stateText: "做完了" }] } });
  });

  it("最近的操作：新的在前，停着的列出作者能点的；没有操作不注", async () => {
    expect(operationSummaryText(await buildOperationSummary(book))).toBeUndefined();
    const gate = deferred();
    fakeInspect({ result: CLEAN, hold: gate.promise });
    const done = await submitted("quality", 1);
    gate.resolve();
    await __drainOperationsForTests();
    const hold = deferred();
    __resetRecipesForTests();
    fakeInspect({ result: CLEAN, hold: hold.promise });
    const paused = await submitted("flavor", 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await changeOperation(book, paused.opId, (current) => ({ ...current, state: "paused", pauseReason: "attempt_unknown", runEpoch: current.runEpoch + 1 }));
    hold.resolve();
    await __drainOperationsForTests();
    const summary = await buildOperationSummary(book);
    expect(summary.operations.map((item) => item.opId)).toEqual([paused.opId, done.opId]);
    expect(summary.operations[0]).toMatchObject({ what: "查 AI 味·第 2 章", allowed: ["resume", "cancel"] });
    const text = operationSummaryText(summary)!;
    expect(text).toContain("查 AI 味·第 2 章，停着：有一步可能已经发出去、结果没收到（可能已经计费）");
    expect(text).toContain("作者可以点「接着做」或「不要了」");
    expect(text).not.toContain("inspect.run");
  });
});
