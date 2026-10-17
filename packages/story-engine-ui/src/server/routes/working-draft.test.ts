import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { registerWorkingDraftRoutes } from "./working-draft.js";

async function realProject(): Promise<string> {
  const dir = await makeHomeTempDir("working-draft-");
  await Promise.all([
    mkdir(join(dir, "story"), { recursive: true }),
    mkdir(join(dir, "timeline"), { recursive: true }),
    mkdir(join(dir, "world"), { recursive: true }),
    mkdir(join(dir, "characters"), { recursive: true }),
  ]);
  await writeFile(join(dir, "project.json"), `${JSON.stringify({ title: "存稿" })}\n`, "utf-8");
  return dir;
}

async function call(method: "GET" | "PUT", url: string, body?: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown>; nextCalled: boolean }> {
  const handlers: Middleware[] = [];
  registerWorkingDraftRoutes({ use: (handler) => handlers.push(handler) });
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 200,
    setHeader: () => response as unknown as ServerResponse,
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return response as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;
  const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url }) as IncomingMessage;
  let nextCalled = false;
  await handlers[0]!(request, response, () => { nextCalled = true; });
  return {
    status: response.statusCode,
    payload: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> : {},
    nextCalled,
  };
}

const getUrl = (project: string, chapter: number) => `/api/working-draft?project=${encodeURIComponent(project)}&chapter=${chapter}`;
const draftPath = (project: string, chapter: number) => join(project, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`);

describe("/api/working-draft", () => {
  it("新章读到 null；带 null 存进去，再读拿到同一个版本号", async () => {
    const project = await realProject();
    expect((await call("GET", getUrl(project, 1))).payload).toEqual({ ok: true, paper: { chapter: 1, draft: null, committed: null, editedSinceCommit: null } });
    const saved = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 1, title: "钟停", body: "钟停了。", baseVersion: null });
    expect(saved.status).toBe(200);
    expect(saved.payload).toMatchObject({ ok: true, unchanged: false });
    expect(await readFile(draftPath(project, 1), "utf-8")).toBe("# 钟停\n\n钟停了。\n");
    const read = await call("GET", getUrl(project, 1));
    expect((read.payload.paper as Record<string, unknown>).draft).toEqual({ chapter: 1, title: "钟停", body: "钟停了。", version: saved.payload.version });
  });

  it("拿旧版本号存：409，带回盘上那份，不写", async () => {
    const project = await realProject();
    const first = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 2, body: "第一版。", baseVersion: null });
    await writeFile(draftPath(project, 2), "AI 改过的。\n", "utf-8");
    const stale = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 2, body: "作者的。", baseVersion: first.payload.version });
    expect(stale.status).toBe(409);
    expect(stale.payload).toMatchObject({ ok: false, code: "draft_conflict", current: { chapter: 2, body: "AI 改过的。" } });
    expect(await readFile(draftPath(project, 2), "utf-8")).toBe("AI 改过的。\n");
  });

  it("baseVersion 缺了不收", async () => {
    const project = await realProject();
    const bad = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 1, body: "x" });
    expect(bad.status).toBe(500);
    expect(String(bad.payload.error)).toContain("baseVersion");
  });

  it("别的路径交给下一个中间件（不吞 /api/draft/…）", async () => {
    const other = await call("GET", "/api/draft/generate");
    expect(other.nextCalled).toBe(true);
  });
});
