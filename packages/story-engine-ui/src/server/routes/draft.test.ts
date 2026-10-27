// @vitest-environment node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeChapterPlan } from "../book/chapter-plan.js";
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
  renderFastDraftPromptText: vi.fn(),
  runFastDraft: vi.fn(),
}));

const lengthFakes = vi.hoisted(() => {
  const requestedDraftLengthBounds = (requested: number) => ({
    lowerBound: Math.max(300, Math.floor(requested * 0.85)),
    upperBound: Math.ceil((requested * 115) / 100),
  });
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
    applyDraftLengthConstraint: (chapterGoal: string, target: { readonly requested: number; readonly lowerBound: number; readonly upperBound: number; readonly source: string }) => `${chapterGoal}\n\n【本轮硬性字数要求】${target.source === "user" ? "用户明确要求" : target.source === "writing_rules" ? "项目写作规则要求" : "系统默认章节目标"}约 ${target.requested} 字，正文不含标题必须控制在 ${target.lowerBound}-${target.upperBound} 个中文字符内。`,
    buildDraftLengthReport,
    buildFastDraftRetryPrompt: (prompt: string, target?: { readonly requested: number; readonly lowerBound: number; readonly upperBound: number }) => `${prompt}\n目标长度：${target?.lowerBound}-${target?.upperBound} 个中文字符`,
    countDraftChineseCharacters,
    trimDraftBodyToLengthTarget,
    requestedDraftLengthBounds,
    resolveDraftMaxOutputTokens: (target: { readonly upperBound: number }) => Math.max(360, Math.min(4096, Math.ceil(target.upperBound / 1.35) + 220)),
  };
});
vi.mock("../writing/draft-length-control.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...lengthFakes,
}));
vi.mock("../book/state-overview.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildStateOverview: storyEngineMocks.buildStateOverview,
}));
vi.mock("../writing/draft-ai-review.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildDraftAIReviewPrompt: storyEngineMocks.buildDraftAIReviewPrompt,
  fallbackDraftAIReviewReport: storyEngineMocks.fallbackDraftAIReviewReport,
  parseDraftAIReviewReport: storyEngineMocks.parseDraftAIReviewReport,
}));
vi.mock("../writing/writing-context-pack.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildWritingContextPack: storyEngineMocks.buildWritingContextPack,
}));
vi.mock("../writing/context-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildWriterContext: storyEngineMocks.buildWriterContext,
}));
vi.mock("../writing/commit-quality-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkDraftBeforeCommit: storyEngineMocks.checkDraftBeforeCommit,
}));
vi.mock("../writing/prompt-cache-diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderFastDraftPromptText: storyEngineMocks.renderFastDraftPromptText,
}));
vi.mock("../writing/fast-draft-writer.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runFastDraft: storyEngineMocks.runFastDraft,
}));

const llmClientMocks = vi.hoisted(() => ({
  buildProviderRequestHeaders: vi.fn(async () => ({})),
  callOpenAICompatibleChatModel: vi.fn(),
  createConfiguredWriterClient: vi.fn(),
  resolveConfiguredChatModel: vi.fn(),
  streamOpenAICompatibleResponse: vi.fn(),
}));

vi.mock("../writing/writer-client.js", () => ({
  createConfiguredWriterClient: llmClientMocks.createConfiguredWriterClient,
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
  resolveInSceneCharacters: vi.fn(),
}));

vi.mock("../writing/presence/in-scene-detector.js", () => ({
  ...presenceMocks,
}));

import { __draftRouteTest, registerDraftRoutes } from "./draft.js";

const { buildStateOverview, buildWriterContext, renderFastDraftPromptText, runFastDraft } = storyEngineMocks;
const { callOpenAICompatibleChatModel, createConfiguredWriterClient, resolveConfiguredChatModel, streamOpenAICompatibleResponse } = llmClientMocks;
const { resolveInSceneCharacters } = presenceMocks;

// 字数只认结构化的 requestedDraftLength，不从本章方向那句话里抠数字（重构 P7「不猜」）；写作规则来自设定卡（重构 P9）。
describe("draft length target helpers", () => {
  it("prefers explicit user target over project writing rules", () => {
    const target = __draftRouteTest.resolveDraftLengthTarget({
      chapterGoal: "这一章约700字，写紧凑一点。",
      requestedDraftLength: 700,
      lengthRules: { targetWords: 1800 },
    });

    expect(target).toMatchObject({
      requested: 700,
      source: "user",
      lowerBound: 595,
      upperBound: 805,
    });
  });

  it("uses writing rules target when the user does not specify length（方向里写的数字不算）", () => {
    const target = __draftRouteTest.resolveDraftLengthTarget({
      chapterGoal: "继续推进主角进入审计楼，写 3000 字。",
      lengthRules: { targetWords: 700 },
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
    resolveInSceneCharacters.mockImplementation(async (input: { readonly explicit?: readonly string[] }) => ({
      selected: input.explicit ?? ["林远"],
      reasons: {},
      prevChapterFound: false,
      explicit: input.explicit !== undefined,
      cappedOutNames: [],
      summary: `本章相关人物：${(input.explicit ?? ["林远"]).join("、")}`,
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("passes context ranking to candidate generation", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-context-");
    await writeProjectJson(projectDir);
    runFastDraft.mockImplementationOnce(async (input: {
      readonly rankContext?: (envelope: MockWriterContextEnvelope) => MockWriterContextEnvelope;
    }) => {
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

  it("作者点名的人物（selectedCharacters，名字）交给在场检测当显式名单，选中的名字交给写手", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-cast-");
    await writeProjectJson(projectDir);
    runFastDraft.mockResolvedValueOnce({
      chapter: 1,
      passed: true,
      draftBody: "苏晴推门进来。",
      title: "候选正文",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: { hash: "test", sections: [] },
      issues: [],
    });

    const response = await callDraftRoute("/api/draft/generate", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "再来一版。",
      persist: false,
      selectedCharacters: ["苏晴", " "],
    });

    expect(response.statusCode).toBe(200);
    expect(resolveInSceneCharacters).toHaveBeenCalledWith(expect.objectContaining({ explicit: ["苏晴"] }));
    expect(runFastDraft).toHaveBeenCalledWith(expect.objectContaining({ selectedCharacters: ["苏晴"] }));
    expect(response.payload.characterSelection).toMatchObject({ selected: ["苏晴"], explicit: true });
  });

  it("另写几版：本章有章纲就照它分前后两半写（和对话里出稿一样），方向沿用章纲里作者的原话", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-segment-");
    await writeProjectJson(projectDir);
    await writeChapterPlan(projectDir, {
      version: 1,
      chapter: 1,
      source: "model",
      direction: "林远连夜对账。",
      summary: "林远对账。",
      beats: ["收截图", "算总数", "接催收电话", "打电话请假"],
      newInformation: ["欠款翻倍"],
      scene: { location: "店里", time: "当晚" },
      characters: ["林远"],
      entities: [],
      threadsAdvanced: [],
      avoid: [],
      createdAt: "2026-10-27T00:00:00.000Z",
    });
    runFastDraft.mockResolvedValueOnce({
      chapter: 1,
      passed: true,
      draftBody: "林远把截图一张张抄下来。",
      title: "对账",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: { hash: "test", sections: [] },
      issues: [],
    });

    const response = await callDraftRoute("/api/draft/generate", { projectPath: projectDir, chapter: 1, persist: false });

    expect(response.statusCode).toBe(200);
    expect(runFastDraft).toHaveBeenCalledWith(expect.objectContaining({
      segmentByPlan: true,
      chapterGoal: "林远连夜对账。",
      chapterPlan: expect.objectContaining({ beats: ["收截图", "算总数", "接催收电话", "打电话请假"] }),
    }));
  });

  it("重构 P4：落盘出稿的 HTTP 路已撤（persist 不是 false 一律 410，不调模型、不写盘）", async () => {
    projectDir = await makeHomeTempDir("story-engine-ui-draft-gone-");
    await writeProjectJson(projectDir);
    const response = await callDraftRoute("/api/draft/generate", { projectPath: projectDir, chapter: 1, chapterGoal: "写吧。" });
    expect(response.statusCode).toBe(410);
    expect(response.payload.ok).toBe(false);
    expect(runFastDraft).not.toHaveBeenCalled();
    await expect(readFile(join(projectDir, "drafts", "fast", "0001.md"), "utf-8")).rejects.toThrow();
  });

  it("重构 P4：流式出稿 / 审稿 / 硬伤检查 / 直接改稿的 HTTP 路都已撤（交给下一个中间件）", async () => {
    const handlers: Middleware[] = [];
    registerDraftRoutes({ use: (handler) => handlers.push(handler) });
    for (const path of ["/api/draft/stream", "/api/draft/ai-review", "/api/draft/quality", "/api/draft/direct-edit"]) {
      const next = vi.fn();
      const end = vi.fn();
      const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", url: path }) as IncomingMessage;
      await handlers[0]!(req, { end, setHeader: vi.fn() } as unknown as ServerResponse, next);
      expect(next, path).toHaveBeenCalledTimes(1);
      expect(end, path).not.toHaveBeenCalled();
    }
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

function longCjkDraft(paragraphCount: number, paragraphLength: number): string {
  const char = "海";
  return Array.from({ length: paragraphCount }, (_, index) => `第${index + 1}段${char.repeat(paragraphLength)}`).join("\n\n");
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
