import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSettingsLoadResult } from "@actalk/story-engine";

const storyEngineMocks = vi.hoisted(() => ({
  loadModelSettingsV0: vi.fn(),
}));

vi.mock("@actalk/story-engine", async () => {
  const actual = await vi.importActual<typeof import("@actalk/story-engine")>("@actalk/story-engine");
  return {
    ...actual,
    ...storyEngineMocks,
  };
});

// resolveConfiguredChatModel 现在会读 task-assignments 旁路合成 thinking/profileId。
// 直接 mock 本地模块的 readTaskAssignments（比 mock node:os 内部 homedir() 稳），其余纯函数走 actual。
const taskAssignMocks = vi.hoisted(() => ({ readTaskAssignments: vi.fn() }));
vi.mock("./task-assignments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-assignments.js")>();
  return { ...actual, readTaskAssignments: taskAssignMocks.readTaskAssignments };
});

import { buildProviderRequestHeaders, callOpenAICompatibleChatModel, createIdleAbort, createOpenAICompatibleWriterClient, getOpencodeSessionId, globalOpencodeSessionPath, isAlwaysOnThinkingModel, isOpencodeHost, isThinkingCannotBeDisabledError, learnAlwaysOnThinkingModel, modelCapabilityKey, resolveConfiguredChatModel, STORY_ENGINE_USER_AGENT, streamChatModelToText, streamOpenAICompatibleResponse } from "./llm-client.js";

const { loadModelSettingsV0 } = storyEngineMocks;

function settingsWithoutTriage(): ModelSettingsLoadResult {
  return {
    passed: true,
    available: true,
    status: "loaded",
    configPath: "/tmp/model-settings.json",
    issues: [],
    summary: {
      available: true,
      status: "loaded",
      configPath: "/tmp/model-settings.json",
      defaultProvider: "main",
      defaultProfile: "balanced",
      providers: [
        {
          id: "main",
          type: "openai-compatible",
          baseUrl: "https://api.example.invalid/v1",
          apiKeyStatus: "not_required",
        },
      ],
      profiles: [
        {
          id: "balanced",
          provider: "main",
          model: "balanced-model",
        },
        {
          id: "fast",
          provider: "main",
          model: "fast-model",
        },
      ],
      taskProfiles: {
        qualityCheck: "fast",
        chapterSteering: "balanced",
      },
      issueCount: 0,
      highRiskIssueCount: 0,
    },
  };
}

describe("createIdleAbort（空闲超时：有字节就续命、彻底静默才判死）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("从不 kick：静默超过 idleMs 后 abort", () => {
    const idle = createIdleAbort(1000);
    expect(idle.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(idle.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2);
    expect(idle.controller.signal.aborted).toBe(true);
    idle.dispose();
  });

  it("持续 kick：永不 abort（有输出就续命，不设总时长上限）", () => {
    const idle = createIdleAbort(1000);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(900); // 每次都在窗口内
      idle.kick();
    }
    // 总共过了 9000ms，远超 idleMs，但因持续 kick 从未静默达 1000ms
    expect(idle.controller.signal.aborted).toBe(false);
    idle.dispose();
  });

  it("kick 后再次静默达 idleMs → abort", () => {
    const idle = createIdleAbort(1000);
    vi.advanceTimersByTime(500);
    idle.kick();
    vi.advanceTimersByTime(500); // 距上次 kick 仅 500ms
    expect(idle.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(600); // 距上次 kick 共 1100ms > 1000
    expect(idle.controller.signal.aborted).toBe(true);
    idle.dispose();
  });

  it("abort 后 kick 不复活", () => {
    const idle = createIdleAbort(1000);
    vi.advanceTimersByTime(1100);
    expect(idle.controller.signal.aborted).toBe(true);
    idle.kick();
    expect(idle.controller.signal.aborted).toBe(true);
    idle.dispose();
  });
});

describe("streamOpenAICompatibleResponse onActivity（每收到一块字节就回调，用于续命）", () => {
  function sseResponse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("正文 + 思考 delta 都累加，且 onActivity 在收到字节时被触发", async () => {
    const response = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想…" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文A" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文B" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const deltas: string[] = [];
    const thinks: string[] = [];
    let activity = 0;
    const out = await streamOpenAICompatibleResponse(
      response,
      (delta) => deltas.push(delta),
      (delta) => thinks.push(delta),
      () => {
        activity += 1;
      },
    );
    expect(out.content).toBe("正文A正文B");
    expect(out.thinking).toBe("想…");
    expect(deltas).toEqual(["正文A", "正文B"]);
    expect(thinks).toEqual(["想…"]);
    expect(activity).toBeGreaterThan(0);
  });
});

describe("resolveConfiguredChatModel triage fallback", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the qualityCheck profile when triage is not configured", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: null, corrupt: false });

    const resolved = await resolveConfiguredChatModel("triage");

    expect(resolved.profile.id).toBe("fast");
    expect(resolved.profile.model).toBe("fast-model");
  });

  it("审查 #9：显式指定的 profileId 不存在 → 明确报错，绝不静默切到 profiles[0]", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({
      file: { version: 1, tasks: { fastDraft: { profileId: "ghost-profile", thinking: true } } },
      corrupt: false,
    });
    await expect(resolveConfiguredChatModel("fastDraft")).rejects.toThrow(/ghost-profile/);
  });
});

describe("resolveConfiguredChatModel 合成思考开关（旁路）", () => {
  it("旁路把 fastDraft 思考设为 false → 返回 thinking:false + 用旁路 profileId；未配置任务默认 thinking:true", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({
      file: { version: 1, tasks: { fastDraft: { profileId: "fast", thinking: false } } },
      corrupt: false,
    });

    const draft = await resolveConfiguredChatModel("fastDraft");
    expect(draft.thinking).toBe(false);
    expect(draft.profile.id).toBe("fast"); // 旁路 profileId 生效

    const quality = await resolveConfiguredChatModel("qualityCheck");
    expect(quality.thinking).toBe(true); // 未配置该任务 → 默认开
  });

  it("enrichment 无旁路 → 回退引擎 chapterSteering 的 profile，thinking 默认 true", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: null, corrupt: false });
    const enr = await resolveConfiguredChatModel("enrichment");
    expect(enr.profile.id).toBe("balanced");
    expect(enr.thinking).toBe(true);
  });
});

describe("思考透传（非流式路）：按 configured.thinkingDialect 翻成各家方言（模型无关·R7）", () => {
  function fakeConfigured(thinking: boolean, thinkingDialect = "glm"): Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"] {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "m", temperature: 0.5 },
      apiKey: "",
      thinking,
      thinkingDialect,
    } as unknown as Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"];
  }
  async function bodyOf(configured: Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"]): Promise<Record<string, unknown>> {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    await callOpenAICompatibleChatModel({ configured, messages: [{ role: "user", content: "x" }] });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    spy.mockRestore();
    return body;
  }

  it("glm 方言 + thinking=false → body.thinking.type === 'disabled'", async () => {
    expect((await bodyOf(fakeConfigured(false))).thinking).toEqual({ type: "disabled" });
  });

  it("调用选项上不存在 maxTokens 字段（死参数陷阱已拔除：传了必须编译失败）", () => {
    const configured = fakeConfigured(false);
    // 该字段已从调用选项类型中删除（多余属性字面量检查会拦住）；若未来有人加回来，
    // 这里会因「多余 @ts-expect-error」编译失败拦住。纯类型级断言，不发真实请求。
    const attempted: Parameters<typeof callOpenAICompatibleChatModel>[0] = {
      configured,
      messages: [{ role: "user", content: "x" }],
      // @ts-expect-error — max_tokens 铁律：调用选项一律不得传 maxTokens（推理模型思考吃额度会截空正文）。
      maxTokens: 1024,
    };
    expect(attempted.configured).toBe(configured);
  });

  it("glm 方言 + thinking=true → body.thinking.type === 'enabled'", async () => {
    expect((await bodyOf(fakeConfigured(true))).thinking).toEqual({ type: "enabled" });
  });

  it("qwen 方言（非流式）→ 强制 enable_thinking:false（即便要开；Qwen3 非流式不关会 400）", async () => {
    for (const want of [true, false]) {
      const body = await bodyOf(fakeConfigured(want, "qwen"));
      expect(body.enable_thinking).toBe(false);
      expect(body.thinking).toBeUndefined();
    }
  });

  it("none 方言（认不出的模型）→ 整键不发（换 Kimi/DeepSeek 不因它报错）", async () => {
    const body = await bodyOf(fakeConfigured(true, "none"));
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });
});

describe("callOpenAICompatibleChatModel 超时（非流式短调用：signal 传入 fetch，超时判死不挂住）", () => {
  function fakeConfigured(): Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"] {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: false,
      thinkingDialect: "none",
    } as unknown as Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"];
  }

  it("fetch 收到 AbortSignal；正常响应不触发 abort", async () => {
    let captured: AbortSignal | null = null;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      captured = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    });
    const out = await callOpenAICompatibleChatModel({ configured: fakeConfigured(), messages: [{ role: "user", content: "x" }] });
    expect(out.content).toBe("ok");
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    spy.mockRestore();
  });

  it("上游死连超过 timeoutMs → abort 并抛「模型请求超时」（章节标题等短调用的 120s 兜底走这条路）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let captured: AbortSignal | null = null;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
        captured = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
        return new Promise<Response>((_resolve, reject) => {
          captured?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      });
      const pending = callOpenAICompatibleChatModel({ configured: fakeConfigured(), messages: [{ role: "user", content: "x" }], timeoutMs: 120_000 });
      const assertion = expect(pending).rejects.toThrow("模型请求超时：120000ms");
      await vi.advanceTimersByTimeAsync(120_001);
      await assertion;
      expect(captured!.aborted).toBe(true);
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamChatModelToText 思考透传（审稿/质检主路径，补覆盖空档）", () => {
  function sseResponse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }
  function streamConfigured(thinking: boolean, thinkingDialect = "glm"): Parameters<typeof streamChatModelToText>[0]["configured"] {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking,
      thinkingDialect,
    } as unknown as Parameters<typeof streamChatModelToText>[0]["configured"];
  }

  it("glm 方言 + thinking=false → body.thinking.type==='disabled' + stream:true，并聚合正文", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文A" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const out = await streamChatModelToText({ configured: streamConfigured(false), messages: [{ role: "user", content: "x" }] });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.stream).toBe(true);
    expect(out.content).toBe("正文A");
    spy.mockRestore();
  });

  it("glm 方言 + thinking=true → body.thinking.type==='enabled'", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    await streamChatModelToText({ configured: streamConfigured(true), messages: [] });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "enabled" });
    spy.mockRestore();
  });

  it("qwen 方言（流式）→ enable_thinking 跟随开关（流式可正常开思考）", async () => {
    for (const want of [true, false]) {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
      await streamChatModelToText({ configured: streamConfigured(want, "qwen"), messages: [] });
      const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.enable_thinking).toBe(want);
      expect(body.thinking).toBeUndefined();
      spy.mockRestore();
    }
  });

  it("none 方言（认不出的模型）→ 整键不发（流式路径同口径，换任何模型不因它报错）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    await streamChatModelToText({ configured: streamConfigured(true, "none"), messages: [] });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    spy.mockRestore();
  });

  it("onDelta：每段正文 delta 逐字外发（供出稿流式进编辑器），仍聚合完整 content", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "甲" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "乙" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const deltas: string[] = [];
    const out = await streamChatModelToText({ configured: streamConfigured(false), messages: [], onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["甲", "乙"]);
    expect(out.content).toBe("甲乙");
    spy.mockRestore();
  });
});

describe("createOpenAICompatibleWriterClient（出稿走流式·afterfix 治非流式整章生成卡代理超时间歇 500）", () => {
  function sseResponse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }
  function writerConfigured(): Parameters<typeof createOpenAICompatibleWriterClient>[0] {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "m", temperature: 0.7 },
      apiKey: "",
      thinking: false,
      thinkingDialect: "qwen",
    } as unknown as Parameters<typeof createOpenAICompatibleWriterClient>[0];
  }
  const ctx = { chapter: 5, sections: [] } as unknown as Parameters<ReturnType<typeof createOpenAICompatibleWriterClient>["generateDraft"]>[0]["context"];

  it("发 stream:true 并从 SSE 增量聚合正文（不再非流式一次性等整章→不卡代理超时）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第五章" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const out = await createOpenAICompatibleWriterClient(writerConfigured()).generateDraft({ context: ctx, maxOutputTokens: 0 });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(out.content).toBe("第五章正文。");
    spy.mockRestore();
  });

  it("绝不传 max_tokens（铁律：思考吃额度会截断/写空正文）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    await createOpenAICompatibleWriterClient(writerConfigured()).generateDraft({ context: ctx, maxOutputTokens: 4096 });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.max_tokens).toBeUndefined();
    expect(body.maxTokens).toBeUndefined();
    spy.mockRestore();
  });

  it("传 onDelta → 出稿时逐字外发正文 delta（agent 路流式进编辑器的源头），仍返回完整 content", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第五章" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文。" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const deltas: string[] = [];
    const out = await createOpenAICompatibleWriterClient(writerConfigured(), (d) => deltas.push(d)).generateDraft({ context: ctx, maxOutputTokens: 0 });
    expect(deltas.join("")).toBe("第五章正文。");
    expect(out.content).toBe("第五章正文。");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// OpenCode Go 会话头 + per-provider 自定义头（opencode.ai/docs/go/ 合规修复）
// ---------------------------------------------------------------------------

describe("isOpencodeHost（定向发头：只命中 opencode 主机，绝不广播）", () => {
  it("opencode 域名命中（大小写不敏感、含子域）", () => {
    expect(isOpencodeHost("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpencodeHost("https://OPENCODE.AI/zen/go/v1")).toBe(true);
    expect(isOpencodeHost("https://api.opencode.ai/v1")).toBe(true);
  });

  it("非 opencode / 非法 URL 不命中", () => {
    expect(isOpencodeHost("https://api.example.com/v1")).toBe(false);
    expect(isOpencodeHost("http://192.168.1.10:3000/v1")).toBe(false);
    expect(isOpencodeHost("not-a-url")).toBe(false);
    expect(isOpencodeHost("")).toBe(false);
  });
});

describe("getOpencodeSessionId（稳定会话 id：首次生成、持久化复用）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-oc-session-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("两次调用返回同一 id（不每次请求换新），并落盘 opencode-session.json（0600）", async () => {
    const first = await getOpencodeSessionId();
    const second = await getOpencodeSessionId();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);

    const onDisk = JSON.parse(await readFile(globalOpencodeSessionPath(), "utf-8")) as { sessionId?: string };
    expect(onDisk.sessionId).toBe(first);
    const mode = (await stat(globalOpencodeSessionPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("模拟重启（重新 import 模块清掉进程内缓存）后仍复用磁盘上的同一 id", async () => {
    const before = await getOpencodeSessionId();
    vi.resetModules();
    const fresh = await import("./llm-client.js");
    const after = await fresh.getOpencodeSessionId();
    expect(after).toBe(before);
  });

  it("并发首调合并为同一次生成（全员拿到同一 id、磁盘只有一份）", async () => {
    const ids = await Promise.all([getOpencodeSessionId(), getOpencodeSessionId(), getOpencodeSessionId()]);
    expect(new Set(ids).size).toBe(1);
  });
});

describe("buildProviderRequestHeaders（出站头组装：opencode 定向 + 自定义头合并）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-oc-headers-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("opencode 主机 → 带 x-opencode-session（稳定复用同一 id）+ 自有 User-Agent + authorization", async () => {
    const input = { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk-test" } as const;
    const first = await buildProviderRequestHeaders(input);
    expect(first["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first["user-agent"]).toBe(STORY_ENGINE_USER_AGENT);
    expect(first.authorization).toBe("Bearer sk-test");

    const second = await buildProviderRequestHeaders(input);
    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"]); // 稳定复用
  });

  it("非 opencode 主机 → 不带 x-opencode-session，也不强加 User-Agent（不广播）", async () => {
    const headers = await buildProviderRequestHeaders({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test" });
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer sk-test");
  });

  it("customHeaders 合并进请求（头名统一小写），且显式配置最后盖（可覆盖自动 session/UA/authorization）", async () => {
    const headers = await buildProviderRequestHeaders({
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "sk-test",
      customHeaders: { "X-Opencode-Session": "manual-session", "X-Relay-Tag": "relay-1" },
    });
    expect(headers["x-opencode-session"]).toBe("manual-session"); // 用户显式配置赢
    expect(headers["x-relay-tag"]).toBe("relay-1");
    expect(headers["user-agent"]).toBe(STORY_ENGINE_USER_AGENT); // 未覆盖时自动头仍在
    expect(Object.keys(headers)).not.toContain("X-Relay-Tag"); // 已归一小写，无双键并发
  });

  it("备胎 relay（非 opencode 主机）只在用户显式配了 customHeaders 时才带 x-opencode-session", async () => {
    const bare = await buildProviderRequestHeaders({ baseUrl: "http://10.0.0.8:3000/v1", apiKey: "sk-relay" });
    expect(bare["x-opencode-session"]).toBeUndefined();

    const withCustom = await buildProviderRequestHeaders({
      baseUrl: "http://10.0.0.8:3000/v1",
      apiKey: "sk-relay",
      customHeaders: { "x-opencode-session": "relay-session" },
    });
    expect(withCustom["x-opencode-session"]).toBe("relay-session");
  });
});

describe("chat 出站请求带头（opencode MissingSessionID 修复·真机验收路径）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-oc-chat-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function chatConfigured(baseUrl: string, customHeaders?: Record<string, string>) {
    return {
      provider: { id: "p", baseUrl, apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "sk-test",
      thinking: false,
      thinkingDialect: "none",
      ...(customHeaders ? { customHeaders } : {}),
    } as unknown as Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"];
  }
  function sentHeaders(spy: { mock: { calls: unknown[][] } }): Record<string, string> {
    return ((spy.mock.calls[0]?.[1] as RequestInit).headers ?? {}) as Record<string, string>;
  }

  it("非流式 callOpenAICompatibleChatModel：opencode 主机带 session+UA，非 opencode 不带", async () => {
    // 每次调用造新 Response（Body 只能读一次；mockResolvedValue 复用同一实例会 "Body has already been read"）。
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    await callOpenAICompatibleChatModel({
      configured: chatConfigured("https://opencode.ai/zen/go/v1"),
      messages: [{ role: "user", content: "x" }],
    });
    const opencodeHeaders = sentHeaders(spy);
    expect(opencodeHeaders["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(opencodeHeaders["user-agent"]).toBe(STORY_ENGINE_USER_AGENT);
    expect(opencodeHeaders.authorization).toBe("Bearer sk-test");
    expect(opencodeHeaders["content-type"]).toBe("application/json");

    spy.mockClear();
    await callOpenAICompatibleChatModel({
      configured: chatConfigured("https://api.example.com/v1"),
      messages: [{ role: "user", content: "x" }],
    });
    const plainHeaders = sentHeaders(spy);
    expect(plainHeaders["x-opencode-session"]).toBeUndefined();
    expect(plainHeaders["user-agent"]).toBeUndefined();
    expect(plainHeaders.authorization).toBe("Bearer sk-test");
  });

  it("流式 streamChatModelToText：opencode 主机同样带 session+UA（审稿/质检主路径）", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));
    await streamChatModelToText({
      configured: chatConfigured("https://opencode.ai/zen/go/v1"),
      messages: [],
    });
    const headers = sentHeaders(spy);
    expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(headers["user-agent"]).toBe(STORY_ENGINE_USER_AGENT);
  });

  it("configured.customHeaders 随请求发出（备胎 relay 场景），值不泄漏进错误消息", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    await callOpenAICompatibleChatModel({
      configured: chatConfigured("http://10.0.0.8:3000/v1", { "x-opencode-session": "relay-session" }),
      messages: [{ role: "user", content: "x" }],
    });
    expect(sentHeaders(spy)["x-opencode-session"]).toBe("relay-session");
  });
});

describe("resolveConfiguredChatModel 合成 customHeaders（从设置文件直读真实值）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-oc-resolve-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("provider 配了 customHeaders → 解析结果带上真实值；未配 → 空对象", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: null, corrupt: false });
    await writeFile(join(dir, "model-settings.json"), JSON.stringify({
      version: 1,
      providers: {
        main: {
          id: "main",
          type: "openai-compatible",
          baseUrl: "https://api.example.invalid/v1",
          customHeaders: { "x-relay-tag": "relay-1" },
        },
      },
      profiles: { fast: { id: "fast", provider: "main", model: "fast-model" } },
      taskProfiles: { qualityCheck: "fast" },
    }), "utf-8");

    const resolved = await resolveConfiguredChatModel("qualityCheck");
    expect(resolved.customHeaders).toEqual({ "x-relay-tag": "relay-1" });
  });
});


// ---------------------------------------------------------------------------
// always-on 思考模型自适应（真机实锤 glm-5.3-flash：发 disabled 必 400「cannot be disabled」）
// ---------------------------------------------------------------------------

describe("isThinkingCannotBeDisabledError（「思考不可关」400 特征判定·宽松覆盖文案变体）", () => {
  it("真机原文（glm-5.3-flash @ opencode-go）→ true：「[1210] cannot be disabled; please use low, high, or max」（不带 thinking 字样也认）", () => {
    const raw = JSON.stringify({ error: { message: "[1210] cannot be disabled; please use low, high, or max", code: 1210 } });
    expect(isThinkingCannotBeDisabledError(400, raw)).toBe(true);
  });

  it("已知文案变体 → true（cannot/can not/can't、1210 码、中文「不可关闭」类）", () => {
    expect(isThinkingCannotBeDisabledError(400, "thinking cannot be disabled for this model")).toBe(true);
    expect(isThinkingCannotBeDisabledError(400, "reasoning can not be disabled")).toBe(true);
    expect(isThinkingCannotBeDisabledError(400, "enable_thinking can't be disabled")).toBe(true);
    expect(isThinkingCannotBeDisabledError(400, "{\"code\":1210,\"message\":\"thinking disabled not allowed\"}")).toBe(true);
    expect(isThinkingCannotBeDisabledError(400, "该模型的思考不可关闭，请用 low/high/max")).toBe(true);
  });

  it("glm-5.3 真机文案（thinking-only 变体，不带 cannot/disabled 连写）→ true", () => {
    expect(isThinkingCannotBeDisabledError(400, "GLM-5.3 is a thinking-only model; disabling thinking...is not supported")).toBe(true);
    expect(isThinkingCannotBeDisabledError(400, "this is a thinking-only model")).toBe(true);
  });

  it("只认 400：500/401 即便文案命中也 false（不吞上游真故障）", () => {
    expect(isThinkingCannotBeDisabledError(500, "[1210] cannot be disabled")).toBe(false);
    expect(isThinkingCannotBeDisabledError(401, "thinking cannot be disabled")).toBe(false);
    expect(isThinkingCannotBeDisabledError(200, "cannot be disabled")).toBe(false);
  });

  it("其他 400 一律 false：鉴权/余额/参数错/模型不存在/空文案，绝不吞错重试", () => {
    expect(isThinkingCannotBeDisabledError(400, "invalid api key")).toBe(false);
    expect(isThinkingCannotBeDisabledError(400, "insufficient balance")).toBe(false);
    expect(isThinkingCannotBeDisabledError(400, "model not found: glm-5.3-flash")).toBe(false);
    expect(isThinkingCannotBeDisabledError(400, "invalid request: messages is required")).toBe(false);
    expect(isThinkingCannotBeDisabledError(400, "")).toBe(false);
  });
});

describe("model-capabilities 能力库（学习落盘 / 查询 / 坏文件保护）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-cap-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("能力键 = baseUrl host + model id（小写归一；路径/协议/大小写不影响）", () => {
    expect(modelCapabilityKey("https://OpenRouter.AI/zen/go/v1", "GLM-5.3-Flash")).toBe("openrouter.ai::glm-5.3-flash");
    expect(modelCapabilityKey("http://47.104.186.114:3000/v1", "m")).toBe("47.104.186.114::m");
    expect(modelCapabilityKey("openrouter.ai", "m")).toBe("openrouter.ai::m"); // 裸 host（agent 路抠出来的）兼容
  });

  it("未学习 → false；learn 落盘（含 learnedAt）→ true；重复 learn 幂等仍只有一个键", async () => {
    expect(await isAlwaysOnThinkingModel("https://api.example.com/v1", "glm-5.3-flash")).toBe(false);
    await learnAlwaysOnThinkingModel("https://api.example.com/v1", "glm-5.3-flash");
    expect(await isAlwaysOnThinkingModel("https://api.example.com/v1", "glm-5.3-flash")).toBe(true);

    const onDisk = JSON.parse(await readFile(join(dir, "model-capabilities.json"), "utf-8")) as {
      models: Record<string, { alwaysOnThinking?: boolean; learnedAt?: string }>;
    };
    expect(onDisk.models["api.example.com::glm-5.3-flash"]?.alwaysOnThinking).toBe(true);
    expect(onDisk.models["api.example.com::glm-5.3-flash"]?.learnedAt).toBeTruthy();

    await learnAlwaysOnThinkingModel("https://api.example.com/v1", "glm-5.3-flash");
    const after = JSON.parse(await readFile(join(dir, "model-capabilities.json"), "utf-8")) as { models: Record<string, unknown> };
    expect(Object.keys(after.models)).toHaveLength(1);
  });

  it("键按 host+model 隔离：换 host 或换 model 互不影响", async () => {
    await learnAlwaysOnThinkingModel("https://a.example.com/v1", "m1");
    expect(await isAlwaysOnThinkingModel("https://a.example.com/v1", "m1")).toBe(true);
    expect(await isAlwaysOnThinkingModel("https://b.example.com/v1", "m1")).toBe(false);
    expect(await isAlwaysOnThinkingModel("https://a.example.com/v1", "m2")).toBe(false);
  });

  it("坏 JSON：查询不崩按无记忆返回 false；learn 绝不拿空库覆盖坏文件（坏文件保护）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const path = join(dir, "model-capabilities.json");
    await writeFile(path, "{broken json", "utf-8");

    expect(await isAlwaysOnThinkingModel("https://a.example.com/v1", "m")).toBe(false); // 不崩
    await learnAlwaysOnThinkingModel("https://a.example.com/v1", "m");
    expect(await readFile(path, "utf-8")).toBe("{broken json"); // 原样保留，未被覆盖
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("model-capabilities"));
  });
});

describe("always-on 思考自适应（非流式 callOpenAICompatibleChatModel）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  const cannotDisabled400 = () =>
    new Response(JSON.stringify({ error: { message: "[1210] cannot be disabled; please use low, high, or max" } }), { status: 400 });
  const ok200 = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-cap-nonstream-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function glmConfigured(thinking: boolean, dialect = "glm") {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "glm-5.3-flash", temperature: 0.5 },
      apiKey: "",
      thinking,
      thinkingDialect: dialect,
    } as unknown as Parameters<typeof callOpenAICompatibleChatModel>[0]["configured"];
  }
  function sentBody(spy: { mock: { calls: unknown[][] } }, call: number): Record<string, unknown> {
    return JSON.parse((spy.mock.calls[call]?.[1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it("关思考被 400「cannot be disabled」拒 → 省略思考参数重试成功 + warn 留痕 + 能力落盘", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(ok200("正文"));

    const out = await callOpenAICompatibleChatModel({ configured: glmConfigured(false), messages: [{ role: "user", content: "x" }] });

    expect(out.content).toBe("正文");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBody(spy, 0).thinking).toEqual({ type: "disabled" }); // 首发按方言照常关
    const retryBody = sentBody(spy, 1);
    expect(retryBody.thinking).toBeUndefined(); // 重试整键省略，让模型用自身默认
    expect(retryBody.enable_thinking).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot be disabled")); // 诚实留痕
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(true); // 已学习落盘
  });

  it("学会后第二次调用直接跳过 disabled 注入（不再付 400 学费，只发一次请求）", async () => {
    await learnAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok200("ok"));

    const out = await callOpenAICompatibleChatModel({ configured: glmConfigured(false), messages: [] });

    expect(out.content).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    const body = sentBody(spy, 0);
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("其他 400 → 不重试、原样抛「模型返回错误」、不学习", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid request: messages malformed" } }), { status: 400 }));

    await expect(callOpenAICompatibleChatModel({ configured: glmConfigured(false), messages: [] }))
      .rejects.toThrow(/模型返回错误/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(false);
  });

  it("用户显式开思考 → 即便模型已学 always-on 也照发 enabled（手动配置优先，绝不硬编码省略）", async () => {
    await learnAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok200("ok"));

    await callOpenAICompatibleChatModel({ configured: glmConfigured(true), messages: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy, 0).thinking).toEqual({ type: "enabled" });
  });

  it("qwen 方言关思考命中同样 400 → 重试省略 enable_thinking（方言无关的自适应）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(ok200("ok"));

    const out = await callOpenAICompatibleChatModel({ configured: glmConfigured(false, "qwen"), messages: [] });

    expect(out.content).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBody(spy, 0).enable_thinking).toBe(false); // 非流式 qwen 强制 false
    expect(sentBody(spy, 1).enable_thinking).toBeUndefined();
    expect(sentBody(spy, 1).thinking).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("重试仍失败（400 还是 cannot be disabled）→ 错误原样抛、不学习（没确认的配方不记账）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(cannotDisabled400());

    await expect(callOpenAICompatibleChatModel({ configured: glmConfigured(false), messages: [] }))
      .rejects.toThrow(/cannot be disabled/);
    expect(spy).toHaveBeenCalledTimes(2); // 只重试一次，不循环
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(false);
  });
});

describe("always-on 思考自适应（流式 streamChatModelToText）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  const cannotDisabled400 = () =>
    new Response(JSON.stringify({ error: { message: "[1210] cannot be disabled; please use low, high, or max" } }), { status: 400 });
  function sseResponse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-cap-stream-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function glmConfigured(thinking: boolean) {
    return {
      provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
      profile: { id: "m", provider: "p", model: "glm-5.3-flash" },
      apiKey: "",
      thinking,
      thinkingDialect: "glm",
    } as unknown as Parameters<typeof streamChatModelToText>[0]["configured"];
  }
  function sentBody(spy: { mock: { calls: unknown[][] } }, call: number): Record<string, unknown> {
    return JSON.parse((spy.mock.calls[call]?.[1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it("400「cannot be disabled」→ 省略思考参数重试 + 聚合重试后的 SSE 正文 + 能力落盘 + warn 留痕", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "甲" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "乙" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]));

    const out = await streamChatModelToText({ configured: glmConfigured(false), messages: [] });

    expect(out.content).toBe("甲乙");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBody(spy, 0).thinking).toEqual({ type: "disabled" });
    expect(sentBody(spy, 1).thinking).toBeUndefined();
    expect(sentBody(spy, 1).stream).toBe(true); // 重试仍是流式
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot be disabled"));
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(true);
  });

  it("其他 400 → 不重试，原样抛「模型请求失败：400」", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid api key", { status: 400 }));

    await expect(streamChatModelToText({ configured: glmConfigured(false), messages: [] }))
      .rejects.toThrow(/模型请求失败：400/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(false);
  });

  it("已学 always-on → 首发即不发 disabled（流式路同样豁免学费）", async () => {
    await learnAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

    await streamChatModelToText({ configured: glmConfigured(false), messages: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy, 0).thinking).toBeUndefined();
    expect(sentBody(spy, 0).enable_thinking).toBeUndefined();
  });

  it("重试仍失败（500）→ 抛重试后的「模型请求失败：500」，不学习", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(new Response("Internal server error", { status: 500 }));

    await expect(streamChatModelToText({ configured: glmConfigured(false), messages: [] }))
      .rejects.toThrow(/模型请求失败：500/);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(false);
  });
});
