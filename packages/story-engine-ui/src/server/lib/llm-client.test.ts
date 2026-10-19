import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSettingsLoadResult } from "../book/types.js";

const storyEngineMocks = vi.hoisted(() => ({
  loadModelSettingsV0: vi.fn(),
}));

vi.mock("./model-settings.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadModelSettingsV0: storyEngineMocks.loadModelSettingsV0,
}));

// resolveConfiguredChatModel 现在会读 task-assignments 旁路合成 thinking/profileId。
// 直接 mock 本地模块的 readTaskAssignments（比 mock node:os 内部 homedir() 稳），其余纯函数走 actual。
const taskAssignMocks = vi.hoisted(() => ({ readTaskAssignments: vi.fn() }));
vi.mock("./task-assignments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-assignments.js")>();
  return { ...actual, readTaskAssignments: taskAssignMocks.readTaskAssignments };
});

import { buildProviderRequestHeaders, callOpenAICompatibleChatModel, createIdleAbort, describeTruncatedFinish, getOpencodeSessionId, globalOpencodeSessionPath, isAlwaysOnThinkingModel, isOpencodeHost, isThinkingCannotBeDisabledError, isTruncatedFinishReason, learnAlwaysOnThinkingModel, modelCapabilityKey, resolveConfiguredChatModel, STORY_ENGINE_USER_AGENT, streamChatModelToText, streamOpenAICompatibleResponse, ThinkingTooLongError } from "./llm-client.js";

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
    expect(out.finishReason).toBeUndefined();
  });

  it("流中途的 error 帧（OpenAI 形 {error:{message}}）→ 抛「模型返回错误：…」，不再当 keepalive 吞掉", async () => {
    const response = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "半截" } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: "upstream overloaded", type: "server_error", code: 503 } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    await expect(streamOpenAICompatibleResponse(response, () => undefined)).rejects.toThrow("模型返回错误：upstream overloaded");
  });

  it("error 帧为字符串 / 只有 code 没有 message → 仍抛错且文案不为空", async () => {
    await expect(streamOpenAICompatibleResponse(sseResponse([`data: ${JSON.stringify({ error: "rate limited" })}\n\n`]), () => undefined))
      .rejects.toThrow("模型返回错误：rate limited");
    await expect(streamOpenAICompatibleResponse(sseResponse([`data: ${JSON.stringify({ error: { code: 429 } })}\n\n`]), () => undefined))
      .rejects.toThrow("模型返回错误：429");
  });

  it("末帧 finish_reason 被记录（stop / length），中间帧的 null 不覆盖", async () => {
    const stopped = await streamOpenAICompatibleResponse(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "A" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]), () => undefined);
    expect(stopped.content).toBe("A");
    expect(stopped.finishReason).toBe("stop");

    const truncated = await streamOpenAICompatibleResponse(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "B" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
    ]), () => undefined);
    expect(truncated.finishReason).toBe("length");
  });

  it("没有换行收尾的末帧也被读到（finish_reason 不漏）", async () => {
    const out = await streamOpenAICompatibleResponse(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "C" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}`,
    ]), () => undefined);
    expect(out.content).toBe("C");
    expect(out.finishReason).toBe("content_filter");
  });
});

describe("isTruncatedFinishReason / describeTruncatedFinish（只认公认截断枚举，陌生值不当失败）", () => {
  it("length / content_filter / max_tokens / truncated（大小写不敏感）为截断；stop / end_turn / tool_calls / 空 不是", () => {
    for (const bad of ["length", "LENGTH", "content_filter", "max_tokens", "truncated"]) expect(isTruncatedFinishReason(bad)).toBe(true);
    for (const ok of ["stop", "end_turn", "tool_calls", "", undefined]) expect(isTruncatedFinishReason(ok)).toBe(false);
  });

  it("文案含 finish_reason 与已收字数；全空时说明「一个字都没出」", () => {
    expect(describeTruncatedFinish("length", 120)).toMatch(/finish_reason=length/u);
    expect(describeTruncatedFinish("length", 120)).toMatch(/120 字/u);
    expect(describeTruncatedFinish("length", 0)).toMatch(/一个字都没出/u);
    expect(describeTruncatedFinish("content_filter", 5)).toMatch(/内容过滤/u);
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

});

describe("callOpenAICompatibleChatModel（重构 P4：内部走流式 + 空闲超时，不设总时长上限）", () => {
  function sse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }), { status: 200 });
  }
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
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
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => sse([frame({ content: "{}" }, "stop"), "data: [DONE]\n\n"]));
    await callOpenAICompatibleChatModel({ configured, messages: [{ role: "user", content: "x" }] });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    spy.mockRestore();
    return body;
  }

  it("发 stream:true，聚合正文并去首尾空白", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sse([frame({ content: "  {\"a\"" }), frame({ content: ":1}  " }, "stop"), "data: [DONE]\n\n"]));
    const out = await callOpenAICompatibleChatModel({ configured: fakeConfigured(false), messages: [{ role: "user", content: "x" }] });
    expect(out).toEqual({ content: "{\"a\":1}" });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBeUndefined();
    spy.mockRestore();
  });

  it("调用选项上不存在 maxTokens / timeoutMs 字段（max_tokens 铁律 + 不设总时长上限：传了必须编译失败）", () => {
    const configured = fakeConfigured(false);
    const withMaxTokens: Parameters<typeof callOpenAICompatibleChatModel>[0] = {
      configured,
      messages: [{ role: "user", content: "x" }],
      // @ts-expect-error — max_tokens 铁律：调用选项一律不得传 maxTokens（推理模型思考吃额度会截空正文）。
      maxTokens: 1024,
    };
    const withTimeout: Parameters<typeof callOpenAICompatibleChatModel>[0] = {
      configured,
      messages: [{ role: "user", content: "x" }],
      // @ts-expect-error — 超时铁律：不设总时长上限，只有空闲超时。
      timeoutMs: 250_000,
    };
    expect(withMaxTokens.configured).toBe(configured);
    expect(withTimeout.configured).toBe(configured);
  });

  it("思考开关按方言透传（glm thinking.type / qwen 流式跟随开关 / none 整键不发）", async () => {
    expect((await bodyOf(fakeConfigured(false))).thinking).toEqual({ type: "disabled" });
    expect((await bodyOf(fakeConfigured(true))).thinking).toEqual({ type: "enabled" });
    expect((await bodyOf(fakeConfigured(true, "qwen"))).enable_thinking).toBe(true);
    expect((await bodyOf(fakeConfigured(false, "qwen"))).enable_thinking).toBe(false);
    const none = await bodyOf(fakeConfigured(true, "none"));
    expect(none.thinking).toBeUndefined();
    expect(none.enable_thinking).toBeUndefined();
  });

  it("只吐思考、正文为空 → 如实抛错，不返回空串", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sse([frame({ reasoning_content: "想了很久" }), frame({}, "stop"), "data: [DONE]\n\n"]));
    await expect(callOpenAICompatibleChatModel({ configured: fakeConfigured(true), messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow("正文(content)为空");
    spy.mockRestore();
  });

  it("有字节就续命：慢速流总长超过空闲时限照常完成；彻底静默才判死", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const encoder = new TextEncoder();
      let push!: (text: string) => void;
      let close!: () => void;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          close = () => controller.close();
        },
      }), { status: 200 }));
      const pending = callOpenAICompatibleChatModel({ configured: fakeConfigured(false, "none"), messages: [{ role: "user", content: "x" }] });
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        push(frame({ content: `段${i}` }));
      }
      push(frame({}, "stop"));
      close();
      await expect(pending).resolves.toEqual({ content: "段0段1段2段3" });
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-10-09 十一轮验收：拟章纲开思考陷进去 20 分钟——思考 token 一直在续命，空闲超时管不住。
describe("streamChatModelToText 「光想不写」上限（maxThinkingMs）", () => {
  const configured = {
    provider: { id: "p", baseUrl: "https://x.invalid/v1", apiKeyStatus: "not_required" },
    profile: { id: "m", provider: "p", model: "m" },
    apiKey: "",
    thinking: true,
    thinkingDialect: "none",
  } as unknown as Parameters<typeof streamChatModelToText>[0]["configured"];

  /** 每 15ms 吐一块：先 reasoningCount 块思考，再 contentCount 块正文（0 = 只思考、永不收尾），被 abort 就报错。 */
  function pacedStream(signal: AbortSignal | null | undefined, reasoningCount: number, contentCount: number): globalThis.Response {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (signal?.aborted) { controller.error(new Error("aborted")); return; }
        if (contentCount === 0 || i < reasoningCount) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] })}\n\n`));
        } else if (i < reasoningCount + contentCount) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "写" } }] })}\n\n`));
        } else {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
        i += 1;
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("一直只思考、超过上限还没出正文 → 抛 ThinkingTooLongError（调用方据此关思考重试）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => pacedStream(init?.signal, 0, 0));
    await expect(streamChatModelToText({ configured, messages: [], maxThinkingMs: 120 })).rejects.toBeInstanceOf(ThinkingTooLongError);
    spy.mockRestore();
  });

  it("上限内开始出正文 → 之后写多久都不掐（不是总时长上限）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => pacedStream(init?.signal, 2, 20));
    const out = await streamChatModelToText({ configured, messages: [], maxThinkingMs: 120 });
    expect(out.content).toBe("写".repeat(20));
    spy.mockRestore();
  });

  it("正文字数上限（maxContentChars）：原地打转吐不停 → 掐掉并如实抛错；没超就照常收尾", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => pacedStream(init?.signal, 0, 30));
    await expect(streamChatModelToText({ configured, messages: [], maxContentChars: 10 })).rejects.toThrow("原地打转");
    const out = await streamChatModelToText({ configured, messages: [], maxContentChars: 100 });
    expect(out.content).toBe("写".repeat(30));
    spy.mockRestore();
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

  it("上游 200 但流里塞 error 帧 → 抛「模型返回错误」而不是返回半截正文（与非流式 parseFirstChoiceContent 对齐）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "半截" } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: "context length exceeded" } })}\n\n`,
    ]));
    await expect(streamChatModelToText({ configured: streamConfigured(false), messages: [] }))
      .rejects.toThrow("模型返回错误：context length exceeded");
    spy.mockRestore();
  });

  it("末帧 finish_reason=length → 抛截断错（半截正文不当完整结果）；=stop 正常返回并带回 finishReason", async () => {
    const truncatedSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "正文…" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    await expect(streamChatModelToText({ configured: streamConfigured(false), messages: [] }))
      .rejects.toThrow(/被截断.*finish_reason=length/u);
    truncatedSpy.mockRestore();

    const okSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "完整" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const out = await streamChatModelToText({ configured: streamConfigured(false), messages: [] });
    expect(out.content).toBe("完整");
    expect(out.finishReason).toBe("stop");
    okSpy.mockRestore();
  });

  it("陌生的非 stop finish_reason（如 end_turn）不当失败——模型无关，不赌陌生网关的枚举", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "end_turn" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const out = await streamChatModelToText({ configured: streamConfigured(false), messages: [] });
    expect(out.content).toBe("ok");
    expect(out.finishReason).toBe("end_turn");
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

  it("callOpenAICompatibleChatModel：opencode 主机带 session+UA，非 opencode 不带", async () => {
    // 每次调用造新 Response（Body 只能读一次；mockResolvedValue 复用同一实例会 "Body has already been read"）。
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }), { status: 200 }));
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
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }), { status: 200 }));
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
