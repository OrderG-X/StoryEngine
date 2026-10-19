// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeHomeTempDir } from "./home-test-tmp.js";
import { listTrash, moveBookToTrash, purgeFromTrash, resolveTrashDir, restoreFromTrash } from "./book-trash.js";

const ORIGINAL = process.env.SE_BOOKS_DIR;
let root = "";

async function makeBook(name: string, title: string): Promise<string> {
  const dir = join(root, "story-engine", name);
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ title }), "utf-8");
  await writeFile(join(dir, "chapters", "0001.md"), "# 第1章\n\n正文", "utf-8");
  return dir;
}

beforeEach(async () => {
  root = await makeHomeTempDir("book-trash-");
  process.env.SE_BOOKS_DIR = root;
});
afterEach(async () => {
  if (ORIGINAL === undefined) delete process.env.SE_BOOKS_DIR;
  else process.env.SE_BOOKS_DIR = ORIGINAL;
  await rm(root, { recursive: true, force: true });
});

describe("书的回收站", () => {
  it("回收站在书库根下；同一本书连删两次（恢复后再删）条目不撞名", async () => {
    expect(resolveTrashDir()).toBe(join(root, "回收站"));
    const dir = await makeBook("fog", "雾港");
    const at = new Date("2026-10-20T10:00:00");
    const first = await moveBookToTrash(dir, "雾港", at);
    expect(first).toBe("fog-20261020-100000");
    await restoreFromTrash(first);
    const second = await moveBookToTrash(dir, "雾港", at);
    expect(second).toBe("fog-20261020-100000");
    await mkdir(join(root, "story-engine", "fog"), { recursive: true });
    await writeFile(join(root, "story-engine", "fog", "project.json"), JSON.stringify({ title: "雾港" }), "utf-8");
    expect(await moveBookToTrash(join(root, "story-engine", "fog"), "雾港", at)).toBe("fog-20261020-100000-2");
  });

  it("原处被占了（同名新书）：恢复加后缀，不覆盖", async () => {
    const dir = await makeBook("fog", "雾港");
    const id = await moveBookToTrash(dir, "雾港");
    await makeBook("fog", "另一本叫雾港的新书");
    const restored = await restoreFromTrash(id);
    expect(restored.projectPath).toBe(`${dir}-恢复`);
    expect(JSON.parse(await readFile(join(dir, "project.json"), "utf-8")).title).toBe("另一本叫雾港的新书");
    expect(JSON.parse(await readFile(join(`${dir}-恢复`, "project.json"), "utf-8")).title).toBe("雾港");
  });

  it("超过 30 天的列的时候真删；还剩几天向上取整；认不出的目录不碰", async () => {
    const old = await moveBookToTrash(await makeBook("old", "老书"), "老书", new Date("2026-09-01T00:00:00Z"));
    const recent = await moveBookToTrash(await makeBook("new", "新书"), "新书", new Date("2026-10-19T12:00:00Z"));
    await mkdir(join(root, "回收站", "别人放的东西"), { recursive: true });
    const items = await listTrash(new Date("2026-10-20T00:00:00Z"));
    expect(items.map((i) => [i.id, i.daysLeft])).toEqual([[recent, 30]]);
    await expect(stat(join(root, "回收站", old))).rejects.toThrow();
    expect(await readdir(join(root, "回收站"))).toContain("别人放的东西");
  });

  it("id 不对、带路径的、彻底删过的，都如实说没有", async () => {
    await expect(restoreFromTrash("../story-engine")).rejects.toThrow("回收站里没有这本书。");
    await expect(purgeFromTrash("nope")).rejects.toThrow("回收站里没有这本书。");
    const id = await moveBookToTrash(await makeBook("x", "某书"), "某书");
    expect(await purgeFromTrash(id)).toEqual({ title: "某书" });
    await expect(restoreFromTrash(id)).rejects.toThrow("回收站里没有这本书。");
  });

  it("说明文件里的原路径被改到安全范围外：放回默认书库，不往外写", async () => {
    const id = await moveBookToTrash(await makeBook("safe", "安全书"), "安全书");
    const recordPath = join(root, "回收站", id, "trash.json");
    const record = JSON.parse(await readFile(recordPath, "utf-8"));
    await writeFile(recordPath, JSON.stringify({ ...record, originalPath: "/etc/evil-book" }), "utf-8");
    const restored = await restoreFromTrash(id);
    expect(restored.projectPath).toBe(join(root, "story-engine", "evil-book"));
  });

  it("回收站和书重叠的不让删", async () => {
    await expect(moveBookToTrash(root, "整个书库")).rejects.toThrow("和回收站重叠");
  });
});
