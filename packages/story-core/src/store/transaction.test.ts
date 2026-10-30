import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISPLACED_DIR, KEPT_TX_DIR, REVISION_PATH, SAVED_COPIES_DIR, TX_DIR } from "./paths.js";
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
    // 书被这次写动过：换回原样之后换一个新代次（这次写没写代次都换）。
    expect(JSON.parse(await read(REVISION_PATH))).toMatchObject({ schema: "store-revision/1" });
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("写到一半断了：写入代次换上了就不退回，内容换回原样后再换一个新的（途中读到的代次和回滚后的都对不上）", async () => {
    await strandedTransaction("prepared", [
      { path: REVISION_PATH, existed: true, renamed: true, old: "代次一", next: "代次二" },
      { path: "chapters/0001.md", existed: true, renamed: true, old: "旧正文", next: "新正文" },
      { path: "ledger/head.json", existed: true, renamed: false, old: "旧版本", next: "新版本" },
    ]);
    await recoverTransactions(book);
    expect(await read("chapters/0001.md")).toBe("旧正文");
    expect(await read("ledger/head.json")).toBe("旧版本");
    const after = await read(REVISION_PATH);
    expect(after).not.toBe("代次一");
    expect(after).not.toBe("代次二");
    expect(JSON.parse(after)).toMatchObject({ schema: "store-revision/1" });
  });

  it("代次还没换上就断了：书里什么都没动，代次也不动", async () => {
    await strandedTransaction("prepared", [
      { path: REVISION_PATH, existed: true, renamed: false, old: "代次一", next: "代次二" },
      { path: "chapters/0001.md", existed: true, renamed: false, old: "旧正文", next: "新正文" },
    ]);
    await recoverTransactions(book);
    expect(await read(REVISION_PATH)).toBe("代次一");
    expect(await read("chapters/0001.md")).toBe("旧正文");
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

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

/** 手工摆出一份带删除成员的 v2 事务（prepared）：deleted = 原件已经挪走了；aside = 挪到 aside 还没挪进留证区就断了。 */
async function strandedDelete(path: string, old: string, state: "kept" | "deleted" | "aside" | "replaced") {
  const txDir = join(book, TX_DIR, "t2");
  await mkdir(join(txDir, "backup"), { recursive: true });
  await mkdir(join(txDir, "aside"), { recursive: true });
  await mkdir(join(book, path, ".."), { recursive: true });
  await writeFile(join(txDir, "backup", "0"), old);
  if (state === "kept") await writeFile(join(book, path), old);
  if (state === "aside") await writeFile(join(txDir, "aside", "0"), old);
  if (state === "replaced") await writeFile(join(book, path), "删了以后别处放上的");
  const manifest = {
    schema: "story-core-tx/2",
    id: "t2",
    createdAt: "2026-10-30T00:00:00.000Z",
    status: "prepared",
    files: [{ path, kind: "delete", existed: true, slot: "0", had: sha(old) }],
  };
  await writeFile(join(txDir, "manifest.json"), JSON.stringify(manifest));
}

describe("事务删文件（清单 v2）", () => {
  it("删掉的文件挪进留证区（不 unlink），和写的同一个事务", async () => {
    await mkdir(join(book, "ledger/chapters"), { recursive: true });
    await writeFile(join(book, "ledger/chapters/0001.json"), "首次定稿的账");
    await commitFiles(book, [{ path: "ledger/chapters/0001.json", delete: true }, { path: "ledger/head.json", content: "新版本" }]);
    await expect(read("ledger/chapters/0001.json")).rejects.toThrow();
    expect(await read("ledger/head.json")).toBe("新版本");
    const displaced = await readdir(join(book, DISPLACED_DIR));
    expect(await Promise.all(displaced.map((name) => readFile(join(book, DISPLACED_DIR, name), "utf-8")))).toEqual(["首次定稿的账"]);
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("要删的不在、删代次文件：拒绝，书不动", async () => {
    await expect(commitFiles(book, [{ path: "chapters/0001.md", delete: true }])).rejects.toThrow("要删的文件不在");
    await mkdir(join(book, "store-control"), { recursive: true });
    await writeFile(join(book, REVISION_PATH), "代次");
    await expect(commitFiles(book, [{ path: REVISION_PATH, delete: true }])).rejects.toThrow("代次文件不许删");
    expect(await read(REVISION_PATH)).toBe("代次");
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("删到一半断了：删了的从备份放回，换一个新代次", async () => {
    await strandedDelete("chapters/0001.md", "原来的正文", "deleted");
    expect((await recoverTransactions(book)).rolledBack).toEqual(["t2"]);
    expect(await read("chapters/0001.md")).toBe("原来的正文");
    expect(JSON.parse(await read(REVISION_PATH))).toMatchObject({ schema: "store-revision/1" });
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("还没删就断了：原件不动、代次不动", async () => {
    await strandedDelete("chapters/0001.md", "原来的正文", "kept");
    await recoverTransactions(book);
    expect(await read("chapters/0001.md")).toBe("原来的正文");
    await expect(read(REVISION_PATH)).rejects.toThrow();
  });

  it("挪到 aside 还没挪进留证区就断了：放回原处", async () => {
    await strandedDelete("chapters/0001.md", "原来的正文", "aside");
    await recoverTransactions(book);
    expect(await read("chapters/0001.md")).toBe("原来的正文");
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("删了以后原处又有了别的一份：先另存再换回原件", async () => {
    await strandedDelete("chapters/0001.md", "原来的正文", "replaced");
    await recoverTransactions(book);
    expect(await read("chapters/0001.md")).toBe("原来的正文");
    const names = await readdir(join(book, SAVED_COPIES_DIR));
    const saved = await Promise.all(names.map((name) => readFile(join(book, SAVED_COPIES_DIR, name), "utf-8")));
    expect(saved.join("")).toContain("删了以后别处放上的");
  });

  it("v1 清单里出现删除成员算坏的：原样留着", async () => {
    await strandedDelete("chapters/0001.md", "原来的正文", "deleted");
    const manifestPath = join(book, TX_DIR, "t2", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    manifest.schema = "story-core-tx/1";
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect((await recoverTransactions(book)).problems).toEqual(["t2"]);
  });
});
