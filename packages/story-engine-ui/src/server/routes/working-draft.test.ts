import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { chapterCommit, readChapterLedger, readDraft, runCommand } from "@actalk/story-core";
import { draftSha, readDraftCandidate, readDraftRecovery, saveDraftCandidate } from "../lib/draft-candidates.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { listSnapshots } from "../lib/snapshot.js";
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

async function call(method: "GET" | "PUT" | "POST", url: string, body?: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown>; nextCalled: boolean }> {
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
/** 稿纸窗口号（前端每开一次稿纸一个）。 */
const WINDOW = "testwindow01";
const draftPath = (project: string, chapter: number) => join(project, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`);

describe("/api/working-draft", () => {
  it("新章读到 null；带 null 存进去，再读拿到同一个版本号", async () => {
    const project = await realProject();
    expect((await call("GET", getUrl(project, 1))).payload).toEqual({ ok: true, paper: { chapter: 1, draft: null, draftVersion: null, committed: null, editedSinceCommit: null } });
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

  it("撞版本：作者那份存成恢复稿（号带回去），接着打的同一底版存进同一份；开这一章提示；找回 → 写进工作稿、可撤销、恢复稿删掉（写作版本 P1b）", async () => {
    const project = await realProject();
    const first = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 2, body: "第一版。", baseVersion: null });
    await writeFile(draftPath(project, 2), "AI 改过的。\n", "utf-8");
    const stale = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 2, body: "作者的。", baseVersion: first.payload.version, client: WINDOW, seq: 1 });
    expect(stale.status).toBe(409);
    const recoveryId = String(stale.payload.recoveryId);
    expect(await readDraftRecovery(project, recoveryId)).toMatchObject({ chapter: 2, body: "作者的。", baseVersion: first.payload.version });
    const again = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 2, body: "作者的。又加一句。", baseVersion: first.payload.version, client: WINDOW, seq: 2 });
    expect(again.payload.recoveryId).toBe(recoveryId);
    expect((await readDraftRecovery(project, recoveryId))?.body).toBe("作者的。又加一句。");
    // 迟到的旧笔（序号小）不把新字倒写回去。
    const late = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 2, body: "作者的。", baseVersion: first.payload.version, client: WINDOW, seq: 1 });
    expect(late.status).toBe(409);
    expect((await readDraftRecovery(project, recoveryId))?.body).toBe("作者的。又加一句。");

    const opened = await call("GET", getUrl(project, 2));
    const pending = (opened.payload.paper as Record<string, unknown>).pending as Record<string, unknown>;
    expect(pending).toMatchObject({ kind: "recovery", id: recoveryId, body: "作者的。又加一句。", sha: draftSha({ body: "作者的。又加一句。" }) });

    const disk = (await readDraft(project, 2))!;
    const adopted = await call("POST", "/api/working-draft/pending", { projectPath: project, chapter: 2, kind: "recovery", id: recoveryId, sha: pending.sha, decision: "adopt", baseVersion: disk.version });
    expect(adopted.status).toBe(200);
    expect(typeof adopted.payload.snapshotId).toBe("string");
    expect((await readDraft(project, 2))?.body).toBe("作者的。又加一句。");
    // 找回了：正文清空、序号留着（再迟到的旧笔也不写回来）。
    expect(await readDraftRecovery(project, recoveryId)).toMatchObject({ body: "", seq: 2 });
    expect((await listSnapshots(project)).some((entry) => entry.label.includes("找回没存上的稿：第2章"))).toBe(true);
    expect(((await call("GET", getUrl(project, 2))).payload.paper as Record<string, unknown>).pending).toBeUndefined();
  });

  it("AI 候选：开章提示；换上 / 不要了不走这里（P2a 片 2D 起交 draft.adopt / draft.discard 操作），候选不动", async () => {
    const project = await realProject();
    const saved = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 3, body: "作者的稿。", baseVersion: null });
    const candidate = await saveDraftCandidate(project, { chapter: 3, title: "", body: "AI 写的一版。", baseVersion: null, basisDigest: "d", source: "draft", status: "ready", reason: "draft_moved" });
    const pending = ((await call("GET", getUrl(project, 3))).payload.paper as Record<string, unknown>).pending as Record<string, unknown>;
    expect(pending).toMatchObject({ kind: "candidate", id: candidate.id, reason: "draft_moved", body: "AI 写的一版。" });

    for (const decision of ["adopt", "dismiss"]) {
      const refused = await call("POST", "/api/working-draft/pending", { projectPath: project, chapter: 3, kind: "candidate", id: candidate.id, sha: pending.sha, decision, baseVersion: saved.payload.version });
      expect(refused.status).toBe(400);
    }
    expect((await readDraft(project, 3))?.body).toBe("作者的稿。");
    expect(await readDraftCandidate(project, candidate.id)).toMatchObject({ body: "AI 写的一版。" });
  });

  it("存上的和恢复稿一样 → 恢复稿清掉；和工作稿一样的候选不提示", async () => {
    const project = await realProject();
    const first = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 4, body: "第一版。", baseVersion: null });
    await writeFile(draftPath(project, 4), "别处改的。\n", "utf-8");
    const stale = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 4, body: "作者的。", baseVersion: first.payload.version });
    const disk = (await readDraft(project, 4))!;
    await call("PUT", "/api/working-draft", { projectPath: project, chapter: 4, body: "作者的。", baseVersion: disk.version });
    expect(await readDraftRecovery(project, String(stale.payload.recoveryId))).toMatchObject({ body: "" });
    await saveDraftCandidate(project, { chapter: 4, title: "", body: "作者的。", baseVersion: null, basisDigest: "d", source: "draft", status: "ready", reason: "draft_moved" });
    expect(((await call("GET", getUrl(project, 4))).payload.paper as Record<string, unknown>).pending).toBeUndefined();
  });

  it("baseVersion 缺了不收", async () => {
    const project = await realProject();
    const bad = await call("PUT", "/api/working-draft", { projectPath: project, chapter: 1, body: "x" });
    expect(bad.status).toBe(500);
    expect(String(bad.payload.error)).toContain("baseVersion");
  });

  it("改已定稿的章名（真机试写：定稿前忘起章名，定稿后改不了）：换定稿第一行、工作稿一起换，存档可撤销；没定稿的、点第二次如实说", async () => {
    const project = await realProject();
    const notYet = await call("POST", "/api/chapter-title", { projectPath: project, chapter: 1, title: "回乡", requestId: "r0" });
    expect(notYet.status).toBe(409);
    expect(notYet.payload).toMatchObject({ ok: false, code: "not_committed" });

    const text = "青石巷的路灯是十一点灭的。\n\n她拖着箱子走到巷子中间。\n";
    await call("PUT", "/api/working-draft", { projectPath: project, chapter: 1, body: text, baseVersion: null });
    const committed = await runCommand(project, chapterCommit, { chapter: 1, text, entries: [] }, { caller: "author", idempotencyKey: "c1" });
    expect(committed.ok).toBe(true);
    expect(await call("POST", "/api/chapter-title", { projectPath: project, chapter: 1, title: "回乡" })).toMatchObject({ status: 400 });

    const renamed = await call("POST", "/api/chapter-title", { projectPath: project, chapter: 1, title: "回乡", requestId: "r1" });
    expect(renamed.status).toBe(200);
    expect(renamed.payload).toMatchObject({ ok: true, title: "回乡", unchanged: false, snapshotId: expect.any(String) });
    const committedText = await readFile(join(project, "chapters", "0001.md"), "utf-8");
    expect(committedText).toBe(`# 回乡\n\n${text}`);
    expect((await readChapterLedger(project, 1))?.entries).toEqual([]);
    expect(await readFile(draftPath(project, 1), "utf-8")).toBe(`# 回乡\n\n${text}`);

    const again = await call("POST", "/api/chapter-title", { projectPath: project, chapter: 1, title: "回乡", requestId: "r1" });
    expect(again.payload).toMatchObject({ ok: true, title: "回乡" });
    expect(again.payload.snapshotId).toBeUndefined();
  }, 30_000);

  it("别的路径交给下一个中间件（不吞前缀相近的路径）", async () => {
    const other = await call("GET", "/api/working-drafts");
    expect(other.nextCalled).toBe(true);
  });
});
