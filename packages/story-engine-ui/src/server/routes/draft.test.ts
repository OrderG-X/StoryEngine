import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";

const storyEngineMocks = vi.hoisted(() => ({
  buildDraftAIReviewPrompt: vi.fn(),
  buildStateOverview: vi.fn(),
  buildWritingContextPack: vi.fn(),
  buildWriterContext: vi.fn(),
  checkDraftBeforeCommit: vi.fn(),
  fallbackDraftAIReviewReport: vi.fn(),
  parseDraftAIReviewReport: vi.fn(),
  readWritingRules: vi.fn(),
  renderFastDraftPromptText: vi.fn(),
  runFastDraft: vi.fn(),
}));

vi.mock("@actalk/story-engine", async () => {
  const actual = await vi.importActual<typeof import("@actalk/story-engine")>("@actalk/story-engine");
  const requestedDraftLengthBounds = (requested: number) => ({
    lowerBound: Math.max(300, Math.floor(requested * 0.85)),
    upperBound: Math.ceil((requested * 115) / 100),
  });
  const resolveDraftLengthTarget = (input: { readonly chapterGoal?: string; readonly requestedDraftLength?: number; readonly writingRules?: unknown }) => {
    const explicitMatch = input.chapterGoal?.match(/(?:约|大约|左右|控制在|写到|写成|先写|写)?\s*(\d{3,5})\s*(?:字|个字|中文字符)/u);
    const chapterLength = typeof input.writingRules === "object" && input.writingRules !== null && "chapterLength" in input.writingRules
      ? (input.writingRules as { readonly chapterLength?: { readonly targetWords?: number } }).chapterLength
      : undefined;
    const requested = input.requestedDraftLength ?? (explicitMatch?.[1] ? Number(explicitMatch[1]) : undefined) ?? chapterLength?.targetWords ?? 1800;
    const source = input.requestedDraftLength ?? explicitMatch?.[1]
      ? "user"
      : chapterLength?.targetWords
        ? "writing_rules"
        : "default";
    return { requested, source, ...requestedDraftLengthBounds(requested) };
  };
  const countDraftChineseCharacters = (value: string) => (value.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const buildDraftLengthReport = (input: { readonly draftBody: string; readonly lengthTarget: { readonly requested: number; readonly lowerBound: number; readonly upperBound: number; readonly source: string }; readonly finalLengthAfterTrim?: number; readonly whetherTrimmed?: boolean }) => {
    const actualLength = countDraftChineseCharacters(input.draftBody);
    const lengthStatus = actualLength < input.lengthTarget.lowerBound
      ? "below_lower_bound"
      : actualLength > input.lengthTarget.upperBound
        ? "above_upper_bound"
        : "within_range";
    return {
      requestedDraftLength: input.lengthTarget.requested,
      lowerBound: input.lengthTarget.lowerBound,
      upperBound: input.lengthTarget.upperBound,
      actualLength,
      lengthStatus,
      source: input.lengthTarget.source,
      ...(lengthStatus === "within_range" ? {} : { retryReason: lengthStatus }),
      ...(input.finalLengthAfterTrim !== undefined ? { finalLengthAfterTrim: input.finalLengthAfterTrim } : {}),
      whetherTrimmed: input.whetherTrimmed ?? false,
    };
  };
  const trimDraftBodyToLengthTarget = (draftBody: string, target: { readonly lowerBound: number; readonly upperBound: number }) => {
    let seen = 0;
    let result = "";
    for (const char of draftBody) {
      result += char;
      if (/[\u3400-\u9fff]/u.test(char)) seen += 1;
      if (seen >= target.upperBound) break;
    }
    const finalLength = countDraftChineseCharacters(result);
    return {
      ok: finalLength >= target.lowerBound && finalLength <= target.upperBound,
      draftBody: result.trim(),
      finalLength,
    };
  };
  return {
    ...actual,
    applyDraftLengthConstraint: (chapterGoal: string, target: { readonly requested: number; readonly lowerBound: number; readonly upperBound: number; readonly source: string }) => `${chapterGoal}\n\n【本轮硬性字数要求】${target.source === "user" ? "用户明确要求" : target.source === "writing_rules" ? "项目写作规则要求" : "系统默认章节目标"}约 ${target.requested} 字，正文不含标题必须控制在 ${target.lowerBound}-${target.upperBound} 个中文字符内。`,
    buildDraftLengthReport,
    buildFastDraftRetryPrompt: (prompt: string, target?: { readonly requested: number; readonly lowerBound: number; readonly upperBound: number }) => `${prompt}\n目标长度：${target?.lowerBound}-${target?.upperBound} 个中文字符`,
    countDraftChineseCharacters,
    trimDraftBodyToLengthTarget,
    resolveDraftLengthTarget,
    requestedDraftLengthBounds,
    resolveDraftMaxOutputTokens: (target: { readonly upperBound: number }) => Math.max(360, Math.min(4096, Math.ceil(target.upperBound / 1.35) + 220)),
    ...storyEngineMocks,
  };
});

const llmClientMocks = vi.hoisted(() => ({
  buildProviderRequestHeaders: vi.fn(async () => ({})),
  callOpenAICompatibleChatModel: vi.fn(),
  createConfiguredWriterClient: vi.fn(),
  resolveConfiguredChatModel: vi.fn(),
  streamOpenAICompatibleResponse: vi.fn(),
}));

vi.mock("../lib/llm-client.js", async () => {
  // 其余导出（createIdleAbort / STREAM_IDLE_TIMEOUT_MS 等）走真实实现——出稿流的空闲超时
  // 铁律要靠真计时器验证；只有上面 hoisted 的几个函数被 mock。
  const actual = await vi.importActual<typeof import("../lib/llm-client.js")>("../lib/llm-client.js");
  return { ...actual, ...llmClientMocks };
});

const qualityJudgeMocks = vi.hoisted(() => ({
  judgeDraftQualityWithModel: vi.fn(),
}));

vi.mock("../lib/quality-judge.js", () => ({
  ...qualityJudgeMocks,
}));

const presenceMocks = vi.hoisted(() => ({
  resolveSelectedCharacterIds: vi.fn(),
}));

vi.mock("../agent/presence/in-scene-detector.js", () => ({
  ...presenceMocks,
}));

import { __draftRouteTest, registerDraftRoutes } from "./draft.js";

const { buildStateOverview, buildWriterContext, readWritingRules, renderFastDraftPromptText, runFastDraft } = storyEngineMocks;
const { buildDraftAIReviewPrompt, buildWritingContextPack, checkDraftBeforeCommit, fallbackDraftAIReviewReport, parseDraftAIReviewReport } = storyEngineMocks;
const { callOpenAICompatibleChatModel, createConfiguredWriterClient, resolveConfiguredChatModel, streamOpenAICompatibleResponse } = llmClientMocks;
const { resolveSelectedCharacterIds } = presenceMocks;

describe("draft length target helpers", () => {
  it("prefers explicit user target over project writing rules", () => {
    const target = __draftRouteTest.resolveDraftLengthTarget({
      chapterGoal: "这一章约700字，写紧凑一点。",
      writingRules: { chapterLength: { targetWords: 1800 } },
    });

    expect(target).toMatchObject({
      requested: 700,
      source: "user",
      lowerBound: 595,
      upperBound: 805,
    });
  });

  it("uses writing rules target when the user does not specify length", () => {
    const target = __draftRouteTest.resolveDraftLengthTarget({
      chapterGoal: "继续推进主角进入审计楼。",
      writingRules: { chapterLength: { targetWords: 700 } },
    });

    expect(target).toMatchObject({
      requested: 700,
      source: "writing_rules",
      lowerBound: 595,
      upperBound: 805,
    });
  });
});

describe("draft length guard routes", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    buildStateOverview.mockResolvedValue({ project: { title: "测试项目" } });
    buildWriterContext.mockResolvedValue({ sections: [] });
    renderFastDraftPromptText.mockReturnValue("写作提示");
    readWritingRules.mockResolvedValue({ version: "v0", chapterLength: { targetWords: 700 } });
    createConfiguredWriterClient.mockResolvedValue({ generateDraft: vi.fn() });
    resolveConfiguredChatModel.mockResolvedValue({
      provider: { baseUrl: "https://example.invalid" },
      profile: { id: "fast-test", model: "fast-model", temperature: 0.1, maxTokens: 4000 },
      apiKey: "test-key",
    });
    streamOpenAICompatibleResponse.mockResolvedValue({ content: longCjkDraft(13, 90) });
    callOpenAICompatibleChatModel.mockResolvedValue({
      content: longCjkDraft(8, 90),
      raw: "{}",
      response: { ok: true, status: 200 },
    });
    resolveSelectedCharacterIds.mockImplementation(async (input: { readonly explicit?: readonly string[] }) => ({
      selectedCharacterIds: input.explicit ?? ["auto-guo"],
      trace: {
        selectedCharacterIds: input.explicit ?? ["auto-guo"],
        selectedNames: input.explicit ? ["显式角色"] : ["林远"],
        byId: {},
        prevChapterFound: false,
        explicit: input.explicit !== undefined,
      },
      summary: input.explicit ? "本章相关角色：显式角色" : "本章相关角色：林远",
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("passes selected context hints and context budget ranking to non-stream generation", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-context-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: {
      readonly projectDir: string;
      readonly chapter: number;
      readonly selectedCharacterIds?: readonly string[];
      readonly selectedHookIds?: readonly string[];
      readonly maxTimelineEvents?: number;
      readonly rankContext?: (envelope: MockWriterContextEnvelope) => MockWriterContextEnvelope;
    }) => {
      expect(input.selectedCharacterIds).toEqual(["lin-wan-qing"]);
      expect(input.selectedHookIds).toEqual(["h-ledger"]);
      expect(input.maxTimelineEvents).toBe(2);
      const ranked = input.rankContext?.(makeMockWriterContext());
      expect(ranked?.sections.map((section) => section.name)).not.toContain("timeline_events");
      const draftPath = join(input.projectDir, "drafts", "fast", "chapter-0001.md");
      await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
      await writeFile(draftPath, `# 第1章\n\n${longCjkDraft(7, 90)}\n`, "utf-8");
      return {
        chapter: input.chapter,
        passed: true,
        draftPath,
        title: "第1章",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "test", sections: [] },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
      selectedCharacterIds: ["lin-wan-qing"],
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 2,
      contextTokenBudget: 20,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.contextBudget).toMatchObject({ droppedSections: ["timeline_events"] });
  });

  it("passes context ranking to persist:false candidate generation", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-context-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: {
      readonly rankContext?: (envelope: MockWriterContextEnvelope) => MockWriterContextEnvelope;
      readonly persist?: boolean;
    }) => {
      expect(input.persist).toBe(false);
      expect(input.rankContext?.(makeMockWriterContext()).sections.map((section) => section.name)).not.toContain("timeline_events");
      return {
        chapter: 1,
        passed: true,
        draftBody: "林远确认候选正文只临时返回。",
        title: "候选正文",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "test", sections: [] },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "再来一版。",
      persist: false,
      contextTokenBudget: 20,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.contextBudget).toMatchObject({ droppedSections: ["timeline_events"] });
  });

  it("resolves selected characters for non-stream generation when explicit ids are omitted", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-presence-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: {
      readonly projectDir: string;
      readonly chapter: number;
      readonly selectedCharacterIds?: readonly string[];
    }) => {
      expect(input.selectedCharacterIds).toEqual(["auto-guo"]);
      const draftPath = join(input.projectDir, "drafts", "fast", "chapter-0002.md");
      await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
      await writeFile(draftPath, `# 第2章\n\n${longCjkDraft(7, 90)}\n`, "utf-8");
      return {
        chapter: input.chapter,
        passed: true,
        draftPath,
        title: "第2章",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "presence", sections: [] },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 2,
      chapterGoal: "林总进入会场。",
    });

    expect(resolveSelectedCharacterIds).toHaveBeenCalledWith(expect.objectContaining({
      projectDir,
      chapter: 2,
      chapterGoal: "林总进入会场。",
      explicit: undefined,
    }));
    expect(response.payload.characterSelection).toMatchObject({
      selectedCharacterIds: ["auto-guo"],
      summary: "本章相关角色：林远",
    });
  });

  it("keeps candidate and main draft context budget ledgers independent", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-context-");
    await writeProjectJson(projectDir);
    runFastDraft
      .mockImplementationOnce(async (input: {
        readonly rankContext?: (envelope: MockWriterContextEnvelope) => MockWriterContextEnvelope;
      }) => {
        expect(input.rankContext?.(makeMockWriterContext("story_calendar")).sections.map((section) => section.name)).not.toContain("story_calendar");
        return {
          chapter: 1,
          passed: true,
          draftBody: "林远确认候选正文只临时返回。",
          title: "候选正文",
          contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
          promptFingerprint: { hash: "candidate", sections: [] },
          issues: [],
        };
      })
      .mockImplementationOnce(async (input: {
        readonly projectDir: string;
        readonly chapter: number;
        readonly rankContext?: (envelope: MockWriterContextEnvelope) => MockWriterContextEnvelope;
      }) => {
        expect(input.rankContext?.(makeMockWriterContext("timeline_events")).sections.map((section) => section.name)).not.toContain("timeline_events");
        const draftPath = join(input.projectDir, "drafts", "fast", "chapter-0001.md");
        await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
        await writeFile(draftPath, `# 第1章\n\n${longCjkDraft(7, 90)}\n`, "utf-8");
        return {
          chapter: input.chapter,
          passed: true,
          draftPath,
          title: "第1章",
          contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
          promptFingerprint: { hash: "main", sections: [] },
          issues: [],
        };
      });

    const candidate = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "再来一版。",
      persist: false,
      contextTokenBudget: 20,
    });
    const main = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
      contextTokenBudget: 20,
    });

    expect(candidate.payload.contextBudget).toMatchObject({ droppedSections: ["story_calendar"] });
    expect(main.payload.contextBudget).toMatchObject({ droppedSections: ["timeline_events"] });
  });

  it("applies selected hints and context budget ranking to streamed generation", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-context-");
    await writeProjectJson(projectDir);
    buildWriterContext.mockResolvedValueOnce(makeMockWriterContext());
    renderFastDraftPromptText.mockImplementationOnce((context: MockWriterContextEnvelope) => {
      expect(context.sections.map((section) => section.name)).not.toContain("timeline_events");
      return "写作提示";
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" } as Response);

    const response = await callDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
      selectedCharacterIds: ["lin-wan-qing"],
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 2,
      contextTokenBudget: 20,
    });

    expect(buildWriterContext).toHaveBeenCalledWith(expect.objectContaining({
      selectedCharacterIds: ["lin-wan-qing"],
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 2,
    }));
    const done = response.events.find((event) => event.event === "done")?.data as { readonly contextBudget?: unknown } | undefined;
    expect(done?.contextBudget).toMatchObject({ droppedSections: ["timeline_events"] });
  });

  it("resolves selected characters for streamed generation when explicit ids are omitted", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-presence-");
    await writeProjectJson(projectDir);
    buildWriterContext.mockResolvedValueOnce(makeMockWriterContext());
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" } as Response);

    const response = await callDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 2,
      chapterGoal: "林总进入会场。",
    });

    expect(buildWriterContext).toHaveBeenCalledWith(expect.objectContaining({
      selectedCharacterIds: ["auto-guo"],
    }));
    const done = response.events.find((event) => event.event === "done")?.data as { readonly characterSelection?: unknown } | undefined;
    expect(done?.characterSelection).toMatchObject({
      selectedCharacterIds: ["auto-guo"],
      summary: "本章相关角色：林远",
    });
  });

  it("applies writing-rules target to non-stream generation and compresses overlong drafts", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: { readonly projectDir: string; readonly chapter: number; readonly chapterGoal: string }) => {
      const draftPath = join(input.projectDir, "drafts", "fast", "chapter-0001.md");
      await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
      await writeFile(draftPath, `# 第1章\n\n${longCjkDraft(13, 90)}\n`, "utf-8");
      return {
        chapter: input.chapter,
        passed: true,
        draftPath,
        title: "第1章",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "test", sections: [] },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.report).toMatchObject({
      draftLength: {
        requestedDraftLength: 700,
        lowerBound: 595,
        upperBound: 805,
        lengthStatus: "within_range",
        finalLengthAfterTrim: expect.any(Number),
        whetherTrimmed: true,
      },
    });
    expect(runFastDraft).toHaveBeenCalledWith(expect.objectContaining({
      chapterGoal: "继续推进主角进入审计楼。",
      requestedDraftLength: undefined,
      maxOutputTokens: expect.any(Number),
    }));
    const runInput = runFastDraft.mock.calls[0]?.[0] as { readonly chapterGoal?: string } | undefined;
    expect(runInput?.chapterGoal).not.toContain("本轮硬性字数要求");
    expect(runInput?.chapterGoal).not.toContain("项目写作规则要求约");
    expect(runInput?.chapterGoal).not.toContain("用户明确要求约");
    expect(runInput?.chapterGoal).not.toContain("系统默认章节目标约");
    const draftContent = await readFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "utf-8");
    const draftBody = draftContent.replace(/^#.*\n+/u, "").trim();
    expect(__draftRouteTest.countCjkChars(draftBody)).toBeGreaterThanOrEqual(595);
    expect(__draftRouteTest.countCjkChars(draftBody)).toBeLessThanOrEqual(805);
  });

  it("passes explicit requestedDraftLength without injecting the non-stream chapter goal", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: { readonly projectDir: string; readonly chapter: number }) => {
      const draftPath = join(input.projectDir, "drafts", "fast", "chapter-0001.md");
      await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
      await writeFile(draftPath, `# 第1章\n\n${longCjkDraft(7, 90)}\n`, "utf-8");
      return {
        chapter: input.chapter,
        passed: true,
        draftPath,
        title: "第1章",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "test", sections: [] },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
      requestedDraftLength: 700,
    });

    expect(response.statusCode).toBe(200);
    expect(runFastDraft).toHaveBeenCalledWith(expect.objectContaining({
      chapterGoal: "继续推进主角进入审计楼。",
      requestedDraftLength: 700,
      maxOutputTokens: expect.any(Number),
    }));
    const runInput = runFastDraft.mock.calls[0]?.[0] as { readonly chapterGoal?: string } | undefined;
    expect(runInput?.chapterGoal).not.toContain("本轮硬性字数要求");
    expect(runInput?.chapterGoal).not.toContain("用户明确要求约");
  });

  it("preserves core-level trim metadata in the non-stream response report", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: { readonly projectDir: string; readonly chapter: number }) => {
      const draftPath = join(input.projectDir, "drafts", "fast", "chapter-0001.md");
      await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
      await writeFile(draftPath, `# 第1章\n\n${longCjkDraft(7, 90)}\n`, "utf-8");
      return {
        chapter: input.chapter,
        passed: true,
        draftPath,
        title: "第1章",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "test", sections: [] },
        draftLength: {
          requestedDraftLength: 700,
          lowerBound: 595,
          upperBound: 805,
          actualLength: 630,
          lengthStatus: "within_range",
          source: "writing_rules",
          finalLengthAfterTrim: 630,
          whetherTrimmed: true,
        },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });

    expect(response.statusCode).toBe(200);
    const report = response.payload.report as { readonly draftLength?: unknown };
    expect(report.draftLength).toMatchObject({
      lengthStatus: "within_range",
      finalLengthAfterTrim: 630,
      whetherTrimmed: true,
    });
  });

  it("enforce 落盘回读彻底失败 → 200 ok:true 但 warnings 投影带出降级留痕（复审 P2②：不再零信号假成功）", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    // 故障注入：引擎报 passed 并给出 draftPath，但草稿根本没落盘 → 执法回读重试耗尽仍空。
    const draftPath = join(projectDir, "drafts", "fast", "chapter-0001.md");
    runFastDraft.mockResolvedValueOnce({
      chapter: 1,
      passed: true,
      draftPath,
      title: "第1章",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: { hash: "test", sections: [] },
      issues: [],
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });

    // 「草稿确已落盘」是引擎报告口径，ok 仍 true（绝不谎报失败）；
    // 但执法跳过 + 正文未载入这两条降级必须随 warnings 投影带出（200 响应此前不带 summary=零信号）。
    expect(response.statusCode).toBe(200);
    expect(response.payload.ok).toBe(true);
    expect(response.payload.draftContent).toBe("");
    expect(response.payload.warnings).toEqual([
      expect.stringContaining("长度执法未执行"),
      expect.stringContaining("正文已写盘"),
    ]);
  }, 10_000);

  it("rejects too-short non-stream drafts and restores the previous working draft", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    const draftPath = join(projectDir, "drafts", "fast", "chapter-0001.md");
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(draftPath, "# 第1章\n\n旧工作稿保留。\n", "utf-8");
    runFastDraft.mockImplementationOnce(async (input: { readonly projectDir: string; readonly chapter: number }) => {
      await writeFile(draftPath, `# 第1章\n\n${longCjkDraft(2, 70)}\n`, "utf-8");
      return {
        chapter: input.chapter,
        passed: true,
        draftPath,
        title: "第1章",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: { hash: "test", sections: [] },
        issues: [],
      };
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });

    expect(response.statusCode).toBe(422);
    expect(response.payload.error).toBe("草稿正文低于目标字数过多，已拒绝写入工作稿；请重试或提高模型输出上限。");
    await expect(readFile(draftPath, "utf-8")).resolves.toBe("# 第1章\n\n旧工作稿保留。\n");
  });

  it("applies writing-rules target to streamed generation before returning done content", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" } as Response);

    const response = await callDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });

    expect(response.events.some((event) => event.event === "error")).toBe(false);
    const done = response.events.find((event) => event.event === "done")?.data as { readonly draftContent?: string } | undefined;
    expect(done?.draftContent).toBeTruthy();
    expect(done).toMatchObject({
      draftLength: {
        requestedDraftLength: 700,
        lowerBound: 595,
        upperBound: 805,
        lengthStatus: "within_range",
        whetherTrimmed: true,
        finalLengthAfterTrim: expect.any(Number),
      },
    });
    expect(__draftRouteTest.countCjkChars(done?.draftContent ?? "")).toBeGreaterThanOrEqual(595);
    expect(__draftRouteTest.countCjkChars(done?.draftContent ?? "")).toBeLessThanOrEqual(805);
    expect(callOpenAICompatibleChatModel).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("目标长度：595-805 个中文字符") }),
      ]),
    }));
  });

  it("章节标题生成收拢进非流式 helper：带 120s 总时长上限（上游死连兜底退回第X章，不再挂住路由）", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-title-");
    await writeProjectJson(projectDir);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" } as Response);

    const response = await callDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });

    expect(response.events.some((event) => event.event === "error")).toBe(false);
    expect(response.events.some((event) => event.event === "done")).toBe(true);
    // 标题是流式出稿后的最后一次模型调用；timeoutMs 只挂在标题调用上（压缩/扩写不带）。
    expect(callOpenAICompatibleChatModel).toHaveBeenLastCalledWith(expect.objectContaining({
      timeoutMs: 120_000,
      temperature: 0.55,
    }));
  });

  it("uses a second fallback when streamed explicit short-target compression becomes too short", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    streamOpenAICompatibleResponse.mockResolvedValueOnce({ content: longCjkDraft(12, 80) });
    callOpenAICompatibleChatModel
      .mockResolvedValueOnce({
        content: longCjkDraft(3, 100),
        raw: "{}",
        response: { ok: true, status: 200 },
      })
      .mockResolvedValueOnce({
        content: longCjkDraft(5, 90),
        raw: "{}",
        response: { ok: true, status: 200 },
      });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" } as Response);

    const response = await callDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "这一章约500字，写林远核对门禁记录。",
    });

    expect(response.events.some((event) => event.event === "error")).toBe(false);
    const done = response.events.find((event) => event.event === "done")?.data as { readonly draftContent?: string } | undefined;
    const cjkCount = __draftRouteTest.countCjkChars(done?.draftContent ?? "");
    expect(cjkCount).toBeGreaterThanOrEqual(425);
    expect(cjkCount).toBeLessThanOrEqual(575);
    // 压缩 + 扩写 + 章节标题（标题已收拢进 callOpenAICompatibleChatModel，带 120s 上限）
    expect(callOpenAICompatibleChatModel).toHaveBeenCalledTimes(3);
    expect(callOpenAICompatibleChatModel).toHaveBeenNthCalledWith(2, expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("目标长度：425-575 个中文字符") }),
      ]),
    }));
  });

  it("returns a readable stream error and does not overwrite an existing draft when short-target fallback still fails", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-length-");
    await writeProjectJson(projectDir);
    const draftPath = join(projectDir, "drafts", "fast", "chapter-0001.md");
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(draftPath, "# 第1章\n\n旧工作稿保留。\n", "utf-8");
    streamOpenAICompatibleResponse.mockResolvedValueOnce({ content: longCjkDraft(12, 80) });
    callOpenAICompatibleChatModel
      .mockResolvedValueOnce({
        content: longCjkDraft(3, 100),
        raw: "{}",
        response: { ok: true, status: 200 },
      })
      .mockResolvedValueOnce({
        content: longCjkDraft(3, 100),
        raw: "{}",
        response: { ok: true, status: 200 },
      });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" } as Response);

    const response = await callDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "这一章约500字，写林远核对门禁记录。",
    });

    const error = response.events.find((event) => event.event === "error")?.data as { readonly error?: string } | undefined;
    expect(error?.error).toBe("模型输出无法稳定满足目标字数，已拒绝写入工作稿；请重试或换一种写法。");
    expect(response.events.some((event) => event.event === "done")).toBe(false);
    await expect(readFile(draftPath, "utf-8")).resolves.toBe("# 第1章\n\n旧工作稿保留。\n");
    expect(callOpenAICompatibleChatModel).toHaveBeenCalledTimes(2);
  });

  it("出稿流上游彻底静默超 90s → abort 上游 fetch 并报可读错误（不再永远挂住路由）", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-idle-");
    await writeProjectJson(projectDir);
    // 只 fake setTimeout：createIdleAbort 的计时器可控，fs/git/nextTick 等真实事件循环不受影响
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let capturedSignal: AbortSignal | null = null;
      let fetchCalled!: () => void;
      const fetchCalledPromise = new Promise<void>((resolvePromise) => {
        fetchCalled = resolvePromise;
      });
      vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
        capturedSignal = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
        fetchCalled();
        // 上游死连：永不出字节，只在被 abort 时按真实 fetch 行为 reject
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      });

      const { finished } = startDraftSseRoute("/api/draft/stream", {
        projectPath: projectDir,
        chapter: 1,
        chapterGoal: "继续推进主角进入审计楼。",
      });
      await fetchCalledPromise;
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(90_001);
      const response = await finished;

      expect(capturedSignal!.aborted).toBe(true);
      const error = response.events.find((event) => event.event === "error")?.data as { readonly error?: string } | undefined;
      expect(error?.error).toContain("静默超过 90s");
      expect(response.events.some((event) => event.event === "done")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("出稿流有字节就续命：总长超 90s 的慢速流式照常完成，不误杀、不设总时长上限", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-idle-");
    await writeProjectJson(projectDir);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let capturedSignal: AbortSignal | null = null;
      vi.spyOn(globalThis, "fetch")
        .mockImplementationOnce((_input, init) => {
          capturedSignal = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
          return Promise.resolve({ ok: true, status: 200, text: async () => "" } as Response);
        });
      // 模拟慢速长生成：每 60s 才来一块字节（每次都落在 90s 空闲窗内 → 续命），总时长 180s 远超窗口
      streamOpenAICompatibleResponse.mockImplementationOnce(async (
        _response: unknown,
        onDelta: (delta: string) => void,
        _onThinkingDelta: unknown,
        onActivity?: () => void,
      ) => {
        for (let i = 0; i < 3; i += 1) {
          await vi.advanceTimersByTimeAsync(60_000);
          onActivity?.();
          onDelta("海");
        }
        return { content: longCjkDraft(8, 90) };
      });

      const response = await startDraftSseRoute("/api/draft/stream", {
        projectPath: projectDir,
        chapter: 1,
        chapterGoal: "继续推进主角进入审计楼。",
      }).finished;

      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);
      expect(response.events.some((event) => event.event === "error")).toBe(false);
      expect(response.events.some((event) => event.event === "done")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("客户端断开（res close 且 writableEnded=false）→ abort 上游 fetch、回报已中止", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-disconnect-");
    await writeProjectJson(projectDir);
    let capturedSignal: AbortSignal | null = null;
    let fetchCalled!: () => void;
    const fetchCalledPromise = new Promise<void>((resolvePromise) => {
      fetchCalled = resolvePromise;
    });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
      capturedSignal = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
      fetchCalled();
      // 上游长连不返回：只在被 abort 时 reject
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    });

    const { res, finished } = startDraftSseRoute("/api/draft/stream", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "继续推进主角进入审计楼。",
    });
    await fetchCalledPromise;
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

    res.emit("close"); // writableEnded 仍为 false = 响应未完成时连接被掐（前端停止/关页）
    const response = await finished;

    expect(capturedSignal!.aborted).toBe(true);
    const error = response.events.find((event) => event.event === "error")?.data as { readonly error?: string } | undefined;
    expect(error?.error).toContain("客户端已断开");
    expect(response.events.some((event) => event.event === "done")).toBe(false);
  });
});

describe("draft ai-review route model call（收拢 streamChatModelToText：流式 + 空闲超时铁律）", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    buildStateOverview.mockResolvedValue({ project: { title: "测试项目" } });
    buildWritingContextPack.mockResolvedValue(undefined);
    checkDraftBeforeCommit.mockResolvedValue({ issues: [] });
    buildDraftAIReviewPrompt.mockReturnValue("审稿提示");
    parseDraftAIReviewReport.mockReturnValue({ verdict: "pass", summary: "通过", issues: [] });
    fallbackDraftAIReviewReport.mockReturnValue({ verdict: "blocked", summary: "兜底", issues: [{ id: "ai-review-format-error" }] });
    resolveConfiguredChatModel.mockResolvedValue({
      provider: { baseUrl: "https://example.invalid" },
      profile: { id: "review-test", model: "review-model", temperature: 0.1 },
      apiKey: "test-key",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("审稿请求带 AbortSignal、走流式（stream:true + response_format），聚合正文交 parseDraftAIReviewReport", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-review-");
    await writeProjectJson(projectDir);
    let capturedSignal: AbortSignal | null = null;
    let capturedBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
      capturedSignal = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
      capturedBody = String((init as RequestInit | undefined)?.body ?? "");
      return Promise.resolve(sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "{\"verdict\":\"pass\"}" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]));
    });

    const response = await callDraftRoute("/api/draft/ai-review", {
      projectPath: projectDir,
      chapter: 1,
      draftContent: longCjkDraft(4, 60),
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ ok: true, model: "review-model", profileId: "review-test", usedFallback: false });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBeUndefined();
    expect(parseDraftAIReviewReport).toHaveBeenCalledWith("{\"verdict\":\"pass\"}");
  });

  it("上游彻底静默超 90s → 空闲超时 abort 死连（不再永远挂住），路由回落兜底报告", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-review-");
    await writeProjectJson(projectDir);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let capturedSignal: AbortSignal | null = null;
      let fetchCalled!: () => void;
      const fetchCalledPromise = new Promise<void>((resolvePromise) => {
        fetchCalled = resolvePromise;
      });
      vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
        capturedSignal = ((init as RequestInit | undefined)?.signal as AbortSignal | null) ?? null;
        fetchCalled();
        // 上游死连：永不出字节，只在被 abort 时按真实 fetch 行为 reject
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      });

      const pending = callDraftRoute("/api/draft/ai-review", {
        projectPath: projectDir,
        chapter: 1,
        draftContent: longCjkDraft(4, 60),
      });
      await fetchCalledPromise;
      expect(capturedSignal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(90_001);
      const response = await pending;

      expect(capturedSignal!.aborted).toBe(true);
      expect(response.statusCode).toBe(200);
      // D18 收敛（刻意修复）：走兜底=没真审成 → ok:false 诚实显红（前端 ok:false → throw → 失败卡），
      // 不再 200 ok:true 伪装完成；error 用与工具侧同一 canonical 文案。
      expect(response.payload).toMatchObject({ ok: false });
      expect(String((response.payload as { error?: unknown }).error)).toContain("审稿未完成");
      expect(fallbackDraftAIReviewReport).toHaveBeenCalledWith(expect.stringContaining("静默超过 90s"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("draft direct edit route", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    buildStateOverview.mockResolvedValue({ project: { title: "测试项目" } });
    resolveConfiguredChatModel.mockResolvedValue({
      provider: { baseUrl: "https://example.invalid" },
      profile: { id: "repair-test", model: "repair-model", temperature: 0.1, maxTokens: 4000 },
      apiKey: "test-key",
    });
    callOpenAICompatibleChatModel.mockResolvedValue({
      content: JSON.stringify({
        reply: "已改到工作稿。",
        changeSummary: "已替换目标文本。",
        draftContent: "# 第1章\n\n海州审计办公室灯还亮着。",
      }),
      raw: "{}",
      response: { ok: true, status: 200 },
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("does not call the model when explicit replacement target is missing", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-edit-");

    const response = await callDraftRoute("/api/draft/direct-edit", {
      projectPath: projectDir,
      chapter: 1,
      instruction: "把“审计办公室”改成“海州审计办公室”，不要扩写。",
      draftContent: "# 第1章\n\n蓝色审计账册在桌上。",
    });

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({
      ok: false,
      error: "未找到目标文本“审计办公室”，请确认要修改的位置。",
    });
    expect(resolveConfiguredChatModel).not.toHaveBeenCalled();
    expect(callOpenAICompatibleChatModel).not.toHaveBeenCalled();
  });

  it("allows direct edit when explicit replacement target exists", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-edit-");

    const response = await callDraftRoute("/api/draft/direct-edit", {
      projectPath: projectDir,
      chapter: 1,
      instruction: "将审计办公室改为海州审计办公室。",
      draftContent: "# 第1章\n\n审计办公室灯还亮着。",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      result: {
        draftContent: "# 第1章\n\n海州审计办公室灯还亮着。",
      },
    });
    expect(resolveConfiguredChatModel).toHaveBeenCalledWith("repair");
    expect(callOpenAICompatibleChatModel).toHaveBeenCalledTimes(1);
  });

  it("模型回吐的草稿与原稿逐字一致（什么都没改）→ 诚实 422、不回『已改』（afterfix·改稿谎报根治）", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-edit-");
    callOpenAICompatibleChatModel.mockResolvedValueOnce({
      content: JSON.stringify({
        reply: "已改到工作稿。",
        changeSummary: "已按要求修改草稿。",
        draftContent: "# 第1章\n\n审计办公室灯还亮着。", // 与原稿一致 = 实际没改
      }),
      raw: "{}",
      response: { ok: true, status: 200 },
    });

    const response = await callDraftRoute("/api/draft/direct-edit", {
      projectPath: projectDir,
      chapter: 1,
      instruction: "润色第一段，让它更紧凑。", // 非显式替换，避开 409 预检
      draftContent: "# 第1章\n\n审计办公室灯还亮着。",
    });

    expect(response.statusCode).toBe(422);
    expect(response.payload.ok).toBe(false);
    expect(response.payload).not.toHaveProperty("result");
  });

  it("returns a readable no-op error when the model returns malformed JSON", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-edit-");
    callOpenAICompatibleChatModel.mockResolvedValueOnce({
      content: '{ "reply": "已改" "draftContent": "# 第1章\\n\\n海州审计办公室灯还亮着。" }',
      raw: "{}",
      response: { ok: true, status: 200 },
    });

    const response = await callDraftRoute("/api/draft/direct-edit", {
      projectPath: projectDir,
      chapter: 1,
      instruction: "将审计办公室改为海州审计办公室。",
      draftContent: "# 第1章\n\n审计办公室灯还亮着。",
    });

    expect(response.statusCode).toBe(422);
    expect(response.payload).toMatchObject({
      ok: false,
      error: "修订模型返回格式不完整，请重试或换一种修改要求。",
    });
    expect(String(response.payload.error)).not.toContain("Expected ','");
    expect(response.payload).not.toHaveProperty("result");
    expect(callOpenAICompatibleChatModel).toHaveBeenCalledTimes(1);
  });
});

async function callDraftRoute(path: string, body: Record<string, unknown>): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  const handlers: Middleware[] = [];
  registerDraftRoutes({ use: (handler) => handlers.push(handler) });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: path,
  }) as IncomingMessage;
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      void name;
      void value;
      return res as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return res as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;

  await new Promise<void>((resolve, reject) => {
    const result = handlers[0]?.(req, res, (error?: unknown) => error ? reject(error) : resolve()) as unknown;
    Promise.resolve(result).then(() => resolve(), reject);
  });

  const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  return { statusCode: res.statusCode, payload };
}

async function callDraftSseRoute(path: string, body: Record<string, unknown>): Promise<{
  readonly statusCode: number;
  readonly raw: string;
  readonly events: readonly { readonly event: string; readonly data: unknown }[];
}> {
  return startDraftSseRoute(path, body).finished;
}

// 假 res 用真 EventEmitter：路由挂了 res 'close' 侦测客户端断开（abortOnClientDisconnect），
// end() 正常收尾时 writableEnded=true 再发 close——与真实 Node 行为一致，顺带验证不误杀。
function startDraftSseRoute(path: string, body: Record<string, unknown>): {
  readonly res: ServerResponse;
  readonly finished: Promise<{
    readonly statusCode: number;
    readonly raw: string;
    readonly events: readonly { readonly event: string; readonly data: unknown }[];
  }>;
} {
  const handlers: Middleware[] = [];
  registerDraftRoutes({ use: (handler) => handlers.push(handler) });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: path,
  }) as IncomingMessage;
  const chunks: Buffer[] = [];
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      void name;
      void value;
      return res as unknown as ServerResponse;
    },
    writeHead: (statusCode: number) => {
      res.statusCode = statusCode;
      return res as unknown as ServerResponse;
    },
    write: (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      res.writableEnded = true;
      res.emit("close");
      return res as unknown as ServerResponse;
    },
  }) as unknown as ServerResponse & { statusCode: number; writableEnded: boolean };

  const finished = (async () => {
    await new Promise<void>((resolve, reject) => {
      const result = handlers[0]?.(req, res, (error?: unknown) => error ? reject(error) : resolve()) as unknown;
      Promise.resolve(result).then(() => resolve(), reject);
    });
    const raw = Buffer.concat(chunks).toString("utf-8");
    return { statusCode: res.statusCode, raw, events: parseSseEvents(raw) };
  })();
  return { res, finished };
}

function parseSseEvents(raw: string): readonly { readonly event: string; readonly data: unknown }[] {
  return raw
    .split(/\n\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event:\s*(.+)$/mu.exec(block)?.[1]?.trim() ?? "message";
      const dataText = /^data:\s*(.+)$/mu.exec(block)?.[1]?.trim() ?? "{}";
      return { event, data: JSON.parse(dataText) as unknown };
    });
}

function longCjkDraft(paragraphCount: number, paragraphLength: number): string {
  const char = "海";
  return Array.from({ length: paragraphCount }, (_, index) => `第${index + 1}段${char.repeat(paragraphLength)}`).join("\n\n");
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

interface MockContextSection {
  readonly name: string;
  readonly content: unknown;
  readonly tokenEstimate: number;
  readonly cachePolicy: "stable" | "dynamic";
}

interface MockWriterContextEnvelope {
  readonly projectId: string;
  readonly chapter: number;
  readonly sections: readonly MockContextSection[];
  readonly trace: {
    readonly sectionNames: readonly string[];
    readonly totalTokenEstimate: number;
    readonly stableTokenEstimate: number;
    readonly dynamicTokenEstimate: number;
    readonly selectedCharacters: readonly string[];
    readonly selectedHooks: readonly string[];
    readonly selectedTimelineEvents: readonly string[];
  };
}

function makeMockWriterContext(dynamicSectionName = "timeline_events"): MockWriterContextEnvelope {
  const sections: readonly MockContextSection[] = [
    { name: "story_core", content: {}, tokenEstimate: 50, cachePolicy: "stable" },
    { name: "chapter_goal", content: {}, tokenEstimate: 10, cachePolicy: "dynamic" },
    { name: "writing_context_pack", content: {}, tokenEstimate: 10, cachePolicy: "dynamic" },
    { name: dynamicSectionName, content: {}, tokenEstimate: 40, cachePolicy: "dynamic" },
  ];
  const totalTokenEstimate = sections.reduce((sum, section) => sum + section.tokenEstimate, 0);
  const stableTokenEstimate = sections
    .filter((section) => section.cachePolicy === "stable")
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
  return {
    projectId: "test-project",
    chapter: 1,
    sections,
    trace: {
      sectionNames: sections.map((section) => section.name),
      totalTokenEstimate,
      stableTokenEstimate,
      dynamicTokenEstimate: totalTokenEstimate - stableTokenEstimate,
      selectedCharacters: [],
      selectedHooks: [],
      selectedTimelineEvents: [],
    },
  };
}

async function writeProjectJson(projectDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(projectDir, "story"), { recursive: true }),
    mkdir(join(projectDir, "timeline"), { recursive: true }),
    mkdir(join(projectDir, "world"), { recursive: true }),
    mkdir(join(projectDir, "characters"), { recursive: true }),
  ]);
  await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: "Draft Length Test" }, null, 2)}\n`, "utf-8");
}
