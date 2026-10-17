import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterPaper } from "../api/workingDraftClient.js";
import { isDraftDirty, paperStage, useDraftStore } from "../stores/draftStore.js";
import { __resetDraftSyncForTests, editDraft, flushDraftSave, flushDraftSaveUnlessHeld, holdDraftSaves, openPaper, refreshPaper, saveDraftNow } from "./draftSync.js";

const PROJECT = "/books/钟楼";

function paper(chapter: number, draft: { body: string; version: string; title?: string } | null, committed: { body: string; title?: string } | null = null): ChapterPaper {
  return { chapter, draft: draft ? { chapter, ...draft } : null, committed, editedSinceCommit: null };
}

interface Disk { version: string | null; body: string; title?: string }

/** 假服务端：一章一份草稿，版本号按写的次数涨。 */
function fakeServer(initial: Record<number, Disk>, committed: Record<number, { body: string; title?: string }> = {}) {
  const disk: Record<number, Disk> = { ...initial };
  let seq = 0;
  const puts: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") {
      const chapter = Number(new URL(url, "http://x").searchParams.get("chapter"));
      const current = disk[chapter];
      const body: ChapterPaper = paper(chapter, current && current.version ? { body: current.body, version: current.version, ...(current.title ? { title: current.title } : {}) } : null, committed[chapter] ?? null);
      return new Response(JSON.stringify({ ok: true, paper: body }), { status: 200 });
    }
    const request = JSON.parse(String(init.body)) as { chapter: number; body: string; title?: string; baseVersion: string | null };
    puts.push(request);
    const current = disk[request.chapter] ?? { version: null, body: "" };
    if (request.baseVersion !== current.version) {
      return new Response(JSON.stringify({ ok: false, code: "draft_conflict", error: "改过了", current: current.version ? { chapter: request.chapter, body: current.body, version: current.version } : null }), { status: 409 });
    }
    seq += 1;
    disk[request.chapter] = { version: `v${seq}`, body: request.body, ...(request.title ? { title: request.title } : {}) };
    return new Response(JSON.stringify({ ok: true, version: `v${seq}`, unchanged: false }), { status: 200 });
  });
  return { disk, puts, fetchMock };
}

beforeEach(() => {
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("稿纸状态", () => {
  it("没有工作稿就显示定稿；作者一改就有没存的字", () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(1, null, { body: "定稿正文。", title: "钟停" }));
    const state = useDraftStore.getState();
    expect(state).toMatchObject({ body: "定稿正文。", title: "钟停", baseVersion: null });
    expect(paperStage(state)).toBe("committed");
    useDraftStore.getState().edit("定稿正文。又加一句。");
    expect(isDraftDirty(useDraftStore.getState())).toBe(true);
    expect(paperStage(useDraftStore.getState())).toBe("edited");
  });

  it("盘上来了新版本：没改过就换上；改过就挂提示，不动作者的字", () => {
    const store = useDraftStore.getState();
    store.loadPaper(PROJECT, paper(2, { body: "一。", version: "a" }));
    store.receivePaper(PROJECT, paper(2, { body: "AI 改的。", version: "b" }));
    expect(useDraftStore.getState()).toMatchObject({ body: "AI 改的。", baseVersion: "b", incoming: null });

    useDraftStore.getState().edit("作者在打字。");
    useDraftStore.getState().receivePaper(PROJECT, paper(2, { body: "AI 又改了。", version: "c" }));
    expect(useDraftStore.getState()).toMatchObject({ body: "作者在打字。", baseVersion: "b", incoming: { body: "AI 又改了。", version: "c", cause: "update" } });

    useDraftStore.getState().keepMine();
    expect(useDraftStore.getState()).toMatchObject({ body: "作者在打字。", baseVersion: "c", incoming: null });
    expect(isDraftDirty(useDraftStore.getState())).toBe(true);
  });

  it("force（作者点的撤销）直接换上", () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(1, { body: "新。", version: "b" }));
    useDraftStore.getState().edit("新。还没存。");
    useDraftStore.getState().receivePaper(PROJECT, paper(1, { body: "旧。", version: "a" }), { force: true });
    expect(useDraftStore.getState()).toMatchObject({ body: "旧。", baseVersion: "a", incoming: null });
  });

  it("别的章、别的书的新版本不收", () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(1, { body: "一。", version: "a" }));
    useDraftStore.getState().receivePaper(PROJECT, paper(2, { body: "二。", version: "x" }));
    useDraftStore.getState().receivePaper("/books/别的", paper(1, { body: "别的。", version: "y" }));
    expect(useDraftStore.getState()).toMatchObject({ chapter: 1, body: "一。", baseVersion: "a" });
  });
});

describe("存稿调度", () => {
  it("停笔后存一次，带上 baseVersion；存完版本号跟上", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ 1: { version: "v0", body: "一。" } });
    server.disk[1] = { version: null, body: "" };
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 1);
    editDraft("一。二。");
    editDraft("一。二。三。");
    expect(server.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(server.puts).toEqual([expect.objectContaining({ chapter: 1, body: "一。二。三。", baseVersion: null })]);
    expect(useDraftStore.getState()).toMatchObject({ baseVersion: "v1", savedBody: "一。二。三。", saveStatus: "saved" });
  });

  it("新的一章没有章名：存稿不带章名（导航上的「下一章」之类占位名不写进稿子）", async () => {
    const server = fakeServer({});
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 11);
    expect(useDraftStore.getState().title).toBe("");
    editDraft("清晨的雾还没散。");
    await flushDraftSave();
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).not.toHaveProperty("title");
  });

  it("撞版本：不覆盖盘上的，挂提示；选保留我这版后再存一次就过", async () => {
    const server = fakeServer({ 3: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 3);
    server.disk[3] = { version: "ai", body: "AI 改过。" };
    editDraft("作者的。");
    await flushDraftSave();
    expect(server.disk[3]?.body).toBe("AI 改过。");
    expect(useDraftStore.getState().incoming).toMatchObject({ body: "AI 改过。", version: "ai", cause: "conflict" });
    // 挂着提示时不再自动存
    editDraft("作者的。再加一句。");
    await flushDraftSave();
    expect(server.puts).toHaveLength(1);
    useDraftStore.getState().keepMine();
    await flushDraftSave();
    expect(server.disk[3]?.body).toBe("作者的。再加一句。");
  });

  it("换成那一版：作者的字换成盘上的，不再存", async () => {
    const server = fakeServer({ 3: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 3);
    server.disk[3] = { version: "ai", body: "AI 改过。" };
    editDraft("作者的。");
    await flushDraftSave();
    useDraftStore.getState().acceptIncoming();
    expect(useDraftStore.getState()).toMatchObject({ body: "AI 改过。", baseVersion: "ai", incoming: null });
    await flushDraftSave();
    expect(server.puts).toHaveLength(1);
  });

  it("换章前先把没存的字存掉", async () => {
    const server = fakeServer({ 1: { version: "v0", body: "一。" }, 2: { version: "w0", body: "二。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 1);
    editDraft("一。改了。");
    await openPaper(PROJECT, 2);
    expect(server.disk[1]?.body).toBe("一。改了。");
    expect(useDraftStore.getState()).toMatchObject({ chapter: 2, body: "二。" });
  });

  it("存稿路上作者又打了字：回来后接着存最新的", async () => {
    const server = fakeServer({ 1: { version: "v0", body: "一。" } });
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const original = server.fetchMock.getMockImplementation()!;
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && first) {
        first = false;
        await gate;
      }
      return original(url, init);
    }));
    await openPaper(PROJECT, 1);
    editDraft("一。二。");
    const saving = saveDraftNow();
    editDraft("一。二。三。");
    release();
    await saving;
    expect(server.disk[1]?.body).toBe("一。二。三。");
    expect(isDraftDirty(useDraftStore.getState())).toBe(false);
  });

  it("AI 回合里作者打字：先不存，AI 的稿回来出提示，作者的字一个不丢；放开后挂着提示也不存", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    const release = holdDraftSaves();
    editDraft("原稿。作者趁 AI 改稿时加的一句。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.puts).toHaveLength(0);
    // AI 改稿落盘（不比版本），回执到了重读一次。
    server.disk[2] = { version: "v-ai", body: "AI 改过的稿。" };
    await refreshPaper();
    expect(useDraftStore.getState()).toMatchObject({ body: "原稿。作者趁 AI 改稿时加的一句。" });
    expect(useDraftStore.getState().incoming).toMatchObject({ body: "AI 改过的稿。", version: "v-ai" });
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.puts).toHaveLength(0);
  });

  it("AI 回合没动稿子：放开后照常存作者打的字", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    const release = holdDraftSaves();
    editDraft("原稿。加一句。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.puts).toHaveLength(0);
    release();
    release();
    await vi.advanceTimersByTimeAsync(700);
    expect(server.puts).toEqual([expect.objectContaining({ chapter: 2, body: "原稿。加一句。", baseVersion: "v0" })]);
  });

  it("AI 回合里切到后台：不存作者刚打的字；回合外切后台照常存", async () => {
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    const release = holdDraftSaves();
    editDraft("原稿。作者趁 AI 改稿时加的一句。");
    await flushDraftSaveUnlessHeld();
    expect(server.puts).toHaveLength(0);
    release();
    await flushDraftSaveUnlessHeld();
    expect(server.puts).toEqual([expect.objectContaining({ chapter: 2, body: "原稿。作者趁 AI 改稿时加的一句。", baseVersion: "v0" })]);
  });

  it("撤销后重读：force 直接换上盘上的旧版", async () => {
    const server = fakeServer({ 1: { version: "v0", body: "旧。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 1);
    editDraft("新。");
    await flushDraftSave();
    server.disk[1] = { version: "v0", body: "旧。" };
    await refreshPaper({ force: true });
    expect(useDraftStore.getState()).toMatchObject({ body: "旧。", baseVersion: "v0" });
  });

  it("服务端出错：如实标错，不当已存", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ ok: false, error: "磁盘满了" }), { status: 500 });
      return new Response(JSON.stringify({ ok: true, paper: paper(1, { body: "一。", version: "v0" }) }), { status: 200 });
    }));
    await openPaper(PROJECT, 1);
    editDraft("一。二。");
    const result = await flushDraftSave();
    expect(result).toEqual({ ok: false, error: "磁盘满了" });
    expect(useDraftStore.getState()).toMatchObject({ saveStatus: "error", saveError: "磁盘满了" });
    expect(isDraftDirty(useDraftStore.getState())).toBe(true);
  });
});
