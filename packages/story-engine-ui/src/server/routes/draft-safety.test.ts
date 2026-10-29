// @vitest-environment node
//
// 作者的字不丢、旧依据写的不换上（写作版本 P1b 第 3、4 轮复核，Astra 的 B1～B10、R1～R4 探针收成回归）。
// 真核心、真路由、真稿纸存盘调度、真撤销；只换模型输出和 fetch 传输。写盘故障、调度屏障都在 rename 上注入（标明了）。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardWrite, chapterCommit, draftPath, draftSave, parseDraftFile, readDraft, readDraftState, readTruthBasis, runCommand, sha256, withBookLock } from "@actalk/story-core";
import { __resetDraftSyncForTests, acceptPaperIncoming, editDraft, flushDraftSave, hasFailedUnsavedDraft, isOwnSavedVersion, keepPaperMine, openPaper, refreshPaper, saveDraftKeepalive, scheduleDraftSave, UnsavedPaperError } from "../../drafts/draftSync.js";
import { isDraftDirty, useDraftStore } from "../../stores/draftStore.js";
import { setCommitIoTestHookForTests } from "../book/legacy-commit-recovery.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import { createStoryProject } from "../book/project-store.js";
import { applyAiDraft } from "../lib/ai-draft-write.js";
import { freshRevision } from "../lib/book-backup.js";
import { writeCards } from "../lib/card-write.js";
import { draftSha, pendingDraftFor, readDraftCandidate, readDraftRecovery, readSaveMark, saveDraftCandidate } from "../lib/draft-candidates.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { createSnapshot, restoreSnapshot } from "../lib/snapshot.js";
import { applyRevision, previewRevision, reviseDraftOneShot } from "../services/revision-service.js";
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
  setCommitIoTestHookForTests(undefined);
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
  return { basis: await readTruthBasis(book), baseVersion: (await readDraftState(book, chapter)).version, materials: [] };
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
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "AI 先落盘了。", ...(await begin(1)), source: "draft" })).toMatchObject({ applied: true });
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
    expect(late.payload).toMatchObject({ code: "stale_save" });
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
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "AI 后来改的 B。", ...(await begin(1)), source: "revise" })).toMatchObject({ applied: true });
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
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "后来 AI 的 B。", ...(await begin(1)), source: "revise" })).toMatchObject({ applied: true });
    await restoreSnapshot(book, before.id);
    const state = await readDraftState(book, 1);
    expect(state.file).toBeUndefined();
    expect(state.version).not.toBeNull();
    // 同一笔重发：序号挡下；同一窗口照旧「没稿」再发一笔：版本号挡下（撤销换了纪元，盘上不是这个窗口存成的那版，不顺着接）。
    expect((await call("PUT", "/api/working-draft", oldRequest)).payload).toMatchObject({ code: "stale_save" });
    const replay = await call("PUT", "/api/working-draft", { ...oldRequest, seq: 2 });
    expect(replay.status).toBe(409);
    expect(replay.payload.currentVersion).toBe(state.version);
    expect(await readDraft(book, 1)).toBeUndefined();
    // 稿纸照新的「没稿」版本存就存得上。
    expect((await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "撤销后重新写的。", baseVersion: state.version, client: "samewindow01", seq: 3 })).status).toBe(200);
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

  it("本窗口迟到的旧存稿（哪怕和盘上一样）：不写，也不顺手清掉后来那几笔的恢复稿（R2）", async () => {
    const base = await save(1, "原稿。");
    const request = { projectPath: book, chapter: 1, client: "samewindow03" };
    const old = { ...request, body: "旧笔已存成工作稿。", baseVersion: base, seq: 1 };
    const first = await call("PUT", "/api/working-draft", old);
    expect(first.status).toBe(200);
    await save(1, "AI 换上的稿。");
    const newer = await call("PUT", "/api/working-draft", { ...request, body: "新笔新增的重要句子。", baseVersion: first.payload.version, seq: 2 });
    expect(newer.status).toBe(409);
    expect((await call("PUT", "/api/working-draft", old)).payload).toMatchObject({ code: "stale_save" });
    expect((await readDraft(book, 1))?.body).toBe("AI 换上的稿。");
    expect((await readDraftRecovery(book, String(newer.payload.recoveryId)))?.body).toBe("新笔新增的重要句子。");
  });

  it.each([["在路上那笔先到", false], ["补发那笔先到", true]] as const)("同一窗口关窗补发（和在路上那笔同一底版）：%s，盘上都是最后的字（第 7 轮 U2）", async (_name, keepaliveFirst) => {
    const base = await save(1, "原稿。");
    const request = { projectPath: book, chapter: 1, baseVersion: base, client: "closewindow1" };
    const cleared = { ...request, body: "", seq: 1 };
    const restored = { ...request, body: "原稿。又补了一句。", seq: 2 };
    if (keepaliveFirst) {
      expect((await call("PUT", "/api/working-draft", restored)).status).toBe(200);
      expect((await call("PUT", "/api/working-draft", cleared)).payload).toMatchObject({ code: "stale_save" });
    } else {
      expect((await call("PUT", "/api/working-draft", cleared)).status).toBe(200);
      expect((await call("PUT", "/api/working-draft", restored)).status).toBe(200);
    }
    expect((await readDraft(book, 1))?.body).toBe("原稿。又补了一句。");
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("顺着接只认同一窗口、盘上还是它存的那版：别的窗口、AI 换过之后照旧撞版本进恢复稿（第 7 轮 U2）", async () => {
    const base = await save(1, "原稿。");
    expect((await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, baseVersion: base, client: "windowaaaa1", body: "甲窗口的字。", seq: 1 })).status).toBe(200);
    const other = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, baseVersion: base, client: "windowbbbb1", body: "乙窗口的字。", seq: 1 });
    expect(other.status).toBe(409);
    await save(1, "AI 换上的稿。");
    const late = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, baseVersion: base, client: "windowaaaa1", body: "甲窗口补发的字。", seq: 2 });
    expect(late.status).toBe(409);
    expect(late.payload.recoveryId).toBeDefined();
    expect((await readDraft(book, 1))?.body).toBe("AI 换上的稿。");
  });

  it.each([["在路上那笔先到", false], ["补发那笔先到", true]] as const)("真稿纸：清空的那笔还在路上、改回原文后关窗补发：%s，盘上是原文（第 7 轮 U2）", async (_name, keepaliveFirst) => {
    await save(1, "原稿。");
    useDraftStore.getState().loadPaper(book, (await call("GET", `/api/working-draft?project=${encodeURIComponent(book)}&chapter=1`)).payload.paper as never);
    const held = barrier();
    const keepaliveDone = barrier();
    let puts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const order = init?.method === "PUT" ? (puts += 1) : 0;
      if (order === 1) await held.promise;
      if (order === 2 && !keepaliveFirst) await held.promise;
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      if (order === 2) keepaliveDone.release();
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    editDraft("");
    const saving = flushDraftSave();
    await Promise.resolve();
    editDraft("原稿。");
    saveDraftKeepalive();
    if (keepaliveFirst) await keepaliveDone.promise;
    held.release();
    await saving;
    await keepaliveDone.promise;
    // 页面要是没真关（补发之后还活着），在路上那笔回来后接着存的那笔也顺着接上，不和自己撞版本。
    await flushDraftSave();
    expect((await readDraft(book, 1))?.body).toBe("原稿。");
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
    expect(useDraftStore.getState().incoming ?? null).toBeNull();
  });

  it.each([["补发那笔先落盘", "keepalive"], ["在路上那笔先落盘", "first"]] as const)("真稿纸：补发之后页面没关、作者又改回原文：%s，盘上是作者最后的字（第 8 轮 V1）", async (_name, landsFirst) => {
    await save(1, "原稿 A。");
    const firstArrived = barrier();
    const releaseFirst = barrier();
    const keepaliveDone = barrier();
    let normalPuts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const first = init?.method === "PUT" && !init.keepalive && (normalPuts += 1) === 1;
      // 「补发先落盘」：在路上那笔还没到服务端；「在路上那笔先落盘」：它到了、写了，只是回执迟迟没回来。
      if (first && landsFirst === "keepalive") { firstArrived.release(); await releaseFirst.promise; }
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      if (first && landsFirst === "first") { firstArrived.release(); await releaseFirst.promise; }
      if (init?.keepalive) keepaliveDone.release();
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    editDraft("在途 B。");
    const saving = flushDraftSave();
    await firstArrived.promise;
    editDraft("关窗补发 C。");
    saveDraftKeepalive();
    await keepaliveDone.promise;
    // 页面没关（离页被取消、从页面缓存回来），作者撤回原文。
    editDraft("原稿 A。");
    releaseFirst.release();
    expect(await saving).toEqual({ ok: true });
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.body).toBe("原稿 A。");
    expect(isDraftDirty(useDraftStore.getState())).toBe(false);
    expect(useDraftStore.getState().incoming ?? null).toBeNull();
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("真稿纸：补发落盘、作者改回原文，重存那笔写盘失败：关窗照样拦，重试真的再发、盘上是原文（第 9 轮 W1）", async () => {
    await save(1, "原稿 A。");
    const firstArrived = barrier();
    const releaseFirst = barrier();
    const keepaliveDone = barrier();
    let normalPuts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && !init.keepalive) {
        normalPuts += 1;
        if (normalPuts === 1) { firstArrived.release(); await releaseFirst.promise; }
        // 第二笔普通存稿（作者改回的原文）换工作稿文件那一下写盘失败一次（注入在 rename 上）。
        if (normalPuts === 2) {
          hooks.beforeRename = async (_from, to) => {
            if (to !== join(book, draftPath(1))) return;
            hooks.beforeRename = undefined;
            throw eio("换工作稿文件");
          };
        }
      }
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      if (init?.keepalive) keepaliveDone.release();
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    editDraft("在途 B。");
    const saving = flushDraftSave();
    await firstArrived.promise;
    editDraft("关窗补发 C。");
    saveDraftKeepalive();
    await keepaliveDone.promise;
    editDraft("原稿 A。");
    releaseFirst.release();
    expect(await saving).toMatchObject({ ok: false });
    expect(hasFailedUnsavedDraft()).toBe(true);
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(normalPuts).toBe(3);
    expect((await readDraft(book, 1))?.body).toBe("原稿 A。");
    expect(hasFailedUnsavedDraft()).toBe(false);
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("真稿纸：只有关窗补发那笔在路上、作者改回原文再换章：等那笔回来、把原文存上才换（第 9 轮 W2）", async () => {
    await save(1, "原稿 A。");
    await save(2, "第二章。");
    const arrived = barrier();
    const release = barrier();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.keepalive) { arrived.release(); await release.promise; }
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    editDraft("关窗补发 B。");
    saveDraftKeepalive();
    await arrived.promise;
    editDraft("原稿 A。");
    let switched = false;
    const opening = openPaper(book, 2).then((opened) => { switched = true; return opened; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(switched).toBe(false);
    release.release();
    expect(await opening).toBe(true);
    expect(useDraftStore.getState().chapter).toBe(2);
    expect((await readDraft(book, 1))?.body).toBe("原稿 A。");
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("真稿纸：页面没关、补发那笔正常回来：它定下存上了，不再多发（第 9 轮）", async () => {
    await save(1, "原稿 A。");
    const { puts } = wireRealRoutes();
    await openPaper(book, 1);
    editDraft("最新 B。");
    saveDraftKeepalive();
    await vi.waitFor(() => expect(useDraftStore.getState().saveStatus).toBe("saved"));
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(puts()).toBe(1);
    expect((await readDraft(book, 1))?.body).toBe("最新 B。");
  });

  it("真稿纸：补发 B 落盘回执压着、改回 A 重存写盘失败、B 的回执迟到：重读不把 A 换成 B；A 接着存，服务端认出是这个窗口接着写的、存上（第 10 轮 X2、第 11 轮 Y1）", async () => {
    await save(1, "原稿 A。");
    const keepaliveLanded = barrier();
    const releaseKeepalive = barrier();
    let keepaliveAnswered = false;
    let keepalives = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const nth = init?.keepalive ? (keepalives += 1) : 0;
      // 第二笔补发（改回的 A）：换工作稿文件那一下写盘失败一次（服务端回滚，盘上还是 B）。
      if (nth === 2) {
        hooks.beforeRename = async (_from, to) => {
          if (to !== join(book, draftPath(1))) return;
          hooks.beforeRename = undefined;
          throw eio("换工作稿文件");
        };
      }
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      if (nth === 1) {
        keepaliveLanded.release();
        await releaseKeepalive.promise;
        keepaliveAnswered = true;
      }
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    editDraft("关窗补发 B。");
    saveDraftKeepalive();
    await keepaliveLanded.promise;
    expect((await readDraft(book, 1))?.body).toBe("关窗补发 B。");
    editDraft("原稿 A。");
    saveDraftKeepalive();
    await vi.waitFor(() => expect(useDraftStore.getState().saveStatus).toBe("error"));
    releaseKeepalive.release();
    await vi.waitFor(() => expect(keepaliveAnswered).toBe(true));
    // 这时手上 A = 底版，最后那笔没存上；AI 工具结果之类触发重读。
    expect(hasFailedUnsavedDraft()).toBe(true);
    // 稿纸不自己认底版：盘上 B 先当成「盘上变了」，手上的 A 不动、马上存一笔。
    expect(await refreshPaper()).toBe("incoming");
    expect(useDraftStore.getState().body).toBe("原稿 A。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.body).toBe("原稿 A。");
    // 存上了：提示收起，没有恢复稿。
    expect(useDraftStore.getState().incoming ?? null).toBeNull();
    expect(hasFailedUnsavedDraft()).toBe(false);
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("真稿纸：只有关窗补发那笔、它写盘失败，页面还在：5 秒后自动再试、存上（第 10 轮 X1）", async () => {
    await save(1, "原稿 A。");
    const { puts } = wireRealRoutes();
    await openPaper(book, 1);
    editDraft("作者 B。");
    hooks.beforeRename = async (_from, to) => {
      if (to !== join(book, draftPath(1))) return;
      hooks.beforeRename = undefined;
      throw eio("换工作稿文件");
    };
    saveDraftKeepalive();
    await vi.waitFor(() => expect(hasFailedUnsavedDraft()).toBe(true));
    expect(puts()).toBe(1);
    await vi.waitFor(() => expect(puts()).toBe(2), { timeout: 8000, interval: 100 });
    await vi.waitFor(() => expect(hasFailedUnsavedDraft()).toBe(false));
    expect((await readDraft(book, 1))?.body).toBe("作者 B。");
  }, 15000);

  it("开书收拾升级前的老格式事务时作者存稿：等收拾完再存，撞了版本进恢复稿，回执之后的字不被回滚盖掉（第 9 轮 W3）", async () => {
    await save(1, "崩溃前的稿 A。");
    const relative = draftPath(1);
    const original = await readFile(join(book, relative), "utf-8");
    const tx = join(book, ".story-engine-tx/commit-chapter-0001");
    await mkdir(join(tx, "backups", dirname(relative)), { recursive: true });
    await writeFile(join(tx, "backups", relative), original);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ version: 2, chapter: 1, createdAt: "2026-10-20T00:00:00.000Z", files: [relative], backups: [{ relativePath: relative, existed: true, backupPath: `backups/${relative}`, sha256: sha256(original) }], status: "staged" }));
    await writeFile(join(book, relative), "中断事务留下的 B。");
    const atRestore = barrier();
    const releaseRestore = barrier();
    setCommitIoTestHookForTests(async (phase, target) => {
      if (phase !== "after-precheck-before-open" || target !== join(book, relative)) return;
      setCommitIoTestHookForTests(undefined);
      atRestore.release();
      await releaseRestore.promise;
    });
    wireRealRoutes();
    await openPaper(book, 1);
    const opening = ensureBookOnCore(book);
    await atRestore.promise;
    editDraft("作者刚补写的 C。");
    let acknowledged = false;
    const saving = flushDraftSave().then((result) => { acknowledged = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acknowledged).toBe(false);
    releaseRestore.release();
    expect(await opening).toMatchObject({ ok: true });
    expect(await saving).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.body).toBe("崩溃前的稿 A。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: "作者刚补写的 C。" });
  });

  it("撤销换了纪元、迟到的同文空写不把撤销后的版本认成这个窗口的：之后照撤销前发的旧笔撞版本进恢复稿（第 8 轮 V3）", async () => {
    const original = await save(1, "撤销回的 R。");
    const snapshot = await createSnapshot(book, "撤销目标 R");
    const client = "round8window01";
    const first = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, client, seq: 1, baseVersion: original, body: "后来写的 A。" });
    expect(first.status).toBe(200);
    // 两笔都在撤销前发出、撤销后才到。
    const queuedNoop = { projectPath: book, chapter: 1, client, seq: 2, baseVersion: original, body: "撤销回的 R。" };
    const queuedEdit = { projectPath: book, chapter: 1, client, seq: 3, baseVersion: first.payload.version, body: "撤销前发出的 B。" };
    await restoreSnapshot(book, snapshot.id);
    expect((await call("PUT", "/api/working-draft", queuedNoop)).payload).toMatchObject({ ok: true, unchanged: true });
    expect((await readSaveMark(book, 1, client))?.seq).toBe(2);
    const late = await call("PUT", "/api/working-draft", queuedEdit);
    expect(late.status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("撤销回的 R。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: queuedEdit.body });
  });

  it("撤销之后没有同文空写穿插：旧串上的新序号照样撞版本进恢复稿（对照）", async () => {
    const original = await save(1, "R。");
    const snapshot = await createSnapshot(book, "撤销目标");
    const request = { projectPath: book, chapter: 1, client: "round8window02", baseVersion: original };
    expect((await call("PUT", "/api/working-draft", { ...request, seq: 1, body: "A。" })).status).toBe(200);
    await restoreSnapshot(book, snapshot.id);
    expect((await call("PUT", "/api/working-draft", { ...request, seq: 2, body: "B。" })).status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("R。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: "B。" });
  });

  it("AI 换了稿、迟到的同文空写不把 AI 的版本收进这个窗口那一串：之后的旧笔不盖 AI 稿（第 8 轮 V3a）", async () => {
    const original = await save(1, "R。");
    const client = "round8window03";
    const first = await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, client, seq: 1, baseVersion: original, body: "A。" });
    expect(first.status).toBe(200);
    const queuedNoop = { projectPath: book, chapter: 1, client, seq: 2, baseVersion: original, body: "碰巧一样的 B。" };
    const queuedEdit = { projectPath: book, chapter: 1, client, seq: 3, baseVersion: first.payload.version, body: "AI 写之前发出的 C。" };
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "碰巧一样的 B。", basis: await readTruthBasis(book), baseVersion: (await readDraftState(book, 1)).version, materials: [], source: "revise" })).toMatchObject({ applied: true });
    expect((await call("PUT", "/api/working-draft", queuedNoop)).payload).toMatchObject({ ok: true, unchanged: true });
    const late = await call("PUT", "/api/working-draft", queuedEdit);
    expect(late.status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("碰巧一样的 B。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: queuedEdit.body });
  });

  it("恢复稿已被别的窗口找回、清空了：本窗口后来的「不要了」照样推进序号，在路上的旧笔到了不再写回来（第 5 轮 S10）", async () => {
    const base = await save(1, "原稿。");
    const changed = await save(1, "AI 工作稿。");
    const request = { projectPath: book, chapter: 1, baseVersion: base, client: "samewindow10" };
    const first = await call("PUT", "/api/working-draft", { ...request, body: "恢复稿第一笔。", seq: 1 });
    expect(first.status).toBe(409);
    const id = first.payload.recoveryId;
    expect((await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id, sha: draftSha({ body: "恢复稿第一笔。" }), decision: "adopt", baseVersion: changed })).status).toBe(200);
    expect((await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id, sha: "", decision: "dismiss", baseVersion: null, client: request.client, seq: 2 })).status).toBe(200);
    expect((await readDraftRecovery(book, String(id)))?.seq).toBe(2);
    await call("PUT", "/api/working-draft", { ...request, body: "作者刚刚明确不要的第二笔。", seq: 2 });
    expect((await readDraftRecovery(book, String(id)))?.body).toBe("");
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("书从备份 / 回收站搬回来：稿纸上照原来那版发的存稿对不上", async () => {
    const base = await save(1, "搬走前的稿。");
    await freshRevision(book);
    expect((await readDraft(book, 1))?.version).not.toBe(base);
    expect((await call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "旧窗口的字。", baseVersion: base })).status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("搬走前的稿。");
  });
});

type Reply = Awaited<ReturnType<typeof call>>;

/** 稿纸的 fetch 接到真路由上；after 在回执交回稿纸之前调（压住回执用）。 */
function wireRoutesWith(after?: (result: Reply, init?: RequestInit) => Promise<void>) {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const input = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (init?.method === "PUT" && input) sent.push(input);
    const result = await call(init?.method ?? "GET", url, input);
    await after?.(result, init);
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
  }));
  return sent;
}

// Astra 第 11 轮探针改写（真稿纸、真路由、真核心事务，只控制回执什么时候到）。
describe("稿纸不自己认底版、旧回执不复活提示（第 11 轮复核）", () => {
  it("Y1：别处写的 B、这个窗口同文空写的旧回执迟到：重读只提示，作者的 C 进恢复稿，B 不被盖", async () => {
    await save(1, "原稿 A。");
    const landed = barrier();
    const releaseAck = barrier();
    let puts = 0;
    let noOp: Reply | undefined;
    const sent = wireRoutesWith(async (result, init) => {
      if (init?.method === "PUT" && ++puts === 1) {
        noOp = result;
        landed.release();
        await releaseAck.promise;
      }
    });
    await openPaper(book, 1);
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "共同得到的 B。", ...(await begin(1)), source: "revise" })).toMatchObject({ applied: true });
    const foreign = (await readDraft(book, 1))!;
    editDraft("共同得到的 B。");
    saveDraftKeepalive();
    await landed.promise;
    expect(noOp?.payload).toMatchObject({ ok: true, unchanged: true, version: foreign.version });
    editDraft("作者后来改的 C。");
    saveDraftKeepalive();
    await vi.waitFor(() => expect(useDraftStore.getState().incoming?.cause).toBe("conflict"));
    expect((await readSaveMark(book, 1, String(sent[0]!.client)))?.saved).toBeUndefined();
    releaseAck.release();
    expect(await refreshPaper()).toBe("incoming");
    expect(isOwnSavedVersion(foreign.version)).toBe(false);
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.body).toBe("共同得到的 B。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者后来改的 C。" });
    // 提示还是撞版本那条（带恢复稿号），点「换成那一版」能一起清掉恢复稿。
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "conflict", version: foreign.version });
    expect(typeof useDraftStore.getState().incoming?.recoveryId).toBe("string");
  });

  it("Y2：重读提示后点「保留我这版」，选之前那笔的 409 迟到：不复活提示，C 存上、恢复稿清掉", async () => {
    await save(1, "原稿 A。");
    const landed = barrier();
    const releaseAck = barrier();
    let puts = 0;
    let conflict: Reply | undefined;
    wireRoutesWith(async (result, init) => {
      if (init?.method === "PUT" && ++puts === 1) {
        conflict = result;
        landed.release();
        await releaseAck.promise;
      }
    });
    await openPaper(book, 1);
    await save(1, "别处的 B。");
    editDraft("作者的 C。");
    expect(await refreshPaper()).toBe("incoming");
    await landed.promise;
    expect(useDraftStore.getState().incoming?.cause).toBe("update");
    expect(await keepPaperMine()).toEqual({ ok: true });
    releaseAck.release();
    await vi.waitFor(() => expect(useDraftStore.getState().savedBody).toBe("作者的 C。"));
    expect(useDraftStore.getState().incoming).toBeNull();
    expect((await readDraft(book, 1))?.body).toBe("作者的 C。");
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
    expect((await readDraftRecovery(book, String(conflict!.payload.recoveryId)))?.body).toBe("");
    expect(await refreshPaper()).toBe("unchanged");
    expect(useDraftStore.getState().incoming).toBeNull();
  });

  it("提示之后盘上又撤回原版：重读收起失效提示，作者的字接着存上", async () => {
    const original = await save(1, "原稿 A。");
    wireRealRoutes();
    await openPaper(book, 1);
    await save(1, "别处的 B。");
    editDraft("作者的 C。");
    expect(await refreshPaper()).toBe("incoming");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState().incoming?.cause).toBe("conflict");
    // 盘上回到原稿（撤销那类）：版本号还是原来那个。
    await runCommand(book, draftSave, { chapter: 1, body: "原稿 A。", baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
    expect((await readDraftState(book, 1)).version).not.toBe(original);
    expect(await refreshPaper()).toBe("incoming");
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "update", body: "原稿 A。" });
    expect(useDraftStore.getState().body).toBe("作者的 C。");
  });

  it("C111：没有同文空写时，重读只提示，恢复稿留着，不自动盖别处的版本", async () => {
    await save(1, "原稿 A。");
    wireRealRoutes();
    await openPaper(book, 1);
    await save(1, "别处的 B。");
    editDraft("作者的 C。");
    expect(await refreshPaper()).toBe("incoming");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.body).toBe("别处的 B。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者的 C。" });
    expect(useDraftStore.getState().incoming?.cause).toBe("conflict");
  });

  it("C114：别的章同文的版本号不同，不认成自己的", async () => {
    await save(1, "第一章 A。");
    await save(2, "第二章 A。");
    wireRealRoutes();
    await openPaper(book, 1);
    editDraft("共同的 B。");
    await flushDraftSave();
    const own = (await readDraft(book, 1))!;
    expect(isOwnSavedVersion(own.version)).toBe(true);
    await openPaper(book, 2);
    const foreign = await save(2, "共同的 B。");
    expect(foreign).not.toBe(own.version);
    expect(isOwnSavedVersion(foreign)).toBe(false);
    editDraft("第二章作者 C。");
    expect(await refreshPaper()).toBe("incoming");
    await flushDraftSave();
    expect((await readDraft(book, 2))?.body).toBe("共同的 B。");
    expect(await pendingDraftFor(book, 2)).toMatchObject({ body: "第二章作者 C。" });
  });

  it("C116：重读读到自己的 B、别处又写了 D：自动存的 C 撞版本进恢复稿，D 不被盖", async () => {
    await save(1, "原稿 A。");
    const landed = barrier();
    const releaseAck = barrier();
    const readCaptured = barrier();
    const releaseRead = barrier();
    let puts = 0;
    let holdRead = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const nth = init?.method === "PUT" ? ++puts : 0;
      if (nth === 2) throw new Error("第二笔传输失败，服务端没收到");
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      if (nth === 1) { landed.release(); await releaseAck.promise; }
      if (!init?.method && holdRead) { holdRead = false; readCaptured.release(); await releaseRead.promise; }
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    editDraft("自己的 B。");
    saveDraftKeepalive();
    await landed.promise;
    editDraft("作者最新 C。");
    saveDraftKeepalive();
    await vi.waitFor(() => expect(hasFailedUnsavedDraft()).toBe(true));
    releaseAck.release();
    holdRead = true;
    const refresh = refreshPaper();
    await readCaptured.promise;
    await save(1, "别处最新 D。");
    releaseRead.release();
    expect(await refresh).toBe("incoming");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.body).toBe("别处最新 D。");
    expect(useDraftStore.getState().body).toBe("作者最新 C。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者最新 C。" });
  });

  it("撞版本提示上点「换成那一版」：稿纸换成盘上那版，作者那份恢复稿一起清掉", async () => {
    await save(1, "原稿 A。");
    wireRealRoutes();
    await openPaper(book, 1);
    await save(1, "别处的 B。");
    editDraft("作者的 C。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState().incoming?.cause).toBe("conflict");
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(await flushDraftSave()).toEqual({ ok: true }); // 选完存一笔核盘（第 13 轮 AA1）：盘上还是 B，空写存上
    expect(useDraftStore.getState()).toMatchObject({ body: "别处的 B。", incoming: null, saveStatus: "saved" });
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });
});

// Astra 第 12 轮探针改写（真稿纸、真路由、真核心事务，只控制请求 / 回执什么时候到；记号写盘故障在 rename 上注入）。
describe("要不要存看改动号、提示只说稿纸不知道的盘上版本、序号先落盘（第 12 轮复核）", () => {
  async function saveTitled(chapter: number, body: string, title: string): Promise<string> {
    const baseVersion = (await readDraftState(book, chapter)).version;
    const outcome = await runCommand(book, draftSave, { chapter, body, title, baseVersion }, { caller: "author" });
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.result.version;
  }

  it.each(["换成那一版", "保留我这版"])("Z1：选「%s」之后盘上又有了 D，选之前发出的那笔撞版本回来：作者看得见 D", async (action) => {
    await save(1, "原稿 A。");
    const started = barrier();
    const deliver = barrier();
    let puts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && ++puts === 1) {
        started.release();
        await deliver.promise; // 已经发出、还没到服务端
      }
      const result = await call(init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined);
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    await save(1, "别处的 B。");
    editDraft("作者的 C。");
    expect(await refreshPaper()).toBe("incoming");
    await started.promise;
    expect(await (action === "换成那一版" ? acceptPaperIncoming() : keepPaperMine())).toEqual({ ok: true });
    await save(1, "别处更新的 D。");
    deliver.release();
    expect(await flushDraftSave()).toEqual({ ok: true });
    const live = useDraftStore.getState();
    expect((await readDraft(book, 1))?.body).toBe("别处更新的 D。");
    expect(live.incoming).toMatchObject({ body: "别处更新的 D。" });
  });

  it("Z2：正文一样、章名不一样：别处改了章名、作者另起了章名，重读不收提示，重开也找得回作者的章名", async () => {
    await saveTitled(1, "正文保持不变。", "原章名");
    wireRealRoutes();
    await openPaper(book, 1);
    await saveTitled(1, "正文保持不变。", "别处的新章名");
    useDraftStore.getState().setTitle("作者要的章名");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState().incoming?.cause).toBe("conflict");
    expect(await refreshPaper()).toBe("incoming");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState()).toMatchObject({ title: "作者要的章名", incoming: { cause: "conflict" } });
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", title: "作者要的章名" });
    await openPaper(book, 1);
    expect(useDraftStore.getState().incoming?.pending).toMatchObject({ kind: "recovery", title: "作者要的章名" });
  });

  it("Z3：撞版本的 C 进了恢复稿，作者又改回原稿 A：A 照存（进恢复稿），重读不拿 AI 的 B 换掉", async () => {
    await save(1, "作者原稿 A。");
    const sent = wireRoutesWith();
    await openPaper(book, 1);
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "AI 的 B。", ...(await begin(1)), source: "revise" })).toMatchObject({ applied: true });
    editDraft("作者临时 C。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者临时 C。" });
    editDraft("作者原稿 A。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(sent.map((input) => input.body)).toEqual(["作者临时 C。", "作者原稿 A。"]);
    expect(await refreshPaper()).toBe("incoming");
    expect(useDraftStore.getState()).toMatchObject({ body: "作者原稿 A。", incoming: { cause: "conflict", body: "AI 的 B。" } });
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: "作者原稿 A。" });
    expect((await readDraft(book, 1))?.body).toBe("AI 的 B。");
  });

  it.each([false, true])("Z4：最后那笔同文空写的序号记号写盘失败（%s）：迟到的旧笔不盖作者最后那份", async (failMark) => {
    await save(1, "作者最后要的 A。");
    const firstSent = barrier();
    const deliverFirst = barrier();
    const replies: { seq: unknown; status: number }[] = [];
    let puts = 0;
    let failOnce = false;
    hooks.beforeRename = async (_from, to) => {
      if (failOnce && to.includes("/agents/drafts/saves/")) {
        failOnce = false;
        throw eio("存稿记号写盘失败");
      }
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const input = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (init?.method === "PUT") {
        const nth = ++puts;
        if (nth === 1) { firstSent.release(); await deliverFirst.promise; }
        if (nth === 2) failOnce = failMark;
      }
      const result = await call(init?.method ?? "GET", url, input);
      if (init?.method === "PUT") replies.push({ seq: input?.seq, status: result.status });
      return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "content-type": "application/json" } });
    }));
    await openPaper(book, 1);
    editDraft("已经放弃的 B。");
    saveDraftKeepalive();
    await firstSent.promise;
    editDraft("作者最后要的 A。");
    saveDraftKeepalive();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    // 记号写不上：这笔不写、如实说没存上（不再报「存上了」）。
    expect(replies[0]).toMatchObject({ seq: 2, status: failMark ? 503 : 200 });
    deliverFirst.release();
    expect(await flushDraftSave()).toEqual({ ok: true });
    await refreshPaper();
    expect((await readDraft(book, 1))?.body).toBe("作者最后要的 A。");
    expect(useDraftStore.getState()).toMatchObject({ body: "作者最后要的 A。", incoming: null });
    expect(hasFailedUnsavedDraft()).toBe(false);
  });

  it("对照：先开读、后发存稿，存上之后迟到的读数不出旧提示（C123）", async () => {
    await save(1, "原稿 A。");
    const readCaptured = barrier();
    const ack = barrier();
    let holdRead = false;
    wireRoutesWith(async (_result, init) => {
      if (!init?.method && holdRead) {
        holdRead = false;
        readCaptured.release();
        await ack.promise;
      }
    });
    await openPaper(book, 1);
    editDraft("作者的 B。");
    holdRead = true;
    const refreshing = refreshPaper();
    await readCaptured.promise;
    expect(await flushDraftSave()).toEqual({ ok: true });
    ack.release();
    expect(await refreshing).toBe("unchanged");
    expect(useDraftStore.getState()).toMatchObject({ body: "作者的 B。", incoming: null });
  });

  it("对照：更早那笔成功的回执晚于新的撞版本回来，不收起新提示（C122）", async () => {
    await save(1, "原稿 A。");
    const landed = barrier();
    const ack = barrier();
    let puts = 0;
    wireRoutesWith(async (_result, init) => {
      if (init?.method === "PUT" && ++puts === 1) {
        landed.release();
        await ack.promise;
      }
    });
    await openPaper(book, 1);
    editDraft("自己的 B。");
    saveDraftKeepalive();
    await landed.promise;
    await save(1, "外部 D。");
    editDraft("作者 C。");
    saveDraftKeepalive();
    await vi.waitFor(() => expect(useDraftStore.getState().incoming).toMatchObject({ cause: "conflict", body: "外部 D。" }));
    ack.release();
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "conflict", body: "外部 D。" });
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者 C。" });
    expect((await readDraft(book, 1))?.body).toBe("外部 D。");
  });
});

// Astra 第 13 轮故障探针改写：序号先落盘、之后某一步失败，旧笔挡住、下一笔照样存得上或保守进恢复稿。
describe("序号先落盘、后面一步失败（第 13 轮复核）", () => {
  const client = "round13faultwindow";
  const put = (seq: number, baseVersion: string | null, body: string) => call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, client, seq, baseVersion, body });
  /** 第 n 次往某处 rename 时失败一次。 */
  function failRename(match: (to: string) => boolean, at = 1) {
    let seen = 0;
    hooks.beforeRename = async (_from, to) => {
      if (!match(to)) return;
      seen += 1;
      if (seen === at) throw eio(to);
    };
  }

  it("工作稿写失败：同号重发挡住，新号照样存上", async () => {
    const base = await save(1, "原稿 A。");
    failRename((to) => to.endsWith("/drafts/fast/chapter-0001.md"));
    expect(await put(1, base, "待存 B。")).toMatchObject({ status: 400, payload: { ok: false, code: "write_failed" } });
    expect(await readSaveMark(book, 1, client)).toMatchObject({ seq: 1 });
    expect((await readDraft(book, 1))?.body).toBe("原稿 A。");
    expect((await put(1, base, "同号重试。")).payload.code).toBe("stale_save");
    expect((await put(2, base, "合法下一笔 C。")).status).toBe(200);
    expect((await readDraft(book, 1))?.body).toBe("合法下一笔 C。");
  });

  it("撞版本后恢复稿也写失败：下一笔照样留下作者的稿", async () => {
    const base = await save(1, "原稿 A。");
    const disk = await save(1, "外部 B。");
    failRename((to) => to.includes("/agents/drafts/recovery/"));
    expect(await put(1, base, "作者 C。")).toMatchObject({ status: 503, payload: { code: "recovery_failed" } });
    expect(await readSaveMark(book, 1, client)).toMatchObject({ seq: 1 });
    expect((await put(1, base, "作者 C。")).payload.code).toBe("stale_save");
    expect((await put(2, base, "作者 C。")).status).toBe(409);
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者 C。" });
    expect((await put(3, disk, "作者确认 C。")).status).toBe(200);
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("写稿后接不上版本链：旧笔照样挡住，下一笔保守进恢复稿", async () => {
    const base = await save(1, "原稿 A。");
    failRename((to) => to.includes("/agents/drafts/saves/"), 2);
    expect((await put(1, base, "自己 B。")).status).toBe(200);
    expect(await readSaveMark(book, 1, client)).toMatchObject({ seq: 1 });
    expect((await readSaveMark(book, 1, client))?.saved).toBeUndefined();
    expect((await put(0, base, "迟到旧稿。")).payload.code).toBe("stale_save");
    expect((await put(2, base, "作者最后 C。")).status).toBe(409);
    expect((await readDraft(book, 1))?.body).toBe("自己 B。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ body: "作者最后 C。" });
  });

  it("「不要了」推进序号后，迟到的旧笔不让恢复稿复活；新的合法笔照样存上", async () => {
    const base = await save(1, "原稿 A。");
    const current = await save(1, "外部 B。");
    const rejected = await put(1, base, "不要的 C。");
    expect(rejected.status).toBe(409);
    const id = rejected.payload.recoveryId as string;
    const seen = (await pendingDraftFor(book, 1))!;
    expect((await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id, sha: seen.sha, decision: "dismiss", baseVersion: current, client, seq: 2 })).status).toBe(200);
    expect((await put(2, base, "迟到也不要的 D。")).status).toBe(409);
    expect(await readDraftRecovery(book, id)).toMatchObject({ seq: 2, settled: true });
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
    expect((await put(3, current, "作者之后合法 E。")).status).toBe(200);
    expect((await readDraft(book, 1))?.body).toBe("作者之后合法 E。");
  });
});

// Astra 第 13 轮探针改写（真稿纸、真路由、真核心事务）：稿 = 章名 + 正文，比对、指纹、回执都按整份；选版本要核盘。
describe("稿 = 章名 + 正文、选了那一版要存一笔核盘（第 13 轮复核）", () => {
  async function saveTitled(chapter: number, body: string, title?: string): Promise<string> {
    const baseVersion = (await readDraftState(book, chapter)).version;
    const outcome = await runCommand(book, draftSave, { chapter, body, ...(title !== undefined ? { title } : {}), baseVersion }, { caller: "author" });
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.result.version;
  }
  const rename = (title: string) => {
    useDraftStore.getState().setTitle(title);
    scheduleDraftSave(0);
  };

  it("AA1：提示 B 之后盘上又成了 D，作者点「换成那一版」B：存一笔核盘，撞上 D 就提示 D、B 进恢复稿，不悄悄丢", async () => {
    await save(1, "原稿 A。");
    wireRoutesWith();
    await openPaper(book, 1);
    await save(1, "提示过的 B。");
    editDraft("作者 C。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "conflict", body: "提示过的 B。" });
    await save(1, "选择前已落盘的 D。");
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(useDraftStore.getState()).toMatchObject({ body: "提示过的 B。", incoming: { cause: "conflict", body: "选择前已落盘的 D。" } });
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "recovery", body: "提示过的 B。" });
    expect(await refreshPaper()).not.toBe("replaced");
    expect(useDraftStore.getState().body).toBe("提示过的 B。");
  });

  it("AA1 对照：盘上还是 B，点「换成那一版」后那一笔空写就存上，不再提示", async () => {
    await save(1, "原稿 A。");
    const sent = wireRoutesWith();
    await openPaper(book, 1);
    await save(1, "提示过的 B。");
    editDraft("作者 C。");
    await flushDraftSave();
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
    expect(useDraftStore.getState()).toMatchObject({ body: "提示过的 B。", incoming: null, saveStatus: "saved" });
    expect(useDraftStore.getState().rev).toBe(useDraftStore.getState().cleanRev);
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("AA2：换成没有章名的 B：章名一起换成空，不夹带手上那份的章名", async () => {
    await save(1, "原稿 A。");
    wireRoutesWith();
    await openPaper(book, 1);
    await save(1, "无章名的 B。");
    editDraft("作者 C。");
    useDraftStore.getState().setTitle("作者给 C 的章名");
    await flushDraftSave();
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "conflict", body: "无章名的 B。" });
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    await flushDraftSave();
    await refreshPaper();
    expect(useDraftStore.getState()).toMatchObject({ body: "无章名的 B。", title: "", savedTitle: "" });
    expect((await readDraft(book, 1))?.title).toBeUndefined();
  });

  it.each(["dismiss", "adopt"] as const)("AA3：别的窗口的恢复稿后来只改了章名：旧卡片「%s」不动它（指纹按整份）", async (decision) => {
    const old = await saveTitled(1, "共同正文。", "原章名");
    const current = await saveTitled(1, "共同正文。", "盘上章名");
    const put = (seq: number, title: string) => call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, body: "共同正文。", title, baseVersion: old, client: "round13otherwindow", seq });
    expect((await put(1, "看到的旧章名")).status).toBe(409);
    const seen = (await pendingDraftFor(book, 1))!;
    expect(seen.title).toBe("看到的旧章名");
    expect((await put(2, "后来才写的新章名")).status).toBe(409);
    const response = await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: seen.kind, id: seen.id, sha: seen.sha, decision, baseVersion: current });
    expect(response.status).toBe(409);
    expect(await readDraftRecovery(book, seen.id)).toMatchObject({ title: "后来才写的新章名", body: "共同正文。", settled: false });
    expect((await readDraft(book, 1))?.title).toBe("盘上章名");
  });

  it("AA4：正文自带「# 章名」行，再从章名入口改名：那一行跟着换，盘上就是新章名", async () => {
    wireRoutesWith();
    await openPaper(book, 1);
    editDraft("# 原章名\n\n这是正文。");
    expect(useDraftStore.getState().title).toBe("原章名");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.title).toBe("原章名");
    rename("作者的新章名");
    expect(useDraftStore.getState().body).toBe("# 作者的新章名\n\n这是正文。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者的新章名", body: "这是正文。" });
    expect(await refreshPaper()).toBe("unchanged");
    expect(useDraftStore.getState()).toMatchObject({ title: "作者的新章名", savedTitle: "作者的新章名" });
  });

  it("章名清空也存得上：空章名 = 没章名，不沿用盘上那个", async () => {
    await saveTitled(1, "正文。", "旧章名");
    wireRoutesWith();
    await openPaper(book, 1);
    rename("");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.title).toBeUndefined();
    expect(await refreshPaper()).toBe("unchanged");
    expect(useDraftStore.getState()).toMatchObject({ title: "", savedTitle: "" });
  });

  it("AA5：空白章只起了章名就撞版本：那份恢复稿是作者的一份稿（没清过），换章回来照样提示、找得回", async () => {
    await save(1, "");
    wireRoutesWith();
    await openPaper(book, 1);
    await saveTitled(1, "AI 刚写出的正文。", "AI 章名");
    rename("作者给空白章起的新名");
    expect(await flushDraftSave()).toEqual({ ok: true });
    const live = useDraftStore.getState();
    expect(live.incoming?.cause).toBe("conflict");
    expect(await readDraftRecovery(book, live.incoming!.recoveryId!)).toMatchObject({ title: "作者给空白章起的新名", body: "", settled: false });
    await openPaper(book, 2);
    await openPaper(book, 1);
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "recovery", title: "作者给空白章起的新名", body: "" });
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者给空白章起的新名", body: "" });
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });
});

// Astra 第 14 轮探针改写：一份稿三种样子（文件原文 / 拆开的稿 / 稿纸上的字），拆过的不再拆；章名行只认一级。
describe("拆过的不再拆、章名行只认一级（第 14 轮复核）", () => {
  async function saveTitled(chapter: number, body: string, title?: string): Promise<string> {
    const baseVersion = (await readDraftState(book, chapter)).version;
    const outcome = await runCommand(book, draftSave, { chapter, body, ...(title !== undefined ? { title } : {}), baseVersion }, { caller: "author" });
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.result.version;
  }
  const put = (base: string | null, client: string, seq: number, title: string, body: string) =>
    call("PUT", "/api/working-draft", { projectPath: book, chapter: 1, client, seq, baseVersion: base, title, body });

  it("AB1b：作者存下章名 + 二级小节，AI 照盘上那份改正文：小节标题还在，章名不动", async () => {
    wireRoutesWith();
    await openPaper(book, 1);
    editDraft("# 正章名\n\n## 正文第一节\n\n原句。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(await readDraft(book, 1)).toMatchObject({ title: "正章名", body: "## 正文第一节\n\n原句。" });
    const draft = parseDraftFile(await readFile(join(book, draftPath(1)), "utf-8"));
    const result = await applyAiDraft(book, { chapter: 1, title: draft.title ?? "", body: draft.body.replace("原句。", "改好的句子。"), ...(await begin(1)), source: "revise" });
    expect(result).toMatchObject({ applied: true });
    expect(await readDraft(book, 1)).toMatchObject({ title: "正章名", body: "## 正文第一节\n\n改好的句子。" });
    // 再读一遍文件、再拼一遍：一行都不少（第 14 轮 AB1a：拆开的不再拆）
    expect(parseDraftFile(await readFile(join(book, draftPath(1)), "utf-8"))).toEqual({ title: "正章名", body: "## 正文第一节\n\n改好的句子。" });
  });

  it("没章名、正文开头就是一级标题行：存上再读回来，那一行还是正文（拼文件时垫一行空章名）", async () => {
    await saveTitled(1, "# 正文里的一级标题\n\n正文。", "");
    const disk = await readDraft(book, 1);
    expect(disk?.title).toBeUndefined();
    expect(disk?.body).toBe("# 正文里的一级标题\n\n正文。");
  });

  it.each(["adopt", "dismiss"] as const)("AB1c：恢复稿只改了小节标题，旧指纹「%s」对不上（409）", async (decision) => {
    const base = await save(1, "A。");
    const current = await save(1, "B。");
    expect((await put(base, "round14section", 1, "章名", "# 章名\n\n## 旧小节\n\n正文。")).status).toBe(409);
    const seen = (await pendingDraftFor(book, 1))!;
    expect(seen).toMatchObject({ title: "章名", body: "## 旧小节\n\n正文。" });
    expect((await put(base, "round14section", 2, "章名", "# 章名\n\n## 新小节\n\n正文。")).status).toBe(409);
    const changed = (await pendingDraftFor(book, 1))!;
    expect(changed.sha).not.toBe(seen.sha);
    const response = await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: seen.kind, id: seen.id, sha: seen.sha, decision, baseVersion: current });
    expect(response.status).toBe(409);
    expect(await readDraftRecovery(book, seen.id)).toMatchObject({ settled: false, body: "## 新小节\n\n正文。" });
    expect((await readDraft(book, 1))?.body).toBe("B。");
  });

  it("AB1d：恢复稿还有小节标题，别处存上的只是后半截一样：不当已存清掉", async () => {
    const base = await save(1, "原稿。");
    const current = await save(1, "外部稿。");
    const response = await put(base, "round14clear", 1, "章名", "# 章名\n\n## 作者第一节\n\n正文。");
    expect(response.status).toBe(409);
    const id = String(response.payload.recoveryId);
    expect((await put(current, "round14another", 1, "章名", "正文。")).status).toBe(200);
    expect(await readDraftRecovery(book, id)).toMatchObject({ settled: false, body: "## 作者第一节\n\n正文。" });
  });

  it.each(["#", "# "])("AB2：稿纸上章名行只剩 %j：章名清空，盘上没章名", async (marker) => {
    wireRoutesWith();
    await openPaper(book, 1);
    editDraft("# 原章名\n\n正文。");
    expect(await flushDraftSave()).toEqual({ ok: true });
    editDraft(`${marker}\n\n正文。`);
    expect(useDraftStore.getState().title).toBe("");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(await readDraft(book, 1)).toMatchObject({ body: "正文。" });
    expect((await readDraft(book, 1))?.title).toBeUndefined();
  });

  it("AB2 对照：「## 小节」不是章名行，章名照旧", async () => {
    wireRoutesWith();
    await openPaper(book, 1);
    editDraft("# 原章名\n\n正文。");
    await flushDraftSave();
    editDraft("## 小节\n\n正文。");
    expect(useDraftStore.getState().title).toBe("原章名");
    expect(await flushDraftSave()).toEqual({ ok: true });
    expect(await readDraft(book, 1)).toMatchObject({ title: "原章名", body: "## 小节\n\n正文。" });
  });

  it.each([
    { label: "没章名", title: "", expected: undefined },
    { label: "自己的章名", title: "AI 起的章名", expected: "AI 起的章名" },
  ])("AB3：AI 候选（$label）换上时照它自己的章名，不夹带盘上后来的章名", async ({ title, expected }) => {
    await saveTitled(1, "作者原稿。", "作者旧章名");
    const start = await begin(1);
    await saveTitled(1, "作者后来改的稿。", "作者后来改的章名");
    const written = await applyAiDraft(book, { chapter: 1, title, body: "AI 稿。", ...start, source: "continue" });
    expect(written).toMatchObject({ applied: false, reason: "draft_moved" });
    if (written.applied) throw new Error("应留下候选");
    wireRoutesWith();
    await openPaper(book, 1);
    expect(useDraftStore.getState().incoming?.pending?.id).toBe(written.candidateId);
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect((await readDraft(book, 1))?.title).toBe(expected);
    expect(useDraftStore.getState().title).toBe(title);
  });

  it("AB4：「不要了」AI 候选不带指纹：不删（409），后来更新的那份留着", async () => {
    const base = await save(1, "作者稿。");
    const input = { chapter: 1, body: "候选正文。", baseVersion: base, basisDigest: (await readTruthBasis(book)).digest, source: "draft" as const, status: "ready" as const };
    const candidate = await saveDraftCandidate(book, { ...input, title: "看到的旧名" });
    await saveDraftCandidate(book, { ...input, id: candidate.id, title: "后来更新的新名" });
    const response = await call("POST", "/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "candidate", id: candidate.id, decision: "dismiss", baseVersion: null });
    expect(response.status).toBe(409);
    expect(await readDraftCandidate(book, candidate.id)).toMatchObject({ title: "后来更新的新名" });
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
    const result = await applyAiDraft(book, { chapter: 2, title: "", body: "李四带着钥匙来了。", baseVersion: null, basis, materials: [], source: "revise" });
    expect(await readFile(join(book, relative), "utf-8")).toBe(original);
    expect(JSON.parse(await readFile(join(tx, "manifest.json"), "utf-8")).status).toBe("recovered");
    expect(result).toMatchObject({ applied: false, reason: "basis_moved" });
    expect(await readDraft(book, 2)).toBeUndefined();
  });

  it("最新那份候选碰巧和工作稿一样：更早那份作者还没处理的照样提示（R4）", async () => {
    await save(1, "底稿。");
    const old = await begin(1);
    await save(1, "作者已改。");
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "作者还没处理的 AI 方案 A。", ...old, source: "revise" })).toMatchObject({ applied: false });
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(await applyAiDraft(book, { chapter: 1, title: "", body: "AI 方案 B。", ...old, source: "revise" })).toMatchObject({ applied: false });
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
    const outcome = await applyAiDraft(book, { chapter: 1, title: "", body: "已经生成完的 AI 改稿。", ...begun, source: "revise" });
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
      const applied = await applyAiDraft(book, { chapter: 2, title: "", body: "李四把钥匙交了出去。", baseVersion: null, basis, materials: [], source: "draft" });
      expect(applied).toMatchObject({ applied: false, reason: "basis_moved" });
      expect(await readDraft(book, 2)).toBeUndefined();
    } finally {
      allowText.release();
      failRest.release();
      await failedWrite;
    }
  });

  it("改稿开工正赶上设定写到一半、那次写失败回滚：等收尾之后才取依据读材料，读的是回滚后的设定（B8-service，第 8 轮起）", async () => {
    await save(1, "他推开门。");
    expect(await runCommand(book, cardWrite, { ops: [{ op: "field.set", card: "张三", label: "籍贯", value: "海州" }] }, { caller: "author", idempotencyKey: "seed-card-a" })).toMatchObject({ ok: true });
    const revisionSwapped = barrier();
    const allowRest = barrier();
    hooks.afterRename = async (from, to) => {
      if (from.includes("/staged/") && to === join(book, "store-control/revision.json")) { revisionSwapped.release(); await allowRest.promise; }
    };
    hooks.beforeRename = async (from, to) => {
      if (from.includes("/staged/") && to.includes("/ledger/receipts/")) throw eio("设定已换、回执写盘失败");
    };
    const failedWrite = runCommand(book, cardWrite, { ops: [{ op: "field.set", card: "张三", label: "籍贯", value: "京城" }] }, { caller: "author", idempotencyKey: "failed-card-b" });
    let prompt = "";
    try {
      await revisionSwapped.promise;
      const revising = reviseDraftOneShot({
        projectDir: book,
        chapter: 1,
        targetText: "他推开门。",
        revisionGoal: "点明籍贯",
        callModel: async (input) => {
          prompt = input;
          return JSON.stringify({ beforeText: "他推开门。", afterText: "海州来的张三推开门。" });
        },
      });
      // 写到一半时改稿取不到依据（等书锁），进不了模型。
      await new Promise((done) => setTimeout(done, 50));
      expect(prompt).toBe("");
      allowRest.release();
      expect(await failedWrite).toMatchObject({ ok: false });
      expect(await revising).toMatchObject({ ok: true, applied: true });
      expect(prompt).toContain("海州");
      expect(prompt).not.toContain("京城");
      expect((await readDraft(book, 1))?.body).toBe("海州来的张三推开门。");
    } finally {
      allowRest.release();
      await failedWrite;
    }
  });

  it("改稿开工正赶上定稿写到一半（真相写了、版本号还没换）：等那条命令写完、镜像同步了才取依据，读到的是新账（第 8 轮 V2）", async () => {
    const commit = (value: string) => runCommand(book, chapterCommit, {
      chapter: 1,
      text: `# 第一章\n\n保险柜的口令是${value}。`,
      entries: [{ kind: "fact", review: "author", nature: "hard", subject: "保险柜", attribute: "口令", value, text: `保险柜的口令是${value}。`, quote: `保险柜的口令是${value}。` }],
    }, { caller: "author", idempotencyKey: value });
    expect(await commit("红松")).toMatchObject({ ok: true });
    expect((await syncLegacyMirror(book)).ok).toBe(true);
    await save(2, "林远看着保险柜。");
    const atHead = barrier();
    const finishHead = barrier();
    hooks.beforeRename = async (_from, to) => {
      if (to === join(book, "ledger/head.json")) { hooks.beforeRename = undefined; atHead.release(); await finishHead.promise; }
    };
    const writing = commit("白鹤");
    let prompt = "";
    try {
      await atHead.promise;
      const revising = reviseDraftOneShot({
        projectDir: book,
        chapter: 2,
        targetText: "林远看着保险柜。",
        revisionGoal: "补上账本里记的口令",
        callModel: async (input) => {
          prompt = input;
          return JSON.stringify({ beforeText: "林远看着保险柜。", afterText: "林远输入白鹤，打开了保险柜。" });
        },
      });
      await new Promise((done) => setTimeout(done, 50));
      expect(prompt).toBe("");
      finishHead.release();
      expect(await writing).toMatchObject({ ok: true });
      expect(await revising).toMatchObject({ ok: true, applied: true });
      expect(prompt).toContain("白鹤");
      expect(prompt).not.toContain("红松");
      expect(await pendingDraftFor(book, 2)).toBeUndefined();
    } finally {
      finishHead.release();
      await writing;
    }
  });
});
