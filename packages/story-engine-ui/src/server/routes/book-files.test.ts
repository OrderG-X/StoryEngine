// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { readZip } from "../lib/zip.js";
import { attachmentHeader, registerBookFilesRoutes } from "./book-files.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("story-engine-export-");
  dirs.push(dir);
  await writeFile(join(dir, "project.json"), JSON.stringify({ id: "story-export", title: "雾港/来信", info: { author: "林某", synopsis: "一封信。" } }), "utf-8");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), "# 第1章 · 死信\n\n　　第一段。\n\n  第二段。\n", "utf-8");
  await writeFile(join(dir, "chapters", "0002.md"), "# 第2章\n\n只有一段。\n", "utf-8");
  await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), "# 第2章 · 改过\n\n改过的一段。\n", "utf-8");
  await writeFile(join(dir, "drafts", "fast", "chapter-0003.md"), "# 第3章 · 还没定\n\n工作稿。\n", "utf-8");
  return dir;
}

describe("备份接口（P10）", () => {
  it("下载备份是 zip、带说明文件；传回去解成新书；不是备份包如实拒", async () => {
    const original = process.env.SE_BOOKS_DIR;
    const library = await makeHomeTempDir("story-engine-restore-");
    dirs.push(library);
    process.env.SE_BOOKS_DIR = library;
    try {
      const dir = await makeBook();
      const backup = await callExport(`/api/books/backup?project=${encodeURIComponent(dir)}`);
      expect(backup.statusCode).toBe(200);
      expect(backup.headers["Content-Type"]).toBe("application/zip");
      const paths = readZip(backup.body).map((entry) => entry.path);
      expect(paths).toContain("story-engine-backup.json");
      expect(paths).toContain("book/chapters/0001.md");

      const restored = await callExport("/api/books/restore", "POST", backup.body);
      expect(restored.statusCode).toBe(200);
      expect(restored.json).toMatchObject({ ok: true, title: "雾港/来信" });
      expect(String(restored.json.projectPath).startsWith(join(library, "story-engine"))).toBe(true);

      const bad = await callExport("/api/books/restore", "POST", Buffer.from("hello"));
      expect(bad.statusCode).toBe(400);
      expect(bad.json.error).toContain("没恢复");
    } finally {
      if (original === undefined) delete process.env.SE_BOOKS_DIR;
      else process.env.SE_BOOKS_DIR = original;
    }
  });
});

describe("导出接口（P10）", () => {
  it("接口：回附件；格式、范围不对回 400 的人话", async () => {
    const dir = await makeBook();
    const ok = await callExport(`/api/books/export?project=${encodeURIComponent(dir)}&format=docx&drafts=1`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["Content-Disposition"]).toBe(attachmentHeader("雾港_来信.docx"));
    expect(ok.headers["X-Export-Chapters"]).toBe("3");
    expect(ok.body.subarray(0, 2).toString("latin1")).toBe("PK");

    const badFormat = await callExport(`/api/books/export?project=${encodeURIComponent(dir)}&format=pdf`);
    expect(badFormat.statusCode).toBe(400);
    expect(badFormat.json.error).toContain("只能导出");
    const badRange = await callExport(`/api/books/export?project=${encodeURIComponent(dir)}&from=3&to=1`);
    expect(badRange.statusCode).toBe(400);
    const empty = await callExport(`/api/books/export?project=${encodeURIComponent(dir)}&from=3`);
    expect(empty.statusCode).toBe(400);
    expect(empty.json.error).toContain("没导出");
  });

  it("附件头：中文名走 UTF-8 编码，另带 ASCII 兜底", () => {
    expect(attachmentHeader("雾港.txt")).toBe(`attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent("雾港.txt")}`);
  });
});

async function callExport(url: string, method = "GET", upload?: Buffer): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer; json: Record<string, unknown> }> {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown) | undefined;
  registerBookFilesRoutes({ use(next) { handler = next; } });
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 0,
    setHeader: vi.fn((key: string, value: string) => { headers[key] = value; }),
    end(value?: string | Buffer) {
      if (value !== undefined) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8"));
    },
  } as unknown as ServerResponse & { statusCode: number };
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (upload) yield upload;
    },
  } as unknown as IncomingMessage;
  await handler!(req, res, () => undefined);
  const body = Buffer.concat(chunks);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(body.toString("utf-8")) as Record<string, unknown>; } catch { /* 附件 */ }
  return { statusCode: res.statusCode, headers, body, json };
}
