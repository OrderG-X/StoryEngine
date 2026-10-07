import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { withProjectCommitLock } from "@actalk/story-engine";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { composeDraftFileText, registerChapterWorkspaceRoutes } from "./chapter-workspace.js";

async function realProject(): Promise<string> {
  const dir = await makeHomeTempDir("chapter-workspace-cas-");
  await Promise.all([
    mkdir(join(dir, "story"), { recursive: true }),
    mkdir(join(dir, "timeline"), { recursive: true }),
    mkdir(join(dir, "world"), { recursive: true }),
    mkdir(join(dir, "characters"), { recursive: true }),
  ]);
  await writeFile(join(dir, "project.json"), `${JSON.stringify({ title: "CAS" })}\n`, "utf-8");
  return dir;
}

function request(body: Record<string, unknown>): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "PUT",
    url: "/api/chapter-workspace",
  }) as IncomingMessage;
}

function getRequest(projectPath: string, chapter: number): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url: `/api/chapter-workspace?project=${encodeURIComponent(projectPath)}&chapter=${chapter}`,
  }) as IncomingMessage;
}

async function call(body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> }> {
  const handlers: Middleware[] = [];
  registerChapterWorkspaceRoutes({ use: (handler) => handlers.push(handler) });
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 200,
    setHeader: () => response as unknown as ServerResponse,
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return response as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;
  await handlers[0]!(request(body), response, () => undefined);
  return {
    status: response.statusCode,
    payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
  };
}

async function callGet(projectPath: string, chapter: number): Promise<{ status: number; payload: Record<string, unknown> }> {
  const handlers: Middleware[] = [];
  registerChapterWorkspaceRoutes({ use: (handler) => handlers.push(handler) });
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 200,
    setHeader: () => response as unknown as ServerResponse,
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return response as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;
  await handlers[0]!(getRequest(projectPath, chapter), response, () => undefined);
  return {
    status: response.statusCode,
    payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
  };
}

function saveBody(projectPath: string, draftContent: string, expectedRevision?: number): Record<string, unknown> {
  return {
    projectPath,
    chapter: 1,
    messages: [],
    selectedAdviceCardKeys: [],
    flowStatus: "draft_ready",
    draftContent,
    draftTitle: "第一章",
    writeDraftFile: true,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

describe("chapter workspace revision compare-and-swap", () => {
  it("queues PUT behind formal apply and persists it afterward as revision N+1", async () => {
    const projectDir = await realProject();
    const initial = await call(saveBody(projectDir, "previewed revision N", 0));
    expect(initial).toMatchObject({ status: 200, payload: { snapshot: { revision: 1 } } });

    const applyEntered = deferred<void>();
    const releaseApply = deferred<void>();
    const formalApply = withProjectCommitLock(projectDir, async () => {
      applyEntered.resolve(undefined);
      await releaseApply.promise;
      await mkdir(join(projectDir, "chapters"), { recursive: true });
      await writeFile(join(projectDir, "chapters", "0001.md"), "formal bytes from revision N", "utf-8");
    });
    await applyEntered.promise;

    let putSettled = false;
    const nextPut = call(saveBody(projectDir, "author revision N+1", 1)).then((value) => {
      putSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(putSettled).toBe(false);

    releaseApply.resolve(undefined);
    await formalApply;
    const saved = await nextPut;

    expect(saved).toMatchObject({
      status: 200,
      payload: { snapshot: { revision: 2, draftContent: "author revision N+1\n" } },
    });
    await expect(readFile(join(projectDir, "chapters", "0001.md"), "utf-8"))
      .resolves.toBe("formal bytes from revision N");
    await expect(readFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "utf-8"))
      .resolves.toBe("author revision N+1\n");
  });

  it("recovers project commit residue before GET exposes committed chapter bytes", async () => {
    const projectDir = await realProject();
    const relativePath = "chapters/0001.md";
    const chapterPath = join(projectDir, relativePath);
    const original = "# 第一章\n\n已完成的原始正式正文。\n";
    const contaminated = "# 第一章\n\n事务中途写入、绝不能被 SSE 对账观察。\n";
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(chapterPath, original, "utf-8");
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    const backupPath = "backups/chapters/0001.md";
    await mkdir(join(txDir, "backups", "chapters"), { recursive: true });
    await writeFile(join(txDir, backupPath), original, "utf-8");
    await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
      version: 2,
      chapter: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: [relativePath],
      backups: [{
        relativePath,
        existed: true,
        backupPath,
        sha256: createHash("sha256").update(original, "utf-8").digest("hex"),
      }],
      status: "staged",
    }, null, 2)}\n`, "utf-8");
    await writeFile(chapterPath, contaminated, "utf-8");

    const response = await callGet(projectDir, 1);

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      // 编辑器只拿正文（首行「# 章名」去掉）；磁盘字节仍是原始正式正文（下一行断言）。
      snapshot: { draftContent: "已完成的原始正式正文。\n", hasCommittedChapter: true },
    });
    await expect(readFile(chapterPath, "utf-8")).resolves.toBe(original);
  });

  it("accepts the first client, rejects a second client with the same loaded revision, and keeps the first payload on disk", async () => {
    const projectDir = await realProject();

    const first = await call(saveBody(projectDir, "client one", 0));
    const stale = await call(saveBody(projectDir, "client two", 0));

    expect(first.status).toBe(200);
    expect(first.payload).toMatchObject({ ok: true, snapshot: { revision: 1, draftContent: "client one\n" } });
    expect(stale.status).toBe(409);
    expect(stale.payload).toMatchObject({
      ok: false,
      error: expect.stringContaining("revision"),
      snapshot: { revision: 1, draftContent: "client one\n" },
    });
    const disk = JSON.parse(await readFile(
      join(projectDir, ".story-engine-ui", "chapter-workspaces", "chapter-0001.json"),
      "utf-8",
    )) as { revision: number; draftContent: string };
    expect(disk).toMatchObject({ revision: 1, draftContent: "client one" });
    await expect(readFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "utf-8"))
      .resolves.toBe("client one\n");
  });

  it("increments revision for a legal write and keeps missing expectedRevision backward compatible", async () => {
    const projectDir = await realProject();
    const legacy = await call(saveBody(projectDir, "legacy client"));
    const next = await call(saveBody(projectDir, "versioned client", 1));

    expect(legacy).toMatchObject({ status: 200, payload: { snapshot: { revision: 1 } } });
    expect(next).toMatchObject({ status: 200, payload: { snapshot: { revision: 2, draftContent: "versioned client\n" } } });
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("composeDraftFileText：autosave 写工作稿时保住第一行章名（定稿取章名的唯一来源）", () => {
  it("正文不带标题行 + 请求带真章名 → 补「# 章名」", async () => {
    const dir = await makeHomeTempDir("draft-title-");
    expect(await composeDraftFileText(join(dir, "none.md"), "下午三点。\n\n她推门。", "夹在书页里的信"))
      .toBe("# 夹在书页里的信\n\n下午三点。\n\n她推门。\n");
  });

  it("请求只带占位章名 → 沿用磁盘上原有的标题行；都没有 → 只写正文", async () => {
    const dir = await makeHomeTempDir("draft-title-keep-");
    const path = join(dir, "chapter-0001.md");
    await writeFile(path, "# 夹在书页里的信\n\n旧正文\n");
    expect(await composeDraftFileText(path, "新正文", "第1章")).toBe("# 夹在书页里的信\n\n新正文\n");
    expect(await composeDraftFileText(join(dir, "missing.md"), "新正文", "第1章")).toBe("新正文\n");
  });

  it("正文自带标题行 → 原样写", async () => {
    const dir = await makeHomeTempDir("draft-title-own-");
    expect(await composeDraftFileText(join(dir, "x.md"), "# 自带标题\n\n正文", "别的标题")).toBe("# 自带标题\n\n正文\n");
  });
});
