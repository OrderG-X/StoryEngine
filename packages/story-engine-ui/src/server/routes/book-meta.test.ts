// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { registerBookMetaRoutes } from "./book-meta.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("story-engine-meta-");
  dirs.push(dir);
  await writeFile(join(dir, "project.json"), JSON.stringify({ id: "story-m", title: "雾港来信", updatedAt: "2026-10-01T00:00:00.000Z" }), "utf-8");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), "# 第1章\n\n一二三。\n", "utf-8");
  return dir;
}

describe("书的资料 / 归档 / 统计接口（P10）", () => {
  it("改资料：宽进（坏值丢、标签去重）、不碰 updatedAt；读回来带统计", async () => {
    const dir = await makeBook();
    const saved = await call("POST", "/api/books/info", { projectPath: dir, info: { author: " 林某 ", tags: ["悬疑", "悬疑", "", 3], targetWords: "300000", dailyGoal: -5, coverTone: 9 } });
    expect(saved.json).toMatchObject({ ok: true, title: "雾港来信", info: { author: "林某", tags: ["悬疑"], targetWords: 300000 }, archived: false });
    expect((saved.json.info as Record<string, unknown>).dailyGoal).toBeUndefined();
    expect((saved.json.info as Record<string, unknown>).coverTone).toBeUndefined();
    const project = JSON.parse(await readFile(join(dir, "project.json"), "utf-8")) as Record<string, unknown>;
    expect(project.updatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(project.id).toBe("story-m");

    const read = await call("GET", `/api/books/info?project=${encodeURIComponent(dir)}`);
    expect(read.json).toMatchObject({ ok: true, info: { author: "林某" }, stats: { totalWords: 3 } });
  });

  it("归档 / 取消归档；书架批量读归档和封面色，读不到的略过", async () => {
    const dir = await makeBook();
    await call("POST", "/api/books/info", { projectPath: dir, info: { coverTone: 2 } });
    expect((await call("POST", "/api/books/archive", { projectPath: dir, archived: true })).json).toMatchObject({ ok: true, archived: true });
    const meta = await call("POST", "/api/books/meta", { paths: [dir, join(dir, "nope"), "/etc"] });
    expect(meta.json).toEqual({ ok: true, books: { [dir]: { archived: true, coverTone: 2 } } });
    expect((await call("POST", "/api/books/archive", { projectPath: dir, archived: false })).json).toMatchObject({ archived: false });
    expect((await call("POST", "/api/books/archive", { projectPath: dir })).statusCode).toBe(400);
  });

  it("统计接口带上日更目标", async () => {
    const dir = await makeBook();
    await call("POST", "/api/books/info", { projectPath: dir, info: { dailyGoal: 3000 } });
    const stats = await call("GET", `/api/books/stats?project=${encodeURIComponent(dir)}`);
    expect(stats.json).toMatchObject({ ok: true, dailyGoal: 3000, stats: { totalWords: 3, streak: 0 } });
  });
});

async function call(method: string, url: string, body?: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown) | undefined;
  registerBookMetaRoutes({ use(next) { handler = next; } });
  let raw = "";
  const res = { statusCode: 0, setHeader: vi.fn(), end(value?: string) { raw += value ?? ""; } } as unknown as ServerResponse & { statusCode: number };
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf-8");
    },
  } as unknown as IncomingMessage;
  await handler!(req, res, () => undefined);
  return { statusCode: res.statusCode, json: JSON.parse(raw) as Record<string, unknown> };
}
