// 写作版本 P2a：回执记操作号和步骤号、撤销范围里的前后哈希、写之前的存档树号；栅栏在书锁里、回放之后跑；章纲命令；书的纪元。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSave } from "../draft/commands.js";
import { CommandReceipt } from "../schema/book.js";
import { bookEpochWrite, readBookEpoch } from "../store/control.js";
import { BOOK_EPOCH_PATH, isUndoablePath, planPath } from "../store/paths.js";
import { commitFiles, sha256Bytes } from "../store/transaction.js";
import { chapterCommit } from "./chapter-commit.js";
import { planSave } from "./plan-save.js";
import { fail, runCommand } from "./runner.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-receipt-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章 · 钟停\n\n钟停在三点十五分。沈青禾推开钟楼的门。";

async function receipts(): Promise<CommandReceipt[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = join(book, "ledger/receipts");
  const names = await readdir(dir);
  return Promise.all(names.map(async (name) => CommandReceipt.parse(JSON.parse(await readFile(join(dir, name), "utf-8")))));
}

describe("回执 v3", () => {
  it("操作的一步：键是 op:<操作>:<步骤>，回执记操作号、步骤号、撤销范围里的前后哈希、存档树号；版本号、回执不进 effects", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "chapters/0001.md"), "旧正文");
    const outcome = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, {
      caller: "author",
      op: { opId: "op-1", stepId: "apply" },
      snapshot: async () => "tree-abc",
    });
    expect(outcome).toMatchObject({ ok: true, replayed: false });
    const [receipt] = await receipts();
    expect(receipt).toMatchObject({ key: "op:op-1:apply", opId: "op-1", stepId: "apply", snapshotTree: "tree-abc" });
    expect(receipt?.effects).toEqual(expect.arrayContaining([{ path: "chapters/0001.md", before: sha256Bytes("旧正文"), after: sha256Bytes(CH1) }]));
    expect(receipt?.effects?.every((effect) => isUndoablePath(effect.path))).toBe(true);
    expect(receipt?.effects?.some((effect) => effect.path.startsWith("ledger/receipts") || effect.path === "ledger/head.json")).toBe(false);
    // 同一步再来：回放，不再写。
    const again = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, { caller: "author", op: { opId: "op-1", stepId: "apply" } });
    expect(again).toMatchObject({ ok: true, replayed: true });
  });

  it("栅栏不过：什么都不写、原样返回它；回执已在的照常回放（回放不写）", async () => {
    const blocked = await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "AI 稿", baseVersion: null }, {
      caller: "author",
      op: { opId: "op-2", stepId: "apply" },
      precondition: async () => fail("operation_stopped", "这次已经停了，没有写。"),
    });
    expect(blocked).toMatchObject({ ok: false, code: "operation_stopped" });
    await expect(readFile(join(book, "drafts/fast/chapter-0001.md"), "utf-8")).rejects.toThrow();

    const done = await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "AI 稿", baseVersion: null }, { caller: "author", op: { opId: "op-3", stepId: "apply" } });
    expect(done).toMatchObject({ ok: true, replayed: false });
    let fenced = 0;
    const replay = await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "AI 稿", baseVersion: null }, {
      caller: "author",
      op: { opId: "op-3", stepId: "apply" },
      precondition: async () => {
        fenced += 1;
        return fail("operation_stopped", "停了");
      },
    });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(fenced).toBe(0);
  });

  it("有撤销范围效果的都带树号：不打存档点的命令、存档回调没给树号的，单要一个（\"tree\"）", async () => {
    const calls: string[] = [];
    const snapshot = async (_label: string, command: string, mode?: "tree") => {
      calls.push(`${command}:${mode ?? "snapshot"}`);
      return mode === "tree" ? `tree-of-${command}` : undefined;
    };
    // draft.save 不打存档点（snapshot: false）。
    await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "作者稿", baseVersion: null }, { caller: "author", op: { opId: "op-7", stepId: "a" }, snapshot });
    // chapter.commit 打存档点，回调没给树号（一批里第二条）。
    await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, { caller: "author", op: { opId: "op-7", stepId: "b" }, snapshot });
    expect(calls).toEqual(["draft.save:tree", "chapter.commit:snapshot", "chapter.commit:tree"]);
    const byStep = new Map((await receipts()).map((receipt) => [receipt.stepId, receipt]));
    expect(byStep.get("a")?.snapshotTree).toBe("tree-of-draft.save");
    expect(byStep.get("b")?.snapshotTree).toBe("tree-of-chapter.commit");
  });

  it("什么都不用改的也留回执，effects 是空的", async () => {
    await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "一样的", baseVersion: null }, { caller: "author", op: { opId: "op-4", stepId: "a" } });
    const { readDraftState } = await import("../draft/draft.js");
    const version = (await readDraftState(book, 1)).version;
    await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "一样的", baseVersion: version }, { caller: "author", op: { opId: "op-4", stepId: "b" } });
    const second = (await receipts()).find((receipt) => receipt.stepId === "b");
    expect(second?.effects).toEqual([]);
  });
});

describe("plan.save", () => {
  it("写章纲：原样写、打存档、不动版本号；和盘上一样就不写", async () => {
    const content = `${JSON.stringify({ chapter: 2, beats: ["甲"] }, null, 2)}\n`;
    let snapshots = 0;
    const options = (stepId: string) => ({ caller: "ai" as const, op: { opId: "op-5", stepId }, snapshot: async () => { snapshots += 1; return "tree-1"; } });
    const first = await runCommand(book, planSave, { chapter: 2, content }, options("plan-save"));
    expect(first).toMatchObject({ ok: true, version: 0, changed: { plans: [2] }, result: { chapter: 2, unchanged: false } });
    expect(await readFile(join(book, planPath(2)), "utf-8")).toBe(content);
    expect(snapshots).toBe(1);
    const [receipt] = await receipts();
    expect(receipt?.effects).toEqual([{ path: planPath(2), before: null, after: sha256Bytes(content) }]);
    const same = await runCommand(book, planSave, { chapter: 2, content }, options("plan-save-2"));
    expect(same).toMatchObject({ ok: true, result: { unchanged: true } });
    expect(snapshots).toBe(1);
  });

  it("不是 JSON 对象：不写、如实说", async () => {
    const outcome = await runCommand(book, planSave, { chapter: 2, content: "[1,2]" }, { caller: "ai", op: { opId: "op-6", stepId: "p" } });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_plan" });
  });
});

describe("撤销范围和书的纪元", () => {
  it("撤销范围：正文、账单、裁定、设定卡、工作稿、章纲；回执、head、控制文件、候选不在", () => {
    for (const path of ["chapters/0001.md", "ledger/chapters/0001.json", "ledger/decisions.json", "ledger/cards.json", "drafts/fast/chapter-0001.md", "drafts/plans/chapter-0001.json"]) {
      expect(isUndoablePath(path)).toBe(true);
    }
    for (const path of ["ledger/head.json", "ledger/receipts/a.json", "store-control/revision.json", "agents/drafts/candidates/x.json", "chapters/sub/0001.md", "chapters/"]) {
      expect(isUndoablePath(path)).toBe(false);
    }
  });

  it("纪元：没有是空串；换了读得出新的；坏了拿内容哈希、和坏之前对不上", async () => {
    expect(await readBookEpoch(book)).toBe("");
    await commitFiles(book, [bookEpochWrite(new Date())]);
    const epoch = await readBookEpoch(book);
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/u);
    await writeFile(join(book, BOOK_EPOCH_PATH), "{坏");
    const broken = await readBookEpoch(book);
    expect(broken.startsWith("invalid-")).toBe(true);
    expect(broken).not.toBe(epoch);
  });
});
