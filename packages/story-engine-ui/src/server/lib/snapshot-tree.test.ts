// @vitest-environment node
// 写作版本 P2a 片 4B：每张有撤销范围效果的回执都带写之前那一刻的树号，树里那份的哈希就是回执记的 before。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit, CommandReceipt, draftSave, runCommand, sha256Bytes } from "@actalk/story-core";
import { coreSnapshotFor, listSnapshots, runWithLazySnapshot } from "./snapshot.js";

const execFileAsync = promisify(execFile);

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "se-snap-tree-"));
  await mkdir(join(book, "chapters"), { recursive: true });
  await writeFile(join(book, "project.json"), JSON.stringify({ title: "测试书" }), "utf-8");
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

async function receipts(): Promise<CommandReceipt[]> {
  const dir = join(book, "ledger/receipts");
  return Promise.all((await readdir(dir)).map(async (name) => CommandReceipt.parse(JSON.parse(await readFile(join(dir, name), "utf-8")))));
}

async function blobSha(tree: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", book, "cat-file", "blob", `${tree}:${path}`], { encoding: "buffer" });
    return sha256Bytes(stdout);
  } catch {
    return null;
  }
}

const CH1 = "# 第1章 · 钟停\n\n钟停在三点十五分。";

describe("回执带树号", () => {
  it("一批里第一条打存档点、第二条起和不打存档点的命令打不进操作历史的存档；每个树号里那份就是回执的 before", async () => {
    await writeFile(join(book, "chapters/0001.md"), "旧正文");
    await runWithLazySnapshot(book, async (snapshot) => {
      await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, { caller: "author", op: { opId: "op-1", stepId: "a" }, snapshot });
      await runCommand(book, draftSave, { chapter: 2, title: "第二章", body: "稿", baseVersion: null }, { caller: "author", op: { opId: "op-1", stepId: "b" }, snapshot });
      await runCommand(book, chapterCommit, { chapter: 1, text: `${CH1}又改了。`, entries: [] }, { caller: "author", op: { opId: "op-1", stepId: "c" }, snapshot });
    });
    const all = await receipts();
    expect(all).toHaveLength(3);
    for (const receipt of all) {
      expect(receipt.snapshotTree).toMatch(/^[0-9a-f]{40}$/u);
      for (const effect of receipt.effects ?? []) expect(await blobSha(receipt.snapshotTree!, effect.path)).toBe(effect.before);
    }
    // 操作历史里只有第一条打的那个存档点（另外两个是「落盘收尾」）。
    const visible = (await listSnapshots(book)).filter((entry) => !entry.label.startsWith("落盘收尾"));
    expect(visible.filter((entry) => entry.label.startsWith("core:"))).toHaveLength(1);
  });

  it("coreSnapshotFor：只要树号的不打存档点", async () => {
    await writeFile(join(book, "chapters/0001.md"), "旧正文");
    const snapshot = coreSnapshotFor(book);
    await runCommand(book, draftSave, { chapter: 1, title: "第一章", body: "稿", baseVersion: null }, { caller: "author", op: { opId: "op-2", stepId: "a" }, snapshot });
    const [receipt] = await receipts();
    expect(receipt?.snapshotTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(await blobSha(receipt!.snapshotTree!, "drafts/fast/chapter-0001.md")).toBeNull();
    expect((await listSnapshots(book)).filter((entry) => entry.label.startsWith("core:"))).toHaveLength(0);
  });
});
