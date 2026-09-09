// @vitest-environment node
//
// makeAgentRequestFetch 单测：主对话 agent（经 AI SDK 走流式）出站请求的两步模型无关改造（R7/R8）。
// 思考方言：glm→thinking:{type:enabled|disabled}、qwen→enable_thinking、none→整键不发；已显式设过不覆盖、非 JSON 原样放行。
// 工具 schema：带 tools 时把 parameters 递归补全 type（满足 Kimi/Moonshot 的 MFJS）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentRequestFetch } from "./model.js";
import { isAlwaysOnThinkingModel, learnAlwaysOnThinkingModel } from "../lib/llm-client.js";

/** 带 fetch 参数签名的 mock，便于读 mock.calls[0][1]（RequestInit）做断言。 */
function fetchSpy(body = "{}") {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status: 200 }));
}
function sentBody(spy: ReturnType<typeof fetchSpy>): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const toolBody = () => JSON.stringify({
  messages: [{ role: "user", content: "x" }],
  tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: { kind: { enum: ["a", "b"] }, n: { type: "integer", minimum: 0, maximum: 9 }, free: {} } } } }],
});
function toolParams(spy: ReturnType<typeof fetchSpy>): { properties: Record<string, { type?: string; minimum?: number }> } {
  return (sentBody(spy).tools as { function: { parameters: { properties: Record<string, { type?: string; minimum?: number }> } } }[])[0].function.parameters;
}

describe("makeAgentRequestFetch", () => {
  it("glm 方言 + thinking=false → 注入 thinking:{type:disabled}", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(false, "glm", "glm-4.6", spy as unknown as typeof fetch);
    await f("http://x", { body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) } as RequestInit);
    expect(sentBody(spy).thinking).toEqual({ type: "disabled" });
  });

  it("glm 方言 + thinking=true → 注入 thinking:{type:enabled}", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(true, "glm", "glm-4.6", spy as unknown as typeof fetch);
    await f("http://x", { body: JSON.stringify({ messages: [] }) } as RequestInit);
    expect(sentBody(spy).thinking).toEqual({ type: "enabled" });
  });

  it("qwen 方言（流式）→ 注入 enable_thinking 跟随开关", async () => {
    for (const want of [true, false]) {
      const spy = fetchSpy();
      const f = makeAgentRequestFetch(want, "qwen", "qwen3.7-plus", spy as unknown as typeof fetch);
      await f("http://x", { body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) } as RequestInit);
      const body = sentBody(spy);
      expect(body.enable_thinking).toBe(want);
      expect(body.thinking).toBeUndefined();
    }
  });

  it("none 方言（认不出的模型）→ 整键不发（thinking/enable_thinking 都 undefined）", async () => {
    for (const want of [true, false]) {
      const spy = fetchSpy();
      const f = makeAgentRequestFetch(want, "none", "kimi-k2.6", spy as unknown as typeof fetch);
      await f("http://x", { body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) } as RequestInit);
      const body = sentBody(spy);
      expect(body.thinking).toBeUndefined();
      expect(body.enable_thinking).toBeUndefined();
    }
  });

  it("已显式设过该方言键 → 不覆盖", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(false, "glm", "glm-4.6", spy as unknown as typeof fetch);
    await f("http://x", { body: JSON.stringify({ messages: [], thinking: { type: "enabled" } }) } as RequestInit);
    expect(sentBody(spy).thinking).toEqual({ type: "enabled" });
  });

  it("非 JSON body 原样放行（不抛）", async () => {
    const spy = fetchSpy("ok");
    const f = makeAgentRequestFetch(false, "glm", "glm-4.6", spy as unknown as typeof fetch);
    await expect(f("http://x", { body: "not-json" } as RequestInit)).resolves.toBeInstanceOf(Response);
  });

  it("Kimi 模型 + tools → MFJS 改造：补 type + 剥校验关键字", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(true, "none", "kimi-k2.6", spy as unknown as typeof fetch);
    await f("http://x", { body: toolBody() } as RequestInit);
    const params = toolParams(spy);
    expect(params.properties.kind.type).toBe("string");   // enum-only 补上 type
    expect(params.properties.free.type).toBe("string");   // 纯 typeless 兜底
    expect(params.properties.n.minimum).toBeUndefined();  // 不支持的关键字被剥
    expect(params.properties.n.type).toBe("integer");     // type 保留
  });

  it("非 Kimi 模型 + tools → schema 原样不动（零影响）", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(true, "glm", "glm-4.6", spy as unknown as typeof fetch);
    await f("http://x", { body: toolBody() } as RequestInit);
    const params = toolParams(spy);
    expect(params.properties.kind.type).toBeUndefined();  // enum-only 仍无 type（没改）
    expect(params.properties.n.minimum).toBe(0);          // 关键字仍在（没剥）
  });

  it("extraHeaders：每请求追加出站头（opencode 会话头/自定义头），Headers 归一小写", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(false, "none", "some-model", spy as unknown as typeof fetch, {
      "x-opencode-session": "session-abc",
      "user-agent": "story-engine-ng/1.0",
    });
    await f("http://x", { body: JSON.stringify({ messages: [] }) } as RequestInit);
    const headers = new Headers((spy.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-opencode-session")).toBe("session-abc");
    expect(headers.get("user-agent")).toBe("story-engine-ng/1.0");
  });

  it("extraHeaders 覆盖同名已有头（自定义 session 盖掉旧值），其余头保留", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(false, "none", "some-model", spy as unknown as typeof fetch, {
      "x-opencode-session": "new-session",
    });
    await f("http://x", {
      headers: { "x-opencode-session": "old-session", "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    } as RequestInit);
    const headers = new Headers((spy.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-opencode-session")).toBe("new-session");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("extraHeaders 与思考方言/body 改造叠加互不影响", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(false, "glm", "glm-4.6", spy as unknown as typeof fetch, {
      "x-opencode-session": "session-abc",
    });
    await f("http://x", { body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) } as RequestInit);
    expect(sentBody(spy).thinking).toEqual({ type: "disabled" });
    const headers = new Headers((spy.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-opencode-session")).toBe("session-abc");
  });

  it("不传 extraHeaders → 不动请求头（向后兼容）", async () => {
    const spy = fetchSpy();
    const f = makeAgentRequestFetch(false, "none", "some-model", spy as unknown as typeof fetch);
    await f("http://x", { headers: { "x-keep": "1" }, body: "{}" } as RequestInit);
    const headers = new Headers((spy.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-keep")).toBe("1");
  });
});


// ---------------------------------------------------------------------------
// always-on 思考模型自适应（agent 路·第三注入点）：400「cannot be disabled」→ 省略思考参数重试 + 学习
// ---------------------------------------------------------------------------

describe("makeAgentRequestFetch always-on 思考自适应", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  const cannotDisabled400 = () =>
    new Response(JSON.stringify({ error: { message: "[1210] cannot be disabled; please use low, high, or max" } }), { status: 400 });
  const chatBody = () => JSON.stringify({ messages: [{ role: "user", content: "x" }] });
  function sentBodyAt(spy: ReturnType<typeof fetchSpy>, call: number): Record<string, unknown> {
    const init = spy.mock.calls[call]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-cap-agent-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("glm 方言关思考被 400 拒 → 省略思考参数重试成功（最终 200）+ warn 留痕 + 能力落盘", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    spy
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const f = makeAgentRequestFetch(false, "glm", "glm-5.3-flash", spy as unknown as typeof fetch);
    const out = await f("https://gw.example.com/v1/chat/completions", { body: chatBody() } as RequestInit);

    expect(out.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBodyAt(spy, 0).thinking).toEqual({ type: "disabled" }); // 首发按方言注入
    expect(sentBodyAt(spy, 1).thinking).toBeUndefined(); // 重试整键省略
    expect(sentBodyAt(spy, 1).enable_thinking).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot be disabled"));
    expect(await isAlwaysOnThinkingModel("https://gw.example.com/v1", "glm-5.3-flash")).toBe(true); // 以请求 URL 的 host 记账
  });

  it("已学 always-on → 注入阶段直接跳过（首发即无 thinking 键，不再付 400 学费）", async () => {
    await learnAlwaysOnThinkingModel("https://gw.example.com/v1", "glm-5.3-flash");
    const spy = fetchSpy();

    const f = makeAgentRequestFetch(false, "glm", "glm-5.3-flash", spy as unknown as typeof fetch);
    await f("https://gw.example.com/v1/chat/completions", { body: chatBody() } as RequestInit);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy).thinking).toBeUndefined();
    expect(sentBody(spy).enable_thinking).toBeUndefined();
  });

  it("其他 400 → 不重试：baseFetch 只调一次，原响应原样返回（含 body 仍可读）", async () => {
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("invalid request: messages malformed", { status: 400 }));

    const f = makeAgentRequestFetch(false, "glm", "glm-5.3-flash", spy as unknown as typeof fetch);
    const out = await f("https://gw.example.com/v1/chat/completions", { body: chatBody() } as RequestInit);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(400);
    expect(await out.text()).toContain("messages malformed"); // 原响应未被消费
    expect(await isAlwaysOnThinkingModel("https://gw.example.com/v1", "glm-5.3-flash")).toBe(false);
  });

  it("用户显式开思考（thinking=true → enabled）→ 照发不误；即便 400 带 cannot be disabled 也不吞不重试", async () => {
    await learnAlwaysOnThinkingModel("https://gw.example.com/v1", "glm-5.3-flash");
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cannotDisabled400());

    const f = makeAgentRequestFetch(true, "glm", "glm-5.3-flash", spy as unknown as typeof fetch);
    const out = await f("https://gw.example.com/v1/chat/completions", { body: chatBody() } as RequestInit);

    expect(spy).toHaveBeenCalledTimes(1); // 没带「关思考」信号 → 无资格重试
    expect(sentBodyAt(spy, 0).thinking).toEqual({ type: "enabled" }); // 手动配置优先
    expect(out.status).toBe(400);
  });

  it("qwen 方言关思考（enable_thinking:false）命中 400 → 重试省略 enable_thinking（方言无关）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    spy
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const f = makeAgentRequestFetch(false, "qwen", "qwen3.7-plus", spy as unknown as typeof fetch);
    const out = await f("https://gw.example.com/v1/chat/completions", { body: chatBody() } as RequestInit);

    expect(out.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBodyAt(spy, 0).enable_thinking).toBe(false);
    expect(sentBodyAt(spy, 1).enable_thinking).toBeUndefined();
    expect(sentBodyAt(spy, 1).thinking).toBeUndefined();
  });

  it("能力文件坏 JSON → 注入阶段不崩（按无记忆照常注入 disabled），坏文件不被覆盖", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writeFile, readFile } = await import("node:fs/promises");
    const path = join(dir, "model-capabilities.json");
    await writeFile(path, "{broken json", "utf-8");
    const spy = fetchSpy();

    const f = makeAgentRequestFetch(false, "glm", "glm-5.3-flash", spy as unknown as typeof fetch);
    await f("https://gw.example.com/v1/chat/completions", { body: chatBody() } as RequestInit);

    expect(sentBody(spy).thinking).toEqual({ type: "disabled" }); // 不崩，按无记忆照常发
    expect(await readFile(path, "utf-8")).toBe("{broken json"); // 未被覆盖
  });
});
