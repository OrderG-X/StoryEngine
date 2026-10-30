// @vitest-environment node
//
// 读存档的 git 实现（写作版本 P2a 片 4C）：树 → 撤销范围里的路径和 blob 号；按号取原始字节；键和 git 的 blob 号是同一种。
// 真 git 仓库。
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "./home-test-tmp.js";
import { withGitHistoryReader } from "./history-reader.js";
import { createSnapshot, snapshotInfoOf } from "./snapshot.js";

const execFileAsync = promisify(execFile);

let dir: string;
beforeEach(async () => {
  dir = await makeHomeTempDir("history-reader-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await mkdir(join(dir, "ledger"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const treeOf = async (label: string): Promise<string> => {
  const snapshot = await createSnapshot(dir, label);
  const info = await snapshotInfoOf(dir, snapshot.id);
  if (!info) throw new Error("存档不在");
  return info.tree;
};

describe("读存档", () => {
  it("只列撤销范围里的；原始字节按号取（不 trim、二进制原样）；键 = git 的 blob 号", async () => {
    const text = "# 第一章\n\n正文。\n\n\n";
    const bytes = Buffer.from([0, 1, 2, 255, 10, 10]);
    await writeFile(join(dir, "chapters", "0001.md"), text, "utf-8");
    await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), bytes);
    await writeFile(join(dir, "ledger", "cards.json"), "{}", "utf-8");
    await writeFile(join(dir, "project.json"), "{}", "utf-8");
    await writeFile(join(dir, "notes.txt"), "不在范围里", "utf-8");
    const tree = await treeOf("一");

    await withGitHistoryReader(dir, async (reader) => {
      const files = await reader.list(tree);
      expect([...(files?.keys() ?? [])].sort()).toEqual(["chapters/0001.md", "drafts/fast/chapter-0002.md", "ledger/cards.json"]);
      const textId = files?.get("chapters/0001.md") ?? "";
      const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", `${tree}:chapters/0001.md`]);
      expect(textId).toBe(stdout.trim());
      expect(Buffer.from(await reader.read(textId)).toString("utf-8")).toBe(text);
      const binary = await reader.read(files?.get("drafts/fast/chapter-0002.md") ?? "");
      expect(Buffer.from(binary).equals(bytes)).toBe(true);
      expect(reader.keyOf(new TextEncoder().encode(text))).toBe(textId);
      expect(reader.keyOf(bytes)).toBe(files?.get("drafts/fast/chapter-0002.md"));
    });
  });

  it("树不在了（号不对、裁掉了）：回 undefined；取不在的字节如实失败", async () => {
    await writeFile(join(dir, "chapters", "0001.md"), "一", "utf-8");
    await treeOf("一");
    await withGitHistoryReader(dir, async (reader) => {
      expect(await reader.list("f".repeat(40))).toBeUndefined();
      expect(await reader.list("../HEAD")).toBeUndefined();
      await expect(reader.read("e".repeat(40))).rejects.toThrow("存档里没有这一份");
      await expect(reader.read("HEAD")).rejects.toThrow("存档号不对");
    });
  });

  it("范围里有软链：如实失败，不当成「存档里没有」", async () => {
    await writeFile(join(dir, "chapters", "0001.md"), "一", "utf-8");
    await symlink(join(dir, "chapters", "0001.md"), join(dir, "chapters", "0002.md"));
    const tree = await treeOf("一");
    await withGitHistoryReader(dir, async (reader) => {
      await expect(reader.list(tree)).rejects.toThrow("不是普通文件");
    });
  });

  it("一次取很多份：按顺序对上", async () => {
    await writeFile(join(dir, "chapters", "0001.md"), "一", "utf-8");
    for (let n = 1; n <= 60; n += 1) await writeFile(join(dir, "drafts", "fast", `chapter-${String(n).padStart(4, "0")}.md`), `第${n}章稿`.repeat(n), "utf-8");
    const tree = await treeOf("多");
    await withGitHistoryReader(dir, async (reader) => {
      const files = await reader.list(tree);
      const drafts = [...(files?.entries() ?? [])].filter(([path]) => path.startsWith("drafts/fast/"));
      expect(drafts).toHaveLength(60);
      const texts = await Promise.all(drafts.map(([, id]) => reader.read(id).then((bytes) => Buffer.from(bytes).toString("utf-8"))));
      drafts.forEach(([path], index) => {
        const n = Number(/chapter-(\d+)/u.exec(path)?.[1]);
        expect(texts[index]).toBe(`第${n}章稿`.repeat(n));
      });
    });
  });
});
