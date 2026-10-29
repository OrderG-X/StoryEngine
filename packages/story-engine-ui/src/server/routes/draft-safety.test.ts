// @vitest-environment node
//
// 作者的字不丢、旧依据写的不换上（写作版本 P1b 第 3、4 轮复核，Astra 的 B1～B10、R1～R4 探针收成回归）。
// 真核心、真路由、真稿纸存盘调度、真撤销；只换模型输出和 fetch 传输。写盘故障、调度屏障都在 rename 上注入（标明了）。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardWrite, chapterCommit, draftPath, draftSave, readDraft, readDraftState, readTruthBasis, runCommand, sha256, withBookLock } from "@actalk/story-core";
import { __resetDraftSyncForTests, editDraft, flushDraftSave, openPaper, UnsavedPaperError } from "../../drafts/draftSync.js";
import { useDraftStore } from "../../stores/draftStore.js";
import * as overviewModule from "../book/state-overview.js";
import { createStoryProject } from "../book/project-store.js";
import { applyAiDraft } from "../lib/ai-draft-write.js";
import { freshRevision } from "../lib/book-backup.js";
import { writeCards } from "../lib/card-write.js";
import { pendingDraftFor, readDraftRecovery } from "../lib/draft-candidates.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { createSnapshot, restoreSnapshot } from "../lib/snapshot.js";
import { applyRevision, previewRevision, reviseDraftOneShot } from "../services/revision-service.js";
import * as contextModule from "../writing/writing-context-pack.js";
import { registerWorkingDraftRoutes } from "./working-draft.js";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      await hooks.beforeRename?.(String(from), String(to));
      await real.rename(from, to);
      await hooks.afterRename?.(String(from), String(to));
    },
  };
});

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("draft-safety-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "存稿安全", genre: "都市", protagonistName: "张三" }));
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
});
afterEach(async () => {
  hooks.beforeRename = undefined;
  hooks.afterRename = undefined;
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(rootDir, { recursive: true, force: true });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}
const eio = (what: string) => Object.assign(new Error(`测试注入：${what}`), { code: "EIO" });

async function save(chapter: number, body: string): Promise<string> {
  const baseVersion = (await readDraftState(book, chapter)).version;
  const outcome = await runCommand(book, draftSave, { chapter, body, baseVersion }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result.version;
}
async function begin(chapter: number) {
  return { basis: await readTruthBasis(book), baseVersion: (await readDraftState(book, chapter)).version };
}

async function call(method: string, url: string, body?: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> }> {
  const handlers: Middleware[] = [];
  registerWorkingDraftRoutes({ use: (handler) => handlers.push(handler) });
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 200,
    setHeader: () => response,
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      return response;
    },
  } as unknown as ServerResponse;
  const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url }) as IncomingMessage;
  await handlers[0]!(request, response, () => { throw new Error("没进存稿路由"); });
  return { status: response.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> };
}

/** 稿纸的 fetch 直接接到真路由上。 */
function wireRealRoutes() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { puts: () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").length };
}

describe("稿纸存稿撞版本：作者的字找得回", () => {
  it("新章（还没稿）撞了版本：恢复稿换章再回来能找回（B1）", async () => {
    wireRealRoutes();
    await openPaper(book, 1);
    editDraft("作者在 AI 回合里打的第一段。");
    expect(await applyAiDraft(book, { chapter: 1, body: "AI 先落盘了。", ...(await begin(1)), source: "draft" })).toMatchObject({ applied: true });
    expect(await flushDraftSave()).toEqual({ ok: true });
    const id = useDraftStore.getState().incoming?.recoveryId;
    expect(typeof id).toBe("string");
    await openPaper(book, 2);
    await openPaper(book, 1);
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", id, body: "作者在 AI 回合里打的第一段。" });
    expect(useDraftStore.getState().incoming?.pending).toMatchObject({ kind: "recovery", id });
  });

  it("恢复稿没写进去：不算存上，换不了章，过后重试存进恢复稿（B4）", async () => {
    const routes = wireRealRoutes();
    await save(1, "原稿。");
    await openPaper(book, 1);
    editDraft("作者唯一的一段新字。");
    await save(1, "其他窗口已改。");
    hooks.beforeRename = async (_from, to) => {
      if (to.includes("/agents/drafts/recovery/")) throw eio("恢复稿写盘失败");
    };
    const failed = await flushDraftSave();
    expect(failed.ok).toBe(false);
    expect(useDraftStore.getState().saveError).toBeTruthy();
    await expect(openPaper(book, 2)).rejects.toBeInstanceOf(UnsavedPaperError);
    expect(useDraftStore.getState()).toMatchObject({ chapter: 1, body: "作者唯一的一段新字。" });
    const before = routes.puts();
    hooks.beforeRename = undefined;
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(routes.puts()).toBeGreaterThan(before);
    await openPaper(book, 2);
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: "作者唯一的一段新字。" });
  });

  it("两个窗口同一底版撞版本：各留一份，谁也不盖谁（B6）", async () => {
    const base = await save(1, "两个窗口共同的底稿。");
    await save(1, "AI 改过。");
    const first = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "窗口甲的独立段落。", baseVersion: base, client: "windowjia01", seq: 1 });
    const second = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "窗口乙的另一段落。", baseVersion: base, client: "windowyi001", seq: 1 });
    expect([first.status, second.status]).toEqual([409, 409]);
    expect(first.payload.recoveryId).not.toBe(second.payload.recoveryId);
    expect((await readDraftRecovery(book, String(first.payload.recoveryId)))?.body).toBe("窗口甲的独立段落。");
    expect((await readDraftRecovery(book, String(second.payload.recoveryId)))?.body).toBe("窗口乙的另一段落。");
    // 找回乙那份之后，甲那份还提示。
    const shown = (await pendingDraftFor(book, 1))!;
    const adopted = await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: shown.kind, id: shown.id, sha: shown.sha, decision: "adopt", baseVersion: (await readDraft(book, 1))!.version });
    expect(adopted.status).toBe(200);
    const left = await pendingDraftFor(book, 1);
    expect(left?.kind).toBe("recovery");
    expect(left?.id).not.toBe(shown.id);
  });

  it("同一窗口的旧笔迟到：不把恢复稿里的新字倒写回去（B6-order）", async () => {
    const base = await save(1, "底稿。");
    await save(1, "AI 工作稿。");
    const newer = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "作者旧字。又补的新字。", baseVersion: base, client: "windowjia01", seq: 2 });
    const late = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "作者旧字。", baseVersion: base, client: "windowjia01", seq: 1 });
    expect([newer.status, late.status]).toEqual([409, 409]);
    expect(late.payload.recoveryId).toBe(newer.payload.recoveryId);
    expect((await readDraftRecovery(book, String(newer.payload.recoveryId)))?.body).toBe("作者旧字。又补的新字。");
  });

  it("找回和接着存的那一笔排在一起：先后哪样，后存的新字都还在（B5）", async () => {
    for (const adoptFirst of [false, true]) {
      const chapter = adoptFirst ? 2 : 1;
      const base = await save(chapter, "底稿。");
      await save(chapter, "当前工作稿。");
      const put = (body: string, seq: number) => call("PUT", "/api/working-draft", { projectPath: book, chapter, body, baseVersion: base, client: "windowjia01", seq });
      expect((await put("恢复稿旧字。", 1)).status).toBe(409);
      const shown = (await pendingDraftFor(book, chapter))!;
      const current = (await readDraft(book, chapter))!;
      const adopt = () => call("POST", "/api/working-draft/pending", { projectPath: book, chapter, kind: "recovery", id: shown.id, sha: shown.sha, decision: "adopt", baseVersion: current.version });
      const locked = barrier();
      const unlock = barrier();
      const holder = withBookLock(book, async () => { locked.release(); await unlock.promise; });
      await locked.promise;
      const [first, second] = adoptFirst ? [adopt(), put("恢复稿旧字。刚追加的重要句子。", 2)] : [put("恢复稿旧字。刚追加的重要句子。", 2), adopt()];
      unlock.release();
      await holder;
      await Promise.all([first, second]);
      const draft = (await readDraft(book, chapter))!;
      const recovery = await readDraftRecovery(book, shown.id);
      expect(draft.body.includes("重要句子") || recovery?.body.includes("重要句子")).toBe(true);
    }
  });

  it("撤销回同一份底稿：照撤销前发的旧存稿对不上，不盖回去（B10）", async () => {
    const base = await save(1, "作者选定要恢复的底稿。");
    const before = await createSnapshot(book, "原底稿");
    const oldRequest = { projectPath: book, chapter: 1, body: "之前存过、后来撤销的 A。", baseVersion: base };
    expect((await call("PUT", "/api/working-draft", oldRequest)).status).toBe(200);
    expect(await applyAiDraft(book, { chapter: 1, body: "AI 后来改的 B。", ...(await begin(1)), source: "revise" })).toMatchObject({ applied: true });
    await restoreSnapshot(book, before.id);
    const restored = (await readDraft(book, 1))!;
    expect(restored.body).toBe("作者选定要恢复的底稿。");
    expect(restored.version).not.toBe(base);
    expect((await call("PUT", "/api/working-draft", oldRequest)).status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("作者选定要恢复的底稿。");
  });

  it("撤销回「这章还没稿」：照撤销前那个「没稿」发的旧存稿对不上，撤销掉的字不复活（R1）", async () => {
    expect(await readDraft(book, 1)).toBeUndefined();
    const before = await createSnapshot(book, "还没写首稿");
    const oldRequest = { projectPath: book, chapter: 1, body: "已经撤销的首稿 A。", baseVersion: null, client: "samewindow01", seq: 1 };
    expect((await call("PUT", "/api/working-draft", oldRequest)).status).toBe(200);
    expect(await applyAiDraft(book, { chapter: 1, body: "后来 AI 的 B。", ...(await begin(1)), source: "revise" })).toMatchObject({ applied: true });
    await restoreSnapshot(book, before.id);
    const state = await readDraftState(book, 1);
    expect(state.file).toBeUndefined();
    expect(state.version).not.toBeNull();
    const replay = await call("PUT", "/api/working-draft", oldRequest);
    expect(replay.status).toBe(409);
    expect(replay.payload.currentVersion).toBe(state.version);
    expect(await readDraft(book, 1)).toBeUndefined();
    // 稿纸照新的「没稿」版本存就存得上。
    expect((await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "撤销后重新写的。", baseVersion: state.version, client: "samewindow01", seq: 2 })).status).toBe(200);
  });

  it("本窗口迟到的旧「不要了」：后来存进恢复稿的新字不清（R2）", async () => {
    const base = await save(1, "原稿。");
    await save(1, "AI 改的稿。");
    const request = { projectPath: book, chapter: 1, baseVersion: base, client: "samewindow02" };
    const first = await call("PUT", "/api/working-draft", { ...request, body: "旧恢复稿。", seq: 1 });
    const next = await call("PUT", "/api/working-draft", { ...request, body: "后来新添、只在恢复稿里的字。", seq: 2 });
    expect([first.status, next.status]).toEqual([409, 409]);
    const late = await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: first.payload.recoveryId, sha: "", decision: "dismiss", baseVersion: null, client: request.client, seq: 1 });
    expect(late.status).toBe(200);
    expect((await readDraftRecovery(book, String(next.payload.recoveryId)))?.body).toBe("后来新添、只在恢复稿里的字。");
    // 本窗口当前的「不要了」照样清。
    expect((await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: next.payload.recoveryId, sha: "", decision: "dismiss", baseVersion: null, client: request.client, seq: 2 })).status).toBe(200);
    expect((await readDraftRecovery(book, String(next.payload.recoveryId)))?.body).toBe("");
  });

  it("本窗口迟到的旧存稿恰好和盘上一样（算存上）：不顺手清掉后来那几笔的恢复稿（R2）", async () => {
    const base = await save(1, "原稿。");
    const request = { projectPath: book, chapter: 1, baseVersion: base, client: "samewindow03" };
    const old = { ...request, body: "旧笔已存成工作稿。", seq: 1 };
    expect((await call("PUT", "/api/working-draft", old)).status).toBe(200);
    const newer = await call("PUT", "/api/working-draft", { ...request, body: "新笔新增的重要句子。", seq: 2 });
    expect(newer.status).toBe(409);
    expect((await call("PUT", "/api/working-draft", old)).status).toBe(200);
    expect((await readDraftRecovery(book, String(newer.payload.recoveryId)))?.body).toBe("新笔新增的重要句子。");
  });

  it("书从备份 / 回收站搬回来：稿纸上照原来那版发的存稿对不上", async () => {
    const base = await save(1, "搬走前的稿。");
    await freshRevision(book);
    expect((await readDraft(book, 1))?.version).not.toBe(base);
    expect((await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "旧窗口的字。", baseVersion: base })).status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("搬走前的稿。");
  });
});

describe("AI 写的稿：旧依据不换上，换不上的整份留着", () => {
  it("两步改稿：预览后作者改了设定，应用时不换上、留成候选（B2）", async () => {
    await save(1, "他推开门。");
    expect(await writeCards(book, { by: "author", ops: [{ op: "field.set", card: "张三", label: "籍贯", value: "海州" }], idempotencyKey: "origin-a" })).toMatchObject({ ok: true });
    const preview = await previewRevision({
      projectDir: book,
      chapter: 1,
      task: { id: "r-preview", chapter: 1, targetType: "paragraph", targetText: "他推开门。", problemSummary: "身份不明", revisionGoal: "点明籍贯", constraints: [], status: "pending" },
      callModel: async (prompt) => {
        expect(prompt).toContain("海州");
        return JSON.stringify({ beforeText: "他推开门。", afterText: "海州来的张三推开门。" });
      },
    });
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(await writeCards(book, { by: "author", ops: [{ op: "field.set", card: "张三", label: "籍贯", value: "京城" }], idempotencyKey: "origin-b" })).toMatchObject({ ok: true });
    const applied = await applyRevision({ projectDir: book, chapter: 1, preview: preview.preview, targetText: "他推开门。" });
    expect(applied).toMatchObject({ ok: false, code: "draft_kept" });
    expect((await readDraft(book, 1))?.body).toBe("他推开门。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "candidate", reason: "basis_moved", body: "海州来的张三推开门。" });
  });

  it("两步改稿：预览没记依据（升级前的旧预览）→ 不换，如实说要重新预览", async () => {
    await save(1, "他推开门。");
    const applied = await applyRevision({ projectDir: book, chapter: 1, preview: { beforeText: "他推开门。", afterText: "他推开了门。" } as never, targetText: "他推开门。" });
    expect(applied).toMatchObject({ ok: false, code: "preview_stale" });
    expect((await readDraft(book, 1))?.body).toBe("他推开门。");
  });

  it("升级前崩溃留下的老格式定稿事务：先收拾再核依据，照没收拾的半截前文写的不换上（R9）", async () => {
    expect(await runCommand(book, chapterCommit, { chapter: 1, text: "前文：他叫张三。", entries: [] }, { caller: "author", idempotencyKey: "legacy-seed" })).toMatchObject({ ok: true });
    const relative = "chapters/0001.md";
    const tx = join(book, ".story-engine-tx/commit-chapter-0001");
    const original = await readFile(join(book, relative), "utf-8");
    await mkdir(join(tx, "backups/chapters"), { recursive: true });
    await writeFile(join(tx, "backups", relative), original);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ version: 2, chapter: 1, createdAt: "2026-10-20T00:00:00.000Z", files: [relative], backups: [{ relativePath: relative, existed: true, backupPath: `backups/${relative}`, sha256: sha256(original) }], status: "staged" }));
    await writeFile(join(book, relative), "前文：他叫李四。");
    const basis = await readTruthBasis(book);
    const result = await applyAiDraft(book, { chapter: 2, body: "李四带着钥匙来了。", baseVersion: null, basis, source: "revise" });
    expect(await readFile(join(book, relative), "utf-8")).toBe(original);
    expect(JSON.parse(await readFile(join(tx, "manifest.json"), "utf-8")).status).toBe("recovered");
    expect(result).toMatchObject({ applied: false, reason: "basis_moved" });
    expect(await readDraft(book, 2)).toBeUndefined();
  });

  it("最新那份候选碰巧和工作稿一样：更早那份作者还没处理的照样提示（R4）", async () => {
    await save(1, "底稿。");
    const old = await begin(1);
    await save(1, "作者已改。");
    expect(await applyAiDraft(book, { chapter: 1, body: "作者还没处理的 AI 方案 A。", ...old, source: "revise" })).toMatchObject({ applied: false });
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(await applyAiDraft(book, { chapter: 1, body: "AI 方案 B。", ...old, source: "revise" })).toMatchObject({ applied: false });
    await save(1, "AI 方案 B。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "candidate", body: "作者还没处理的 AI 方案 A。" });
  });

  it("换上那一下写盘失败：原稿不动，AI 那份整份留成候选（B7）", async () => {
    await save(1, "作者原稿。");
    const begun = await begin(1);
    let injected = false;
    hooks.beforeRename = async (from, to) => {
      if (from.includes("/staged/") && to === join(book, draftPath(1))) {
        injected = true;
        throw eio("工作稿写盘失败");
      }
    };
    const outcome = await applyAiDraft(book, { chapter: 1, body: "已经生成完的 AI 改稿。", ...begun, source: "revise" });
    expect(injected).toBe(true);
    expect(outcome).toMatchObject({ applied: false, reason: "apply_failed" });
    expect((await readDraft(book, 1))?.body).toBe("作者原稿。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "candidate", reason: "apply_failed", body: "已经生成完的 AI 改稿。" });
  });

  it("事务写到一半时开工、事务失败回滚：照中途那版写的不换上（B8）", async () => {
    expect(await runCommand(book, chapterCommit, { chapter: 1, text: "他叫张三。", entries: [] }, { caller: "author", idempotencyKey: "seed-a" })).toMatchObject({ ok: true });
    const revisionSwapped = barrier();
    const allowText = barrier();
    const textSwapped = barrier();
    const failRest = barrier();
    hooks.afterRename = async (from, to) => {
      if (!from.includes("/staged/")) return;
      if (to === join(book, "store-control/revision.json")) { revisionSwapped.release(); await allowText.promise; }
      if (to === join(book, "chapters/0001.md")) { textSwapped.release(); await failRest.promise; }
    };
    hooks.beforeRename = async (from, to) => {
      if (from.includes("/staged/") && to === join(book, "ledger/chapters/0001.json")) throw eio("正文换上后账单写盘失败");
    };
    const failedWrite = runCommand(book, chapterCommit, { chapter: 1, text: "他叫李四。", entries: [] }, { caller: "author", idempotencyKey: "failed-b" });
    try {
      await revisionSwapped.promise;
      const basis = await readTruthBasis(book);
      allowText.release();
      await textSwapped.promise;
      expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe("他叫李四。");
      failRest.release();
      expect(await failedWrite).toMatchObject({ ok: false });
      expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe("他叫张三。");
      const applied = await applyAiDraft(book, { chapter: 2, body: "李四把钥匙交了出去。", baseVersion: null, basis, source: "draft" });
      expect(applied).toMatchObject({ applied: false, reason: "basis_moved" });
      expect(await readDraft(book, 2)).toBeUndefined();
    } finally {
      allowText.release();
      failRest.release();
      await failedWrite;
    }
  });

  it("改稿服务读到了事务中途的设定、事务回滚：改出来的不换上（B8-service）", async () => {
    await save(1, "他推开门。");
    expect(await runCommand(book, cardWrite, { ops: [{ op: "field.set", card: "张三", label: "籍贯", value: "海州" }] }, { caller: "author", idempotencyKey: "seed-card-a" })).toMatchObject({ ok: true });
    const revisionSwapped = barrier();
    const allowCard = barrier();
    const cardSwapped = barrier();
    const failRest = barrier();
    hooks.afterRename = async (from, to) => {
      if (!from.includes("/staged/")) return;
      if (to === join(book, "store-control/revision.json")) { revisionSwapped.release(); await allowCard.promise; }
      if (to === join(book, "ledger/cards.json")) { cardSwapped.release(); await failRest.promise; }
    };
    hooks.beforeRename = async (from, to) => {
      if (from.includes("/staged/") && to.includes("/ledger/receipts/")) throw eio("设定已换、回执写盘失败");
    };
    const failedWrite = runCommand(book, cardWrite, { ops: [{ op: "field.set", card: "张三", label: "籍贯", value: "京城" }] }, { caller: "author", idempotencyKey: "failed-card-b" });
    const originalOverview = overviewModule.buildStateOverview;
    const originalContext = contextModule.buildWritingContextPack;
    // 两个材料构建器在读完开工依据之后才进来：只加调度屏障，材料照真的读。
    vi.spyOn(overviewModule, "buildStateOverview").mockImplementation(async (...args) => {
      allowCard.release();
      await cardSwapped.promise;
      return originalOverview(...args);
    });
    vi.spyOn(contextModule, "buildWritingContextPack").mockImplementation(async (...args) => {
      allowCard.release();
      await cardSwapped.promise;
      return originalContext(...args);
    });
    try {
      await revisionSwapped.promise;
      const outcome = await reviseDraftOneShot({
        projectDir: book,
        chapter: 1,
        targetText: "他推开门。",
        revisionGoal: "点明籍贯",
        callModel: async (prompt) => {
          expect(prompt).toContain("京城");
          failRest.release();
          expect(await failedWrite).toMatchObject({ ok: false });
          return JSON.stringify({ beforeText: "他推开门。", afterText: "京城来的张三推开门。" });
        },
      });
      expect(await readFile(join(book, "ledger/cards.json"), "utf-8")).toContain("海州");
      expect(outcome.ok).toBe(false);
      expect((await readDraft(book, 1))?.body).toBe("他推开门。");
    } finally {
      allowCard.release();
      failRest.release();
      await failedWrite;
    }
  });
});
