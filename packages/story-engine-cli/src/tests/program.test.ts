import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildWriterContext,
  createDeepSeekAIReviewerProvider,
  createStoryProject,
  findFirstPromptDifference,
  readCharacterState,
  readHookPool,
  readThreadPool,
  readStoryCalendar,
  readTimelineEvents,
  readWorldState,
  registerAIReviewerProvider,
  toSafeCharacterId,
  type WriterClient,
} from "@actalk/story-engine";
import { renderFastDraftPrompt, runApplyReviewPlanCommand, runChapterSteeringCommand, runCommitDraftCommand, runDraftCommand, runIntentLifecycleDiagnosticsCommand, runMaintenanceRunCommand, runModelSettingsShowCommand, runModelSettingsValidateCommand, runReviewCommand, runReviewPlanCommand, runReviewPromptCommand, runStateOverviewCommand, type FetchLike } from "../program.js";

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
      continuityQuality: { passed: boolean; score: number };
      tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
      cacheMetrics: { promptCacheHitTokens: number | null; promptCacheMissTokens: number | null; cacheHitRatio: number | null; cacheMetricsAvailable: boolean };
      promptFingerprint: { firstDynamicCharOffset: number | null; firstDynamicSectionName: string | null; firstDynamicSectionIndex: number | null };
    };
    expect(printed).toMatchObject({
      passed: true,
      draftPath: join(projectDir, "drafts", "fast", "chapter-0001.md"),
      continuityQuality: { passed: true, score: 1 },
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
      updatedCharacters: ["guo-xu"],
      timelineEventIds: ["ch0001-001"],
      updatedHooks: ["h-ledger"],
      updatedWorld: true,
      updatedCalendar: true,
      issues: [],
    });
    expect(writerClient.generateDraft).not.toHaveBeenCalled();
    await expect(readFile(join(projectDir, "chapters", "0001.md"), "utf-8")).resolves.toContain("Ledger hook");
    await expect(readCharacterState(projectDir, "guo-xu")).resolves.toMatchObject({
      emotion: "平静",
      goal: expect.stringContaining("Ledger hook"),
      lastUpdatedChapter: 1,
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
      currentPhase: "chapter_1_committed",
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
        characterUpdates: 1,
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
    expect("threadTrackingUpdates" in report ? report.threadTrackingUpdates : undefined).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        title: expect.stringContaining("林远决定先去库房"),
        evidence: expect.arrayContaining([expect.stringContaining("决定先去库房")]),
      }),
      expect.objectContaining({
        type: "lead",
        title: "后墙异常响动",
        evidence: expect.arrayContaining([expect.stringContaining("后墙")]),
      }),
    ]));
    expect("arcGoalUpdates" in report ? report.arcGoalUpdates : undefined).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "查清资源账目",
        evidence: expect.arrayContaining([expect.stringContaining("账目")]),
      }),
    ]));
    expect("commitPlan" in report ? report.commitPlan?.characterUpdates?.[0]?.characterId : undefined).toBe(characterId);
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
    expect(printed.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        title: expect.stringContaining("林远决定先去库房"),
      }),
      expect.objectContaining({
        type: "lead",
        title: "后墙异常响动",
      }),
    ]));
    expect(printed.threadHygieneReport).toMatchObject({
      beforeCount: 0,
      afterCount: expect.any(Number),
      mergedCount: 0,
      markedDoneCount: 0,
    });
    expect(printed.arcGoalUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "查清资源账目",
        evidence: expect.arrayContaining([expect.stringContaining("账目")]),
      }),
    ]));
    expect(printed.summary).toEqual({
      characterUpdates: 1,
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

describe("story-engine review CLI", () => {
  it("writes a mock AI review report without modifying formal story state", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runReviewCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      mock: true,
      json: true,
    }, { stdout });

    expect(report.passed).toBe(true);
    expect(report.scope).toBe("window");
    expect(report.provider).toMatchObject({ id: "mock", usedFallback: false });
    expect(report.reportPath).toBe(join(projectDir, "reports", "ai-review-window-0008.json"));
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "stale_thread" }),
      expect.objectContaining({ type: "thread_should_merge" }),
      expect.objectContaining({ type: "thread_should_be_done" }),
    ]));
    expect(report.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "prioritize_thread" }),
      expect.objectContaining({ action: "merge_threads" }),
      expect.objectContaining({ action: "mark_thread_done" }),
    ]));
    const printed = JSON.parse(stdout.output()) as {
      passed: boolean;
      reportPath: string;
      provider: { id: string; usedFallback: boolean };
      suggestions: Array<{ action: string }>;
      actionabilitySummary: { executableActionCount: number };
      candidateDiagnostics: {
        selectionStage: { selectedThreadIds: string[] };
        analysisStage: { doneCandidates: string[]; mergeGroups: string[][]; dropCandidates: string[] };
        reviewerStage: { suggestionCount: number; executableSuggestionCount: number };
      };
    };
    expect(printed.reportPath).toBe(report.reportPath);
    expect(printed.provider).toMatchObject({ id: "mock", usedFallback: false });
    expect(printed.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "merge_threads" }),
    ]));
    expect(printed.actionabilitySummary.executableActionCount).toBeGreaterThan(0);
    expect(printed.candidateDiagnostics.selectionStage.selectedThreadIds.length).toBeGreaterThan(0);
    expect(printed.candidateDiagnostics.analysisStage.doneCandidates).toEqual(expect.arrayContaining(["thread-done-candidate"]));
    expect(printed.candidateDiagnostics.analysisStage.mergeGroups.length).toBeGreaterThan(0);
    expect(printed.candidateDiagnostics.reviewerStage.suggestionCount).toBe(report.suggestions.length);
    await expect(readFile(report.reportPath!, "utf-8")).resolves.toContain("Mock review found");
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
    await expect(readThreadPool(projectDir)).resolves.toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({ id: "thread-stale-intent", status: "open" }),
      ]),
    });
    expect(stdout.output()).not.toMatch(/Bearer\s+\S+/u);
  });

  it("accepts --provider mock as the provider-interface path", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);

    const report = await runReviewCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      provider: "mock",
      json: true,
    }, { stdout: createWritable() });

    expect(report.passed).toBe(true);
    expect(report.provider).toMatchObject({ id: "mock", usedFallback: false });
    expect(report.reportPath).toBe(join(projectDir, "reports", "ai-review-window-0008.json"));
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("refuses non-mock review without calling a real model", async () => {
    const projectDir = await createFixtureProject();
    const stdout = createWritable();

    const report = await runReviewCommand({
      project: projectDir,
      chapter: 1,
      scope: "window",
      json: true,
    }, { stdout });

    expect(report.passed).toBe(false);
    expect(report.summary).toContain("does not call real external models yet");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "reviewer-provider-failed",
        severity: "error",
      }),
    ]));
    await expect(access(join(projectDir, "reports", "ai-review-window-0001.json"))).rejects.toThrow();
  });

  it("falls back for deepseek review when no key is configured", async () => {
    registerAIReviewerProvider(createDeepSeekAIReviewerProvider({ env: {}, fetch: async () => {
      throw new Error("should not fetch");
    } }));
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runReviewCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      provider: "deepseek",
      fallbackToMock: true,
      json: true,
    }, { stdout });

    expect(report.passed).toBe(true);
    expect(report.provider).toMatchObject({ id: "mock", usedFallback: true });
    expect(report.reportPath).toBe(join(projectDir, "reports", "ai-review-window-0008.json"));
    const printed = JSON.parse(stdout.output()) as { provider: { id: string; usedFallback: boolean; errorType?: string } };
    expect(printed.provider).toMatchObject({ id: "mock", usedFallback: true });
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("fails deepseek review when no key is configured and fallback is disabled", async () => {
    registerAIReviewerProvider(createDeepSeekAIReviewerProvider({ env: {}, fetch: async () => {
      throw new Error("should not fetch");
    } }));
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);

    const report = await runReviewCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      provider: "deepseek",
      json: true,
    }, { stdout: createWritable() });

    expect(report.passed).toBe(false);
    expect(report.provider).toMatchObject({ id: "deepseek", usedFallback: false });
    expect(report.reportPath).toBeUndefined();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });
});

describe("story-engine review-prompt CLI", () => {
  it("writes a prompt contract without calling a model or modifying formal story state", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runReviewPromptCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      tokenBudget: 2048,
      includeExamples: true,
      json: true,
    }, { stdout });

    expect(report.version).toBe("ai-reviewer-prompt-contract-v1");
    expect(report.reportPath).toBe(join(projectDir, "reports", "ai-review-prompt-window-0008.json"));
    expect(report.inputSummary).toMatchObject({
      scope: "window",
      chapter: 8,
      tokenBudget: 2048,
    });
    expect(report.systemPrompt).toContain("StoryEngine-NG AI Reviewer");
    expect(report.userPrompt).toContain("Allowed actions");
    expect(report.userPrompt).toContain("Short examples:");
    expect(report.responseSchema).toMatchObject({
      type: "object",
      properties: {
        issues: expect.any(Object),
        suggestions: expect.any(Object),
        summary: { type: "string" },
      },
    });
    const printed = JSON.parse(stdout.output()) as {
      reportPath: string;
      inputSummary: { threadCount: number };
      userPrompt: string;
    };
    expect(printed.reportPath).toBe(report.reportPath);
    expect(printed.inputSummary.threadCount).toBe(report.inputSummary.threadCount);
    expect(printed.userPrompt).toContain("Structured review input");
    await expect(readFile(report.reportPath!, "utf-8")).resolves.toContain("ai-reviewer-prompt-contract-v1");
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });
});

describe("story-engine review-plan CLI", () => {
  it("builds a review action preview report without modifying formal story state", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const reviewStdout = createWritable();
    const reviewReport = await runReviewCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      mock: true,
      json: true,
    }, { stdout: reviewStdout });
    const stdout = createWritable();

    const plan = await runReviewPlanCommand({
      project: projectDir,
      report: reviewReport.reportPath,
      chapter: 8,
      json: true,
    }, { stdout });

    expect(plan.scope).toBe("window");
    expect(plan.reportPath).toBe(join(projectDir, "reports", "review-plan-window-0008.json"));
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "mark_thread_done",
        preview: expect.objectContaining({
          before: expect.objectContaining({ id: "thread-done-candidate", status: "open" }),
          after: expect.objectContaining({ id: "thread-done-candidate", status: "done" }),
        }),
      }),
      expect.objectContaining({
        action: "merge_threads",
        preview: expect.objectContaining({
          before: expect.arrayContaining([
            expect.objectContaining({ id: expect.stringContaining("thread-") }),
          ]),
          after: expect.objectContaining({
            mergedTitle: expect.any(String),
            removedIds: expect.arrayContaining(["thread-merge-b"]),
          }),
        }),
      }),
      expect.objectContaining({
        action: "prioritize_thread",
      }),
    ]));
    for (const action of plan.actions) {
      expect(action.safety).toMatchObject({
        requiresConfirmation: true,
        mutatesState: false,
        canAutoApply: false,
        riskLevel: expect.any(String),
        reasons: expect.any(Array),
        warnings: expect.any(Array),
      });
      expect(action.confirmability).toMatchObject({
        recommended: expect.any(Boolean),
        score: expect.any(Number),
        reason: expect.any(String),
      });
      expect(action.confirmationMode).toMatch(/recommended_confirm|manual_review|do_not_confirm/u);
    }
    const printed = JSON.parse(stdout.output()) as {
      reportPath: string;
      actions: Array<{ action: string; safety: { riskLevel: string; warnings: string[] }; confirmability: { recommended: boolean }; confirmationMode: string }>;
      recommendedActionSummary: { totalRecommended: number };
      alreadyDoneGuardSummary: { filteredCount: number; filteredActionIds: string[]; filteredTargetIds: string[] };
      mergeDropPreviewSummary: { mergePreviewCount: number; dropPreviewCount: number };
      reviewPlanStage: { actionCount: number; executableActionCount: number; recommendedActionIds: string[] };
      candidateDiagnostics?: { reviewPlanStage: { actionCount: number; recommendedActionIds: string[] } };
    };
    expect(printed.reportPath).toBe(plan.reportPath);
    expect(printed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "mark_thread_done",
        safety: expect.objectContaining({ riskLevel: "safe" }),
        confirmability: expect.objectContaining({ recommended: true }),
        confirmationMode: "recommended_confirm",
      }),
    ]));
    expect(printed.recommendedActionSummary.totalRecommended).toBeGreaterThan(0);
    expect(printed.alreadyDoneGuardSummary).toEqual({
      filteredCount: 0,
      filteredActionIds: [],
      filteredTargetIds: [],
    });
    expect(printed.mergeDropPreviewSummary.mergePreviewCount).toBeGreaterThan(0);
    expect(printed.mergeDropPreviewSummary.dropPreviewCount).toBeGreaterThanOrEqual(0);
    expect(printed.reviewPlanStage.actionCount).toBe(plan.actions.length);
    expect(printed.reviewPlanStage.executableActionCount).toBeGreaterThan(0);
    expect(printed.candidateDiagnostics?.reviewPlanStage.actionCount).toBe(plan.actions.length);
    await expect(readFile(plan.reportPath!, "utf-8")).resolves.toContain("Prepared");
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
    await expect(readThreadPool(projectDir)).resolves.toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({ id: "thread-done-candidate", status: "open" }),
      ]),
    });
  });

  it("filters already-done thread targets from review-plan recommended action ids", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const threadPool = await readThreadPool(projectDir);
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: threadPool.threads.map((thread) => thread.id === "thread-done-candidate"
          ? { ...thread, status: "done" }
          : thread.id === "thread-stale-intent"
            ? { ...thread, title: "库房账册来源", evidence: ["林远已经查清库房账册来源。"] }
            : thread),
      }, null, 2)}\n`,
      "utf-8",
    );
    const review = await runReviewCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      mock: true,
      json: true,
    }, { stdout: createWritable() });
    await writeFile(
      review.reportPath!,
      `${JSON.stringify({
        passed: true,
        scope: "window",
        issues: [],
        suggestions: [
          {
            action: "mark_thread_done",
            targetIds: ["thread-done-candidate"],
            reason: "Already completed thread should not be recommended again.",
            confidence: 0.9,
          },
          {
            action: "mark_thread_done",
            targetIds: ["thread-stale-intent"],
            reason: "Open thread has clear completion evidence.",
            confidence: 0.9,
          },
        ],
        summary: "Already done guard CLI fixture.",
        createdAt: "2026-05-14T00:00:00.000Z",
      }, null, 2)}\n`,
      "utf-8",
    );
    const stdout = createWritable();

    const plan = await runReviewPlanCommand({
      project: projectDir,
      report: review.reportPath,
      chapter: 8,
      json: true,
    }, { stdout });

    expect(plan.filteredAlreadyDoneActions).toEqual([
      expect.objectContaining({
        id: "review-action-0001",
        doneTargetIds: ["thread-done-candidate"],
      }),
    ]);
    expect(plan.alreadyDoneGuardSummary).toEqual({
      filteredCount: 1,
      filteredActionIds: ["review-action-0001"],
      filteredTargetIds: ["thread-done-candidate"],
    });
    expect(plan.reviewPlanStage.recommendedActionIds).toEqual(["review-action-0002"]);
    expect(plan.reviewPlanStage.filteredAlreadyDoneActionCount).toBe(1);
    expect(plan.reviewPlanStage.filteredAlreadyDoneActionIds).toEqual(["review-action-0001"]);
    const printed = JSON.parse(stdout.output()) as {
      alreadyDoneGuardSummary: { filteredCount: number; filteredActionIds: string[]; filteredTargetIds: string[] };
      reviewPlanStage: { recommendedActionIds: string[]; filteredAlreadyDoneActionIds?: string[] };
      filteredAlreadyDoneActions?: Array<{ id: string; doneTargetIds: string[] }>;
    };
    expect(printed.alreadyDoneGuardSummary.filteredCount).toBe(1);
    expect(printed.reviewPlanStage.recommendedActionIds).toEqual(["review-action-0002"]);
    expect(printed.reviewPlanStage.filteredAlreadyDoneActionIds).toEqual(["review-action-0001"]);
    expect(printed.filteredAlreadyDoneActions?.[0]).toMatchObject({
      id: "review-action-0001",
      doneTargetIds: ["thread-done-candidate"],
    });
  });
});

describe("story-engine apply-review-plan CLI", () => {
  it("requires confirmation unless dry-run is used", async () => {
    const { projectDir, planPath } = await createReviewPlanFixtureForCli();
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const blocked = await runApplyReviewPlanCommand({
      project: projectDir,
      plan: planPath,
      json: true,
    }, { stdout });

    expect(blocked.passed).toBe(false);
    expect(blocked.skippedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "confirmation_required" }),
    ]));
    await expect(readFile(blocked.reportPath!, "utf-8")).resolves.toContain("confirmation_required");
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);

    const dryRun = await runApplyReviewPlanCommand({
      project: projectDir,
      plan: planPath,
      action: ["review-action-0001"],
      dryRun: true,
      json: true,
    }, { stdout: createWritable() });

    expect(dryRun.passed).toBe(true);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.appliedActions).toEqual([
      expect.objectContaining({ action: "mark_thread_done" }),
    ]);
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("treats --confirm as dry-run unless experimental manual apply is enabled", async () => {
    const { projectDir, planPath } = await createReviewPlanFixtureForCli();
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const result = await runApplyReviewPlanCommand({
      project: projectDir,
      plan: planPath,
      action: ["review-action-0001"],
      confirm: true,
      json: true,
    }, { stdout });

    expect(result.passed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.appliedActions).toEqual([
      expect.objectContaining({ action: "mark_thread_done", targetIds: ["thread-done-candidate"] }),
    ]);
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("applies selected thread actions only to story/threads.json when experimental manual apply is enabled", async () => {
    const { projectDir, planPath } = await createReviewPlanFixtureForCli();
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const result = await runApplyReviewPlanCommand({
      project: projectDir,
      plan: planPath,
      action: ["review-action-0001"],
      confirm: true,
      json: true,
    }, { stdout, env: { STORY_ENGINE_ENABLE_REVIEW_PLAN_APPLY_CONFIRM: "1" } });

    expect(result.passed).toBe(true);
    expect(result.appliedActions).toEqual([
      expect.objectContaining({ action: "mark_thread_done", targetIds: ["thread-done-candidate"] }),
    ]);
    expect(result.reportPath).toBe(join(projectDir, "reports", "apply-review-plan-0008.json"));
    const printed = JSON.parse(stdout.output()) as { appliedActions: Array<{ action: string }> };
    expect(printed.appliedActions).toEqual([
      expect.objectContaining({ action: "mark_thread_done" }),
    ]);
    const after = await snapshotGovernedFiles(projectDir);
    expect(after["story/hooks.json"]).toBe(before["story/hooks.json"]);
    expect(after["story/arc-goals.json"]).toBe(before["story/arc-goals.json"]);
    expect(after["timeline/events.json"]).toBe(before["timeline/events.json"]);
    expect(after["world/state.json"]).toBe(before["world/state.json"]);
    expect(after["time/calendar.json"]).toBe(before["time/calendar.json"]);
    expect(after["characters/guo-xu/state.json"]).toBe(before["characters/guo-xu/state.json"]);
    await expect(readThreadPool(projectDir)).resolves.toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({ id: "thread-done-candidate", status: "done" }),
      ]),
    });
    await expect(access(join(projectDir, ".story-engine-tx"))).rejects.toThrow();
  });
});

describe("story-engine maintenance-run CLI", () => {
  it("runs mock review, plan, and apply dry-run reports without modifying state", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 20,
      scope: "window",
      mock: true,
      json: true,
    }, { stdout });

    expect(report.passed).toBe(true);
    expect(report.reviewProvider).toMatchObject({ id: "mock", usedFallback: false });
    expect(report.wouldModifyState).toBe(false);
    expect(report.issueCount).toBeGreaterThan(0);
    expect(report.suggestionCount).toBeGreaterThan(0);
    expect(report.actionCount).toBeGreaterThan(0);
    expect(report.applicableActionCount).toBeGreaterThan(0);
    expect(report.appliedDryRunCount).toBeGreaterThan(0);
    expect(report.actionBreakdown.mark_thread_done).toBeGreaterThan(0);
    expect(report.actionBreakdown.merge_threads).toBeGreaterThan(0);
    expect(report.actionBreakdown.drop_thread).toBeGreaterThan(0);
    expect(report.applyDryRunBreakdown.mark_thread_done).toBeGreaterThan(0);
    expect(report.applyDryRunBreakdown.merge_threads).toBeGreaterThan(0);
    expect(report.applyDryRunBreakdown.drop_thread).toBeGreaterThan(0);
    expect(report.recommendedActionSummary.totalRecommended).toBeGreaterThan(0);
    expect(report.recommendedActionSummary.byAction.mark_thread_done).toBeGreaterThan(0);
    expect(report.recommendedActionSummary.byAction.merge_threads).toBeGreaterThanOrEqual(0);
    expect(report.recommendedActionSummary.byAction.drop_thread).toBeGreaterThanOrEqual(0);
    expect(report.recommendedActionSummary.byRisk.safe).toBeGreaterThan(0);
    expect(report.recommendedActionSummary.byConfirmationMode.recommended_confirm).toBeGreaterThan(0);
    expect(report.recommendedActionSummary.byConfirmationMode.manual_review).toBeGreaterThanOrEqual(0);
    expect(report.recommendedActionSummary.byConfirmationMode.do_not_confirm).toBeGreaterThanOrEqual(0);
    expect(report.recommendedActionIds.length).toBeGreaterThan(0);
    expect(report.mergeDropPreviewSummary).toMatchObject({
      mergePreviewCount: expect.any(Number),
      safeMergeCount: expect.any(Number),
      cautionMergeCount: expect.any(Number),
      riskyMergeCount: expect.any(Number),
      dropPreviewCount: expect.any(Number),
      safeDropCount: expect.any(Number),
      cautionDropCount: expect.any(Number),
      riskyDropCount: expect.any(Number),
    });
    expect(report.mergeDropPreviewSummary.mergePreviewCount).toBeGreaterThan(0);
    expect(report.mergeDropPreviewSummary.dropPreviewCount).toBeGreaterThan(0);
    expect(report.actionabilitySummary).toMatchObject({
      executableActionCount: expect.any(Number),
      markThreadDoneCount: expect.any(Number),
      mergeThreadsCount: expect.any(Number),
      dropThreadCount: expect.any(Number),
      prioritizeCount: expect.any(Number),
    });
    expect(report.actionabilitySummary?.executableActionCount).toBeGreaterThan(0);
    expect(report.recommendedActionIds.every((id) => {
      const planActionId = Number(id.replace("review-action-", ""));
      return Number.isFinite(planActionId);
    })).toBe(true);
    expect(report.riskyActionIds.length).toBeGreaterThanOrEqual(0);
    expect(report.reviewInputThreadSelection).toMatchObject({
      totalThreadCount: expect.any(Number),
      selectedThreadCount: expect.any(Number),
      staleCandidateCount: expect.any(Number),
      mergeCandidateCount: expect.any(Number),
      doneCandidateCount: expect.any(Number),
    });
    expect(report.transactionResidue).toEqual({
      txDirectoryExists: false,
      txStagedFilesCount: 0,
      hasTransactionResidue: false,
    });
    expect(report.reviewReportPath).toBe(join(projectDir, "reports", "ai-review-window-0020.json"));
    expect(report.reviewPlanPath).toBe(join(projectDir, "reports", "review-plan-window-0020.json"));
    expect(report.applyDryRunReportPath).toBe(join(projectDir, "reports", "apply-review-plan-window-0020-dry-run.json"));
    expect(report.maintenanceReportPath).toBe(join(projectDir, "reports", "maintenance-run-window-0020.json"));
    const printed = JSON.parse(stdout.output()) as {
      wouldModifyState: boolean;
      appliedDryRunCount: number;
      recommendedActionSummary: { totalRecommended: number; byConfirmationMode: { recommended_confirm: number } };
      alreadyDoneGuardSummary: { filteredCount: number; filteredActionIds: string[]; filteredTargetIds: string[] };
      recommendedActionIds: string[];
      riskyActionIds: string[];
      mergeDropPreviewSummary: { mergePreviewCount: number; dropPreviewCount: number };
      actionabilitySummary: { executableActionCount: number };
      reviewProvider: { id: string; usedFallback: boolean };
      intentDiagnosticsVisibility: {
        present: boolean;
        usedByReviewer: boolean;
        advisoryOnly: boolean;
        totalIntents: number;
        cleanupVisibleCount: number;
        visibleItemCount: number;
        cleanupCandidateCounts: Record<string, number>;
      };
      candidateDiagnostics: {
        intentDiagnostics: {
          usedByReviewer: boolean;
          cleanupVisibleCount: number;
          visibleItemCount: number;
        };
        selectionStage: { selectedThreadIds: string[] };
        analysisStage: { rejectedDoneCandidates: unknown[]; rejectedMergeGroups: unknown[]; rejectedDropCandidates: unknown[] };
        reviewerStage: { executableSuggestionCount: number };
        reviewPlanStage: { actionCount: number; recommendedActionIds: string[] };
      };
      transactionResidue: { hasTransactionResidue: boolean };
      reviewInputThreadSelection?: { selectedThreadCount: number };
    };
    expect(printed.wouldModifyState).toBe(false);
    expect(printed.appliedDryRunCount).toBe(report.appliedDryRunCount);
    expect(printed.recommendedActionSummary.totalRecommended).toBe(report.recommendedActionSummary.totalRecommended);
    expect(printed.recommendedActionSummary.byConfirmationMode.recommended_confirm).toBe(report.recommendedActionSummary.byConfirmationMode.recommended_confirm);
    expect(printed.alreadyDoneGuardSummary).toEqual(report.alreadyDoneGuardSummary);
    expect(printed.recommendedActionIds).toEqual(report.recommendedActionIds);
    expect(printed.riskyActionIds).toEqual(report.riskyActionIds);
    expect(printed.mergeDropPreviewSummary.mergePreviewCount).toBe(report.mergeDropPreviewSummary.mergePreviewCount);
    expect(printed.mergeDropPreviewSummary.dropPreviewCount).toBe(report.mergeDropPreviewSummary.dropPreviewCount);
    expect(printed.actionabilitySummary.executableActionCount).toBe(report.actionabilitySummary?.executableActionCount);
    expect(printed.reviewProvider).toMatchObject({ id: "mock", usedFallback: false });
    expect(report.intentDiagnosticsVisibility).toMatchObject({
      present: true,
      usedByReviewer: true,
      advisoryOnly: true,
      totalIntents: expect.any(Number),
      cleanupVisibleCount: expect.any(Number),
      visibleItemCount: expect.any(Number),
      cleanupCandidateCounts: expect.any(Object),
    });
    expect(printed.intentDiagnosticsVisibility).toEqual(report.intentDiagnosticsVisibility);
    expect(printed.candidateDiagnostics.intentDiagnostics).toMatchObject({
      usedByReviewer: true,
      cleanupVisibleCount: report.intentDiagnosticsVisibility?.cleanupVisibleCount,
      visibleItemCount: report.intentDiagnosticsVisibility?.visibleItemCount,
    });
    expect(printed.candidateDiagnostics.selectionStage.selectedThreadIds.length).toBeGreaterThan(0);
    expect(printed.candidateDiagnostics.reviewerStage.executableSuggestionCount).toBe(report.actionabilitySummary?.executableActionCount);
    expect(printed.candidateDiagnostics.reviewPlanStage.actionCount).toBe(report.actionCount);
    expect(printed.candidateDiagnostics.reviewPlanStage.recommendedActionIds).toEqual(report.recommendedActionIds);
    expect(printed.candidateDiagnostics.analysisStage.rejectedDoneCandidates.length).toBeGreaterThanOrEqual(0);
    expect(printed.candidateDiagnostics.analysisStage.rejectedMergeGroups.length).toBeGreaterThanOrEqual(0);
    expect(printed.candidateDiagnostics.analysisStage.rejectedDropCandidates.length).toBeGreaterThanOrEqual(0);
    expect(printed.transactionResidue.hasTransactionResidue).toBe(false);
    expect(printed.reviewInputThreadSelection?.selectedThreadCount).toBe(report.reviewInputThreadSelection?.selectedThreadCount);
    await expect(readFile(report.reviewReportPath!, "utf-8")).resolves.toContain("Mock review found");
    await expect(readFile(report.reviewPlanPath!, "utf-8")).resolves.toContain("Prepared");
    await expect(readFile(report.applyDryRunReportPath!, "utf-8")).resolves.toContain("\"dryRun\": true");
    await expect(readFile(report.maintenanceReportPath!, "utf-8")).resolves.toContain("wouldModifyState");
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("accepts --provider mock for maintenance-run without modifying state", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);

    const report = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 20,
      scope: "window",
      provider: "mock",
      json: true,
    }, { stdout: createWritable() });

    expect(report.passed).toBe(true);
    expect(report.reviewProvider).toMatchObject({ id: "mock", usedFallback: false });
    expect(report.wouldModifyState).toBe(false);
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("explains why maintenance-run has no recommended action ids", async () => {
    registerAIReviewerProvider({
      id: "no-recommended-test",
      name: "No Recommended Test Provider",
      kind: "mock",
      async review(input) {
        return {
          passed: true,
          scope: input.scope,
          issues: [],
          suggestions: [
            {
              action: "no_action",
              targetIds: [],
              reason: "No direct thread maintenance is safe.",
              confidence: 0.9,
            },
          ],
          summary: "No recommended maintenance action.",
          createdAt: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const stdout = createWritable();

    const report = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 20,
      scope: "window",
      provider: "no-recommended-test",
      json: true,
    }, { stdout });

    expect(report.recommendedActionIds).toEqual([]);
    expect(report.noRecommendedActionReason).toMatchObject({
      actionCount: 1,
      executableActionCount: 0,
      recommendedActionCount: 0,
      prioritizeOnly: false,
    });
    expect(report.noRecommendedActionReason?.reason).toBeTruthy();
    const printed = JSON.parse(stdout.output()) as { noRecommendedActionReason?: { reason: string } };
    expect(printed.noRecommendedActionReason?.reason).toBe(report.noRecommendedActionReason?.reason);
  });

  it("falls back for deepseek maintenance-run when no key is configured", async () => {
    registerAIReviewerProvider(createDeepSeekAIReviewerProvider({ env: {}, fetch: async () => {
      throw new Error("should not fetch");
    } }));
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 20,
      scope: "window",
      provider: "deepseek",
      fallbackToMock: true,
      json: true,
    }, { stdout });

    expect(report.passed).toBe(true);
    expect(report.reviewProvider).toMatchObject({ id: "mock", usedFallback: true });
    expect(report.wouldModifyState).toBe(false);
    const printed = JSON.parse(stdout.output()) as { reviewProvider: { id: string; usedFallback: boolean; errorType?: string } };
    expect(printed.reviewProvider).toMatchObject({ id: "mock", usedFallback: true });
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("--mock maintenance-run does not call the deepseek provider", async () => {
    registerAIReviewerProvider(createDeepSeekAIReviewerProvider({ env: { DEEPSEEK_API_KEY: "unit-key" }, fetch: async () => {
      throw new Error("deepseek fetch should not run");
    } }));
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);

    const report = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 20,
      scope: "window",
      mock: true,
      json: true,
    }, { stdout: createWritable() });

    expect(report.passed).toBe(true);
    expect(report.reviewProvider).toMatchObject({ id: "mock", usedFallback: false });
  });

  it("refuses maintenance-run without --mock and does not write reports", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);
    const stdout = createWritable();

    const report = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      json: true,
    }, { stdout });

    expect(report.passed).toBe(false);
    expect(report.summary).toContain("does not call real external models yet");
    expect(report.wouldModifyState).toBe(false);
    expect(report.transactionResidue.hasTransactionResidue).toBe(false);
    await expect(access(join(projectDir, "reports", "maintenance-run-window-0008.json"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });

  it("supports no-save and no-apply-dry-run modes", async () => {
    const projectDir = await createFixtureProject();
    await seedReviewState(projectDir);
    const before = await snapshotGovernedFiles(projectDir);

    const noSave = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      mock: true,
      save: false,
      action: ["review-action-0001"],
      json: true,
    }, { stdout: createWritable() });

    expect(noSave.passed).toBe(true);
    expect(noSave.reviewReportPath).toBeUndefined();
    expect(noSave.reviewPlanPath).toBeUndefined();
    expect(noSave.applyDryRunReportPath).toBeUndefined();
    expect(noSave.maintenanceReportPath).toBeUndefined();
    expect(noSave.appliedDryRunCount).toBe(1);
    await expect(access(join(projectDir, "reports"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);

    const noApply = await runMaintenanceRunCommand({
      project: projectDir,
      chapter: 8,
      scope: "window",
      mock: true,
      applyDryRun: false,
      json: true,
    }, { stdout: createWritable() });

    expect(noApply.passed).toBe(true);
    expect(noApply.appliedDryRunCount).toBe(0);
    expect(noApply.applyDryRunReportPath).toBeUndefined();
    expect(noApply.reviewReportPath).toBe(join(projectDir, "reports", "ai-review-window-0008.json"));
    expect(noApply.reviewPlanPath).toBe(join(projectDir, "reports", "review-plan-window-0008.json"));
    expect(noApply.maintenanceReportPath).toBe(join(projectDir, "reports", "maintenance-run-window-0008.json"));
    await expect(access(join(projectDir, "reports", "apply-review-plan-window-0008-dry-run.json"))).rejects.toThrow();
    await expect(snapshotGovernedFiles(projectDir)).resolves.toEqual(before);
  });
});

describe("story-engine intent-lifecycle-diagnostics CLI", () => {
  it("writes intent diagnostics without changing story state", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          {
            id: "intent-generic",
            type: "intent",
            title: "决定先回去",
            status: "open",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["林澈想了想，决定先回去。"],
          },
          {
            id: "intent-signal",
            type: "intent",
            title: "确认无线电信号来源",
            status: "open",
            firstSeenChapter: 2,
            lastTouchedChapter: 8,
            evidence: ["对讲机收到断续广播，林澈要追踪信号源。"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const before = await readThreadPool(projectDir);
    const stdout = createWritable();

    const report = await runIntentLifecycleDiagnosticsCommand({
      project: projectDir,
      chapter: 12,
      json: true,
    }, { stdout });

    expect(report.reportPath).toBe(join(projectDir, "reports", "intent-lifecycle-diagnostics-0012.json"));
    await expect(access(report.reportPath!)).resolves.toBeUndefined();
    expect(report.valueClassCounts.low_value_generic).toBe(1);
    expect(report.valueClassCounts.high_value_narrative).toBe(1);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "intent-generic", intentValueClass: "low_value_generic" }),
      expect.objectContaining({ threadId: "intent-signal", intentTypeCategory: "signal_or_clue_goal" }),
    ]));
    expect(JSON.parse(stdout.output())).toMatchObject({ totalIntents: 2 });
    await expect(readThreadPool(projectDir)).resolves.toEqual(before);
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

async function createReviewPlanFixtureForCli(): Promise<{
  readonly projectDir: string;
  readonly planPath: string;
}> {
  const projectDir = await createFixtureProject();
  await seedReviewState(projectDir);
  const review = await runReviewCommand({
    project: projectDir,
    chapter: 8,
    scope: "window",
    mock: true,
    json: true,
  }, { stdout: createWritable() });
  const plan = await runReviewPlanCommand({
    project: projectDir,
    report: review.reportPath,
    chapter: 8,
    json: true,
  }, { stdout: createWritable() });
  return { projectDir, planPath: plan.reportPath! };
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

async function seedReviewState(projectDir: string): Promise<void> {
  await Promise.all([
    writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify(Array.from({ length: 8 }, (_, index) => {
        const chapter = index + 1;
        return {
          id: `ch${String(chapter).padStart(4, "0")}-001`,
          chapter,
          summary: `第${chapter}章林远推进账房线索。`,
          participants: ["guo-xu"],
          effects: {
            semanticSummary: {
              chapter,
              mainEvent: `第${chapter}章林远在账房确认账目线索。`,
              nextLead: "后墙异常响动仍未查清。",
              mentionedCharacterNames: ["林远"],
              locations: ["账房"],
            },
          },
        };
      }), null, 2)}\n`,
      "utf-8",
    ),
    writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
        hooks: [
          {
            id: "hook-stale",
            title: "账目",
            description: "账房账目长期未推进。",
            status: "active",
            relatedCharacters: ["林远"],
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["林远发现账目。"],
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
            id: "thread-stale-intent",
            type: "intent",
            title: "林远准备去库房查账",
            status: "open",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["林远准备去库房查账。"],
          },
          {
            id: "thread-merge-a",
            type: "intent",
            title: "林远决定去库房调查账册",
            status: "open",
            firstSeenChapter: 2,
            lastTouchedChapter: 7,
            evidence: ["林远决定去库房调查账册。"],
          },
          {
            id: "thread-merge-b",
            type: "intent",
            title: "明日去库房查账册",
            status: "open",
            firstSeenChapter: 3,
            lastTouchedChapter: 8,
            evidence: ["明日去库房查账册。"],
          },
          {
            id: "thread-done-candidate",
            type: "lead",
            title: "后墙异常响动",
            status: "open",
            firstSeenChapter: 4,
            lastTouchedChapter: 8,
            evidence: ["林远已经查清后墙异常响动的来源，暗号已解。"],
          },
          {
            id: "thread-drop-candidate",
            type: "intent",
            title: "继续观察情况",
            status: "open",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["以后再说。"],
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
            id: "arc-drift",
            title: "查清资源账目",
            status: "active",
            scope: "main_arc",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["林远开始追查外院账目。"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    ),
  ]);
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
