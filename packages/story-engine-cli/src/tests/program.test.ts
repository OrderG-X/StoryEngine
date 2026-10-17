import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildWriterContext,
  createStoryProject,
  findFirstPromptDifference,
  readCharacterState,
  readHookPool,
  readStoryCalendar,
  readTimelineEvents,
  readWorldState,
  toSafeCharacterId,
  type WriterClient,
} from "@actalk/story-engine";
import { renderFastDraftPrompt, runChapterSteeringCommand, runCommitDraftCommand, runDraftCommand, runModelSettingsShowCommand, runModelSettingsValidateCommand, runStateOverviewCommand, type FetchLike } from "../program.js";

describe("story-engine draft CLI", () => {
  it("model-settings show returns missing without failing when the config file is absent", async () => {
    const projectDir = await createFixtureProject();
    const stdout = createWritable();

    const report = await runModelSettingsShowCommand({
      project: projectDir,
      json: true,
    }, { stdout });

    expect(report).toMatchObject({
      passed: true,
      available: false,
      status: "missing",
      issues: [],
    });
    expect(JSON.parse(stdout.output())).toMatchObject({
      passed: true,
      status: "missing",
    });
  });

  it("model-settings validate prints sanitized JSON and never leaks API keys", async () => {
    const projectDir = await createFixtureProject();
    await writeModelSettingsFixture(projectDir, validModelSettingsFixture());
    const stdout = createWritable();

    const report = await runModelSettingsValidateCommand({
      project: projectDir,
      json: true,
    }, {
      env: {
        STORY_ENGINE_TEST_API_KEY: "super-secret-key",
      },
      stdout,
    });

    expect(report.passed).toBe(true);
    expect(report.summary.providers[0]).toMatchObject({
      apiKeyEnv: "STORY_ENGINE_TEST_API_KEY",
      apiKeyStatus: "present",
    });
    expect(stdout.output()).not.toContain("super-secret-key");
    expect(JSON.parse(stdout.output())).toMatchObject({
      passed: true,
      summary: {
        providers: [
          {
            apiKeyEnv: "STORY_ENGINE_TEST_API_KEY",
            apiKeyStatus: "present",
          },
        ],
      },
    });
  });

  it("model-settings validate reports unknown provider and plaintext apiKey issues", async () => {
    const projectDir = await createFixtureProject();
    await writeModelSettingsFixture(projectDir, {
      ...validModelSettingsFixture(),
      providers: {
        main: {
          ...validModelSettingsFixture().providers.main,
          apiKey: "plain-secret",
        },
      },
      profiles: {
        creative: {
          ...validModelSettingsFixture().profiles.creative,
          provider: "missing-provider",
        },
      },
    });
    const stdout = createWritable();

    const report = await runModelSettingsValidateCommand({
      project: projectDir,
      json: true,
    }, { stdout });

    expect(report.passed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "plaintext_api_key", severity: "high" }));
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "unknown_profile_provider" }));
    expect(stdout.output()).not.toContain("plain-secret");
  });

  it("dry-run builds a report without calling a writer or writing a draft", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    };
    const stdout = createWritable();

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      dryRun: true,
      json: true,
    }, { writerClient, stdout });

    expect(report.passed).toBe(true);
    expect(report.draftPath).toBeUndefined();
    expect(writerClient.generateDraft).not.toHaveBeenCalled();
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
    await expect(access(join(projectDir, "diagnostics", "fast-draft-chapter-0001.json"))).resolves.toBeUndefined();
    expect(report.diagnostics).toMatchObject({ stage: "fast-draft", chapter: 1 });
    const printed = JSON.parse(stdout.output()) as { chapter: number; passed: boolean; contextStats: unknown; diagnostics: unknown };
    expect(printed).toMatchObject({ chapter: 1, passed: true });
    expect(printed.contextStats).toBeDefined();
    expect(printed.diagnostics).toBeDefined();
  });

  it("defaults to dry-run when no dry-run flag is provided", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    };

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      json: true,
    }, { writerClient, stdout: createWritable() });

    expect(report.passed).toBe(true);
    expect(report.draftPath).toBeUndefined();
    expect(writerClient.generateDraft).not.toHaveBeenCalled();
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
    await expect(access(join(projectDir, "diagnostics", "fast-draft-chapter-0001.json"))).resolves.toBeUndefined();
  });

  it("actual mode uses a fake writer and writes only drafts/fast/chapter-0001.md", async () => {
    const projectDir = await createFixtureProject();
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      dryRun: false,
      json: true,
    }, { writerClient: fakeInjectedWriter(), stdout });

    expect(report.passed).toBe(true);
    expect(report.draftPath).toBe(join(projectDir, "drafts", "fast", "chapter-0001.md"));
    expect(report.diagnostics).toMatchObject({ stage: "fast-draft", chapter: 1 });
    await expect(readFile(report.draftPath!, "utf-8")).resolves.toContain("never calls a model");
    await expect(access(join(projectDir, "diagnostics", "fast-draft-chapter-0001.json"))).resolves.toBeUndefined();
    await expect(access(join(projectDir, "chapters", "chapter-0001.md"))).rejects.toThrow();
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
    await expect(access(join(projectDir, "chapters", "0001_Fast Draft Chapter 1.md"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
    await expect(access(join(projectDir, ".git"))).rejects.toThrow();
  });

  it("does not create a formal chapter", async () => {
    const projectDir = await createFixtureProject();

    await runDraftCommand({ project: projectDir, chapter: 1, dryRun: false }, {
      writerClient: fakeInjectedWriter(),
      stdout: createWritable(),
    });

    expect((await stat(join(projectDir, "drafts", "fast", "chapter-0001.md"))).isFile()).toBe(true);
    await expect(access(join(projectDir, "chapters", "chapter-0001.md"))).rejects.toThrow();
  });

  it("does not update State, Timeline, World, or Hook files", async () => {
    const projectDir = await createFixtureProject();
    const before = await snapshotGovernedFiles(projectDir);

    await runDraftCommand({ project: projectDir, chapter: 1, dryRun: false }, {
      writerClient: fakeInjectedWriter(),
      stdout: createWritable(),
    });

    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
    await expect(access(join(projectDir, "state-diff", "chapter-0001.json"))).rejects.toThrow();
    await expect(access(join(projectDir, "timeline", "chapter-0001.json"))).rejects.toThrow();
    await expect(access(join(projectDir, "world", "diff", "chapter-0001.json"))).rejects.toThrow();
    await expect(access(join(projectDir, "story", "hook-diff", "chapter-0001.json"))).rejects.toThrow();
  });

  it("fails without an API key before calling the real adapter", async () => {
    const projectDir = await createFixtureProject();
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error("must not be called");
    });
    const stderr = createWritable();

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      dryRun: false,
    }, {
      env: {
        STORY_ENGINE_LLM_BASE_URL: "https://api.deepseek.com",
      },
      fetch: fetchMock,
      stderr,
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(["Missing STORY_ENGINE_LLM_API_KEY."]);
    expect(report.diagnostics).toMatchObject({ stage: "fast-draft", chapter: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.output()).not.toContain("fake-test-key");
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
  });

  it("can generate a draft through an OpenAI-compatible mocked fetch without leaking the API key", async () => {
    const projectDir = await createFixtureProject();
    const before = await snapshotGovernedFiles(projectDir);
    const fetchMock = vi.fn<FetchLike>(async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
      expect(init.headers["Authorization"]).toBe("Bearer fake-test-key");
      const body = JSON.parse(init.body) as { model: string; messages: Array<{ content: string }>; max_tokens?: number };
      expect(body.model).toBe("deepseek-v4-flash");
      // max_tokens 铁律：推理模型的 reasoning_content 也吃 max_tokens 额度，光思考 6~9k
      // 就能把正文截空。任何调用路径一律不传，让模型用自身上限自然收尾。
      expect(body.max_tokens).toBeUndefined();
      expect(body.messages[0]?.content).toContain("Write only the chapter body.");
      expect(body.messages[0]?.content).toContain("项目写作规则要求约 1800 字");
      expect(body.messages[0]?.content).not.toContain("legacy");
      return responseJson({
        choices: [
          {
            message: {
              content: "Guo Xu opens the ledger and chooses the fastest path into the conflict.",
            },
          },
        ],
        usage: {
          prompt_tokens: 111,
          completion_tokens: 22,
          total_tokens: 133,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 31,
        },
      });
    });
    const stdout = createWritable();

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      dryRun: false,
      json: true,
    }, {
      env: {
        STORY_ENGINE_LLM_BASE_URL: "https://api.deepseek.com",
        STORY_ENGINE_LLM_API_KEY: "fake-test-key",
      },
      fetch: fetchMock,
      stdout,
    });

    expect(report).toMatchObject({
      passed: true,
      draftPath: join(projectDir, "drafts", "fast", "chapter-0001.md"),
      tokenUsage: { promptTokens: 111, completionTokens: 22, totalTokens: 133 },
      cacheMetrics: {
        provider: "deepseek",
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 31,
        cacheHitRatio: 0.720721,
        cacheMetricsAvailable: true,
      },
      issues: [],
    });
    expect(report.draftLength).toMatchObject({
      requestedDraftLength: 1800,
      lowerBound: 1530,
      upperBound: 2070,
      lengthStatus: "below_lower_bound",
    });
    expect(report.diagnostics).toMatchObject({
      stage: "fast-draft",
      chapter: 1,
      tokenUsage: { promptTokens: 111, completionTokens: 22, totalTokens: 133 },
    });
    await expect(readFile(report.draftPath!, "utf-8")).resolves.toContain(
      "Guo Xu opens the ledger",
    );
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
    const printed = JSON.parse(stdout.output()) as {
      passed: boolean;
      draftPath: string;
      tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
      cacheMetrics: { promptCacheHitTokens: number | null; promptCacheMissTokens: number | null; cacheHitRatio: number | null; cacheMetricsAvailable: boolean };
      promptFingerprint: { firstDynamicCharOffset: number | null; firstDynamicSectionName: string | null; firstDynamicSectionIndex: number | null };
    };
    expect(printed).toMatchObject({
      passed: true,
      draftPath: join(projectDir, "drafts", "fast", "chapter-0001.md"),
      tokenUsage: { promptTokens: 111, completionTokens: 22, totalTokens: 133 },
      cacheMetrics: {
        provider: "deepseek",
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 31,
        cacheHitRatio: 0.720721,
        cacheMetricsAvailable: true,
      },
    });
    expect(printed).toMatchObject({
      promptFingerprint: {
        firstDynamicSectionName: "Chapter",
        firstDynamicSectionIndex: 5,
      },
    });
    expect(printed.promptFingerprint.firstDynamicCharOffset).toBeGreaterThan(0);
    expect(stdout.output()).not.toContain("fake-test-key");
  });

  it("reports null cache metrics when the provider response omits cache metadata", async () => {
    const projectDir = await createFixtureProject();
    const fetchMock = vi.fn<FetchLike>(async () => responseJson({
      choices: [
        {
          message: {
            content: "Guo Xu keeps the ledger clue in view and moves carefully.",
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }));
    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      dryRun: false,
    }, {
      env: {
        STORY_ENGINE_LLM_BASE_URL: "https://api.deepseek.com",
        STORY_ENGINE_LLM_API_KEY: "fake-test-key",
      },
      fetch: fetchMock,
      stdout: createWritable(),
    });

    expect(report.cacheMetrics).toEqual({
      provider: "deepseek",
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      cacheHitRatio: null,
      rawCacheMetadata: null,
      cacheMetricsAvailable: false,
    });
  });

  it("parses DeepSeek cached token details when cache hit tokens are nested", async () => {
    const projectDir = await createFixtureProject();
    const fetchMock = vi.fn<FetchLike>(async () => responseJson({
      choices: [
        {
          message: {
            content: "Guo Xu keeps the ledger clue in view and moves carefully.",
          },
        },
      ],
      usage: {
        prompt_tokens: 111,
        completion_tokens: 22,
        total_tokens: 133,
        prompt_tokens_details: {
          cached_tokens: 80,
        },
        prompt_cache_miss_tokens: 31,
      },
    }));

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      dryRun: false,
    }, {
      env: {
        STORY_ENGINE_LLM_BASE_URL: "https://api.deepseek.com",
        STORY_ENGINE_LLM_API_KEY: "fake-test-key",
      },
      fetch: fetchMock,
      stdout: createWritable(),
    });

    expect(report.cacheMetrics).toMatchObject({
      provider: "deepseek",
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 31,
      cacheHitRatio: 0.720721,
      cacheMetricsAvailable: true,
    });
    expect(report.cacheMetrics?.rawCacheMetadata).toMatchObject({
      "usage.prompt_tokens_details.cached_tokens": 80,
      "usage.prompt_cache_miss_tokens": 31,
    });
  });

  it("renders a stable fast draft prompt from ContextGateway sections", async () => {
    const projectDir = await createFixtureProject();
    const context = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "Draft chapter 1.",
    });
    const prompt = renderFastDraftPrompt(context);

    expect(context.trace.sectionNames).toEqual([
      "story_core",
      "world_core",
      "character_profile",
      "character_core",
      "chapter_goal",
      "writing_context_pack",
      "story_calendar",
      "hook_pool",
      "hook_tracking",
      "story_threads",
      "arc_goals",
      "character_state",
      "world_state",
      "story_continuity",
      "timeline_events",
    ]);
    const sectionOffsets = context.trace.sectionNames.map((sectionName) => prompt.indexOf(`## ${sectionName}`));
    expect(sectionOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(sectionOffsets).toEqual([...sectionOffsets].sort((a, b) => a - b));
    expect(prompt).toContain("Write only the chapter body.");
    expect(prompt).toContain("Do not update state, timeline, world, hooks, or calendar.");
    expect(prompt).not.toContain(["Pipeline", "Runner"].join(""));
  });

  it("captures the improved Chapter 19/20 prompt divergence after stable sections", async () => {
    const projectDir = await createFixtureProject();
    const context19 = await buildWriterContext({
      projectDir,
      chapter: 19,
      chapterGoal: "Draft chapter 19.",
    });
    const context20 = await buildWriterContext({
      projectDir,
      chapter: 20,
      chapterGoal: "Draft chapter 20.",
    });
    const prompt19 = renderFastDraftPrompt(context19);
    const prompt20 = renderFastDraftPrompt(context20);
    const diff = findFirstPromptDifference(prompt19, prompt20);

    expect(diff.firstDiffCharOffset).toBe(prompt19.indexOf("Chapter: 19") + "Chapter: ".length);
    expect(diff.firstDiffCharOffset).toBeGreaterThan(500);
    expect(diff.leftSnippet).toContain("Chapter: 19");
    expect(diff.rightSnippet).toContain("Chapter: 20");
    expect(context19.trace.sectionNames[0]).toBe("story_core");
    expect(prompt19.indexOf("## story_core")).toBeLessThan(prompt19.indexOf("Chapter: 19"));
    expect(prompt19.indexOf("## chapter_goal")).toBeGreaterThan(prompt19.indexOf("Chapter: 19"));
  });

  it("keeps the new CLI free of legacy package references", async () => {
    const packageRoot = join(import.meta.dirname, "..", "..");
    const files = [
      join(packageRoot, "package.json"),
      join(packageRoot, "src", "program.ts"),
      join(packageRoot, "src", "index.ts"),
    ];

    for (const file of files) {
      const source = await readFile(file, "utf-8");
      const legacyPackagePattern = new RegExp([
        ["@actalk", "inkos-core"].join("/"),
        ["packages", "core"].join("/"),
        ["packages", "cli"].join("/"),
        ["Pipeline", "Runner"].join(""),
        String.raw`from ["']` + ["@actalk", "inkos"].join("/"),
      ].join("|"));
      expect(source).not.toMatch(legacyPackagePattern);
    }
  });

  it("keeps draft persistence and validation delegated to story-engine core", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "program.ts"), "utf-8");

    expect(source).toContain("runFastDraft");
    expect(source).not.toContain("function writeFastDraft");
    expect(source).not.toContain("function validateGeneratedDraft");
    expect(source).not.toMatch(/writeFile\([^)]*drafts/u);
    expect(source).not.toMatch(/mkdir\([^)]*drafts/u);
  });
});

describe("story-engine draft CLI opencode 会话头（与 UI llm-client 同源：仅 opencode 主机定向发头）", () => {
  it("baseUrl 指向 opencode 主机 → 带 x-opencode-session + 自有 UA；持久化 0600、两次运行复用同一 id", async () => {
    const projectDir = await createFixtureProject();
    const dataDir = await mkdtemp(join(tmpdir(), "story-engine-cli-oc-session-"));
    const seenSessions: string[] = [];
    const fetchMock = vi.fn<FetchLike>(async (url, init) => {
      expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
      expect(init.headers["Authorization"]).toBe("Bearer fake-test-key");
      expect(init.headers["user-agent"]).toBe("story-engine-ng/1.0");
      const session = init.headers["x-opencode-session"];
      expect(session).toMatch(/^[0-9a-f-]{36}$/u);
      seenSessions.push(session);
      return responseJson({
        choices: [{ message: { content: "Guo Xu checks the ledger." } }],
      });
    });
    const env = {
      STORY_ENGINE_LLM_BASE_URL: "https://opencode.ai/zen/go/v1",
      STORY_ENGINE_LLM_API_KEY: "fake-test-key",
      SE_DATA_DIR: dataDir,
    };

    const first = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "opencode",
      model: "opencode-model",
      dryRun: false,
      json: true,
    }, { env, fetch: fetchMock, stdout: createWritable() });
    const second = await runDraftCommand({
      project: projectDir,
      chapter: 2,
      provider: "opencode",
      model: "opencode-model",
      dryRun: false,
      json: true,
    }, { env, fetch: fetchMock, stdout: createWritable() });

    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(seenSessions).toHaveLength(2);
    expect(seenSessions[1]).toBe(seenSessions[0]);
    const sessionPath = join(dataDir, "opencode-session.json");
    expect(JSON.parse(await readFile(sessionPath, "utf-8"))).toEqual({ version: 1, sessionId: seenSessions[0] });
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
  });

  it("复用 UI 写出的同格式 opencode-session.json（同文件同格式，不另起新 id）", async () => {
    const projectDir = await createFixtureProject();
    const dataDir = await mkdtemp(join(tmpdir(), "story-engine-cli-oc-reuse-"));
    const existing = "11111111-2222-4333-8444-555555555555";
    await writeFile(join(dataDir, "opencode-session.json"), `${JSON.stringify({ version: 1, sessionId: existing }, null, 2)}\n`, "utf-8");
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      expect(init.headers["x-opencode-session"]).toBe(existing);
      return responseJson({
        choices: [{ message: { content: "Guo Xu checks the ledger." } }],
      });
    });

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "opencode",
      model: "opencode-model",
      dryRun: false,
      json: true,
    }, {
      env: {
        STORY_ENGINE_LLM_BASE_URL: "https://api.opencode.ai/v1",
        STORY_ENGINE_LLM_API_KEY: "fake-test-key",
        SE_DATA_DIR: dataDir,
      },
      fetch: fetchMock,
      stdout: createWritable(),
    });

    expect(report.passed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("非 opencode 地址 → 不带 x-opencode-session / user-agent（不广播），也不落盘会话文件", async () => {
    const projectDir = await createFixtureProject();
    const dataDir = await mkdtemp(join(tmpdir(), "story-engine-cli-oc-plain-"));
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      expect(init.headers["Authorization"]).toBe("Bearer fake-test-key");
      expect(init.headers["x-opencode-session"]).toBeUndefined();
      expect(init.headers["user-agent"]).toBeUndefined();
      return responseJson({
        choices: [{ message: { content: "Guo Xu checks the ledger." } }],
      });
    });

    const report = await runDraftCommand({
      project: projectDir,
      chapter: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      dryRun: false,
      json: true,
    }, {
      env: {
        STORY_ENGINE_LLM_BASE_URL: "https://api.deepseek.com",
        STORY_ENGINE_LLM_API_KEY: "fake-test-key",
        SE_DATA_DIR: dataDir,
      },
      fetch: fetchMock,
      stdout: createWritable(),
    });

    expect(report.passed).toBe(true);
    await expect(access(join(dataDir, "opencode-session.json"))).rejects.toThrow();
  });
});

describe("story-engine commit-draft CLI", () => {
  it("fails when the fast draft is missing", async () => {
    const projectDir = await createFixtureProject();
    await seedCommitHook(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stderr = createWritable();

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
    }, { stderr });

    expect(report.passed).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
    expect(stderr.output()).toContain("Fast draft commit failed.");
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("commits a fast draft and updates State, Timeline, World, Hook, and Calendar without calling a model", async () => {
    const projectDir = await createFixtureProject();
    await seedCommitHook(projectDir);
    await seedCommitDraftLocationBible(projectDir);
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      longChineseDraft({ characterName: "Guo Xu", hookText: "Ledger hook", withTitle: true, withDialogue: true }),
      "utf-8",
    );
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    };
    const stdout = createWritable();

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
      json: true,
    }, { writerClient, stdout });

    expect(report).toMatchObject({
      chapter: 1,
      passed: true,
      chapterPath: join(projectDir, "chapters", "0001.md"),
      // 2026-10-10 引擎升级：人物状态、线索、目标只听章节语义声明；命令行定稿不带声明 → 不改人物状态。
      updatedCharacters: [],
      timelineEventIds: ["ch0001-001"],
      updatedHooks: ["h-ledger"],
      updatedWorld: true,
      updatedCalendar: true,
      issues: [],
    });
    expect(writerClient.generateDraft).not.toHaveBeenCalled();
    await expect(readFile(join(projectDir, "chapters", "0001.md"), "utf-8")).resolves.toContain("Ledger hook");
    await expect(readCharacterState(projectDir, "guo-xu")).resolves.not.toMatchObject({
      goal: expect.stringContaining("Ledger hook"),
    });
    await expect(readTimelineEvents(projectDir)).resolves.toEqual([
      expect.objectContaining({
        id: "ch0001-001",
        chapter: 1,
        // Timeline summaries follow the shared event-ranking contract: the
        // character/location-bearing core event wins here, while hook coverage
        // remains explicit in the structured semantic fields below.
        summary: expect.stringContaining("Guo Xu"),
        participants: ["guo-xu"],
        effects: {
          semanticSummary: expect.objectContaining({
            chapterSummary: expect.stringContaining("Ledger hook"),
            keyEvents: expect.arrayContaining([expect.stringContaining("Ledger hook")]),
            foreshadowingTerms: expect.arrayContaining(["Ledger hook"]),
            timelineSummary: expect.stringContaining("Guo Xu"),
            discovery: "他在页角看见 Ledger hook 的标记，知道这不是偶然。",
            mentionedHooks: ["h-ledger"],
            mentionedCharacters: ["guo-xu"],
            mentionedCharacterNames: ["Guo Xu"],
            locations: expect.arrayContaining(["园圃"]),
          }),
        },
      }),
    ]);
    await expect(readWorldState(projectDir)).resolves.toMatchObject({
      // P2：提交不再用「chapter_N_committed」水印覆盖用户设定的 currentPhase——
      // 作者填的「开篇」必须跨定稿保留（旧实现每章提交都把它顶成水印）。
      currentPhase: "开篇",
      activeConflicts: [],
      activeHooks: ["h-ledger"],
      knownSecrets: [],
      lastUpdatedChapter: 1,
    });
    await expect(readHookPool(projectDir)).resolves.toMatchObject({
      hooks: [
        {
          id: "h-ledger",
          title: "Ledger hook",
          description: "A deterministic hook for commit CLI tests.",
          status: "active",
          relatedCharacters: expect.arrayContaining(["guo-xu", "Guo Xu"]),
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: expect.arrayContaining([expect.stringContaining("Ledger hook")]),
        },
      ],
    });
    await expect(readStoryCalendar(projectDir)).resolves.toEqual({
      currentStoryDay: 1,
      currentTimeOfDay: "unknown",
    });
    expect("qualityCheck" in report ? report.qualityCheck?.passed : undefined).toBe(true);
    const printed = JSON.parse(stdout.output()) as {
      chapter: number;
      passed: boolean;
      diagnostics?: unknown;
      qualityCheck?: { passed: boolean };
    };
    expect(printed).toMatchObject({ chapter: 1, passed: true });
    expect(printed.diagnostics).toBeDefined();
    expect(printed.qualityCheck).toMatchObject({ passed: true });
  });

  it("auto-builds a commit plan for a real project without hook fixtures", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-real-commit-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "真实提交测试",
      genre: "修仙爽文",
      premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
      mainCharacterName: "林远",
    });
    await seedCommitDraftLocationBible(projectDir);
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      longChineseDraft({ characterName: "林远", withTitle: true, withDialogue: true }),
      "utf-8",
    );
    const characterId = toSafeCharacterId("林远");

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
      json: true,
    }, { stdout: createWritable() });

    expect(report).toMatchObject({
      chapter: 1,
      passed: true,
      chapterPath: join(projectDir, "chapters", "0001.md"),
      updatedCharacters: [],
      timelineEventIds: ["ch0001-001"],
      updatedHooks: [],
      updatedWorld: true,
      updatedCalendar: true,
      issues: [],
    });
    expect("qualityCheck" in report ? report.qualityCheck?.passed : undefined).toBe(true);
    await expect(readFile(join(projectDir, "chapters", "0001.md"), "utf-8")).resolves.toContain("林远");
    await expect(readFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "utf-8")).resolves.toContain("林远");
    await expect(readCharacterState(projectDir, characterId)).resolves.toMatchObject({
      characterId,
      lastUpdatedChapter: null,
    });
    await expect(readTimelineEvents(projectDir)).resolves.toEqual([
      expect.objectContaining({
        id: "ch0001-001",
        chapter: 1,
        summary: expect.stringContaining("林远"),
        participants: [characterId],
        effects: {
          semanticSummary: expect.objectContaining({
            mentionedCharacters: [characterId],
            mentionedCharacterNames: ["林远"],
            mentionedHooks: [],
            locations: expect.arrayContaining(["园圃"]),
          }),
        },
      }),
    ]);
    await expect(readHookPool(projectDir)).resolves.toEqual({ hooks: [] });
    await expect(readStoryCalendar(projectDir)).resolves.toEqual({
      currentStoryDay: 1,
      currentTimeOfDay: "unknown",
    });
  });

  it("previews the generated commit plan without committing state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-preview-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "提交预览测试",
      genre: "修仙爽文",
      premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
      mainCharacterName: "林远",
    });
    await seedCommitDraftLocationBible(projectDir);
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      `${longChineseDraft({ characterName: "林远", hookText: "账目", withTitle: true, withDialogue: true })}\n林远决定先去库房查账，后墙传来异常响动。\n`,
      "utf-8",
    );
    const characterId = toSafeCharacterId("林远");
    const before = await snapshotGovernedFiles(projectDir, characterId);
    const stdout = createWritable();

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
      preview: true,
      json: true,
    }, { stdout });

    expect(report).toMatchObject({
      chapter: 1,
      passed: true,
      summary: {
        characterUpdates: 0,
        timelineEvents: 1,
        worldUpdates: true,
        hookUpdates: 0,
        calendarUpdate: true,
      },
      issues: [],
    });
    expect(report.qualityCheck).toMatchObject({ passed: true });
    expect("semanticSummary" in report ? report.semanticSummary : undefined).toMatchObject({
      chapter: 1,
      protagonist: "林远",
      mentionedCharacters: [characterId],
      mentionedCharacterNames: ["林远"],
      mentionedHooks: [],
      locations: expect.arrayContaining(["园圃"]),
    });
    // 2026-08-12 契约翻转：HOOK_KEYWORDS 题材词表已摘除（题材中立）——纯正文不再自发新建伏笔，
    // 「账目/异常响动」这类悬念由下方 lead/intent 线索通道完整追踪（见 threadTrackingUpdates 断言）。
    expect(("hookTrackingUpdates" in report ? report.hookTrackingUpdates : undefined) ?? []).toEqual([]);
    // 2026-10-10 引擎升级：线索、目标、人物状态只听声明；没声明的命令行预览不再从正文猜（「库房 / 后墙」是旧测试书的词）。
    expect(("threadTrackingUpdates" in report ? report.threadTrackingUpdates : undefined) ?? []).toEqual([]);
    expect(("arcGoalUpdates" in report ? report.arcGoalUpdates : undefined) ?? []).toEqual([]);
    expect("commitPlan" in report ? report.commitPlan?.characterUpdates : undefined).toBeUndefined();
    const printed = JSON.parse(stdout.output()) as {
      passed: boolean;
      commitPlan: unknown;
      qualityCheck?: { passed: boolean };
      semanticSummary?: {
        chapter: number;
        protagonist: string;
        mentionedCharacters: string[];
        mentionedCharacterNames: string[];
        locations: string[];
      };
      hookTrackingUpdates?: Array<{
        title: string;
        evidence: string[];
        relatedCharacters: string[];
      }>;
      threadTrackingUpdates?: Array<{
        type: string;
        title: string;
        evidence: string[];
      }>;
      threadHygieneReport?: {
        beforeCount: number;
        afterCount: number;
        mergedCount: number;
        markedDoneCount: number;
      };
      arcGoalUpdates?: Array<{
        title: string;
        evidence: string[];
      }>;
      summary: {
        characterUpdates: number;
        timelineEvents: number;
        worldUpdates: boolean;
        hookUpdates: number;
        calendarUpdate: boolean;
      };
    };
    expect(printed.passed).toBe(true);
    expect(printed.commitPlan).toBeDefined();
    expect(printed.qualityCheck).toMatchObject({ passed: true });
    expect(printed.semanticSummary).toMatchObject({
      chapter: 1,
      protagonist: "林远",
      mentionedCharacters: [characterId],
      mentionedCharacterNames: ["林远"],
      locations: expect.arrayContaining(["园圃"]),
    });
    // 词表已摘除：JSON 输出同样不再有正文自发新建的伏笔（线索通道断言在下方，悬念不丢）
    expect(printed.hookTrackingUpdates ?? []).toEqual([]);
    expect(printed.threadTrackingUpdates ?? []).toEqual([]);
    expect(printed.threadHygieneReport).toMatchObject({
      beforeCount: 0,
      afterCount: expect.any(Number),
      mergedCount: 0,
      markedDoneCount: 0,
    });
    expect(printed.arcGoalUpdates ?? []).toEqual([]);
    expect(printed.summary).toEqual({
      characterUpdates: 0,
      timelineEvents: 1,
      worldUpdates: true,
      hookUpdates: 0,
      calendarUpdate: true,
    });
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir, characterId)).resolves.toEqual(before);
    await expect(readTimelineEvents(projectDir)).resolves.toEqual([]);
    await expect(readStoryCalendar(projectDir)).resolves.toEqual({
      currentStoryDay: 1,
      currentTimeOfDay: "unknown",
    });
  });

  it("preview reports quality errors without committing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-preview-quality-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "提交预览质量失败测试",
      genre: "修仙爽文",
      premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
      mainCharacterName: "林远",
    });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "# 第一章\n\n短。\n", "utf-8");
    const characterId = toSafeCharacterId("林远");
    const before = await snapshotGovernedFiles(projectDir, characterId);

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
      preview: true,
      json: true,
    }, { stdout: createWritable() });

    expect(report.passed).toBe(true);
    expect(report.qualityCheck).toMatchObject({ passed: false });
    expect(report.qualityCheck?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "too_short" }),
    ]));
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir, characterId)).resolves.toEqual(before);
  });

  it("blocks commit-draft when quality check has errors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-quality-block-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "提交质量阻断测试",
      genre: "修仙爽文",
      premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
      mainCharacterName: "林远",
    });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "{\"tool_call\":\"write\"}\n", "utf-8");
    const characterId = toSafeCharacterId("林远");
    const before = await snapshotGovernedFiles(projectDir, characterId);
    const stdout = createWritable();

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
      json: true,
    }, { stdout });

    expect(report.passed).toBe(false);
    expect("qualityCheck" in report ? report.qualityCheck?.passed : undefined).toBe(false);
    expect(report.issues.join("\n")).toContain("JSON or a tool-call artifact");
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir, characterId)).resolves.toEqual(before);
    await expect(readTimelineEvents(projectDir)).resolves.toEqual([]);
    const printed = JSON.parse(stdout.output()) as { passed: boolean; qualityCheck?: { passed: boolean } };
    expect(printed).toMatchObject({ passed: false, qualityCheck: { passed: false } });
  });

  it("commits when quality check only reports warning or info", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-quality-pass-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "提交质量通过测试",
      genre: "修仙爽文",
      premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
      mainCharacterName: "林远",
    });
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      longChineseDraft({ characterName: "林远", withTitle: false, withDialogue: false }),
      "utf-8",
    );
    const characterId = toSafeCharacterId("林远");

    const report = await runCommitDraftCommand({
      project: projectDir,
      chapter: 1,
      json: true,
    }, { stdout: createWritable() });

    expect(report.passed).toBe(true);
    expect("qualityCheck" in report ? report.qualityCheck?.passed : undefined).toBe(true);
    expect("qualityCheck" in report ? report.qualityCheck?.issues : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "missing_chapter_title" }),
      expect.objectContaining({ severity: "info", type: "no_dialogue" }),
    ]));
    await expect(access(join(projectDir, "chapters", "0001.md"))).resolves.toBeUndefined();
    await expect(readCharacterState(projectDir, characterId)).resolves.toMatchObject({
      lastUpdatedChapter: null,
    });
    await expect(readTimelineEvents(projectDir)).resolves.toHaveLength(1);
  });

  it("keeps commit-draft free of legacy package and legacy runner references", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "program.ts"), "utf-8");

    expect(source).not.toMatch(new RegExp([
      ["packages", "core"].join("/"),
      ["Pipeline", "Runner"].join(""),
    ].join("|")));
  });
});

describe("story-engine state-overview CLI", () => {
  it("prints a read-only state overview JSON report", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          {
            id: "intent-low",
            type: "intent",
            title: "Guo Xu 想了想，决定先不管这个",
            status: "open",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["他想了想，决定先不管这个。"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const before = await readFile(join(projectDir, "story", "threads.json"), "utf-8");
    const stdout = createWritable();

    const report = await runStateOverviewCommand({
      project: projectDir,
      chapter: 5,
      save: false,
      json: true,
    }, { stdout });

    expect(report.project.currentChapter).toBe(5);
    expect(report.reportPath).toBeUndefined();
    expect(report.maintenance).toMatchObject({
      diagnosticsAvailable: true,
      mergeDisabled: true,
      dropDisabled: true,
      confirmPolicy: {
        markDone: "manual_only",
        merge: "disabled",
        drop: "disabled",
      },
    });
    const printed = JSON.parse(stdout.output()) as typeof report;
    expect(printed.storyFoundation.available).toBe(true);
    expect(printed.storyBible).toMatchObject({
      available: true,
      genre: "progression",
    });
    expect(printed.writingRules).toMatchObject({
      available: true,
      narrativePerspective: "第三人称有限视角",
    });
    expect(printed.threads.cleanupVisibleCount).toBeGreaterThan(0);
    expect(printed.uiHints.disabledActions).toEqual(expect.arrayContaining([
      "merge_threads_confirm",
      "drop_thread_confirm",
    ]));
    await expect(readFile(join(projectDir, "story", "threads.json"), "utf-8")).resolves.toBe(before);
  });
});

describe("story-engine chapter-steering CLI", () => {
  it("prints a read-only steering draft JSON report without saving by default when --no-save is used", async () => {
    const projectDir = await createFixtureProject();
    await seedChapterSteeringState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runChapterSteeringCommand({
      project: projectDir,
      direction: "下一章去地下车库确认信号源",
      chapter: 8,
      mustAvoid: ["避难所"],
      pacing: "medium",
      revealLevel: "small",
      save: false,
      json: true,
    }, { stdout });

    expect(report.reportPath).toBeUndefined();
    expect(report.generatedChapterGoalPreview).toContain("下一章去地下车库确认信号源");
    expect(report.safety).toMatchObject({
      writesState: false,
      requiresPreviewBeforeCommit: true,
    });
    expect(report.safety.disabledActions).toEqual(expect.arrayContaining([
      "apply_review_plan_confirm",
      "merge_threads_confirm",
      "drop_thread_confirm",
    ]));
    expect(report.foundationContext).toMatchObject({
      available: true,
      storyBibleAvailable: true,
      writingRulesAvailable: true,
    });
    expect(report.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(report.suggestions.every((suggestion) => suggestion.availableActions.join("|") === "include|skip|weaken|alternative")).toBe(true);
    expect(report.suggestions.some((suggestion) => suggestion.sourceId === "intent-low")).toBe(false);
    expect(report.suggestions.some((suggestion) => suggestion.type === "risk")).toBe(true);
    const printed = JSON.parse(stdout.output()) as typeof report;
    expect(printed.generatedChapterGoalPreview).toContain("下一章去地下车库确认信号源");
    expect(printed.foundationContext.summary).toContain("Foundation available");
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-cli-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "Fast Draft CLI Fixture",
    genre: "progression",
    premise: "A deterministic CLI fixture for fast draft tests.",
    mainCharacterName: "Guo Xu",
  });
  return projectDir;
}

async function seedCommitDraftLocationBible(projectDir: string): Promise<void> {
  // Location extraction is data-driven: the engine only extracts locations that
  // are registered in the project's location-bible. The commit-draft drafts here
  // reference 外院园圃 / 库房 / 账房, so seed those locations to assert extraction.
  await writeFile(
    join(projectDir, "story", "location-bible.json"),
    `${JSON.stringify({
      version: "v0",
      locations: ["外院", "园圃", "账房", "库房"].map((name, index) => ({
        id: `loc-${index}`,
        name,
        type: index === 0 ? "opening" : "scene",
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
}

function validModelSettingsFixture() {
  return {
    version: 1,
    defaultProvider: "main",
    defaultProfile: "creative",
    providers: {
      main: {
        id: "main",
        label: "Main provider",
        type: "openai-compatible",
        baseUrl: "https://api.example.invalid/v1",
        apiKeyEnv: "STORY_ENGINE_TEST_API_KEY",
      },
    },
    profiles: {
      creative: {
        id: "creative",
        provider: "main",
        model: "story-model",
        temperature: 0.7,
        maxTokens: 3000,
        timeoutMs: 30000,
        retries: 1,
        stream: false,
      },
    },
    taskProfiles: {
      fastDraft: "creative",
      chapterSteering: "creative",
      qualityCheck: "creative",
      repair: "creative",
      futureReview: "creative",
    },
  };
}

async function writeModelSettingsFixture(projectDir: string, settings: unknown): Promise<void> {
  const settingsDir = join(projectDir, ".story-engine");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, "model-settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

async function seedChapterSteeringState(projectDir: string): Promise<void> {
  await Promise.all([
    writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
        hooks: [
          {
            id: "hook-radio",
            title: "无线电异常信号",
            description: "收音机里出现断续广播。",
            status: "active",
            firstSeenChapter: 2,
            lastTouchedChapter: 7,
            evidence: ["第7章：广播频率异常。"],
            nextActionHint: "确认信号源。",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    ),
    writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          {
            id: "lead-signal",
            type: "lead",
            title: "确认无线电信号来源",
            status: "touched",
            firstSeenChapter: 3,
            lastTouchedChapter: 7,
            evidence: ["收音机里出现避难所坐标。"],
            relatedLocations: ["地下车库"],
          },
          {
            id: "intent-low",
            type: "intent",
            title: "Guo Xu 想了想，决定先不管这个",
            status: "open",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["他想了想，决定先不管这个。"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    ),
    writeFile(
      join(projectDir, "story", "arc-goals.json"),
      `${JSON.stringify({
        goals: [
          {
            id: "goal-shelter",
            title: "判断避难所广播真假",
            status: "active",
            scope: "mini_arc",
            firstSeenChapter: 5,
            lastTouchedChapter: 7,
            evidence: ["广播坐标和信号源不一致。"],
            relatedLocations: ["地下车库"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    ),
    writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify([
        {
          id: "ch0007-001",
          chapter: 7,
          summary: "Guo Xu 在地下车库听见收音机断续广播，意识到信号源可能不在避难所坐标。",
          participants: ["guo-xu"],
          effects: {
            semanticSummary: {
              mainEvent: "Guo Xu 发现信号源异常。",
              locations: ["地下车库"],
            },
          },
        },
      ], null, 2)}\n`,
      "utf-8",
    ),
  ]);
}

function longChineseDraft(input: {
  readonly characterName: string;
  readonly hookText?: string;
  readonly withTitle: boolean;
  readonly withDialogue: boolean;
}): string {
  const title = input.withTitle ? "# 第一章 外院账册\n\n" : "";
  const hookSentence = input.hookText ? `他在页角看见 ${input.hookText} 的标记，知道这不是偶然。\n\n` : "";
  const dialogue = input.withDialogue ? `${input.characterName}说：“我会把这笔账一点点查清楚。”\n\n` : "";
  const paragraph = [
    `${input.characterName}站在外院园圃的石阶旁，袖口沾着晨露，心里却比任何时候都清醒。`,
    "管事刚刚把最差的灵田分给他，又当众扣下半袋粮米，仿佛成员就该把这种羞辱吞进肚子里。",
    "他没有立刻反驳，只把账册上被涂改的数字、粮米袋上的旧印和旁人闪躲的目光全都记住。",
    "真正的反击不能只靠怒气，需要证据、耐心和一次足够准确的出手。",
  ].join("");
  return `${title}${hookSentence}${dialogue}${Array.from({ length: 5 }, () => paragraph).join("\n\n")}\n`;
}

function fakeInjectedWriter(): WriterClient {
  return {
    async generateDraft({ context, maxOutputTokens }) {
      return {
        title: `Fast Draft Chapter ${context.chapter}`,
        content: [
          `Guo Xu stepped into chapter ${context.chapter} with a clear immediate goal.`,
          `This deterministic fake draft is limited to ${maxOutputTokens} output tokens and never calls a model.`,
        ].join("\n\n"),
        tokenUsage: {
          promptTokens: context.trace.totalTokenEstimate,
          completionTokens: 30,
          totalTokens: context.trace.totalTokenEstimate + 30,
        },
      };
    },
  };
}

function responseJson(value: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async text() {
      return JSON.stringify(value);
    },
  };
}

async function snapshotGovernedFiles(projectDir: string, characterId = "guo-xu"): Promise<Record<string, string>> {
  const files = [
    `characters/${characterId}/state.json`,
    "timeline/events.json",
    "world/state.json",
    "story/hooks.json",
    "story/threads.json",
    "story/arc-goals.json",
    "time/calendar.json",
  ];
  const entries = await Promise.all(files.map(async (file) => [file, await readFile(join(projectDir, file), "utf-8")] as const));
  return Object.fromEntries(entries);
}

async function seedCommitHook(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, "story", "hooks.json"),
    `${JSON.stringify({
      hooks: [
        {
          id: "h-ledger",
          title: "Ledger hook",
          description: "A deterministic hook for commit CLI tests.",
          status: "seeded",
          relatedCharacters: ["guo-xu"],
        },
      ],
    }, null, 2)}\n`,
    "utf-8",
  );
}
function createWritable(): Pick<NodeJS.WriteStream, "write"> & { output: () => string } {
  let text = "";
  return {
    write(chunk: string | Uint8Array) {
      text += String(chunk);
      return true;
    },
    output() {
      return text;
    },
  };
}
