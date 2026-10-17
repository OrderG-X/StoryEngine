import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEPT_TX_DIR, TX_DIR } from "./paths.js";
import { commitFiles, hasPendingTransactions, KEPT_REPORT_THRESHOLD, recoverTransactions, setAsideBrokenTransactions } from "./transaction.js";

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

  it("上级目录是软链：拒绝写，链那头的目录一个字节不动", async () => {
    const outside = await mkdtemp(join(tmpdir(), "story-core-outside-"));
    try {
      await symlink(outside, join(book, "ledger"));
      await expect(commitFiles(book, [{ path: "ledger/chapters/0001.json", content: "{}" }])).rejects.toThrow("上级目录是软链");
      await mkdir(join(book, "chapters"), { recursive: true });
      await symlink(outside, join(book, "chapters", "sub"));
      await expect(commitFiles(book, [{ path: "chapters/sub/x.md", content: "x" }])).rejects.toThrow("上级目录是软链");
      // 事务根被换成软链也不写。
      await rm(join(book, TX_DIR), { recursive: true, force: true });
      await symlink(outside, join(book, TX_DIR));
      await expect(commitFiles(book, [{ path: "a.md", content: "x" }])).rejects.toThrow("上级目录是软链");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("书目录本身是软链：按真实路径写和恢复", async () => {
    const link = `${book}-link`;
    await symlink(book, link);
    try {
      await commitFiles(link, [{ path: "chapters/0001.md", content: "正文" }]);
      expect(await read("chapters/0001.md")).toBe("正文");
      await strandedTransaction("prepared", [{ path: "chapters/0001.md", existed: true, renamed: true, old: "正文", next: "改坏的" }]);
      expect((await recoverTransactions(link)).rolledBack).toEqual(["t1"]);
      expect(await read("chapters/0001.md")).toBe("正文");
    } finally {
      await rm(link, { force: true });
    }
  });

  it("清单指到书外的事务：不回滚、原样留着报出来", async () => {
    await strandedTransaction("prepared", [{ path: "chapters/0001.md", existed: false, renamed: true, next: "x" }]);
    const manifestPath = join(book, TX_DIR, "t1", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    manifest.files[0].path = "../escape.md";
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect((await recoverTransactions(book)).problems).toEqual(["t1"]);
    expect(await hasPendingTransactions(book)).toBe(true);
  });

  it("坏事务：作者确认后挪进留证区（不删），之后恢复报告干净；留证超过上限就提醒", async () => {
    for (let index = 0; index <= KEPT_REPORT_THRESHOLD; index += 1) {
      await mkdir(join(book, KEPT_TX_DIR, `old-${index}`), { recursive: true });
    }
    await mkdir(join(book, TX_DIR, "bad"), { recursive: true });
    await writeFile(join(book, TX_DIR, "bad", "manifest.json"), "{坏");
    const moved = await setAsideBrokenTransactions(book);
    expect(moved).toMatchObject({ moved: ["bad"], kept: KEPT_REPORT_THRESHOLD + 2, keptOverLimit: true });
    const keptNames = await readdir(join(book, KEPT_TX_DIR));
    const bad = keptNames.find((name) => name.endsWith("-bad"));
    expect(await readFile(join(book, KEPT_TX_DIR, bad as string, "manifest.json"), "utf-8")).toBe("{坏");
    const report = await recoverTransactions(book);
    expect(report).toMatchObject({ problems: [], kept: KEPT_REPORT_THRESHOLD + 2, keptOverLimit: true });
    expect(await hasPendingTransactions(book)).toBe(false);
  });
});
