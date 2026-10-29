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

import { __resetCapabilityMemoryForTests, __setModelConfigReadGapHookForTests, buildProviderRequestHeaders, callOpenAICompatibleChatModel, createIdleAbort, freezeModelChoices, describeTruncatedFinish, getOpencodeSessionId, globalOpencodeSessionPath, isAlwaysOnThinkingModel, isOpencodeHost, isThinkingCannotBeDisabledError, isTruncatedFinishReason, learnAlwaysOnThinkingModel, modelCapabilityKey, resolveConfiguredChatModel, STORY_ENGINE_USER_AGENT, streamChatModelToText, streamOpenAICompatibleResponse, serializeModelSecrets, unlearnedCapabilityCount, withModelConfigLock } from "./llm-client.js";

import { runInOperation } from "./operations/context.js";

// 进程里学到的兼容能力每条用例清掉（写作版本 P2a 4.5：「不认」先进内存再落盘），用例之间不串。
beforeEach(() => __resetCapabilityMemoryForTests());

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

  it("流中途的 error 帧（OpenAI 形 {error:{message}}）→ 读到底、记下错误，不再当 keepalive 吞掉；调用方按产物不能用报「模型返回错误：…」", async () => {
    const frames = () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "半截" } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: "upstream overloaded", type: "server_error", code: 503 } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(await streamOpenAICompatibleResponse(frames(), () => undefined)).toMatchObject({ content: "半截", errorText: "upstream overloaded", sawEnd: true, badFrames: 0 });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(frames());
    await expect(streamChatModelToText({ configured: { provider: { id: "p", baseUrl: "https://x.invalid/v1" }, profile: { model: "m" }, apiKey: "k", thinking: false, thinkingDialect: "none" } as never, messages: [] }))
      .rejects.toMatchObject({ message: "模型返回错误：upstream overloaded", attemptClass: "unusable", unusable: "error_frame" });
    spy.mockRestore();
  });

  it("error 帧为字符串 / 只有 code 没有 message → 文案不为空", async () => {
    expect(await streamOpenAICompatibleResponse(sseResponse([`data: ${JSON.stringify({ error: "rate limited" })}\n\n`]), () => undefined))
      .toMatchObject({ errorText: "rate limited" });
    expect(await streamOpenAICompatibleResponse(sseResponse([`data: ${JSON.stringify({ error: { code: 429 } })}\n\n`]), () => undefined))
      .toMatchObject({ errorText: "429" });
  });

  it("解析不了的数据帧不当保活跳过：记坏帧数，正文丢了字就不交出去（产物不能用）", async () => {
    const frames = () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "甲" } }] })}\n\n`,
      "data: {坏的\n\n",
      ": 这是保活注释\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "丙" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(await streamOpenAICompatibleResponse(frames(), () => undefined)).toMatchObject({ content: "甲丙", badFrames: 1, sawEnd: true });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(frames());
    await expect(streamChatModelToText({ configured: { provider: { id: "p", baseUrl: "https://x.invalid/v1" }, profile: { model: "m" }, apiKey: "k", thinking: false, thinkingDialect: "none" } as never, messages: [] }))
      .rejects.toMatchObject({ attemptClass: "unusable", unusable: "bad_frames" });
    spy.mockRestore();
  });

  it("没见结束标记就断了：结果不明，半截正文不交出去", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "写了一半" } }] })}\n\n`]));
    await expect(streamChatModelToText({ configured: { provider: { id: "p", baseUrl: "https://x.invalid/v1" }, profile: { model: "m" }, apiKey: "k", thinking: false, thinkingDialect: "none" } as never, messages: [] }))
      .rejects.toMatchObject({ attemptClass: "unknown" });
    spy.mockRestore();
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

  it("备用模型（P10）：选了就带上；和主模型同一个不带；档案没了不挡主模型", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: {}, fallbackProfileId: "balanced" }, corrupt: false });
    expect((await resolveConfiguredChatModel("qualityCheck")).fallback?.profile.model).toBe("balanced-model");
    expect((await resolveConfiguredChatModel("chapterSteering")).fallback).toBeUndefined();

    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: {}, fallbackProfileId: "ghost" }, corrupt: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolved = await resolveConfiguredChatModel("qualityCheck");
    expect(resolved.profile.id).toBe("fast");
    expect(resolved.fallback).toBeUndefined();
    warn.mockRestore();
  });
});

describe("开工时冻结的模型选择（写作版本 P2a 4.5）", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  const inOperation = <T>(models: Awaited<ReturnType<typeof freezeModelChoices>>, fn: () => Promise<T>): Promise<T> =>
    runInOperation({ bookDir: "/tmp/book", opId: "op-1", runEpoch: 1, bookEpoch: "e", signal: new AbortController().signal, lane: "foreground", models }, fn);

  it("操作里按开工时那份取：作者中途改了任务用哪个模型、改了思考开关，这次操作照旧", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: { qualityCheck: { profileId: "fast", thinking: false } }, fallbackProfileId: "balanced" }, corrupt: false });
    const frozen = await freezeModelChoices();
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: { qualityCheck: { profileId: "balanced", thinking: true } } }, corrupt: false });

    const inside = await inOperation(frozen, () => resolveConfiguredChatModel("qualityCheck"));
    expect(inside).toMatchObject({ profile: { id: "fast" }, thinking: false, task: "qualityCheck", fallback: { profile: { id: "balanced" } } });
    // 操作外（下一次）按现在的设置。
    expect(await resolveConfiguredChatModel("qualityCheck")).toMatchObject({ profile: { id: "balanced" }, thinking: true });
  });

  it("开工时那个档案后来被删了：如实失败，不悄悄换成别的模型；开工时就配不出的任务照那时的原因失败", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: { qualityCheck: { profileId: "fast", thinking: true }, fastDraft: { profileId: "ghost", thinking: true } } }, corrupt: false });
    const frozen = await freezeModelChoices();
    const without = settingsWithoutTriage();
    loadModelSettingsV0.mockResolvedValue({ ...without, summary: { ...without.summary, profiles: without.summary.profiles.filter((profile) => profile.id !== "fast") } });
    await expect(inOperation(frozen, () => resolveConfiguredChatModel("qualityCheck"))).rejects.toThrow(/开工时给「.*」用的模型「fast-model」被删了/u);
    await expect(inOperation(frozen, () => resolveConfiguredChatModel("fastDraft"))).rejects.toThrow(/ghost/u);
  });

  it("服务商路由一起冻住（Astra P2a 第 8 轮第 5 条）：开工后改了地址 / 密钥来源 → 这次如实停下，不往哪边发；只改限流组照旧、按冻结的组排队", async () => {
    const base = settingsWithoutTriage();
    const withProvider = (patch: Record<string, unknown>): ModelSettingsLoadResult => ({ ...base, summary: { ...base.summary, providers: [{ ...base.summary.providers[0]!, ...patch }] } });
    loadModelSettingsV0.mockResolvedValue(withProvider({ quotaGroup: "套餐甲" }));
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: { qualityCheck: { profileId: "fast", thinking: true } }, fallbackProfileId: "balanced" }, corrupt: false });
    const frozen = await freezeModelChoices();
    expect(frozen.providers.main).toEqual({ id: "main", type: "openai-compatible", baseUrl: "https://api.example.invalid/v1", quotaGroup: "套餐甲" });

    loadModelSettingsV0.mockResolvedValue(withProvider({ quotaGroup: "套餐乙", label: "改了名" }));
    expect(await inOperation(frozen, () => resolveConfiguredChatModel("qualityCheck"))).toMatchObject({ provider: { baseUrl: "https://api.example.invalid/v1", quotaGroup: "套餐甲", label: "改了名" } });

    loadModelSettingsV0.mockResolvedValue(withProvider({ baseUrl: "https://other.example.invalid/v1" }));
    await expect(inOperation(frozen, () => resolveConfiguredChatModel("qualityCheck"))).rejects.toThrow(/服务商地址（或密钥来源）改了/u);
    loadModelSettingsV0.mockResolvedValue(withProvider({ apiKeyEnv: "OTHER_KEY", apiKeyStatus: "present" }));
    await expect(inOperation(frozen, () => resolveConfiguredChatModel("qualityCheck"))).rejects.toThrow(/服务商地址（或密钥来源）改了/u);
    // 操作外照现在的设置。
    expect(await resolveConfiguredChatModel("qualityCheck")).toMatchObject({ provider: { apiKeyEnv: "OTHER_KEY" } });
  });

  it("档案的服务商开工时就不在：那个任务冻结成一句原因（受理前就挡下），备用不带", async () => {
    const base = settingsWithoutTriage();
    loadModelSettingsV0.mockResolvedValue({ ...base, summary: { ...base.summary, profiles: [...base.summary.profiles, { id: "orphan", provider: "gone", model: "orphan-model" }] } });
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: { version: 1, tasks: { qualityCheck: { profileId: "orphan", thinking: true } }, fallbackProfileId: "orphan" }, corrupt: false });
    const frozen = await freezeModelChoices();
    expect(frozen.tasks.qualityCheck).toEqual({ error: expect.stringMatching(/服务商不见了/u) });
    expect(frozen.fallback).toBeUndefined();
    expect(frozen.providers.gone).toBeUndefined();
  });
});

describe("模型设置锁（Astra P2a 第 9 轮第 1 条）：解析模型时读的设置、密钥是同一次保存的", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-model-lock-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    __setModelConfigReadGapHookForTests(undefined);
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("读完设置、读密钥之前有人保存（换地址 + 换密钥）：保存等这次读完，新密钥不会配旧地址；存完之后开工时冻住的那次如实停下", async () => {
    const base = settingsWithoutTriage();
    const at = (baseUrl: string): ModelSettingsLoadResult => ({ ...base, summary: { ...base.summary, providers: [{ ...base.summary.providers[0]!, baseUrl, apiKeyStatus: "present" }] } });
    loadModelSettingsV0.mockResolvedValue(at("https://old.example.invalid/v1"));
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: null, corrupt: false });
    await writeFile(join(dir, "model-secrets.json"), serializeModelSecrets({ main: "key-old" }), "utf-8");
    const frozen = await freezeModelChoices();

    // 设置页保存（另一个请求，在锁外起）：地址、密钥一起换，和路由一样在锁里写。解析读完设置、读密钥之前放它走。
    let savedDone = false;
    let startSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => { startSave = resolve; });
    const saved = saveStarted.then(() => withModelConfigLock(async () => {
      loadModelSettingsV0.mockResolvedValue(at("https://new.example.invalid/v1"));
      await writeFile(join(dir, "model-secrets.json"), serializeModelSecrets({ main: "key-new" }), "utf-8");
    })).then(() => { savedDone = true; });
    __setModelConfigReadGapHookForTests(async () => {
      startSave();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const resolved = await resolveConfiguredChatModel("qualityCheck");
    expect(resolved).toMatchObject({ provider: { baseUrl: "https://old.example.invalid/v1" }, apiKey: "key-old" });
    expect(savedDone).toBe(false);
    await saved;
    __setModelConfigReadGapHookForTests(undefined);
    expect(await resolveConfiguredChatModel("qualityCheck")).toMatchObject({ provider: { baseUrl: "https://new.example.invalid/v1" }, apiKey: "key-new" });
    const inOp = runInOperation({ bookDir: "/tmp/book", opId: "op-1", runEpoch: 1, bookEpoch: "e", signal: new AbortController().signal, lane: "foreground", models: frozen }, () => resolveConfiguredChatModel("qualityCheck"));
    await expect(inOp).rejects.toThrow(/服务商地址（或密钥来源）改了/u);
  });

  it("锁可重入：锁里再解析模型不卡住", async () => {
    loadModelSettingsV0.mockResolvedValue(settingsWithoutTriage());
    taskAssignMocks.readTaskAssignments.mockResolvedValue({ file: null, corrupt: false });
    const resolved = await withModelConfigLock(() => resolveConfiguredChatModel("qualityCheck"));
    expect(resolved.profile.id).toBe("fast");
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

  it("一直只思考、超过上限还没出正文 → 抛策略原因 thinking_too_long（调用方据此关思考重试）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => pacedStream(init?.signal, 0, 0));
    await expect(streamChatModelToText({ configured, messages: [], maxThinkingMs: 120 })).rejects.toMatchObject({ attemptClass: "policy_abort", policy: "thinking_too_long" });
    spy.mockRestore();
  });

  it("在限流闸里排队的时间不算「光想不写」（2026-10-28：一章核账 13 遍并发，排着队的几遍被当成思考超时掐掉）", async () => {
    const holds: (() => void)[] = [];
    const encoder = new TextEncoder();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (!String(init?.body).includes("占位")) return pacedStream(init?.signal, 2, 3);
      // 占住许可：一直不出字，放行时一口气收尾。
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          holds.push(() => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "占" } }] })}\n\ndata: [DONE]\n\n`));
            controller.close();
          });
        },
      }), { status: 200 });
    });
    const held = Array.from({ length: 8 }, () => streamChatModelToText({ configured, messages: [{ role: "user", content: "占位" }] }));
    await vi.waitFor(() => expect(holds).toHaveLength(8));
    const queued = streamChatModelToText({ configured, messages: [{ role: "user", content: "排队" }], maxThinkingMs: 120 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const release of holds) release();
    expect((await queued).content).toBe("写".repeat(3));
    await Promise.all(held);
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
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`, "data: [DONE]\n\n"]));
    await streamChatModelToText({ configured: streamConfigured(true), messages: [] });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "enabled" });
    spy.mockRestore();
  });

  it("qwen 方言（流式）→ enable_thinking 跟随开关（流式可正常开思考）", async () => {
    for (const want of [true, false]) {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`, "data: [DONE]\n\n"]));
      await streamChatModelToText({ configured: streamConfigured(want, "qwen"), messages: [] });
      const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.enable_thinking).toBe(want);
      expect(body.thinking).toBeUndefined();
      spy.mockRestore();
    }
  });

  it("none 方言（认不出的模型）→ 整键不发（流式路径同口径，换任何模型不因它报错）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`, "data: [DONE]\n\n"]));
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
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\ndata: [DONE]\n\n`));
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
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`, "data: [DONE]\n\n"]));

    await streamChatModelToText({ configured: glmConfigured(false), messages: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy, 0).thinking).toBeUndefined();
    expect(sentBody(spy, 0).enable_thinking).toBeUndefined();
  });

  it("重试仍失败（500）→ 抛重试后的「模型请求失败：500」；被拒那项照样记住（是被拒那一刻学到的，下次不再发）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cannotDisabled400())
      .mockResolvedValueOnce(new Response("Internal server error", { status: 500 }));

    await expect(streamChatModelToText({ configured: glmConfigured(false), messages: [] }))
      .rejects.toThrow(/模型请求失败：500/);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await isAlwaysOnThinkingModel("https://x.invalid/v1", "glm-5.3-flash")).toBe(true);
  });
});

describe("streamChatModelToText 备用模型（P10）", () => {
  function sse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }), { status: 200 });
  }
  const text = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  function model(id: string, extra: Record<string, unknown> = {}) {
    return {
      provider: { id, label: id.toUpperCase(), baseUrl: `https://${id}.invalid/v1`, apiKeyStatus: "not_required" },
      profile: { id, provider: id, model: `${id}-model` },
      apiKey: `key-${id}`,
      thinking: false,
      thinkingDialect: "glm",
      ...extra,
    } as unknown as Parameters<typeof streamChatModelToText>[0]["configured"];
  }

  it("主模型报错、还没出字 → 换备用再试一次，思考开关跟着这次调用", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).startsWith("https://a.invalid") ? new Response("bad key", { status: 401 }) : sse([text("备用写的"), "data: [DONE]\n\n"]));
    const out = await streamChatModelToText({ configured: model("a", { fallback: model("b", { thinking: true }) }), messages: [] });
    expect(out.content).toBe("备用写的");
    const second = spy.mock.calls[1]!;
    expect(String(second[0])).toBe("https://b.invalid/v1/chat/completions");
    const body = JSON.parse((second[1] as RequestInit).body as string);
    expect(body.model).toBe("b-model");
    expect(body.thinking).toEqual({ type: "disabled" });
    spy.mockRestore();
  });

  it("备用也没成 → 两边原因一起报；没设备用照旧只报主模型", async () => {
    let spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      new Response(String(url).includes("a.invalid") ? "主挂了" : "备也挂了", { status: 401 }));
    await expect(streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] }))
      .rejects.toThrow(/401 主挂了.*备用模型 B · b-model 也没成.*备也挂了/u);
    spy.mockRestore();
    spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("主挂了", { status: 401 }));
    await expect(streamChatModelToText({ configured: model("a"), messages: [] })).rejects.toThrow("401 主挂了");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("已经出了正文才断 / 原地打转 → 不换备用（出的字收不回）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => sse([text("写了一半"), `data: ${JSON.stringify({ error: { message: "上游断了" } })}\n\n`]));
    await expect(streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).rejects.toThrow();
    await expect(streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [], maxContentChars: 2 })).rejects.toThrow("原地打转");
    expect(spy.mock.calls.every(([url]) => String(url).startsWith("https://a.invalid"))).toBe(true);
    spy.mockRestore();
  });
});

describe("失败分类和能力探测（写作版本 P2a 4.2、4.5）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-probe-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function sse(chunks: readonly string[]): globalThis.Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }), { status: 200 });
  }
  const ok = () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`, "data: [DONE]\n\n"]);
  function model(id: string, extra: Record<string, unknown> = {}) {
    return {
      provider: { id, label: id.toUpperCase(), baseUrl: `https://${id}.invalid/v1`, apiKeyStatus: "not_required" },
      profile: { id, provider: id, model: `${id}-model` },
      apiKey: "",
      thinking: false,
      thinkingDialect: "glm",
      ...extra,
    } as unknown as Parameters<typeof streamChatModelToText>[0]["configured"];
  }
  const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(String(init?.body)) as Record<string, unknown>;
  const noStreamOptions400 = () => new Response(JSON.stringify({ error: { message: "unknown field stream_options" } }), { status: 400 });
  /** 一直不回、直到被掐（signal abort）的 fetch。 */
  const hanging = (init: RequestInit | undefined) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });

  it("503：只 fetch 一次、不换备用、记结果不明（闸不再自己重发 503）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("忙", { status: 503 }));
    const error = await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ attemptClass: "unknown", statusCode: 503 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("DNS 失败（ENOTFOUND）= 没发出去 → 换备用", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("a.invalid")) throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
      return ok();
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await streamChatModelToText({ configured: model("a", { fallback: model("b") }), messages: [] })).content).toBe("好");
  });

  it("不跟跳转：redirect manual；3xx 记结果不明、不再发", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 302, headers: { location: "https://elsewhere.invalid" } }));
    const error = await streamChatModelToText({ configured: model("a"), messages: [] }).catch((caught: unknown) => caught);
    expect((spy.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
    expect(error).toMatchObject({ attemptClass: "unknown" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("四笔并发撞同一项不认：只有一笔被拒（探的那笔学了自己再发），等着的照学到的发", async () => {
    let rejected = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if ("stream_options" in bodyOf(init)) {
        rejected += 1;
        return noStreamOptions400();
      }
      return ok();
    });
    const results = await Promise.all(Array.from({ length: 4 }, () => streamChatModelToText({ configured: model("a"), messages: [] })));
    expect(results.map((result) => result.content)).toEqual(["好", "好", "好", "好"]);
    expect(rejected).toBe(1);
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("探的那笔被取消：放开，等着的里只有一笔接着探（同一时刻带不知道那项的只有一笔在发）", async () => {
    let unknownInFlight = 0;
    let maxUnknownInFlight = 0;
    let first = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const probing = "stream_options" in bodyOf(init);
      if (probing) unknownInFlight += 1;
      maxUnknownInFlight = Math.max(maxUnknownInFlight, unknownInFlight);
      try {
        if (first) {
          first = false;
          return await hanging(init);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return probing ? noStreamOptions400() : ok();
      } finally {
        if (probing) unknownInFlight -= 1;
      }
    });
    const cancel = new AbortController();
    const prober = streamChatModelToText({ configured: model("a"), messages: [], signal: cancel.signal }).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const waiters = Promise.all([0, 1].map(() => streamChatModelToText({ configured: model("a"), messages: [] })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancel.abort(new Error("作者停了"));
    await prober;
    expect((await waiters).map((result) => result.content)).toEqual(["好", "好"]);
    expect(maxUnknownInFlight).toBe(1);
  });

  it("等着的按自己的 signal 退出：不 fetch、不死等", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => hanging(init));
    const probeStop = new AbortController();
    const prober = streamChatModelToText({ configured: model("a"), messages: [], signal: probeStop.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const waiterStop = new AbortController();
    const waiter = streamChatModelToText({ configured: model("a"), messages: [], signal: waiterStop.signal }).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 5));
    waiterStop.abort(new Error("等的那笔停了"));
    expect(await waiter).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
    probeStop.abort(new Error("收尾"));
    await prober;
  });

  it("学到的落盘失败：进程里照样记着，不再被拒第二次", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "x", "utf-8");
    process.env.SE_DATA_DIR = join(blocker, "data");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let rejected = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if ("stream_options" in bodyOf(init)) {
        rejected += 1;
        return noStreamOptions400();
      }
      return ok();
    });
    await streamChatModelToText({ configured: model("a"), messages: [] });
    await streamChatModelToText({ configured: model("a"), messages: [] });
    expect(rejected).toBe(1);
    await expect(stat(join(blocker, "data", "model-capabilities.json"))).rejects.toThrow();
  });

  it("「能关思考」只认真发了关闭参数的 2xx：开着思考成功不算认，之后关思考那笔还是探的", async () => {
    let probes = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = bodyOf(init);
      if ((body.thinking as { type?: string } | undefined)?.type === "disabled") probes += 1;
      return ok();
    });
    // 先确认 stream_options 认（开思考这笔只带它）。
    await streamChatModelToText({ configured: model("a", { thinking: true }), messages: [] });
    expect(await unlearnedCapabilityCount(model("a"))).toBe(1);
    await streamChatModelToText({ configured: model("a"), messages: [] });
    expect(probes).toBe(1);
    expect(await unlearnedCapabilityCount(model("a"))).toBe(0);
  });
});
