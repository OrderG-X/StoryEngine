import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEPT_TX_DIR, REVISION_PATH, TX_DIR } from "./paths.js";
import { commitFiles, hasPendingTransactions, KEPT_REPORT_THRESHOLD, recoverTransactions, setAsideBrokenTransactions, sha256Bytes } from "./transaction.js";

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

  it("写和删一起提交：删掉的不在了，返回每个成员换之前、换之后的哈希；删本来不在的不算成员", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "chapters/0001.md"), "旧正文");
    await writeFile(join(book, "chapters/0002.md"), "要删的");
    const effects = await commitFiles(book, [
      { path: "chapters/0001.md", content: "新正文" },
      { path: "chapters/0002.md", delete: true },
      { path: "chapters/0003.md", delete: true },
    ]);
    expect(effects).toEqual([
      { path: "chapters/0001.md", before: sha256Bytes("旧正文"), after: sha256Bytes("新正文") },
      { path: "chapters/0002.md", before: sha256Bytes("要删的"), after: null },
    ]);
    expect(await read("chapters/0001.md")).toBe("新正文");
    await expect(lstat(join(book, "chapters/0002.md"))).rejects.toThrow();
    expect(await hasPendingTransactions(book)).toBe(false);
    expect(await commitFiles(book, [{ path: "chapters/0009.md", delete: true }])).toEqual([]);
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("按字节写、按字节备份：不是 UTF-8 的内容原样换上、原样回滚", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0xc3, 0x28]);
    await commitFiles(book, [{ path: "assets/a.bin", content: bytes }]);
    expect(new Uint8Array(await readFile(join(book, "assets/a.bin")))).toEqual(bytes);
    // 摆一份「换上新的之后断了」的事务：回滚要把原来的字节一个不差放回去。
    const txDir = join(book, TX_DIR, "t2");
    await mkdir(join(txDir, "staged"), { recursive: true });
    await mkdir(join(txDir, "backup"), { recursive: true });
    await writeFile(join(txDir, "backup", "0"), bytes);
    await writeFile(join(book, "assets/a.bin"), "改坏的");
    await writeFile(join(txDir, "manifest.json"), JSON.stringify({
      schema: "story-core-tx/2", id: "t2", createdAt: "2026-10-29T00:00:00.000Z", status: "prepared",
      files: [{ path: "assets/a.bin", kind: "write", existed: true, slot: "0", beforeSha: sha256Bytes(bytes) }],
    }));
    expect((await recoverTransactions(book)).rolledBack).toEqual(["t2"]);
    expect(new Uint8Array(await readFile(join(book, "assets/a.bin")))).toEqual(bytes);
  });

  it("删到一半断了：已删的从备份放回，还没删的原样，已换上的写换回", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    const txDir = join(book, TX_DIR, "t3");
    await mkdir(join(txDir, "staged"), { recursive: true });
    await mkdir(join(txDir, "backup"), { recursive: true });
    // 0：写，已换上；1：删，已删（原件不在、备份在）；2：删，还没删（原件在）。
    await writeFile(join(txDir, "backup", "0"), "旧正文");
    await writeFile(join(book, "chapters/0001.md"), "新正文");
    await writeFile(join(txDir, "backup", "1"), "第二章");
    await writeFile(join(txDir, "backup", "2"), "第三章");
    await writeFile(join(book, "chapters/0003.md"), "第三章");
    await writeFile(join(txDir, "manifest.json"), JSON.stringify({
      schema: "story-core-tx/2", id: "t3", createdAt: "2026-10-29T00:00:00.000Z", status: "prepared",
      files: [
        { path: "chapters/0001.md", kind: "write", existed: true, slot: "0", beforeSha: sha256Bytes("旧正文") },
        { path: "chapters/0002.md", kind: "delete", existed: true, slot: "1", beforeSha: sha256Bytes("第二章") },
        { path: "chapters/0003.md", kind: "delete", existed: true, slot: "2", beforeSha: sha256Bytes("第三章") },
      ],
    }));
    expect((await recoverTransactions(book)).rolledBack).toEqual(["t3"]);
    expect(await read("chapters/0001.md")).toBe("旧正文");
    expect(await read("chapters/0002.md")).toBe("第二章");
    expect(await read("chapters/0003.md")).toBe("第三章");
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("清单成员种类不认识：算坏的，原样留着", async () => {
    const txDir = join(book, TX_DIR, "t4");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(txDir, "manifest.json"), JSON.stringify({
      schema: "story-core-tx/2", id: "t4", createdAt: "x", status: "prepared",
      files: [{ path: "a.md", kind: "move", existed: true, slot: "0", beforeSha: null }],
    }));
    expect((await recoverTransactions(book)).problems).toEqual(["t4"]);
  });
});
