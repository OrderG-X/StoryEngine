/**
 * safe-fs（P1 第 21 轮 AI2）：临时文件落盘后、rename 前路径被调换，一律拒绝、目标和书外文件不动；
 * 核完到 rename 之间被调换的，换上后核出来如实报错。只在真实的 fsync / rename 点注入调换，不替换业务逻辑。
 */
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveFileInBook, readFileInBook, writeFileInBook } from "./safe-fs.js";

const io = vi.hoisted(() => ({
  afterSync: undefined as undefined | ((path: string) => Promise<void>),
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await io.afterSync?.(String(args[0]));
      };
      return handle;
    },
    rename: async (from: string, to: string) => {
      await io.beforeRename?.(String(from), String(to));
      return actual.rename(from, to);
    },
  };
});

let root: string;
let book: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "story-core-safe-fs-")));
  book = join(root, "book");
  outside = join(root, "outside");
  await mkdir(join(book, "drafts"), { recursive: true });
  await mkdir(outside);
});
afterEach(async () => {
  io.afterSync = undefined;
  io.beforeRename = undefined;
  await rm(root, { recursive: true, force: true });
});

const target = () => join(book, "drafts", "chapter-0001.md");
const isOurTemp = (path: string) => dirname(path) === dirname(target()) && basename(path).startsWith(`.${basename(target())}.`);
const sha = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

describe("writeFileInBook：临时文件落盘后被调换", () => {
  it.each(["regular", "symlink", "hardlink"] as const)("换成 %s：rename 前拒绝，原稿和书外文件不动、不留临时文件", async (kind) => {
    await writeFile(target(), "原稿 A");
    const foreign = join(outside, "foreign.txt");
    await writeFile(foreign, "书外的字");
    io.afterSync = async (path) => {
      if (!isOurTemp(path)) return;
      io.afterSync = undefined;
      await rm(path);
      if (kind === "regular") await writeFile(path, "书外的字");
      else if (kind === "symlink") await symlink(foreign, path);
      else await link(foreign, path);
    };
    await expect(writeFileInBook(book, target(), "新稿 B", { label: "draft" })).rejects.toMatchObject({ code: expect.stringMatching(/^UNSAFE_/u) });
    expect(await readFile(target(), "utf-8")).toBe("原稿 A");
    expect((await lstat(target())).nlink).toBe(1);
    expect(await readFile(foreign, "utf-8")).toBe("书外的字");
    expect((await readdir(dirname(target()))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("上级目录被挪到书外、软链接回：不往书外 rename", async () => {
    await writeFile(target(), "原稿 A");
    const movedOut = join(outside, "drafts");
    io.afterSync = async (path) => {
      if (!isOurTemp(path)) return;
      io.afterSync = undefined;
      await rename(dirname(target()), movedOut);
      await symlink(movedOut, dirname(target()));
    };
    await expect(writeFileInBook(book, target(), "新稿 B", { label: "draft" })).rejects.toMatchObject({ code: expect.stringMatching(/^UNSAFE_/u) });
    expect(await readFile(join(movedOut, basename(target())), "utf-8")).toBe("原稿 A");
  });

  it("上级目录被换成另一个真目录：拒绝", async () => {
    await writeFile(target(), "原稿 A");
    io.afterSync = async (path) => {
      if (!isOurTemp(path)) return;
      io.afterSync = undefined;
      await rename(dirname(target()), join(book, "drafts-old"));
      await mkdir(dirname(target()));
    };
    await expect(writeFileInBook(book, target(), "新稿 B", { label: "draft" })).rejects.toMatchObject({ code: "UNSAFE_DIRECTORY_SWAPPED" });
    expect(await readFile(join(book, "drafts-old", basename(target())), "utf-8")).toBe("原稿 A");
  });

  it("核完到 rename 之间被调换：换上后核出来，如实报错不当成功", async () => {
    await writeFile(target(), "原稿 A");
    io.beforeRename = async (from) => {
      if (!isOurTemp(from)) return;
      io.beforeRename = undefined;
      await rm(from);
      await writeFile(from, "调换进来的字");
    };
    await expect(writeFileInBook(book, target(), "新稿 B", { label: "draft" })).rejects.toMatchObject({ code: "UNSAFE_INODE_MISMATCH" });
  });

  it("目标原来的权限照旧；原来没有的按 0600 建", async () => {
    await writeFile(target(), "原稿 A");
    await chmod(target(), 0o640);
    await writeFileInBook(book, target(), "新稿 B", { label: "draft" });
    expect((await lstat(target())).mode & 0o777).toBe(0o640);
    expect(await readFile(target(), "utf-8")).toBe("新稿 B");
    const fresh = join(book, "drafts", "chapter-0002.md");
    await writeFileInBook(book, fresh, "第二章", { label: "draft" });
    expect((await lstat(fresh)).mode & 0o777).toBe(0o600);
  });
});

describe("moveFileInBook：挪到位的文件被调换", () => {
  async function staged(content: string): Promise<string> {
    const path = join(book, ".tx", "staged-0");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  it("内容不是写进去的那份：不挪", async () => {
    await writeFile(target(), "原稿 A");
    const source = await staged("被改过的字");
    await expect(moveFileInBook(book, source, target(), { label: "draft", expectSha: sha("新稿 B") })).rejects.toMatchObject({ code: "UNSAFE_CONTENT_MISMATCH" });
    expect(await readFile(target(), "utf-8")).toBe("原稿 A");
  });

  it.each(["symlink", "hardlink"] as const)("暂存是 %s：不挪", async (kind) => {
    await writeFile(target(), "原稿 A");
    const foreign = join(outside, "foreign.txt");
    await writeFile(foreign, "新稿 B");
    const source = join(book, ".tx", "staged-0");
    await mkdir(dirname(source), { recursive: true });
    if (kind === "symlink") await symlink(foreign, source);
    else await link(foreign, source);
    await expect(moveFileInBook(book, source, target(), { label: "draft", expectSha: sha("新稿 B") })).rejects.toBeTruthy();
    expect(await readFile(target(), "utf-8")).toBe("原稿 A");
  });

  it("核完到 rename 之间暂存被调换：换上后核出来，如实报错不当成功", async () => {
    await writeFile(target(), "原稿 A");
    const source = await staged("新稿 B");
    io.beforeRename = async (from) => {
      if (from !== source) return;
      io.beforeRename = undefined;
      await rm(from);
      await writeFile(from, "调换进来的字");
    };
    await expect(moveFileInBook(book, source, target(), { label: "draft", expectSha: sha("新稿 B") })).rejects.toMatchObject({ code: "UNSAFE_INODE_MISMATCH" });
  });

  it("正常挪：内容对得上就换上、沿用原来的权限", async () => {
    await writeFile(target(), "原稿 A");
    await chmod(target(), 0o640);
    const source = await staged("新稿 B");
    await moveFileInBook(book, source, target(), { label: "draft", expectSha: sha("新稿 B") });
    expect(await readFile(target(), "utf-8")).toBe("新稿 B");
    expect((await lstat(target())).mode & 0o777).toBe(0o640);
  });
});

describe("readFileInBook", () => {
  it("不在是 undefined；软链、硬链、上级是软链都不读", async () => {
    expect(await readFileInBook(book, target(), "draft")).toBeUndefined();
    const foreign = join(outside, "foreign.txt");
    await writeFile(foreign, "书外的字");
    await symlink(foreign, target());
    await expect(readFileInBook(book, target(), "draft")).rejects.toBeTruthy();
    await rm(target());
    await link(foreign, target());
    await expect(readFileInBook(book, target(), "draft")).rejects.toMatchObject({ code: "UNSAFE_HARDLINK" });
    await rm(target());
    await rm(join(book, "drafts"), { recursive: true });
    await mkdir(join(outside, "drafts"));
    await writeFile(join(outside, "drafts", basename(target())), "书外的字");
    await symlink(join(outside, "drafts"), join(book, "drafts"));
    await expect(readFileInBook(book, target(), "draft")).rejects.toMatchObject({ code: "UNSAFE_SYMLINK" });
  });
});

describe("核心事务接上 safe-fs", () => {
  it.each(["暂存落盘后被改", "核完到 rename 之间被换"] as const)("%s：这次写整份退回，目标还是原样", async (when) => {
    const { commitFiles, hasPendingTransactions } = await import("./transaction.js");
    await writeFile(target(), "原稿 A");
    const isStaged = (path: string) => path.includes(`${join(".story-core-tx")}`) && basename(dirname(path)) === "staged";
    if (when === "暂存落盘后被改") {
      io.afterSync = async (path) => {
        if (!isStaged(path)) return;
        io.afterSync = undefined;
        await writeFile(path, "调换进来的字");
      };
    } else {
      io.beforeRename = async (from) => {
        if (!isStaged(from)) return;
        io.beforeRename = undefined;
        await rm(from);
        await writeFile(from, "调换进来的字");
      };
    }
    await expect(commitFiles(book, [{ path: "drafts/chapter-0001.md", content: "新稿 B" }])).rejects.toBeTruthy();
    expect(await readFile(target(), "utf-8")).toBe("原稿 A");
    expect(await hasPendingTransactions(book)).toBe(false);
  });
});

describe("另存区不是书里的真目录（P1 第 21 轮 AI1）", () => {
  it("是书外目录的软链：读当没有、写拒绝，书外的不动", async () => {
    const { listSavedDrafts, readSavedDraft, saveCopyBeforeRestore, settleSavedCopy } = await import("./saved-copies.js");
    await saveCopyBeforeRestore(book, { from: "tx@1", path: "drafts/fast/chapter-0001.md", content: "# 作者的 C\n\n唯一的一份。\n" });
    const [saved] = await listSavedDrafts(book, 1);
    expect(saved).toMatchObject({ body: "唯一的一份。" });
    const movedOut = join(outside, "saved");
    await rename(join(book, ".story-core-saved"), movedOut);
    await symlink(movedOut, join(book, ".story-core-saved"));
    expect(await listSavedDrafts(book, 1)).toEqual([]);
    expect(await readSavedDraft(book, saved!.id)).toBeUndefined();
    await settleSavedCopy(book, saved!.id);
    await expect(saveCopyBeforeRestore(book, { from: "tx@2", path: "drafts/fast/chapter-0001.md", content: "别的" })).rejects.toThrow(/另存区不是普通目录/u);
    const outsideRecord = JSON.parse(await readFile(join(movedOut, `${saved!.id}.json`), "utf-8")) as { settled?: boolean };
    expect(outsideRecord.settled).toBeUndefined();
    expect((await readdir(movedOut)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});

describe("要盖掉 / 删掉的那份先核内容（P1 第 22 轮 AJ1、AJ2）", () => {
  it("writeFileInBook：盖掉的不是核过的那份、或应该不在却在，不写", async () => {
    await writeFile(target(), "原稿 A");
    await expect(writeFileInBook(book, target(), "新稿 B", { label: "draft", expectTargetSha: sha("别的") })).rejects.toMatchObject({ code: "UNSAFE_TARGET_CHANGED" });
    await expect(writeFileInBook(book, target(), "新稿 B", { label: "draft", expectTargetSha: null })).rejects.toMatchObject({ code: "UNSAFE_TARGET_CHANGED" });
    expect(await readFile(target(), "utf-8")).toBe("原稿 A");
    await writeFileInBook(book, target(), "新稿 B", { label: "draft", expectTargetSha: sha("原稿 A") });
    expect(await readFile(target(), "utf-8")).toBe("新稿 B");
    expect((await readdir(dirname(target()))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removeFileInBook：内容核不上不删；不在当删过了；核完到挪开之间被换了，放回原处不删", async () => {
    const { removeFileInBook } = await import("./safe-fs.js");
    await writeFile(target(), "作者 C");
    await expect(removeFileInBook(book, target(), { label: "draft", expectSha: sha("别的") })).rejects.toMatchObject({ code: "UNSAFE_TARGET_CHANGED" });
    expect(await readFile(target(), "utf-8")).toBe("作者 C");
    io.beforeRename = async (from) => {
      if (from !== target()) return;
      io.beforeRename = undefined;
      await rm(from);
      await writeFile(from, "后来的 X");
    };
    await expect(removeFileInBook(book, target(), { label: "draft", expectSha: sha("作者 C") })).rejects.toMatchObject({ code: "UNSAFE_INODE_MISMATCH" });
    expect(await readFile(target(), "utf-8")).toBe("后来的 X");
    expect((await readdir(dirname(target()))).filter((name) => name.endsWith(".del"))).toEqual([]);
    await removeFileInBook(book, target(), { label: "draft", expectSha: sha("后来的 X") });
    await expect(lstat(target())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeFileInBook(book, target(), { label: "draft", expectSha: sha("后来的 X") })).resolves.toBeUndefined();
  });
});

describe("收拾半截事务：换没换回拿内容证明、只删核过的那份（P1 第 22 轮 AJ1、AJ2）", () => {
  const DRAFT = "drafts/fast/chapter-0001.md";
  const A = "# 选定 A\n\n完整的原稿 A。\n";
  const C = "# 作者 C\n\n唯一的新稿 C。\n";
  const X = "# 被调换 X\n\n不该被接受的 X。\n";
  const draft = () => join(book, DRAFT);

  /** 一份被杀在换上之后的核心事务：盘上是 C（不是这份写的），before 是原来那份（null = 原来没有）。 */
  async function residue(before: string | null, extra: { readonly had?: boolean } = {}): Promise<string> {
    const dir = join(book, ".story-core-tx", "round22-tx");
    await mkdir(join(dir, "backup"), { recursive: true });
    await mkdir(join(dir, "staged"), { recursive: true });
    if (before !== null) await writeFile(join(dir, "backup", "0"), before);
    const file = { path: DRAFT, slot: "0", existed: before !== null, ...(before !== null && extra.had ? { had: sha(before) } : {}) };
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "round22-tx", createdAt: "2026-10-20T00:00:00.000Z", status: "prepared", files: [file] }));
    await mkdir(dirname(draft()), { recursive: true });
    await writeFile(draft(), C);
    return dir;
  }

  it.each([false, true])("备份换回时被调换（清单记原来那份：%s）：重开不凭备份不在就当退过了", async (had) => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    const dir = await residue(A, { had });
    io.beforeRename = async (from) => {
      if (from !== join(dir, "backup", "0")) return;
      io.beforeRename = undefined;
      await rename(from, `${from}.displaced`);
      await writeFile(from, X);
    };
    expect((await recoverTransactions(book)).problems).toEqual(["round22-tx"]);
    expect((await recoverTransactions(book)).problems).toEqual(["round22-tx"]);
    expect(await hasPendingTransactions(book)).toBe(true);
    expect(await readFile(join(dir, "backup", "0.displaced"), "utf-8")).toBe(A);
  });

  it("老清单退到一半被打断：退之前补记了原来那份（清单不改），下次接着退完", async () => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    const OTHER = "drafts/fast/chapter-0002.md";
    const dir = join(book, ".story-core-tx", "round23-tx");
    await mkdir(join(dir, "backup"), { recursive: true });
    await mkdir(join(dir, "staged"), { recursive: true });
    await writeFile(join(dir, "backup", "0"), A);
    await writeFile(join(dir, "backup", "1"), A);
    const files = [DRAFT, OTHER].map((path, slot) => ({ path, slot: String(slot), existed: true }));
    const manifest = JSON.stringify({ schema: "story-core-tx/1", id: "round23-tx", createdAt: "2026-10-20T00:00:00.000Z", status: "prepared", files });
    await writeFile(join(dir, "manifest.json"), manifest);
    await mkdir(dirname(draft()), { recursive: true });
    await writeFile(draft(), C);
    await writeFile(join(book, OTHER), C);
    io.beforeRename = async (from) => {
      if (from === join(dir, "backup", "1")) throw Object.assign(new Error("injected"), { code: "EIO" });
    };
    expect((await recoverTransactions(book)).problems).toEqual(["round23-tx"]);
    expect(await readFile(draft(), "utf-8")).toBe(A);
    expect(await readFile(join(dir, "manifest.json"), "utf-8")).toBe(manifest);
    io.beforeRename = undefined;
    expect(await recoverTransactions(book)).toMatchObject({ rolledBack: ["round23-tx"], problems: [] });
    expect(await hasPendingTransactions(book)).toBe(false);
    expect(await readFile(join(book, OTHER), "utf-8")).toBe(A);
  });

  it("备份不在了、正式那份已经是原来的样子：清单记着原来那份，就是退过了", async () => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    const dir = await residue(A, { had: true });
    await rm(join(dir, "backup", "0"));
    await writeFile(draft(), A);
    expect(await recoverTransactions(book)).toMatchObject({ rolledBack: ["round22-tx"], problems: [] });
    expect(await hasPendingTransactions(book)).toBe(false);
    expect(await readFile(draft(), "utf-8")).toBe(A);
  });

  it("进程内写到一半失败、换回备份时被调换：这份事务留着，重开也不清", async () => {
    const { commitFiles, hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    await mkdir(dirname(draft()), { recursive: true });
    await writeFile(draft(), A);
    let swapped = false;
    io.beforeRename = async (from, to) => {
      if (from.endsWith(`${join("staged", "1")}`)) throw Object.assign(new Error("injected"), { code: "EIO" });
      if (from.includes(`${join("", "backup", "")}`) && to === draft()) {
        swapped = true;
        io.beforeRename = undefined;
        await rename(from, `${from}.displaced`);
        await writeFile(from, X);
      }
    };
    await expect(commitFiles(book, [{ path: DRAFT, content: C }, { path: "drafts/fast/trigger.md", content: "t" }])).rejects.toMatchObject({ code: "EIO" });
    expect(swapped).toBe(true);
    expect(await hasPendingTransactions(book)).toBe(true);
    expect((await recoverTransactions(book)).problems).toHaveLength(1);
    expect(await hasPendingTransactions(book)).toBe(true);
  });

  it("删新建的之前上级换成书外软链：不删书外的，这份留着", async () => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    await residue(null);
    const away = join(outside, "fast");
    io.beforeRename = async (from) => {
      if (from !== draft()) return;
      io.beforeRename = undefined;
      await rename(dirname(draft()), away);
      await symlink(away, dirname(draft()));
    };
    expect((await recoverTransactions(book)).problems).toEqual(["round22-tx"]);
    expect(await readFile(join(away, basename(DRAFT)), "utf-8")).toBe(C);
    expect(await hasPendingTransactions(book)).toBe(true);
  });

  /** 老格式残留：这份事务新建了工作稿（原来没有），盘上现在是 C。 */
  async function legacyResidue(): Promise<void> {
    const dir = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      version: 2, chapter: 1, createdAt: "2026-10-20T00:00:00.000Z", files: [DRAFT], backups: [{ relativePath: DRAFT, existed: false }], status: "staged",
    }));
    await mkdir(dirname(draft()), { recursive: true });
    await writeFile(draft(), C);
  }

  it("老格式：删新建的之前上级换成书外软链：不删书外的，如实挡着", async () => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    await legacyResidue();
    const away = join(outside, "fast");
    io.beforeRename = async (from) => {
      if (from !== draft()) return;
      io.beforeRename = undefined;
      await rename(dirname(draft()), away);
      await symlink(away, dirname(draft()));
    };
    await expect(recoverTransactions(book)).rejects.toMatchObject({ name: "LegacyResidueError" });
    expect(await readFile(join(away, basename(DRAFT)), "utf-8")).toBe(C);
    expect(await hasPendingTransactions(book)).toBe(true);
  });

  it("老格式：另存完 C、删之前盘上换成了 X：X 不删，下一次先另存 X 再删", async () => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    const { listSavedDrafts } = await import("./saved-copies.js");
    await legacyResidue();
    let hit = false;
    io.afterSync = async (path) => {
      if (hit || !path.includes(".story-core-saved") || !path.endsWith(".tmp")) return;
      hit = true;
      await writeFile(draft(), X);
    };
    await expect(recoverTransactions(book)).rejects.toMatchObject({ name: "LegacyResidueError" });
    expect(await readFile(draft(), "utf-8")).toBe(X);
    await recoverTransactions(book);
    expect(await hasPendingTransactions(book)).toBe(false);
    await expect(lstat(draft())).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listSavedDrafts(book, 1)).map((item) => item.body).sort()).toEqual(["不该被接受的 X。", "唯一的新稿 C。"]);
  });

  it("另存完 C、删之前盘上换成了 X：X 不删，下一次先另存 X 再删", async () => {
    const { hasPendingTransactions, recoverTransactions } = await import("./transaction.js");
    const { listSavedDrafts } = await import("./saved-copies.js");
    await residue(null);
    let hit = false;
    io.afterSync = async (path) => {
      if (hit || !path.includes(".story-core-saved") || !path.endsWith(".tmp")) return;
      hit = true;
      await writeFile(draft(), X);
    };
    expect((await recoverTransactions(book)).problems).toEqual(["round22-tx"]);
    expect(hit).toBe(true);
    expect(await readFile(draft(), "utf-8")).toBe(X);
    expect(await recoverTransactions(book)).toMatchObject({ rolledBack: ["round22-tx"], problems: [] });
    expect(await hasPendingTransactions(book)).toBe(false);
    expect((await listSavedDrafts(book, 1)).map((item) => item.body).sort()).toEqual(["不该被接受的 X。", "唯一的新稿 C。"]);
  });
});
