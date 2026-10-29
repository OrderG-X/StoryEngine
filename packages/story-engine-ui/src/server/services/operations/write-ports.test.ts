// @vitest-environment node
// 写口底座（写作版本 P2a 设计第三节、6.3、6.4）：应用步骤走核心命令带 op + 栅栏、按回执记已应用、崩在提交之后不重写；
// 换不上留稳定号候选；改句记录、字数按键记一次；清理操作时清键；发布步骤按键幂等；写手诊断进操作自己的目录。真项目、真命令。
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSave, readDraft, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { applyAiDraft, type AiDraftOutcome } from "../../lib/ai-draft-write.js";
import { readDraftCandidate, settleDraftCandidate } from "../../lib/draft-candidates.js";
import { readFixLog } from "../../lib/fix-log.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests, operationDir, pruneOperations, readOperation, type OperationRecord } from "../../lib/operations/store.js";
import { readWordStats, WORD_STATS_PATH } from "../../lib/word-stats.js";
import { writeDiagnostics } from "../../writing/diagnostics.js";
import { SETTLED_STATES, untilOperation } from "../../lib/operations/test-helpers.js";
import {
  __resetRecipesForTests,
  cancelOperation,
  reconcileOperations,
  registerRecipe,
  resumeOperation,
  submitOperation,
  type Recipe,
} from "./executor.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("operations-write-ports-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "写口", genre: "悬疑", protagonistName: "林远" }));
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

interface Params {
  readonly body: string;
  readonly fixes: readonly { readonly from: string; readonly to: string }[];
}

/** 一个应用步骤的配方：bundle 冻结开写时的依据和底版号，apply 换上。hooks 给测试在换上前后停住。 */
function applyRecipe(hooks: { beforeApply?: () => Promise<void>; afterApply?: () => Promise<void>; publish?: boolean } = {}) {
  const outcomes: AiDraftOutcome[] = [];
  const recipe: Recipe<Params> = {
    kind: "test.apply",
    version: 1,
    lane: "foreground",
    async prepare(_bookDir, input) {
      return { ok: true, params: input.params as Params, writeScope: { chapters: [1] }, budget: 4 };
    },
    async run(ctx) {
      const bundle = await ctx.step("bundle", ctx.params, async () => ({
        basis: await readTruthBasis(ctx.bookDir),
        baseVersion: (await readDraft(ctx.bookDir, 1))?.version ?? null,
      }));
      const outcome = await ctx.apply("apply", bundle, async () => {
        await hooks.beforeApply?.();
        const written = await applyAiDraft(ctx.bookDir, {
          chapter: 1,
          title: "第一章",
          body: ctx.params.body,
          baseVersion: bundle.baseVersion,
          basis: bundle.basis,
          materials: [],
          source: "draft",
          fixes: ctx.params.fixes,
        });
        outcomes.push(written);
        await hooks.afterApply?.();
        return written;
      });
      if (hooks.publish) await ctx.publish("note", { n: 1 }, async (key) => ({ key }));
      return { schema: "operation-result/1", summary: outcome.applied ? "换上了" : "留成候选", body: outcome };
    },
    stepBudget: () => 2,
    modelTasks: () => [],
  };
  registerRecipe(recipe);
  return outcomes;
}

const submit = (params: Params, key = "chat:m1:1") =>
  submitOperation(book, { kind: "test.apply", params, requestKey: key, issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: key } });

async function accepted(params: Params, key?: string): Promise<string> {
  const outcome = await submit(params, key);
  if (!outcome.ok || !("record" in outcome)) throw new Error(JSON.stringify(outcome));
  return outcome.record.opId;
}

function settled(opId: string, states: readonly string[] = SETTLED_STATES): Promise<OperationRecord> {
  return untilOperation(book, opId, (record) => states.includes(record.state));
}

const statsFile = async (): Promise<{ published?: Record<string, string> }> => JSON.parse(await readFile(join(book, WORD_STATS_PATH), "utf-8"));
const fixFile = async (): Promise<{ schema: string; fixes: unknown[]; published: Record<string, { count: number }> }> =>
  JSON.parse(await readFile(join(book, ".story-engine-ui/continuity-checks/0001.fixes.json"), "utf-8"));

const FIX = { from: "钟没停。", to: "钟停了。" };

describe("应用步骤", () => {
  it("换上：核心回执带这次的号；记进 appliedEffects；字数、改句记录各按键记一次（零条也记）", async () => {
    applyRecipe();
    const opId = await accepted({ body: "钟停了。林远站在门口。", fixes: [] });
    const done = await settled(opId);
    expect(done).toMatchObject({ state: "succeeded", result: { body: { applied: true } } });
    expect(done.applying).toBeUndefined();
    expect(done.appliedEffects).toEqual([expect.objectContaining({ stepId: "apply", command: "draft.applyGenerated", paths: expect.arrayContaining(["drafts/fast/chapter-0001.md"]) })]);
    expect((await readDraft(book, 1))?.body).toBe("钟停了。林远站在门口。");
    expect(Object.keys((await statsFile()).published ?? {})).toEqual([`${opId}:apply`]);
    expect(await fixFile()).toMatchObject({ schema: "fix-log/2", fixes: [], published: { [`${opId}:apply`]: { count: 0 } } });
    expect((await readWordStats(book)).today.ai).toBeGreaterThan(0);
  });

  it("崩在核心提交之后、检查点之前：开书按回执补记已应用；接着做回放回执，不再写一版、字数和改句不重记", async () => {
    const after = deferred();
    const applied = deferred();
    let first = true;
    const outcomes = applyRecipe({
      afterApply: async () => {
        if (!first) return;
        first = false;
        applied.resolve();
        await after.promise;
      },
    });
    const opId = await accepted({ body: "钟停了。林远站在门口。", fixes: [FIX] });
    await applied.promise;
    const versionAfterFirst = (await readDraft(book, 1))?.version;
    // 进程没了：调度表、执行登记清掉，盘上还是 running、「在应用」。
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    await reconcileOperations(book);
    const paused = await readOperation(book, opId);
    expect(paused).toMatchObject({ record: { state: "paused", pauseReason: "interrupted", appliedEffects: [expect.objectContaining({ stepId: "apply" })] } });
    expect(paused.kind === "record" && paused.record.applying).toBeUndefined();
    after.resolve();
    expect(await resumeOperation(book, opId)).toMatchObject({ ok: true });
    expect(await settled(opId)).toMatchObject({ state: "succeeded", appliedEffects: [expect.objectContaining({ stepId: "apply" })] });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({ applied: true });
    expect((await readDraft(book, 1))?.version).toBe(versionAfterFirst);
    expect((await readFixLog(book, 1))).toEqual([FIX]);
    expect(Object.keys((await statsFile()).published ?? {})).toEqual([`${opId}:apply`]);
  });

  it("换上前被取消：栅栏挡住，稿不写、不留候选", async () => {
    const reached = deferred();
    const release = deferred();
    const outcomes = applyRecipe({ beforeApply: async () => { reached.resolve(); await release.promise; } });
    const opId = await accepted({ body: "不该写进去的。", fixes: [] });
    await reached.promise;
    await cancelOperation(book, opId);
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readOperation(book, opId)).toMatchObject({ record: { state: "cancelled" } });
    expect(outcomes).toHaveLength(0);
    expect(await readDraft(book, 1)).toBeUndefined();
    expect(await readdir(join(book, "agents/drafts/candidates")).catch(() => [])).toEqual([]);
  });

  it("写的途中作者存了稿：留稳定号候选（同一次操作同一步永远同号）；作者不要了 → 墓碑，同号再来不复活", async () => {
    const reached = deferred();
    const release = deferred();
    applyRecipe({ beforeApply: async () => { reached.resolve(); await release.promise; } });
    const opId = await accepted({ body: "AI 写的一版。", fixes: [FIX] });
    await reached.promise;
    const author = await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "作者这时写的。", baseVersion: null }, { caller: "author" });
    expect(author.ok).toBe(true);
    release.resolve();
    const done = await settled(opId);
    const body = (done.result as { body: AiDraftOutcome }).body;
    expect(body).toMatchObject({ applied: false, reason: "draft_moved" });
    const id = body.applied ? "" : body.candidateId;
    expect(await readDraftCandidate(book, id)).toMatchObject({ status: "ready", body: "AI 写的一版。", op: { opId, stepId: "apply" } });
    expect(done.appliedEffects ?? []).toEqual([]);
    expect(await readFixLog(book, 1)).toEqual([]);
    expect((await readDraft(book, 1))?.body).toBe("作者这时写的。");

    await settleDraftCandidate(book, id);
    expect(await readDraftCandidate(book, id)).toMatchObject({ status: "handled", body: "" });
    // 同一次操作同一步再换一次（模拟恢复后整步重做）：不复活。
    const { keepOperationCandidateLocked } = await import("../../lib/draft-candidates.js");
    expect(await keepOperationCandidateLocked(book, {
      chapter: 1, title: "第1章", body: "AI 写的一版。", baseVersion: null, basisDigest: "d", source: "draft", reason: "draft_moved", op: { opId, stepId: "apply" },
    })).toEqual({ kind: "handled", id });
    expect(await readDraftCandidate(book, id)).toMatchObject({ status: "handled", body: "" });
  });
});

describe("发布步骤、清理", () => {
  it("发布步骤拿到这次的键、输出落检查点；清理过期的操作时清掉它的字数、改句键和候选墓碑", async () => {
    applyRecipe({ publish: true });
    const opId = await accepted({ body: "钟停了。", fixes: [FIX] });
    expect(await settled(opId)).toMatchObject({ state: "succeeded" });
    const note = JSON.parse(await readFile(join(operationDir(book, opId), "steps", "note.json"), "utf-8"));
    expect(note).toMatchObject({ output: { key: `${opId}:note` } });
    expect(Object.keys((await fixFile()).published)).toEqual([`${opId}:apply`]);

    const { clearCandidateTombstones } = await import("../../lib/draft-candidates.js");
    const { clearFixLogKeys } = await import("../../lib/fix-log.js");
    const { clearWordStatsKeys } = await import("../../lib/word-stats.js");
    const later = new Date(Date.now() + 400 * 24 * 3600 * 1000);
    const cleared = await pruneOperations(book, () => "换上了", later, async (id) => {
      await clearFixLogKeys(book, id);
      await clearWordStatsKeys(book, id);
      await clearCandidateTombstones(book, id);
    });
    expect(cleared.cleared).toEqual([opId]);
    expect((await fixFile()).published).toEqual({});
    expect((await fixFile()).fixes).toEqual([FIX]);
    expect((await statsFile()).published ?? {}).toEqual({});
  });
});

describe("写手诊断", () => {
  it("在操作里写进这次操作自己的 artifacts/，不写书里的 diagnostics/", async () => {
    const paths: string[] = [];
    registerRecipe<Record<string, never>>({
      kind: "test.diag",
      version: 1,
      lane: "foreground",
      async prepare() {
        return { ok: true, params: {}, writeScope: { chapters: [] }, budget: 1 };
      },
      async run(ctx) {
        const record = await ctx.step("write:1", {}, async () => (await writeDiagnostics(ctx.bookDir, { stage: "fast-draft", chapter: 1, generatedAt: new Date().toISOString() } as never)).diagnosticsPath);
        paths.push(record ?? "");
        return { schema: "operation-result/1", summary: "写好了" };
      },
      stepBudget: () => 1,
      modelTasks: () => [],
    });
    const outcome = await submitOperation(book, { kind: "test.diag", params: {}, requestKey: "chat:d:1", issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: "d" } });
    if (!outcome.ok || !("record" in outcome)) throw new Error("没受理");
    expect(await settled(outcome.record.opId)).toMatchObject({ state: "succeeded" });
    expect(paths[0]).toBe(join(operationDir(book, outcome.record.opId), "artifacts", "diagnostics", "fast-draft-chapter-0001.json"));
    expect(await readdir(join(book, "diagnostics")).catch(() => [])).toEqual([]);
  });
});
