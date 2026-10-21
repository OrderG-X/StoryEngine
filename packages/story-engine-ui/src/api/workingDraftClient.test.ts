import { afterEach, describe, expect, it, vi } from "vitest";
import { retitleCommittedChapter } from "./workingDraftClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("改已定稿那一章的章名", () => {
  it("POST 带书、章号、章名和每次一个的防重复编号；成功交回服务端定下的章名", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, title: "回乡", unchanged: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await retitleCommittedChapter("/books/a", 1, " 回乡 ")).toEqual({ ok: true, title: "回乡", unchanged: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chapter-title");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ projectPath: "/books/a", chapter: 1, title: " 回乡 ", requestId: expect.any(String) });
  });

  it("没改成：如实带回服务端的原因；网络断了也不抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "第 3 章还没定稿，章名在稿纸上直接改。" }), { status: 409 })));
    expect(await retitleCommittedChapter("/books/a", 3, "回乡")).toEqual({ ok: false, error: "第 3 章还没定稿，章名在稿纸上直接改。" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("断网"); }));
    expect(await retitleCommittedChapter("/books/a", 3, "回乡")).toEqual({ ok: false, error: "没改成：断网" });
  });
});
