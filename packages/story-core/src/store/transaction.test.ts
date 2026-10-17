import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TX_DIR } from "./paths.js";
import { commitFiles, hasPendingTransactions, recoverTransactions } from "./transaction.js";

let book: string;

beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-tx-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const read = (path: string) => readFile(join(book, path), "utf-8");

/** 手工摆出一份「写到一半断电」的事务目录。 */
async function strandedTransaction(status: "prepared" | "applied", files: { path: string; existed: boolean; renamed: boolean; old?: string; next: string }[]) {
  const txDir = join(book, TX_DIR, "t1");
  await mkdir(join(txDir, "staged"), { recursive: true });
  await mkdir(join(txDir, "backup"), { recursive: true });
  for (const [index, file] of files.entries()) {
    const slot = String(index);
    await mkdir(join(book, file.path, ".."), { recursive: true });
    if (file.existed) await writeFile(join(txDir, "backup", slot), file.old ?? "");
    if (file.renamed) await writeFile(join(book, file.path), file.next);
    else {
      await writeFile(join(txDir, "staged", slot), file.next);
      if (file.existed) await writeFile(join(book, file.path), file.old ?? "");
    }
  }
  const manifest = {
    schema: "story-core-tx/1",
    id: "t1",
    createdAt: "2026-10-17T00:00:00.000Z",
    status,
    files: files.map((file, index) => ({ path: file.path, existed: file.existed, slot: String(index) })),
  };
  await writeFile(join(txDir, "manifest.json"), JSON.stringify(manifest));
}

describe("多文件事务", () => {
  it("全部写上，事务目录清干净", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "chapters/0001.md"), "旧正文");
    await commitFiles(book, [
      { path: "chapters/0001.md", content: "新正文" },
      { path: "ledger/chapters/0001.json", content: "{}" },
    ]);
    expect(await read("chapters/0001.md")).toBe("新正文");
    expect(await read("ledger/chapters/0001.json")).toBe("{}");
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("写到一半断了：已换上的换回旧的，新建的删掉", async () => {
    await strandedTransaction("prepared", [
      { path: "chapters/0001.md", existed: true, renamed: true, old: "旧正文", next: "新正文" },
      { path: "ledger/chapters/0001.json", existed: false, renamed: true, next: "{}" },
      { path: "ledger/head.json", existed: true, renamed: false, old: "旧版本", next: "新版本" },
    ]);
    const report = await recoverTransactions(book);
    expect(report.rolledBack).toEqual(["t1"]);
    expect(await read("chapters/0001.md")).toBe("旧正文");
    await expect(read("ledger/chapters/0001.json")).rejects.toThrow();
    expect(await read("ledger/head.json")).toBe("旧版本");
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("已经写完只差收尾的：留着新内容，只清目录", async () => {
    await strandedTransaction("applied", [{ path: "chapters/0001.md", existed: true, renamed: true, old: "旧", next: "新" }]);
    const report = await recoverTransactions(book);
    expect(report.cleaned).toEqual(["t1"]);
    expect(await read("chapters/0001.md")).toBe("新");
  });

  it("清单坏了：原样留着、如实报出来", async () => {
    await mkdir(join(book, TX_DIR, "bad"), { recursive: true });
    await writeFile(join(book, TX_DIR, "bad", "manifest.json"), "{坏");
    const report = await recoverTransactions(book);
    expect(report.problems).toEqual(["bad"]);
    expect(await readdir(join(book, TX_DIR))).toEqual(["bad"]);
  });

  it("不覆盖软链、不许写出书目录、同一文件不许写两次", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "elsewhere.md"), "别处");
    await symlink(join(book, "elsewhere.md"), join(book, "chapters/0001.md"));
    await expect(commitFiles(book, [{ path: "chapters/0001.md", content: "x" }])).rejects.toThrow("不是普通文件");
    await expect(commitFiles(book, [{ path: "../outside.md", content: "x" }])).rejects.toThrow("不在书目录里");
    await expect(commitFiles(book, [{ path: "a.md", content: "1" }, { path: "a.md", content: "2" }])).rejects.toThrow("重复写");
    expect(await read("elsewhere.md")).toBe("别处");
    expect(await hasPendingTransactions(book)).toBe(false);
  });
});
