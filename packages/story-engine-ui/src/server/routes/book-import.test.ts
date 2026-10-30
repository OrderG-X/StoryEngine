// @vitest-environment node
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { projectBook } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { callRoute } from "./test-helpers.js";

type ContinueOutcome = import("../services/operations/recipes/index.js").ContinueRereadOutcome;
const reread = vi.hoisted(() => ({
  startReread: vi.fn(async (_book: string, _total: number) => undefined),
  continueReread: vi.fn(async (_book: string): Promise<ContinueOutcome> => ({ ok: true, status: "running" })),
}));
vi.mock("../services/operations/recipes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/operations/recipes/index.js")>()),
  startReread: reread.startReread,
  continueReread: reread.continueReread,
}));

const { registerBookImportRoutes } = await import("./book-import.js");

const TEXT = [
  "作品相关：本书纯属虚构。",
  "第一章 雨夜",
  "钟停在三点十五分。",
  "沈青禾推开门。",
  "第二章 来信",
  "第二天上午，外乡人又来了。",
  "第三章 空章",
].join("\n");

let rootDir: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("book-import-route-");
  reread.startReread.mockClear();
  reread.continueReread.mockClear();
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("导入已写的书", () => {
  it("预览：切出开头和章节、空章另算、书名取文件名，不写盘", async () => {
    const { statusCode, payload } = await callRoute(registerBookImportRoutes, "POST", "/api/books/import-preview", {
      files: [{ name: "《雾港来信》.txt", text: TEXT }],
    });
    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ ok: true, emptyDropped: 1, suggestedTitle: "雾港来信" });
    expect((payload.parts as Array<{ kind: string; title: string }>).map((part) => [part.kind, part.title])).toEqual([
      ["preamble", ""],
      ["chapter", "雨夜"],
      ["chapter", "来信"],
    ]);
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("没选文件、文件是空的：如实拒", async () => {
    expect((await callRoute(registerBookImportRoutes, "POST", "/api/books/import-preview", { files: [] })).payload.error).toBe("没有选文件");
    expect((await callRoute(registerBookImportRoutes, "POST", "/api/books/import-preview", { files: [{ name: "a.txt", text: "  \n" }] })).payload.error).toBe("选的文件是空的");
  });

  it("导入：建书、章都算定稿、开一轮通读记账；按勾选导、开头勾上就当一章", async () => {
    const { statusCode, payload } = await callRoute(registerBookImportRoutes, "POST", "/api/books/import", {
      title: "雾港来信",
      rootDir,
      files: [{ name: "雾港来信.txt", text: TEXT }],
      include: [true, true, false],
    });
    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ ok: true, imported: { chapters: 2 } });
    const projectDir = payload.projectDir as string;
    const view = await projectBook(projectDir);
    expect(view.chapters.map((chapter) => [chapter.chapter, chapter.origin])).toEqual([[1, "import"], [2, "import"]]);
    expect(await readFile(join(projectDir, "chapters", "0001.md"), "utf8")).toBe("# 第1章\n\n作品相关：本书纯属虚构。\n");
    expect(await readFile(join(projectDir, "chapters", "0002.md"), "utf8")).toBe("# 第2章 · 雨夜\n\n钟停在三点十五分。\n\n沈青禾推开门。\n");
    expect(reread.startReread).toHaveBeenCalledWith(projectDir, 2);
  });

  it("勾选和文件对不上（文件变了）、一章没选：不建书", async () => {
    const files = [{ name: "a.txt", text: TEXT }];
    const mismatch = await callRoute(registerBookImportRoutes, "POST", "/api/books/import", { rootDir, files, include: [true, true] });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.payload.error).toContain("对不上");
    const none = await callRoute(registerBookImportRoutes, "POST", "/api/books/import", { rootDir, files, include: [false, false, false] });
    expect(none.payload.error).toContain("一章都没选");
    expect(await readdir(rootDir)).toEqual([]);
    expect(reread.startReread).not.toHaveBeenCalled();
  });

  it("导到一半出错：整本删掉、如实报错", async () => {
    reread.startReread.mockRejectedValueOnce(new Error("记账员起不来"));
    const { statusCode, payload } = await callRoute(registerBookImportRoutes, "POST", "/api/books/import", {
      rootDir,
      files: [{ name: "a.txt", text: TEXT }],
    });
    expect(statusCode).toBe(500);
    expect(payload.error).toContain("记账员起不来");
    expect(await readdir(join(rootDir, "story-engine"))).toEqual([]);
  });

  it("接着记：交给执行器（停着的接着做、没成的重交）；没在通读的如实说", async () => {
    const imported = await callRoute(registerBookImportRoutes, "POST", "/api/books/import", { rootDir, files: [{ name: "a.txt", text: TEXT }] });
    const projectDir = imported.payload.projectDir as string;
    reread.continueReread.mockResolvedValueOnce({ ok: false, message: "这本书没有在通读记账。" });
    const idle = await callRoute(registerBookImportRoutes, "POST", "/api/books/reread", { projectPath: projectDir });
    expect(idle.statusCode).toBe(400);
    expect(idle.payload.error).toBe("这本书没有在通读记账。");

    const resumed = await callRoute(registerBookImportRoutes, "POST", "/api/books/reread", { projectPath: projectDir });
    expect(resumed.payload).toEqual({ ok: true, status: "running" });
    expect(reread.continueReread).toHaveBeenLastCalledWith(projectDir);
  });
});
