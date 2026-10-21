// @vitest-environment node
//
// web_search 纯逻辑单测（P11）：博查 / Tavily 两家接口的结果归一、没开时如实说、
// 编排层诚实回报（空 query / 密钥不对 / 额度 / 网络失败 / 零结果分开措辞），fetch 注入不走真网络。
import { describe, expect, it } from "vitest";

import {
  buildWebSearchSummary,
  normalizeSearchResults,
  probeSearchSettings,
  runWebSearch,
} from "./web-search.js";

const BOCHA = { provider: "bocha", apiKey: "k-test" } as const;
const TAVILY = { provider: "tavily", apiKey: "k-test" } as const;

interface Call { readonly url: string; readonly init?: RequestInit }

function fetchJson(body: unknown, status = 200, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function bochaBody(items: readonly { name: string; url: string; snippet?: string; summary?: string }[], wrap = true): unknown {
  const inner = { _type: "SearchResponse", webPages: { value: items } };
  return wrap ? { code: 200, msg: null, data: inner } : inner;
}

describe("runWebSearch：没开就如实说", () => {
  it("没设置搜索服务 → ok:false、说去设置里开、不发请求", async () => {
    let called = false;
    const out = await runWebSearch({
      query: "清代镖局",
      settings: null,
      fetchImpl: (async () => { called = true; return new Response(""); }) as typeof fetch,
    });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("联网搜索还没开");
    expect(out.summary).toContain("设置");
    expect(called).toBe(false);
  });
});

describe("runWebSearch：博查", () => {
  it("正常检索 → 带密钥 POST 正式接口、结果归一、summary 带来源域名", async () => {
    const calls: Call[] = [];
    const out = await runWebSearch({
      query: "清代镖局",
      settings: BOCHA,
      fetchImpl: fetchJson(bochaBody([
        { name: "镖局史话", url: "https://www.example.com/biao", snippet: "短的", summary: "护送货物的机构" },
      ]), 200, calls),
    });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([{ title: "镖局史话", url: "https://www.example.com/biao", snippet: "护送货物的机构" }]);
    expect(out.summary).toContain("example.com");
    expect(out.summary).toContain("参考资料");
    expect(calls[0]?.url).toBe("https://api.bochaai.com/v1/web-search");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer k-test");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ query: "清代镖局", count: 5, summary: true });
  });

  it("不包 data 的老样子也认；没有 summary 用 snippet", async () => {
    const out = await runWebSearch({
      query: "q",
      settings: BOCHA,
      fetchImpl: fetchJson(bochaBody([{ name: "甲", url: "https://a.com", snippet: "摘要" }], false)),
    });
    expect(out.results).toEqual([{ title: "甲", url: "https://a.com", snippet: "摘要" }]);
  });

  it("包体里报错码（比如余额不足 403）→ 按失败说额度", async () => {
    const out = await runWebSearch({ query: "q", settings: BOCHA, fetchImpl: fetchJson({ code: 403, msg: "x", data: null }) });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("额度用完");
    expect(out.summary).toContain("博查");
  });
});

describe("runWebSearch：Tavily", () => {
  it("正常检索 → POST /search、results 归一", async () => {
    const calls: Call[] = [];
    const out = await runWebSearch({
      query: "lighthouse keeper",
      maxResults: 3,
      settings: TAVILY,
      fetchImpl: fetchJson({ results: [{ title: "Keeper", url: "https://b.org/k", content: "  long\n text  ", score: 0.9 }] }, 200, calls),
    });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([{ title: "Keeper", url: "https://b.org/k", snippet: "long text" }]);
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ query: "lighthouse keeper", max_results: 3, search_depth: "basic" });
  });
});

describe("runWebSearch：诚实回报", () => {
  it("空 query（模型退化输入）→ 诚实失败，不发请求", async () => {
    let called = false;
    const out = await runWebSearch({
      query: "   ",
      settings: BOCHA,
      fetchImpl: (async () => { called = true; return new Response(""); }) as typeof fetch,
    });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("搜索关键词");
    expect(called).toBe(false);
  });

  it("401 → 说密钥不对、去设置检查", async () => {
    const out = await runWebSearch({ query: "q", settings: TAVILY, fetchImpl: fetchJson({}, 401) });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("密钥不对");
  });

  it("429 → 说太频繁；5xx → 说那边故障", async () => {
    const busy = await runWebSearch({ query: "q", settings: TAVILY, fetchImpl: fetchJson({}, 429) });
    expect(busy.summary).toContain("太频繁");
    const down = await runWebSearch({ query: "q", settings: TAVILY, fetchImpl: fetchJson({}, 503) });
    expect(down.summary).toContain("出了故障");
  });

  it("网络失败 → ok:false + 如实说明 + 绝不编造", async () => {
    const out = await runWebSearch({
      query: "测试",
      settings: BOCHA,
      fetchImpl: (async () => { throw new Error("boom"); }) as typeof fetch,
    });
    expect(out.ok).toBe(false);
    expect(out.results).toEqual([]);
    expect(out.summary).toContain("没查成（网络请求失败）");
    expect(out.summary).toContain("不会编造");
  });

  it("零结果 → ok:false 且措辞区别于网络失败", async () => {
    const out = await runWebSearch({ query: "测试", settings: BOCHA, fetchImpl: fetchJson(bochaBody([])) });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("没有检索到可用结果");
  });

  it("包体对不上（不是预期的样子）→ 当零结果，不抛错", async () => {
    const out = await runWebSearch({ query: "测试", settings: TAVILY, fetchImpl: fetchJson(["?"]) });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("没有检索到可用结果");
  });

  it("maxResults 退化输入（0/负数）→ 用默认值不炸", async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ name: `条目${i}`, url: `https://e.com/${i}` }));
    const out = await runWebSearch({ query: "多结果", maxResults: 0, settings: BOCHA, fetchImpl: fetchJson(bochaBody(items)) });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBe(5); // DEFAULT_MAX_RESULTS
  });
});

describe("probeSearchSettings（设置页「试一下」）", () => {
  it("没开 / 能用 / 密钥不对 / 没结果 分开说，不带给 AI 的话术", async () => {
    expect((await probeSearchSettings({ settings: null })).summary).toContain("还没开");
    const works = await probeSearchSettings({ settings: BOCHA, fetchImpl: fetchJson(bochaBody([{ name: "甲", url: "https://a.com" }])) });
    expect(works).toEqual({ works: true, summary: "能用：真搜到了结果。" });
    const bad = await probeSearchSettings({ settings: TAVILY, fetchImpl: fetchJson({}, 401) });
    expect(bad.works).toBe(false);
    expect(bad.summary).toBe("没成功：Tavily说密钥不对。");
    const empty = await probeSearchSettings({ settings: BOCHA, fetchImpl: fetchJson(bochaBody([])) });
    expect(empty).toEqual({ works: false, summary: "连上了，但没搜到结果，可以过会儿再试。" });
  });
});

describe("normalizeSearchResults", () => {
  it("只认 http/https、去重、没标题的丢掉、摘要压空白并截短", () => {
    const out = normalizeSearchResults([
      { t: "甲", u: "https://a.com", s: "x".repeat(300) },
      { t: "甲重", u: "https://a.com", s: "" },
      { t: "坏链接", u: "javascript:alert(1)", s: "" },
      { t: "", u: "https://c.com", s: "" },
      "不是对象",
      { t: "乙", u: "http://b.com", s: 42 },
    ], (item) => ({ title: item.t, url: item.u, snippet: item.s }), 8);
    expect(out.map((r) => r.title)).toEqual(["甲", "乙"]);
    expect(out[0]?.snippet).toHaveLength(200);
    expect(out[1]?.snippet).toBe("");
  });
});

describe("buildWebSearchSummary", () => {
  it("条目化 + 序号 + 域名剥 www + 长摘要截断", () => {
    const summary = buildWebSearchSummary("测试", [
      { title: "甲", url: "https://www.foo.com/a", snippet: "长".repeat(120) },
      { title: "乙", url: "https://bar.org/b", snippet: "" },
    ]);
    expect(summary).toContain("1. 甲（foo.com）");
    expect(summary).toContain("2. 乙（bar.org）");
    expect(summary).toContain("…");
    expect(summary).not.toMatch(/web_search|bocha|tavily/iu);
  });
});
