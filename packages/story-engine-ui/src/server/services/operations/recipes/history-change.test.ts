// @vitest-environment node
/**
 * 撤销 / 整本恢复 / 裁剪操作历史（写作版本 P2a 片 4C，history.change）：
 * - 撤销 = 撤最近一次还没撤的（撤过的跳过；撤销本身也能撤回来）；后来又改过的停下等「全撤」；
 * - 整本恢复只认按钮，恢复换成这次操作自己的纪元（自己的栅栏不挡自己），能撤回来；
 * - 裁剪是作者的决定：对话里交的停下等「确认裁剪」，算好之后历史又动过就作废、一处不动。
 * 真配方、真执行器、真核心写盘、真 git 存档。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardWrite, draftSave, opBookEpoch, readBookEpoch, readDraft, readDraftState, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../../book/project-store.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests, OperationStopped } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, type OperationRecord } from "../../../lib/operations/store.js";
import { SETTLED_STATES, untilOperation } from "../../../lib/operations/test-helpers.js";
import { createSnapshot, listSnapshots } from "../../../lib/snapshot.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation, type Recipe } from "../executor.js";
import { applyAiDraft, type AiDraftInput } from "../../../lib/ai-draft-write.js";
import { applyAiDraftInOperation, restoreInOperation, undoInOperation } from "../test-helpers.js";
import { operationView } from "../view.js";
import { HISTORY_CHANGE_KIND, historyChangeRecipe, PRUNE_CONFIRM_ACTION, PRUNE_CONFIRM_KIND, UNDO_CONFIRM_ACTION, UNDO_CONFIRM_KIND } from "./history-change.js";

const execFileAsync = promisify(execFile);

const hook = vi.hoisted(() => ({
  afterHistoryApply: undefined as undefined | (() => Promise<void>),
  /** 撤销算计划之前（记了「撤哪次」之后）。 */
  beforePlan: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../../../lib/history-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/history-reader.js")>();
  return {
    ...actual,
    withGitHistoryReader: async (...args: Parameters<typeof actual.withGitHistoryReader>) => {
      await hook.beforePlan?.();
      return actual.withGitHistoryReader(...args);
    },
  };
});
vi.mock("../../../lib/operations/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/operations/command.js")>();
  return {
    ...actual,
    runCommandInOperation: async (...args: Parameters<typeof actual.runCommandInOperation>) => {
      const outcome = await actual.runCommandInOperation(...args);
      if (args[1].name === "history.apply") await hook.afterHistoryApply?.();
      return outcome;
    },
  };
});

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  hook.afterHistoryApply = undefined;
  hook.beforePlan = undefined;
  root = await makeHomeTempDir("history-change-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "撤回", genre: "悬疑", protagonistName: "林远" }));
  registerRecipe(historyChangeRecipe);
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const bodyOf = async (chapter: number): Promise<string | undefined> => (await readDraft(book, chapter))?.body;

/** AI 照盘上现在这版写一稿（一次真操作）。 */
async function aiWrites(chapter: number, body: string): Promise<void> {
  const basis = await readTruthBasis(book);
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
  const outcome = await applyAiDraftInOperation(book, { chapter, title: "", body, baseVersion, basis, materials: [], source: "draft" });
  if (!outcome.applied) throw new Error(outcome.message);
}

async function aiInput(chapter: number, body: string): Promise<AiDraftInput> {
  return { chapter, title: "", body, baseVersion: (await readDraft(book, chapter))?.version ?? null, basis: await readTruthBasis(book), materials: [], source: "draft" };
}

/** 一次操作里 AI 换上几章稿（一章一步）。 */
const TWO_DRAFTS_KIND = "test.ai-drafts";
const twoDraftsRecipe: Recipe<readonly AiDraftInput[]> = {
  kind: TWO_DRAFTS_KIND,
  version: 1,
  lane: "foreground",
  async prepare(_bookDir, input) {
    const params = input.params as readonly AiDraftInput[];
    return { ok: true, params, writeScope: { chapters: params.map((item) => item.chapter) }, budget: 0 };
  },
  async run(ctx) {
    for (const item of ctx.params) {
      const apply = () => applyAiDraft(ctx.bookDir, item);
      await ctx.apply(`apply-${item.chapter}`, item, apply, apply);
    }
    return { schema: "operation-result/1", summary: "换上了", body: null };
  },
  stepBudget: () => 0,
  modelTasks: () => [],
};

async function authorSaves(chapter: number, body: string): Promise<void> {
  const { version: baseVersion } = await readDraftState(book, chapter);
  const outcome = await runCommand(book, draftSave, { chapter, title: "", body, baseVersion }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
}

async function submit(mode: "undo" | "restore" | "prune", params: Record<string, unknown>, origin: "chat" | "button"): Promise<OperationRecord> {
  const requestKey = randomUUID();
  const submitted = await submitOperation(book, {
    kind: HISTORY_CHANGE_KIND,
    mode,
    params,
    requestKey,
    issuedAt: new Date().toISOString(),
    origin: origin === "chat" ? { kind: "chat", messageId: requestKey } : { kind: "button", messageId: requestKey },
  });
  if (!submitted.ok || !("record" in submitted)) throw new Error(JSON.stringify(submitted));
  return untilOperation(book, submitted.record.opId, (record) => SETTLED_STATES.includes(record.state) || record.state === "waiting_author");
}

async function answer(record: OperationRecord): Promise<OperationRecord> {
  // 点过的那张还留在记录里（带 decisionHash），点的是还没点的那张。
  const pending = record.pendingActions.find((action) => !action.decisionHash);
  if (!pending) throw new Error("没在等作者");
  const resumed = await resumeOperation(book, record.opId, { actionId: pending.actionId, decision: "apply" });
  if (!resumed.ok) throw new Error(JSON.stringify(resumed));
  return untilOperation(book, record.opId, (item) => item.eventSeq > record.eventSeq && (SETTLED_STATES.includes(item.state) || item.state === "waiting_author"));
}

describe("撤销上一步", () => {
  it("撤最近一次还没撤的：撤过的跳过、一步步往回；撤销本身能撤回来", async () => {
    await aiWrites(1, "第一版。");
    await aiWrites(1, "第二版。");
    const first = await undoInOperation(book);
    expect(first.summary).toContain("撤好了");
    expect(first.body).toMatchObject({ mode: "undo", paths: ["drafts/fast/chapter-0001.md"] });
    expect(await bodyOf(1)).toBe("第一版。");

    await undoInOperation(book);
    expect(await bodyOf(1)).toBeUndefined();

    // 「撤回来」：撤刚才那次撤销 = 第一版又回来了
    const back = await undoInOperation(book, (await undoInOperationLast()).opId);
    expect(back.summary).toBe("撤好了：「撤销」退回去了，第 1 章工作稿回到它之前的样子。");
    expect(await bodyOf(1)).toBe("第一版。");
  });

  it("没有能撤的：如实说，不写", async () => {
    const done = await undoInOperation(book);
    expect(done.summary).toBe("没有能撤的改动了。");
    expect(done.body.paths).toEqual([]);
  });

  it("这次之后作者又改过：停下等「全撤」（卡上说哪几处）；点了才撤，作者后来那笔一起退回", async () => {
    await aiWrites(1, "AI 写的。");
    await authorSaves(1, "作者接着改的。");
    // 作者那笔不是操作写的、没回执：「上一次」还是 AI 那次
    const waiting = await submit("undo", {}, "button");
    expect(waiting.state).toBe("waiting_author");
    expect(waiting.pendingActions[0]).toMatchObject({ actionId: UNDO_CONFIRM_ACTION, kind: UNDO_CONFIRM_KIND, decisions: ["apply"] });
    const preview = operationView(waiting).pendingActions[0]?.preview as { lines: string[]; notes: string[] };
    expect(preview.lines).toEqual(["第 1 章工作稿：这次之后别的改动又改过"]);
    expect(preview.notes[0]).toContain("要撤的是");
    expect(await bodyOf(1)).toBe("作者接着改的。");

    const done = await answer(waiting);
    expect(done.state).toBe("succeeded");
    expect(await bodyOf(1)).toBeUndefined();
  });

  it("AI 那次撤了、作者之后自己又写：再往前找到别章那次，说不准，停下给作者看，点了才撤（Astra 第 13 轮第 1 条）", async () => {
    await aiWrites(9, "第九章。");
    await aiWrites(1, "AI 写的。");
    await undoInOperation(book);
    expect(await bodyOf(1)).toBeUndefined();
    // 撤销删了稿子、换了工作稿纪元：作者重新开这一章，照盘上现在的版本存。
    const saved = await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者自己从头写的。", baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
    expect(saved.ok).toBe(true);
    const waiting = await submit("undo", {}, "chat");
    expect(waiting.state).toBe("waiting_author");
    const preview = operationView(waiting).pendingActions[0]?.preview as { lines: string[]; notes: string[] };
    expect(preview.lines).toEqual(["第 1 章工作稿：在操作之外改过，跟操作记录接不上"]);
    expect(preview.notes[0]).toContain("要撤的是");
    expect(await bodyOf(9)).toBe("第九章。");
    const done = await answer(waiting);
    expect(done.state).toBe("succeeded");
    expect(await bodyOf(9)).toBeUndefined();
    expect(await bodyOf(1)).toBe("作者自己从头写的。");
  });

  /** A 写第 1 章；B 一次操作改第 1、2 章；全撤 A（第 1 章没了、第 2 章还是 B 的）。 */
  async function partlySwept(): Promise<void> {
    await aiWrites(1, "A 写的。");
    registerRecipe(twoDraftsRecipe);
    const first = await aiInput(1, "B 写的第一章。");
    const second = await aiInput(2, "B 写的第二章。");
    const submitted = await submitOperation(book, { kind: TWO_DRAFTS_KIND, params: [first, second], requestKey: randomUUID(), issuedAt: new Date().toISOString(), origin: { kind: "button" } });
    if (!submitted.ok || !("record" in submitted)) throw new Error(JSON.stringify(submitted));
    expect(await untilOperation(book, submitted.record.opId, (record) => SETTLED_STATES.includes(record.state))).toMatchObject({ state: "succeeded" });
    const a = (await listOperations(book)).find((record) => record.kind === "test.ai-draft");
    await undoInOperation(book, a?.opId);
    expect(await bodyOf(1)).toBeUndefined();
    expect(await bodyOf(2)).toBe("B 写的第二章。");
  }

  /** 作者照盘上现在的版本把第 1 章原样存回 B 那版（不留回执）。 */
  async function authorPutsBack(): Promise<void> {
    const saved = await runCommand(book, draftSave, { chapter: 1, title: "", body: "B 写的第一章。", baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
    expect(saved.ok).toBe(true);
  }

  it("一次操作改了两章、它之前那次被全撤顺带退掉一章，作者又原样存回：靠另一章还在找到它，也停下给作者看（Astra 第 14 轮第 1 条）", async () => {
    await partlySwept();
    await authorPutsBack();
    const waiting = await submit("undo", {}, "button");
    expect(waiting.state).toBe("waiting_author");
    const preview = operationView(waiting).pendingActions[0]?.preview as { lines: string[]; notes: string[] };
    // 内容就是它写的那份，谱系里却没有它：撤它的计划照样列成后来改过。
    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0]).toMatch(/^第 1 章工作稿：这次之后.*又改过$/u);
    expect(await bodyOf(1)).toBe("B 写的第一章。");
    expect(await answer(waiting)).toMatchObject({ state: "succeeded" });
    expect(await bodyOf(2)).toBeUndefined();
  });

  it("记了撤哪次、算计划之前断了，作者这时原样存回：接着做照现在的样子重算，照样停下给作者看（Astra 第 15 轮第 1 条）", async () => {
    await partlySwept();
    hook.beforePlan = async () => {
      hook.beforePlan = undefined;
      throw new OperationStopped("operation_stopped", "记了撤哪次、算计划之前断了");
    };
    const paused = await submit("undo", {}, "button");
    expect(paused.state).toBe("paused");
    await authorPutsBack();
    expect(await resumeOperation(book, paused.opId)).toMatchObject({ ok: true });
    const waiting = await untilOperation(book, paused.opId, (record) => record.eventSeq > paused.eventSeq && (SETTLED_STATES.includes(record.state) || record.state === "waiting_author"));
    expect(waiting.state).toBe("waiting_author");
    expect(await bodyOf(1)).toBe("B 写的第一章。");
  });

  for (const [when, stopAt] of [["记了撤哪次、算计划之前", 1], ["算了计划、应用之前", 2]] as const) {
    it(`往前找跳过了撤掉的第 1 章、找到第 9 章；${when}断了，作者这时原样存回第 1 章：接着做照现在的样子重算，停下给作者看（Astra 第 16 轮第 1 条）`, async () => {
      await aiWrites(9, "第九章。");
      await aiWrites(1, "AI 写的。");
      await undoInOperation(book);
      expect(await bodyOf(1)).toBeUndefined();
      let calls = 0;
      hook.beforePlan = async () => {
        calls += 1;
        if (calls !== stopAt) return;
        hook.beforePlan = undefined;
        throw new OperationStopped("operation_stopped", `${when}断了`);
      };
      const paused = await submit("undo", {}, "button");
      expect(paused.state).toBe("paused");
      const saved = await runCommand(book, draftSave, { chapter: 1, title: "", body: "AI 写的。", baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
      expect(saved.ok).toBe(true);
      expect(await resumeOperation(book, paused.opId)).toMatchObject({ ok: true });
      const waiting = await untilOperation(book, paused.opId, (record) => record.eventSeq > paused.eventSeq && (SETTLED_STATES.includes(record.state) || record.state === "waiting_author"));
      expect(waiting.state).toBe("waiting_author");
      const preview = operationView(waiting).pendingActions[0]?.preview as { lines: string[]; notes: string[] };
      expect(preview.lines).toEqual(["第 1 章工作稿：在操作之外改过，跟操作记录接不上"]);
      expect(preview.notes[0]).toContain("要撤的是");
      expect(await bodyOf(9)).toBe("第九章。");
    });
  }

  for (const when of ["点了之后、应用之前断了", "点之前"] as const) {
    it(`说不准的第 1 章，作者看过卡${when}又改了它：旧的确认不算，再停下问（Astra 第 17 轮第 1 条）`, async () => {
      await aiWrites(9, "第九章。");
      await aiWrites(1, "AI 写的。");
      await undoInOperation(book);
      await authorSaves(1, "AI 写的。");
      const waiting = await submit("undo", {}, "button");
      expect(waiting.state).toBe("waiting_author");
      expect((operationView(waiting).pendingActions[0]?.preview as { lines: string[] }).lines).toEqual(["第 1 章工作稿：在操作之外改过，跟操作记录接不上"]);
      let asked: OperationRecord;
      if (when === "点之前") {
        await authorSaves(1, "作者又改了一版。");
        asked = await answer(waiting);
      } else {
        hook.beforePlan = async () => {
          hook.beforePlan = undefined;
          throw new OperationStopped("operation_stopped", "点了之后、应用之前断了");
        };
        const paused = await answer(waiting);
        expect(paused.state).toBe("paused");
        await authorSaves(1, "作者又改了一版。");
        expect(await resumeOperation(book, paused.opId)).toMatchObject({ ok: true });
        asked = await untilOperation(book, paused.opId, (record) => record.eventSeq > paused.eventSeq && (SETTLED_STATES.includes(record.state) || record.state === "waiting_author"));
      }
      expect(asked.state).toBe("waiting_author");
      expect(await bodyOf(9)).toBe("第九章。");
      expect(await answer(asked)).toMatchObject({ state: "succeeded" });
      expect(await bodyOf(9)).toBeUndefined();
      expect(await bodyOf(1)).toBe("作者又改了一版。");
    });
  }

  it("上一次是升级之前、没留存档的写：如实说撤不了、指去「历史」，不说「没有能撤的」", async () => {
    const outcome = await runCommand(book, cardWrite, { ops: [{ op: "card.create", kind: "character", name: "沈舟" }] }, { caller: "author", idempotencyKey: "old-write" });
    if (!outcome.ok) throw new Error(outcome.message);
    const failed = await submit("undo", {}, "chat");
    expect(failed.state).toBe("failed");
    expect(failed.failure?.message).toContain("没留存档");
    expect(failed.failure?.message).toContain("顶栏「历史」");
  });

  it("对话里交的撤销照样只撤「上一次」（不收号）", async () => {
    await aiWrites(1, "第一版。");
    await aiWrites(2, "第二章。");
    const done = await submit("undo", { opId: "op-0123456789abcdef0123" }, "chat");
    expect(done.state).toBe("succeeded");
    expect(await bodyOf(2)).toBeUndefined();
    expect(await bodyOf(1)).toBe("第一版。");
  });
});

/** 最近交的那次撤销操作（撤回来用它的号）。 */
async function undoInOperationLast(): Promise<{ readonly opId: string }> {
  const all = await listOperations(book);
  const undos = all.filter((record) => record.kind === HISTORY_CHANGE_KIND && record.mode === "undo" && record.state === "succeeded");
  const last = undos.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!last) throw new Error("没有撤销");
  return { opId: last.opId };
}

describe("整本恢复", () => {
  it("恢复到存档：之后写的都退回；换成这次操作自己的纪元；能撤回来", async () => {
    await aiWrites(1, "第一章。");
    const snapshot = await createSnapshot(book, "写第二章前");
    await aiWrites(2, "第二章。");
    await authorSaves(1, "作者改了第一章。");
    const epochBefore = await readBookEpoch(book);

    const restored = await restoreInOperation(book, snapshot.id);
    expect(restored.summary).toContain("已恢复到");
    expect(await bodyOf(1)).toBe("第一章。");
    expect(await bodyOf(2)).toBeUndefined();
    const epoch = await readBookEpoch(book);
    expect(epoch).not.toBe(epochBefore);
    expect(epoch).toBe(opBookEpoch(restored.opId));
    // 恢复前打了存档点，操作历史里算「恢复」一类
    expect((await listSnapshots(book)).length).toBeGreaterThan(0);

    // 「撤销上一步」（不带号）撤的就是这次恢复
    await undoInOperation(book);
    expect(await bodyOf(1)).toBe("作者改了第一章。");
    expect(await bodyOf(2)).toBe("第二章。");
  });

  it("恢复写成了、记检查点之前进程没了，之后裁剪换了存档号：接着做照回执报「已恢复」，不说存档不在（Astra 第 13 轮第 3 条）", async () => {
    await aiWrites(1, "第一章。");
    const snapshot = await createSnapshot(book, "写第二章前");
    await aiWrites(2, "第二章。");
    // 写成了、记检查点之前这次执行断了（当成进程没了：停在「中断」，等作者接着做）。
    hook.afterHistoryApply = async () => {
      hook.afterHistoryApply = undefined;
      throw new OperationStopped("operation_stopped", "进程没了");
    };
    const interrupted = await submit("restore", { snapshot: snapshot.id }, "button");
    expect(interrupted).toMatchObject({ state: "paused", pauseReason: "interrupted" });
    expect(await bodyOf(2)).toBeUndefined();
    const opId = interrupted.opId;
    for (let i = 0; i < 30; i += 1) await execFileAsync("git", ["-C", book, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
    const pruned = await submit("prune", { keep: 5 }, "button");
    expect(pruned.state).toBe("succeeded");
    expect((await listSnapshots(book)).some((item) => item.id === snapshot.id)).toBe(false);
    expect(await resumeOperation(book, opId)).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = (await listOperations(book)).find((record) => record.opId === opId);
    expect(done?.state).toBe("succeeded");
    expect(done && operationView(done).conclusion).toContain("已恢复到「写第二章前」之前");
    expect(await bodyOf(1)).toBe("第一章。");
    expect(await bodyOf(2)).toBeUndefined();
  });

  it("对话里交的整本恢复不受理；存档号不在的如实失败", async () => {
    const snapshot = await createSnapshot(book, "起点");
    const requestKey = randomUUID();
    const chat = await submitOperation(book, {
      kind: HISTORY_CHANGE_KIND, mode: "restore", params: { snapshot: snapshot.id }, requestKey, issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: requestKey },
    });
    expect(chat.ok).toBe(false);
    const gone = await submit("restore", { snapshot: "f".repeat(40) }, "button");
    expect(gone.state).toBe("failed");
    expect(gone.failure?.message).toContain("存档已经不在了");
  });
});

describe("裁剪操作历史", () => {
  async function seedSnapshots(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) await execFileAsync("git", ["-C", book, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
  }
  const commitCount = async (): Promise<number> => Number((await execFileAsync("git", ["-C", book, "rev-list", "--count", "HEAD"])).stdout.trim());

  it("不到 keep 条：直接说不用裁", async () => {
    await createSnapshot(book, "起点");
    const done = await submit("prune", { keep: 50 }, "chat");
    expect(done.state).toBe("succeeded");
    expect(operationView(done).conclusion).toContain("不用裁");
  });

  it("对话里交的停下等「确认裁剪」；点了才裁，正文不动", async () => {
    await aiWrites(1, "正文。");
    await seedSnapshots(30);
    const before = await commitCount();
    const waiting = await submit("prune", { keep: 20 }, "chat");
    expect(waiting.state).toBe("waiting_author");
    expect(waiting.pendingActions[0]).toMatchObject({ actionId: PRUNE_CONFIRM_ACTION, kind: PRUNE_CONFIRM_KIND });
    expect(await commitCount()).toBe(before);

    const done = await answer(waiting);
    expect(done.state).toBe("succeeded");
    expect(await commitCount()).toBe(21);
    expect(await bodyOf(1)).toBe("正文。");
  });

  it("算好之后历史又动过：作废、一处不动", async () => {
    await createSnapshot(book, "起点");
    await seedSnapshots(30);
    const waiting = await submit("prune", { keep: 20 }, "chat");
    await seedSnapshots(1);
    const before = await commitCount();
    const done = await answer(waiting);
    expect(done.state).toBe("obsolete");
    expect(await commitCount()).toBe(before);
  });
});
