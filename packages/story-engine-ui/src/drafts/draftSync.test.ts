import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterPaper, PendingDraft } from "../api/workingDraftClient.js";
import { isDraftDirty, paperStage, useDraftStore } from "../stores/draftStore.js";
import { __resetDraftSyncForTests, acceptPaperIncoming, editDraft, flushDraftSave, keepPaperMine, openPaper, refreshPaper, saveDraftNow } from "./draftSync.js";

const PROJECT = "/books/钟楼";

function paper(chapter: number, draft: { body: string; version: string; title?: string } | null, committed: { body: string; title?: string } | null = null): ChapterPaper {
  return { chapter, draft: draft ? { chapter, ...draft } : null, committed, editedSinceCommit: null };
}

interface Disk { version: string | null; body: string; title?: string }

/**
 * 假服务端：一章一份草稿，版本号按写的次数涨。撞版本时把作者那份存成恢复稿（同章同底版一份）；
 * pending 是开章时提示的那一份（恢复稿优先，再 AI 候选），POST /pending 换上 / 不要了。
 */
function fakeServer(initial: Record<number, Disk>, committed: Record<number, { body: string; title?: string }> = {}) {
  const disk: Record<number, Disk> = { ...initial };
  let seq = 0;
  const puts: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  const recoveries: Record<string, PendingDraft & { chapter: number }> = {};
  const candidates: Record<string, PendingDraft & { chapter: number }> = {};
  const pendingFor = (chapter: number): PendingDraft | undefined => {
    const all = [...Object.values(recoveries), ...Object.values(candidates)].filter((entry) => entry.chapter === chapter && entry.body !== disk[chapter]?.body);
    const found = all[0];
    if (!found) return undefined;
    const { chapter: _chapter, ...pending } = found;
    return pending as PendingDraft;
  };
  const write = (chapter: number, body: string, title?: string): string => {
    seq += 1;
    disk[chapter] = { version: `v${seq}`, body, ...(title ? { title } : {}) };
    return `v${seq}`;
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") {
      const chapter = Number(new URL(url, "http://x").searchParams.get("chapter"));
      const current = disk[chapter];
      const pending = pendingFor(chapter);
      const body: ChapterPaper = {
        ...paper(chapter, current && current.version ? { body: current.body, version: current.version, ...(current.title ? { title: current.title } : {}) } : null, committed[chapter] ?? null),
        ...(pending ? { pending } : {}),
      };
      return new Response(JSON.stringify({ ok: true, paper: body }), { status: 200 });
    }
    if (url.endsWith("/pending")) {
      const request = JSON.parse(String(init.body)) as { chapter: number; kind: "recovery" | "candidate"; id: string; sha: string; decision: "adopt" | "dismiss"; baseVersion: string | null };
      decisions.push(request);
      const store = request.kind === "recovery" ? recoveries : candidates;
      const entry = store[request.id];
      if (request.decision === "dismiss") {
        delete store[request.id];
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (!entry) return new Response(JSON.stringify({ ok: false, error: "那一份已经不在了" }), { status: 404 });
      if (request.baseVersion !== (disk[request.chapter]?.version ?? null)) return new Response(JSON.stringify({ ok: false, error: "又改过了，没换" }), { status: 409 });
      delete store[request.id];
      return new Response(JSON.stringify({ ok: true, version: write(request.chapter, entry.body) }), { status: 200 });
    }
    const request = JSON.parse(String(init.body)) as { chapter: number; body: string; title?: string; baseVersion: string | null };
    puts.push(request);
    const current = disk[request.chapter] ?? { version: null, body: "" };
    if (request.baseVersion !== current.version) {
      const recoveryId = `${request.chapter}-${request.baseVersion ?? "new"}`;
      recoveries[recoveryId] = { kind: "recovery", id: recoveryId, chapter: request.chapter, body: request.body, sha: `sha-${request.body}` };
      return new Response(JSON.stringify({ ok: false, code: "draft_conflict", error: "改过了", recoveryId, current: current.version ? { chapter: request.chapter, body: current.body, version: current.version } : null }), { status: 409 });
    }
    return new Response(JSON.stringify({ ok: true, version: write(request.chapter, request.body, request.title), unchanged: false }), { status: 200 });
  });
  /** AI 写好一版、没换上（写的途中稿子改过）：服务端留成候选。 */
  const keepCandidate = (chapter: number, body: string, id = `${chapter}-cand`): void => {
    candidates[id] = { kind: "candidate", id, chapter, body, sha: `sha-${body}`, reason: "draft_moved" };
  };
  return { disk, puts, decisions, recoveries, candidates, keepCandidate, fetchMock };
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

  it("撤销后盘上变了、作者手上有没存的字：字不丢，出提示（第 4 轮复核 R7）", () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(1, { body: "新。", version: "b" }));
    useDraftStore.getState().edit("新。还没存。");
    useDraftStore.getState().receivePaper(PROJECT, paper(1, { body: "旧。", version: "a" }));
    expect(useDraftStore.getState()).toMatchObject({ body: "新。还没存。", baseVersion: "b", incoming: { body: "旧。", version: "a", cause: "update" } });
  });

  it("撤销后盘上那版没章名 → 稿纸上的章名也清掉，不留着改过的（真机试写：撤销「改章名」后稿纸还显示新章名）", () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(1, { body: "正文。", version: "b", title: "回巷" }));
    useDraftStore.getState().receivePaper(PROJECT, paper(1, { body: "正文。", version: "a" }));
    expect(useDraftStore.getState()).toMatchObject({ title: "", savedTitle: "", baseVersion: "a" });
  });

  it("手上的字等于底版、但最后那笔没存上：盘上别处的新版只出提示；盘上是自己存的那版就以它为底接着存（第 10 轮复核 X2）", () => {
    const own = (version: string | null) => version === "b";
    useDraftStore.getState().loadPaper(PROJECT, paper(1, { body: "A。", version: "a" }));
    expect(useDraftStore.getState().receivePaper(PROJECT, paper(1, { body: "AI 的 C。", version: "c" }), { unsaved: true, isOwn: own })).toBe("incoming");
    expect(useDraftStore.getState()).toMatchObject({ body: "A。", baseVersion: "a", incoming: { body: "AI 的 C。", version: "c" } });
    useDraftStore.getState().loadPaper(PROJECT, paper(1, { body: "A。", version: "a" }));
    expect(useDraftStore.getState().receivePaper(PROJECT, paper(1, { body: "自己的 B。", version: "b" }), { unsaved: true, isOwn: own })).toBe("own");
    expect(useDraftStore.getState()).toMatchObject({ body: "A。", baseVersion: "b", savedBody: "自己的 B。", incoming: null });
    expect(isDraftDirty(useDraftStore.getState())).toBe(true);
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

  it("撞版本：不覆盖盘上的，挂提示；作者那份存成恢复稿，接着打的字也存进去；同一份不重发；选保留我这版后再存一次就过", async () => {
    const server = fakeServer({ 3: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 3);
    server.disk[3] = { version: "ai", body: "AI 改过。" };
    editDraft("作者的。");
    await flushDraftSave();
    expect(server.disk[3]?.body).toBe("AI 改过。");
    expect(useDraftStore.getState().incoming).toMatchObject({ body: "AI 改过。", version: "ai", cause: "conflict", recoveryId: "3-v0" });
    expect(server.recoveries["3-v0"]?.body).toBe("作者的。");
    // 同一份字不再重发（不打转）
    await flushDraftSave();
    expect(server.puts).toHaveLength(1);
    // 挂着提示时接着打的字照存，存进恢复稿
    editDraft("作者的。再加一句。");
    await flushDraftSave();
    expect(server.puts).toHaveLength(2);
    expect(server.recoveries["3-v0"]?.body).toBe("作者的。再加一句。");
    expect(server.disk[3]?.body).toBe("AI 改过。");
    await keepPaperMine();
    await flushDraftSave();
    expect(server.disk[3]?.body).toBe("作者的。再加一句。");
    expect(useDraftStore.getState().incoming).toBeNull();
  });

  it("撞版本后换成那一版：作者的字换成盘上的，不再存；那份恢复稿删掉", async () => {
    const server = fakeServer({ 3: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 3);
    server.disk[3] = { version: "ai", body: "AI 改过。" };
    editDraft("作者的。");
    await flushDraftSave();
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(useDraftStore.getState()).toMatchObject({ body: "AI 改过。", baseVersion: "ai", incoming: null });
    expect(server.recoveries["3-v0"]).toBeUndefined();
    await flushDraftSave();
    expect(server.puts).toHaveLength(1);
  });

  it("上次没存上的一版：开章时提示，找回那一版换上（带眼前的版本）", async () => {
    const server = fakeServer({ 3: { version: "v0", body: "原稿。" } });
    server.recoveries["3-old"] = { kind: "recovery", id: "3-old", chapter: 3, body: "上回没存上的字。", sha: "sha-old" };
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 3);
    expect(useDraftStore.getState()).toMatchObject({ body: "原稿。", incoming: { cause: "recovery", body: "上回没存上的字。" } });
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(server.decisions).toEqual([expect.objectContaining({ kind: "recovery", id: "3-old", sha: "sha-old", decision: "adopt", baseVersion: "v0" })]);
    expect(useDraftStore.getState()).toMatchObject({ body: "上回没存上的字。", incoming: null });
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

  it("换章读新章那会儿作者又打了字：换上之前再存一次，原章盘上有这句（第 4 轮复核 R3）", async () => {
    const server = fakeServer({ 1: { version: "v0", body: "一。" }, 2: { version: "w0", body: "二。" } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((!init || !init.method || init.method === "GET") && url.includes("chapter=2")) editDraft("一。改了。读盘时又打的一句。");
      return server.fetchMock(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await openPaper(PROJECT, 1);
    editDraft("一。改了。");
    await openPaper(PROJECT, 2);
    expect(server.disk[1]?.body).toBe("一。改了。读盘时又打的一句。");
    expect(useDraftStore.getState()).toMatchObject({ chapter: 2, body: "二。" });
  });

  it("换章读盘时又打的字存不上：不换章，字留在原章稿纸上", async () => {
    const server = fakeServer({ 1: { version: "v0", body: "一。" }, 2: { version: "w0", body: "二。" } });
    let failPuts = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((!init || !init.method || init.method === "GET") && url.includes("chapter=2")) {
        editDraft("一。读盘时又打的一句。");
        failPuts = true;
      }
      if (failPuts && init?.method === "PUT") throw new Error("写盘失败");
      return server.fetchMock(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await openPaper(PROJECT, 1);
    await expect(openPaper(PROJECT, 2)).rejects.toThrow();
    expect(useDraftStore.getState()).toMatchObject({ chapter: 1, body: "一。读盘时又打的一句。" });
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

  it("AI 回合里作者打字：照常存；AI 那版没换上、留成候选，回执到了稿纸出提示，作者的字一个不丢", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    editDraft("原稿。作者趁 AI 改稿时加的一句。");
    await vi.advanceTimersByTimeAsync(700);
    expect(server.disk[2]?.body).toBe("原稿。作者趁 AI 改稿时加的一句。");
    // AI 写完时版本对不上：服务端没换，留成候选。
    server.keepCandidate(2, "AI 改过的稿。");
    await refreshPaper();
    expect(useDraftStore.getState()).toMatchObject({ body: "原稿。作者趁 AI 改稿时加的一句。", incoming: { cause: "candidate", body: "AI 改过的稿。" } });
    // 挂着候选提示照常存
    editDraft("原稿。作者趁 AI 改稿时加的一句。又一句。");
    await vi.advanceTimersByTimeAsync(700);
    expect(server.disk[2]?.body).toBe("原稿。作者趁 AI 改稿时加的一句。又一句。");
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "candidate" });
  });

  it("换成 AI 这版：先存掉手上的字，再按眼前的版本换上，读回新稿", async () => {
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    server.keepCandidate(2, "AI 写的一版。");
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    editDraft("原稿。作者刚加的。");
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    expect(server.puts).toEqual([expect.objectContaining({ body: "原稿。作者刚加的。", baseVersion: "v0" })]);
    expect(server.decisions).toEqual([expect.objectContaining({ kind: "candidate", decision: "adopt", baseVersion: "v1" })]);
    expect(useDraftStore.getState()).toMatchObject({ body: "AI 写的一版。", baseVersion: "v2", incoming: null });
  });

  it("换成 AI 这版时稿子又被改过：不换，如实说，提示还在", async () => {
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    server.keepCandidate(2, "AI 写的一版。");
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    server.disk[2] = { version: "elsewhere", body: "别处改的。" };
    const result = await acceptPaperIncoming();
    expect(result).toEqual({ ok: false, error: "又改过了，没换" });
    expect(server.disk[2]?.body).toBe("别处改的。");
    expect(server.candidates["2-cand"]).toBeDefined();
  });

  it("AI 这版不要了：服务端删掉，提示收起，稿子不动", async () => {
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    server.keepCandidate(2, "AI 写的一版。");
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    expect(await keepPaperMine()).toEqual({ ok: true });
    expect(server.candidates["2-cand"]).toBeUndefined();
    expect(useDraftStore.getState()).toMatchObject({ body: "原稿。", incoming: null });
  });

  it("盘上变了、作者手上有没存的字：马上存一笔进恢复稿，不只留在页面里", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ 2: { version: "v0", body: "原稿。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 2);
    useDraftStore.getState().edit("原稿。还没到存的时候。");
    server.disk[2] = { version: "undo", body: "撤销后的。" };
    await refreshPaper();
    await vi.advanceTimersByTimeAsync(10);
    expect(server.recoveries["2-v0"]?.body).toBe("原稿。还没到存的时候。");
    expect(useDraftStore.getState().incoming).toMatchObject({ cause: "conflict", body: "撤销后的。" });
  });

  it("撤销后重读：手上的字都存上了，直接换上盘上的旧版", async () => {
    const server = fakeServer({ 1: { version: "v0", body: "旧。" } });
    vi.stubGlobal("fetch", server.fetchMock);
    await openPaper(PROJECT, 1);
    editDraft("新。");
    await flushDraftSave();
    server.disk[1] = { version: "v0", body: "旧。" };
    await refreshPaper();
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
