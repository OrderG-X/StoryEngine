// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeHomeTempDir } from "./home-test-tmp.js";
import { createZip } from "./zip.js";
import type * as BackupModule from "./book-backup.js";

// test-setup 把自动备份换成了空操作；这里测它本身，拿真的。
const backup = await vi.importActual<typeof BackupModule>("./book-backup.js");

const ORIGINAL = { books: process.env.SE_BOOKS_DIR, data: process.env.SE_DATA_DIR };
let root = "";

beforeEach(async () => {
  root = await makeHomeTempDir("story-engine-backup-");
  process.env.SE_BOOKS_DIR = join(root, "lib");
  process.env.SE_DATA_DIR = join(root, "data");
});

afterEach(async () => {
  if (ORIGINAL.books === undefined) delete process.env.SE_BOOKS_DIR;
  else process.env.SE_BOOKS_DIR = ORIGINAL.books;
  if (ORIGINAL.data === undefined) delete process.env.SE_DATA_DIR;
  else process.env.SE_DATA_DIR = ORIGINAL.data;
  await rm(root, { recursive: true, force: true });
});

async function makeBook(name = "story-aaa111"): Promise<string> {
  const dir = join(root, "lib", "story-engine", name);
  await mkdir(join(dir, "chapters"), { recursive: true });
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await mkdir(join(dir, ".git", "objects", "ab"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ id: "story-aaa111", title: "雾港来信" }), "utf-8");
  await writeFile(join(dir, "chapters", "0001.md"), "# 第1章 · 死信\n\n正文。\n", "utf-8");
  await writeFile(join(dir, ".git", "objects", "ab", "cdef"), Buffer.from([0x78, 0x9c, 1, 2, 3]));
  await writeFile(join(dir, ".git", "index.lock"), "", "utf-8");
  return dir;
}

describe("备份（P10）", () => {
  it("打包整本书（含存档历史、空目录），恢复成一本新书：内容一样、git 锁文件不带、重名加后缀", async () => {
    const dir = await makeBook();
    const made = await backup.createBookBackup(dir, new Date(2026, 9, 20, 9, 5, 7));
    expect(made.filename).toBe("雾港来信-备份-20261020-090507.zip");

    const first = await backup.restoreBookFromBackup(made.data);
    expect(first).toEqual({ projectPath: `${dir}-恢复`, title: "雾港来信" });
    expect(await readFile(join(first.projectPath, "chapters", "0001.md"), "utf-8")).toContain("死信");
    expect([...(await readFile(join(first.projectPath, ".git", "objects", "ab", "cdef")))]).toEqual([0x78, 0x9c, 1, 2, 3]);
    expect((await stat(join(first.projectPath, "drafts", "fast"))).isDirectory()).toBe(true);
    await expect(stat(join(first.projectPath, ".git", "index.lock"))).rejects.toThrow();

    const second = await backup.restoreBookFromBackup(made.data);
    expect(second.projectPath).toBe(`${dir}-恢复2`);
    // 解压的临时目录不留。
    expect((await readdir(join(root, "lib", "story-engine"))).filter((name) => name.includes(".restoring-"))).toEqual([]);
  });

  it("不是本应用的备份、缺 project.json：如实拒绝，不建目录", async () => {
    await expect(backup.restoreBookFromBackup(createZip([{ path: "a.txt", data: "x" }]))).rejects.toThrow("不是 StoryEngine 的备份包");
    const noBook = createZip([{ path: backup.BACKUP_MANIFEST, data: JSON.stringify({ kind: "story-engine-backup", version: 1, title: "x", folder: "story-x" }) }]);
    await expect(backup.restoreBookFromBackup(noBook)).rejects.toThrow("缺 project.json");
    await expect(backup.restoreBookFromBackup(Buffer.from("not a zip"))).rejects.toThrow();
    await expect(readdir(join(root, "lib", "story-engine"))).rejects.toThrow();
  });

  it("包里写着越界的书目录名也只落在书库里", async () => {
    const zip = createZip([
      { path: backup.BACKUP_MANIFEST, data: JSON.stringify({ kind: "story-engine-backup", version: 1, title: "x", folder: "../../evil" }) },
      { path: "book/project.json", data: JSON.stringify({ title: "x" }) },
    ]);
    const restored = await backup.restoreBookFromBackup(zip);
    expect(restored.projectPath).toBe(join(root, "lib", "story-engine", "evil"));
  });

  it("设置：默认开、默认文件夹；改文件夹要在用户目录下，空串换回默认", async () => {
    expect(await backup.readBackupSettings()).toEqual({ auto: true });
    expect(backup.backupDirOf({ auto: true })).toBe(join(root, "lib", "备份"));
    await expect(backup.updateBackupSettings({ dir: "relative/path" })).rejects.toThrow("完整的文件夹路径");
    await expect(backup.updateBackupSettings({ dir: "/etc/backups" })).rejects.toThrow("不能用");
    const custom = join(root, "my-backups");
    expect(await backup.updateBackupSettings({ auto: false, dir: custom })).toEqual({ auto: false, dir: custom });
    expect(await backup.updateBackupSettings({ dir: "" })).toEqual({ auto: false });
  });

  it("定稿后自动备份：存进这本书的子文件夹、只留最近 10 份、结果记下；关了就不做", async () => {
    const dir = await makeBook();
    const folder = join(root, "lib", "备份", "story-aaa111");
    await mkdir(folder, { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      const file = join(folder, `旧-${String(i).padStart(2, "0")}.zip`);
      await writeFile(file, "old");
      await utimes(file, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
    }
    const status = await backup.autoBackupAfterCommit(dir, new Date(2026, 9, 20, 10, 0, 0));
    expect(status).toMatchObject({ ok: true, title: "雾港来信" });
    const kept = (await readdir(folder)).sort();
    expect(kept).toHaveLength(10);
    expect(kept).toContain("雾港来信-备份-20261020-100000.zip");
    expect(kept).not.toContain("旧-00.zip");
    expect((await backup.readBackupSettings()).last).toMatchObject({ ok: true, title: "雾港来信" });

    await backup.updateBackupSettings({ auto: false });
    expect(await backup.autoBackupAfterCommit(dir)).toBeNull();
  });

  it("自动备份没成：不抛，如实记下原因", async () => {
    const status = await backup.autoBackupAfterCommit(join(root, "lib", "story-engine", "nope"));
    expect(status?.ok).toBe(false);
    expect((await backup.readBackupSettings()).last?.ok).toBe(false);
  });
});
