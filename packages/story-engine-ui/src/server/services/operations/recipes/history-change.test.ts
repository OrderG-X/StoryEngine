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
import { cardWrite, draftSave, opBookEpoch, readBookEpoch, readDraft, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../../book/project-store.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, type OperationRecord } from "../../../lib/operations/store.js";
import { SETTLED_STATES, untilOperation } from "../../../lib/operations/test-helpers.js";
import { createSnapshot, listSnapshots } from "../../../lib/snapshot.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import { applyAiDraftInOperation, restoreInOperation, undoInOperation } from "../test-helpers.js";
import { operationView } from "../view.js";
import { HISTORY_CHANGE_KIND, historyChangeRecipe, PRUNE_CONFIRM_ACTION, PRUNE_CONFIRM_KIND, UNDO_CONFIRM_ACTION, UNDO_CONFIRM_KIND } from "./history-change.js";

const execFileAsync = promisify(execFile);

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
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

async function authorSaves(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
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
  const pending = record.pendingActions[0];
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
