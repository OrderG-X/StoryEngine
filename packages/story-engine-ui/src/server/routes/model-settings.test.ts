import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callRoute } from "./test-helpers.js";
import {
  findInvalidTaskProfile,
  MASKED_CUSTOM_HEADER_VALUE,
  readProfileIdsFromConfig,
  registerModelSettingsRoutes,
} from "./model-settings.js";
import type { TaskAssignmentsFile } from "../lib/task-assignments.js";

// M1 热生效断言用：PUT 保存后必须调 invalidateStoryAgent 清进程内 agent 缓存（改模型设置不重启即生效）。
const storyAgentMocks = vi.hoisted(() => ({ invalidateStoryAgent: vi.fn() }));
vi.mock("../agent/story-agent.js", () => ({ invalidateStoryAgent: storyAgentMocks.invalidateStoryAgent }));

/** 最小合法 model-settings（单 provider），baseUrl / apiKeyEnv / customHeaders 可覆盖。 */
function sampleSettingsText(overrides: { baseUrl?: string; apiKeyEnv?: string; customHeaders?: Record<string, string> } = {}): string {
  return `${JSON.stringify({
    version: 1,
    defaultProvider: "main",
    defaultProfile: "balanced",
    providers: {
      main: {
        id: "main",
        label: "OpenAI Compatible",
        type: "openai-compatible",
        baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
        apiKeyEnv: overrides.apiKeyEnv ?? "STORY_ENGINE_API_KEY",
        ...(overrides.customHeaders ? { customHeaders: overrides.customHeaders } : {}),
      },
    },
    profiles: {
      balanced: {
        id: "balanced",
        label: "长篇均衡",
        provider: "main",
        model: "model-name",
        temperature: 0.7,
        maxTokens: 4096,
        timeoutMs: 60000,
        retries: 2,
        stream: true,
      },
    },
    taskProfiles: {
      fastDraft: "balanced",
      chapterSteering: "balanced",
      qualityCheck: "balanced",
      repair: "balanced",
      draftReview: "balanced",
      triage: "balanced",
    },
  }, null, 2)}\n`;
}

describe("readProfileIdsFromConfig / findInvalidTaskProfile（审查 #9）", () => {
  const config = {
    version: 1,
    profiles: { balanced: { id: "balanced" }, fast: { id: "fast" } },
  };

  it("抽出全部合法 profile id", () => {
    expect(readProfileIdsFromConfig(config)).toEqual(new Set(["balanced", "fast"]));
  });

  it("引用不存在的 profileId → 返回该任务", () => {
    const assignments: TaskAssignmentsFile = {
      version: 1,
      tasks: { fastDraft: { profileId: "ghost", thinking: true } },
    };
    expect(findInvalidTaskProfile(assignments, config)).toEqual({ task: "fastDraft", profileId: "ghost" });
  });

  it("全部合法（含只切思考、无 profileId 的任务）→ null", () => {
    const assignments: TaskAssignmentsFile = {
      version: 1,
      tasks: { fastDraft: { profileId: "fast", thinking: true }, triage: { thinking: false } },
    };
    expect(findInvalidTaskProfile(assignments, config)).toBeNull();
  });
});

describe("provider 测试接口安全（审查 #1）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  const SECRET_ENV = "SE_TEST_SECRET_ENV_DO_NOT_LEAK";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-mst-"));
    process.env.SE_DATA_DIR = dir; // 空目录：无已存 provider，隔离真实 ~/.story-engine
    process.env[SECRET_ENV] = "super-secret-value";
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    delete process.env[SECRET_ENV];
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function mockModelsFetch() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ id: "m1", name: "Model 1" }] }), { status: 200 }),
    );
  }

  it("绝不按客户端传的 apiKeyEnv 读 process.env 外送（旧漏洞回归）", async () => {
    const spy = mockModelsFetch();
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", {
      providerId: "attacker",
      baseUrl: "http://attacker.test/v1",
      apiKeyEnv: SECRET_ENV,
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    // 无 authorization 头，且密钥值绝不出现在请求里
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain("super-secret-value");
  });

  it("用户当下输入的 apiKey 会作为 Bearer 发送（合法用例仍可用）", async () => {
    const spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", {
      providerId: "custom",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-user-typed",
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-user-typed");
    expect(init.redirect).toBe("error");
  });

  it("非 http/https 协议 baseUrl → 400 拒绝", async () => {
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", {
      providerId: "x",
      baseUrl: "file:///etc/passwd",
    });
    expect(statusCode).toBe(400);
    expect(payload.ok).toBe(false);
  });

  it("内嵌账号密码的 URL → 400 拒绝", async () => {
    const { statusCode } = await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", {
      providerId: "x",
      baseUrl: "https://user:pass@evil.test/v1",
    });
    expect(statusCode).toBe(400);
  });

  it("已存 provider：有已存密钥 → 带 Bearer（R1a）", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText(), "utf-8");
    await writeFile(
      join(dir, "model-secrets.json"),
      JSON.stringify({ version: 1, providerApiKeys: { main: "sk-saved" } }),
      "utf-8",
    );
    const spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", { providerId: "main" });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-saved");
  });

  it("已存 provider：无已存密钥但 apiKeyEnv 指向的 env 有值 → 请求不带 authorization（R1a 核心）", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "model-settings.json"),
      sampleSettingsText({ apiKeyEnv: SECRET_ENV }),
      "utf-8",
    );
    // 故意不写 model-secrets.json；env 里已有 SECRET_ENV
    const spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", { providerId: "main" });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain("super-secret-value");
  });
});

describe("PUT 保存：origin 变更时清密钥（R1b）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-mst-put-"));
    process.env.SE_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  async function readSecrets(): Promise<Record<string, string>> {
    const raw = await readFile(join(dir, "model-secrets.json"), "utf-8");
    return (JSON.parse(raw) as { providerApiKeys: Record<string, string> }).providerApiKeys;
  }

  it("origin 变更且未提供新密钥 → 该 provider 密钥被删", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ baseUrl: "https://api.example.com/v1" }), "utf-8");
    await writeFile(
      join(dir, "model-secrets.json"),
      JSON.stringify({ version: 1, providerApiKeys: { main: "sk-old" } }),
      "utf-8",
    );
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText({ baseUrl: "https://attacker.example/v1" }),
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(await readSecrets()).not.toHaveProperty("main");
  });

  it("origin 变更且提供了新密钥 → 用新密钥", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ baseUrl: "https://api.example.com/v1" }), "utf-8");
    await writeFile(
      join(dir, "model-secrets.json"),
      JSON.stringify({ version: 1, providerApiKeys: { main: "sk-old" } }),
      "utf-8",
    );
    const { statusCode } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText({ baseUrl: "https://new.example.com/v1" }),
      providerApiKeys: { main: "sk-new" },
    });
    expect(statusCode).toBe(200);
    expect(await readSecrets()).toEqual({ main: "sk-new" });
  });

  it("同 origin 仅路径变化（/v1→/v2）→ 旧密钥保留", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ baseUrl: "https://api.example.com/v1" }), "utf-8");
    await writeFile(
      join(dir, "model-secrets.json"),
      JSON.stringify({ version: 1, providerApiKeys: { main: "sk-keep" } }),
      "utf-8",
    );
    const { statusCode } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText({ baseUrl: "https://api.example.com/v2" }),
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(await readSecrets()).toEqual({ main: "sk-keep" });
  });

  it("旧配置缺失时 PUT → 密钥不被误删", async () => {
    // 无 model-settings.json（available=false），但 secrets 已有
    await writeFile(
      join(dir, "model-secrets.json"),
      JSON.stringify({ version: 1, providerApiKeys: { main: "sk-keep" } }),
      "utf-8",
    );
    const { statusCode } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText({ baseUrl: "https://anywhere.example/v1" }),
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(await readSecrets()).toEqual({ main: "sk-keep" });
  });
});

describe("customHeaders：保存 / 脱敏回显 / 打码还原", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;
  const HEADER_SECRET = "real-header-secret-value";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-mst-ch-"));
    process.env.SE_DATA_DIR = dir;
    storyAgentMocks.invalidateStoryAgent.mockClear();
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  async function readSavedSettings(): Promise<{ providers: Record<string, { customHeaders?: Record<string, string> }> }> {
    return JSON.parse(await readFile(join(dir, "model-settings.json"), "utf-8"));
  }

  it("PUT 保存 customHeaders 落盘为真实值，但响应 rawText 打码、summary 只回键名（值绝不出 API）", async () => {
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText({ customHeaders: { "x-opencode-session": HEADER_SECRET } }),
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);

    // 落盘是真实值
    const saved = await readSavedSettings();
    expect(saved.providers.main.customHeaders).toEqual({ "x-opencode-session": HEADER_SECRET });

    // 响应脱敏：rawText 值被打码；整个 payload（含 result/issues/taskAssignments）不含机密值
    expect(payload.rawText).toContain(MASKED_CUSTOM_HEADER_VALUE);
    expect(JSON.stringify(payload)).not.toContain(HEADER_SECRET);
    const result = payload.result as { summary: { providers: { id: string; customHeaderNames?: string[] }[] } };
    expect(result.summary.providers[0]?.customHeaderNames).toEqual(["x-opencode-session"]);
  });

  it("GET 回显脱敏：rawText 打码、summary 出键名、整个响应不含 customHeaders 值", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ customHeaders: { "x-opencode-session": HEADER_SECRET } }), "utf-8");

    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "GET", "/api/model-settings");

    expect(statusCode).toBe(200);
    expect(payload.rawText).toContain(MASKED_CUSTOM_HEADER_VALUE);
    expect(JSON.stringify(payload)).not.toContain(HEADER_SECRET);
    const result = payload.result as { summary: { providers: { customHeaderNames?: string[] }[] } };
    expect(result.summary.providers[0]?.customHeaderNames).toEqual(["x-opencode-session"]);
  });

  it("PUT 回传打码值 → 还原为磁盘真实值（面板不改动直接保存不丢头、哨兵绝不落盘）", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ customHeaders: { "x-opencode-session": HEADER_SECRET } }), "utf-8");

    const maskedText = sampleSettingsText({ customHeaders: { "x-opencode-session": MASKED_CUSTOM_HEADER_VALUE } });
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: maskedText,
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);

    const saved = await readSavedSettings();
    expect(saved.providers.main.customHeaders).toEqual({ "x-opencode-session": HEADER_SECRET });
    expect(JSON.stringify(saved)).not.toContain(MASKED_CUSTOM_HEADER_VALUE);
  });

  it("PUT 打码值但无旧值可还原（全新配置带哨兵）→ 该条目丢弃、整键不留，哨兵绝不落盘，丢弃进 warnings 如实告知", async () => {
    const maskedText = sampleSettingsText({ customHeaders: { "x-opencode-session": MASKED_CUSTOM_HEADER_VALUE } });
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: maskedText,
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);

    const saved = await readSavedSettings();
    expect(saved.providers.main.customHeaders).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain(MASKED_CUSTOM_HEADER_VALUE);

    // 丢弃绝不静默：warnings 点名被丢的键（只列键名，绝无值/哨兵）
    const warnings = payload.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 个自定义请求头无法还原已丢弃");
    expect(warnings[0]).toContain("x-opencode-session");
    expect(warnings[0]).not.toContain(MASKED_CUSTOM_HEADER_VALUE);
  });

  it("PUT 混合场景：有旧值的哨兵还原、无旧值的哨兵丢弃并进 warnings（只列被丢键名），可还原头不受牵连", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ customHeaders: { "x-opencode-session": HEADER_SECRET } }), "utf-8");

    const maskedText = sampleSettingsText({
      customHeaders: {
        "x-opencode-session": MASKED_CUSTOM_HEADER_VALUE,
        "x-brand-new": MASKED_CUSTOM_HEADER_VALUE,
      },
    });
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: maskedText,
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);

    // 可还原的还原成真实值；不可还原的丢弃；哨兵绝不落盘
    const saved = await readSavedSettings();
    expect(saved.providers.main.customHeaders).toEqual({ "x-opencode-session": HEADER_SECRET });
    expect(JSON.stringify(saved)).not.toContain(MASKED_CUSTOM_HEADER_VALUE);

    const warnings = payload.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 个自定义请求头无法还原已丢弃");
    expect(warnings[0]).toContain("x-brand-new");
    expect(warnings[0]).not.toContain("x-opencode-session"); // 已还原的不进警告
    expect(warnings[0]).not.toContain(HEADER_SECRET); // 警告绝不带任何头值
    expect(warnings[0]).not.toContain(MASKED_CUSTOM_HEADER_VALUE);
  });

  it("PUT 全部哨兵都可还原 → 响应不带 warnings 字段（无丢弃不刷警告）", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ customHeaders: { "x-opencode-session": HEADER_SECRET } }), "utf-8");

    const maskedText = sampleSettingsText({ customHeaders: { "x-opencode-session": MASKED_CUSTOM_HEADER_VALUE } });
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: maskedText,
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.warnings).toBeUndefined();
  });

  it("PUT 落盘权限：model-settings.json 与 model-secrets.json 同为 0600（customHeaders 视同机密，机密边界前后一致）", async () => {
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText({ customHeaders: { "x-opencode-session": HEADER_SECRET } }),
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);

    const settingsStat = await stat(join(dir, "model-settings.json"));
    expect(settingsStat.mode & 0o777).toBe(0o600);
    const secretsStat = await stat(join(dir, "model-secrets.json"));
    expect(secretsStat.mode & 0o777).toBe(0o600);
  });

  it("PUT 非法 customHeaders（值不是字符串）→ 400 拒绝保存", async () => {
    const bad = JSON.parse(sampleSettingsText()) as { providers: Record<string, Record<string, unknown>> };
    bad.providers.main.customHeaders = { "x-token": 42 as unknown as string };
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: `${JSON.stringify(bad, null, 2)}\n`,
      providerApiKeys: {},
    });
    expect(statusCode).toBe(400);
    expect(payload.ok).toBe(false);
  });

  it("M1 热生效回归守卫：PUT 保存成功后调用 invalidateStoryAgent（agent 缓存失效，改设置不必重启）", async () => {
    const { statusCode, payload } = await callRoute(registerModelSettingsRoutes, "PUT", "/api/model-settings", {
      rawText: sampleSettingsText(),
      providerApiKeys: {},
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(storyAgentMocks.invalidateStoryAgent).toHaveBeenCalledTimes(1);
  });
});

describe("provider 连通性测试带头（/models 出口：opencode 会话头 + customHeaders）", () => {
  let dir: string;
  const originalDataDir = process.env.SE_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "se-mst-test-hdr-"));
    process.env.SE_DATA_DIR = dir;
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.SE_DATA_DIR;
    else process.env.SE_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function mockModelsFetch() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }),
    );
  }
  function sentHeaders(spy: ReturnType<typeof mockModelsFetch>): Record<string, string> {
    return ((spy.mock.calls[0]?.[1] as RequestInit).headers ?? {}) as Record<string, string>;
  }

  it("已存 provider 是 opencode 主机 → /models 测试自动带 x-opencode-session + 自有 User-Agent", async () => {
    await writeFile(join(dir, "model-settings.json"), sampleSettingsText({ baseUrl: "https://opencode.ai/zen/go/v1" }), "utf-8");
    const spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", { providerId: "main" });
    const headers = sentHeaders(spy);
    expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(headers["user-agent"]).toBe("story-engine-ng/1.0");
  });

  it("已存 provider 的 customHeaders 随 /models 测试发出（备胎 relay 配头场景）", async () => {
    await writeFile(
      join(dir, "model-settings.json"),
      sampleSettingsText({ baseUrl: "http://10.0.0.8:3000/v1", customHeaders: { "x-opencode-session": "relay-session" } }),
      "utf-8",
    );
    const spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", { providerId: "main" });
    const headers = sentHeaders(spy);
    expect(headers["x-opencode-session"]).toBe("relay-session"); // 用户配的头
    expect(headers["user-agent"]).toBeUndefined(); // 非 opencode 主机不强加 UA
  });

  it("inline URL 与已存 provider 同源 → 复用其 customHeaders；不同源 → 绝不外送（视同机密）", async () => {
    await writeFile(
      join(dir, "model-settings.json"),
      sampleSettingsText({ baseUrl: "http://10.0.0.8:3000/v1", customHeaders: { "x-relay-secret": "shhh-secret" } }),
      "utf-8",
    );

    // 同源（同 host:port，仅路径不同）→ 带上
    let spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", {
      providerId: "main",
      baseUrl: "http://10.0.0.8:3000/v2",
    });
    expect(sentHeaders(spy)["x-relay-secret"]).toBe("shhh-secret");
    spy.mockRestore();

    // 不同源（攻击者 URL）→ 绝不带，密钥值绝不出现在请求里
    spy = mockModelsFetch();
    await callRoute(registerModelSettingsRoutes, "POST", "/api/model-settings/test", {
      providerId: "main",
      baseUrl: "https://attacker.example/v1",
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(sentHeaders(spy)["x-relay-secret"]).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain("shhh-secret");
  });
});
