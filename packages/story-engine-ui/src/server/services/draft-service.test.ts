// @vitest-environment node
/**
 * draft-service 出稿主编排的回归锁：执法在写盘前（拒稿不碰盘上旧稿）、自动去味、章纲、质量环节。
 * 重构 P7 起引擎不写盘、出稿只写一次（走 draft.applyGenerated），原来「先写后回读、不合格再回滚」那套连测试一起删了。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WriterClient } from "../writing/fast-draft-writer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storyEngineMocks = vi.hoisted(() => ({
  buildDraftLengthReport: vi.fn(() => ({
    requestedDraftLength: 1800,
    lowerBound: 200,
    upperBound: 2000,
    actualLength: 500,
    lengthStatus: "within_range",
    source: "default",
    whetherTrimmed: false,
  })),
  buildStateOverview: vi.fn(async () => ({ overview: true })),
  buildAiFlavorReport: vi.fn(() => ({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] })),
  checkDraftBeatFidelity: vi.fn(() => ({ missingBeats: [] })),
  countDraftChineseCharacters: vi.fn(() => 500),
  detectAiFlavorViolations: vi.fn(() => ({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] })),
  resolveDraftLengthTarget: vi.fn(() => ({ requested: 1800, lowerBound: 200, upperBound: 2000, source: "default" })),
  resolveDraftMaxOutputTokens: vi.fn(() => 2048),
  runFastDraft: vi.fn(),
  trimDraftBodyToLengthTarget: vi.fn(),
}));

vi.mock("../writing/draft-length-control.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildDraftLengthReport: storyEngineMocks.buildDraftLengthReport,
  countDraftChineseCharacters: storyEngineMocks.countDraftChineseCharacters,
  resolveDraftLengthTarget: storyEngineMocks.resolveDraftLengthTarget,
  resolveDraftMaxOutputTokens: storyEngineMocks.resolveDraftMaxOutputTokens,
  trimDraftBodyToLengthTarget: storyEngineMocks.trimDraftBodyToLengthTarget,
}));
vi.mock("../book/state-overview.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildStateOverview: storyEngineMocks.buildStateOverview,
}));
vi.mock("../writing/fast-draft-writer.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runFastDraft: storyEngineMocks.runFastDraft,
}));
vi.mock("@actalk/story-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildAiFlavorReport: storyEngineMocks.buildAiFlavorReport,
  checkDraftBeatFidelity: storyEngineMocks.checkDraftBeatFidelity,
  detectAiFlavorViolations: storyEngineMocks.detectAiFlavorViolations,
}));

vi.mock("../writing/beat-miss-adjudication.js", () => ({
  adjudicateMissingBeats: vi.fn(),
  isAdjudicationQuoteVerbatim: vi.fn(() => true),
}));

vi.mock("../writing/ai-flavor/anti-rules.js", () => ({
  readAntiAiPatterns: vi.fn(async () => []),
  readAntiRules: vi.fn(async () => []),
}));


vi.mock("../writing/rank-writer-context.js", () => ({
  contextBudgetPayload: vi.fn(() => ({ budget: true })),
  makeWriterRankContext: vi.fn(() => ({
    rankContext: (envelope: unknown) => envelope,
    droppedSections: [],
    droppedDetails: [],
    coreImpact: false,
    issues: [],
  })),
  resolveWriterTokenBudget: vi.fn(() => 8000),
}));

vi.mock("../writing/presence/in-scene-detector.js", () => ({
  resolveInSceneCharacters: vi.fn(async () => ({
    selected: [], reasons: {}, prevChapterFound: false, explicit: false, cappedOutNames: [], summary: "本章相关人物：本章方向和上一章里都没点到谁。",
  })),
}));

vi.mock("../writing/ai-flavor/ai-flavor-rules.js", () => ({
  ALL_BUILTIN_AI_FLAVOR_RULES: [],
  buildUserAntiAiPatternRules: vi.fn(() => []),
}));

vi.mock("./de-ai-flavor-batch.js", () => ({
  runDeAiFlavorBatch: vi.fn(),
}));

const planMocks = vi.hoisted(() => ({
  resolveChapterPlanForDraft: vi.fn(),
}));
vi.mock("../editorial/plan-chapter.js", () => ({ ...planMocks }));

const pipelineMocks = vi.hoisted(() => ({
  runDraftQualityPipeline: vi.fn(),
}));
vi.mock("./draft-pipeline/run-quality-pipeline.js", () => ({ ...pipelineMocks }));

import { defaultDraftPath } from "../lib/project-io.js";
import { runDeAiFlavorBatch } from "./de-ai-flavor-batch.js";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import { pendingDraftCandidate, pendingDraftFor } from "../lib/draft-candidates.js";
import { resolveInSceneCharacters, type InSceneResult } from "../writing/presence/in-scene-detector.js";
import { resolveProjectDraftLengthTarget, runAutoDeAiRound, runGenerateDraft } from "./draft-service.js";
import { writeCheckMemory } from "../editorial/continuity/check-memory.js";
import { readCheckInputs } from "../editorial/continuity/check-service.js";

const DRAFT_TEXT = "# 第1章\n\n主角拿到账册，连夜翻看。\n";

function stubWriterClient(): WriterClient {
  return {
    generateDraft: vi.fn(async () => ({ title: "账册", content: DRAFT_TEXT })),
  };
}

// 编辑部 R5.4·新发现 4：选角回执有的自带句号（in-scene-detector 的「还没有人物卡……」那句），
// 出稿回执在拼接处再补「。」曾拼出「。。」。修复在拼接处去重：末尾句号归一成恰好一个。
describe("runGenerateDraft 出稿回执句号去重（R5.4·新发现 4）", () => {
  let projectDir: string | undefined;
  // 原句照抄 in-scene-detector（没卡、账里也没人那支）——带句号收尾。
  const presenceWithPeriod = (): InSceneResult => ({
    selected: [],
    reasons: {},
    prevChapterFound: false,
    explicit: false,
    cappedOutNames: [],
    summary: "本章相关人物：还没有人物卡，账里也没记过出场的人。",
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-r54-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("引擎拒稿（单候选）→ 失败回执不出现「。。」，选角句完整保留", async () => {
    vi.mocked(resolveInSceneCharacters).mockResolvedValueOnce(presenceWithPeriod());
    storyEngineMocks.runFastDraft.mockResolvedValueOnce({
      chapter: 2,
      passed: false,
      issues: ["正文为空"],
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {},
    });

    const result = await runGenerateDraft({ projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient() });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("账里也没记过出场的人。请重试或调整本章方向");
    expect(result.summary).not.toContain("。。");
  }, 10_000);

  it("出稿成功 → 回执不出现「。。」，选角句照常收尾接下一句", async () => {
    const draftPath = defaultDraftPath(projectDir!, 2);
    vi.mocked(resolveInSceneCharacters).mockResolvedValueOnce(presenceWithPeriod());
    storyEngineMocks.runFastDraft.mockImplementationOnce(async () => {
      return {
        chapter: 2,
        passed: true,
        draftBody: "主角拿到账册，连夜翻看。",
        title: "账册",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: {},
        issues: [],
      };
    });

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 2,
      writerClient: stubWriterClient(),
      policies: { aiFlavorRecheck: false },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("账里也没记过出场的人。工作稿尚未定稿");
    expect(result.summary).not.toContain("。。");
  }, 10_000);

  it("写稿那几分钟里作者存了稿（或撤销、恢复）→ AI 这版不换上、留成候选、如实说，盘上作者那份不动（写作版本 P1b）", async () => {
    const draftPath = defaultDraftPath(projectDir!, 2);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, "# 第2章\n\n作者原来的稿。\n", "utf-8");
    storyEngineMocks.runFastDraft.mockImplementationOnce(async () => {
      await writeFile(draftPath, "# 第2章\n\n作者在这期间存的新稿。\n", "utf-8");
      return {
        chapter: 2,
        passed: true,
        draftBody: "主角拿到账册，连夜翻看。",
        title: "账册",
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: {},
        issues: [],
      };
    });

    const result = await runGenerateDraft({ projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), policies: { aiFlavorRecheck: false } });

    expect(result.ok).toBe(false);
    expect(result.kept).toMatchObject({ reason: "draft_moved" });
    expect(result.summary).toContain("AI 这版没换上");
    expect(await readFile(draftPath, "utf-8")).toContain("作者在这期间存的新稿。");
    // 候选留着、等作者选（本进程写完的是 ready，稿纸会提示）
    expect(await pendingDraftCandidate(projectDir!, 2)).toMatchObject({ id: result.kept?.candidateId, status: "ready", body: "主角拿到账册，连夜翻看。" });
  }, 10_000);
});

describe("runGenerateDraft enforce 路执法（真稿保护）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  const OLD_DRAFT = "# 第1章\n\n这是上一版合格旧稿，绝不允许被回滚误删。\n";

  it("执法拒稿 → 盘上旧稿一字不动（重构 P7：先在内存里执法，过了才写，不再先写后回滚）", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, OLD_DRAFT, "utf-8");
    // 引擎交回一版「短稿」（引擎不写盘）；字数核对返回 100 < lowerBound 200 → 执法拒稿。
    storyEngineMocks.countDraftChineseCharacters.mockReturnValue(100);
    storyEngineMocks.runFastDraft.mockImplementation(async () => ({
      chapter: 1,
      passed: true,
      title: "第1章",
      draftBody: "短。",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {},
      issues: [],
    }));

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 1,
      writerClient: stubWriterClient(),
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });

    expect(result.ok).toBe(false);
    expect(result.rejection?.kind).toBe("length_rejected");
    expect(await readFile(draftPath, "utf-8")).toBe(OLD_DRAFT);
  }, 10_000);
});

describe("runAutoDeAiRound 只在内存里改（写作版本 P1b）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("改写没跑成、报错带绝对路径 → info.error 如实降级但路径已消毒，不给新正文", async () => {
    vi.mocked(runDeAiFlavorBatch).mockResolvedValue({
      ok: false,
      detected: 1,
      rewritten: 0,
      skipped: 1,
      skippedByReason: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 1 },
      changes: [],
      updatedContent: "主角拿到账册，连夜翻看。",
      summary: "没改成。",
      error: "读取失败（EACCES: permission denied, open '/Users/someone/books/a/drafts/fast/chapter-0001.md'）",
    });
    const result = await runAutoDeAiRound({
      draftBody: "主角拿到账册，连夜翻看。",
      initialHighMedium: 1,
      targets: [],
      rules: [],
      antiRules: [],
      callModel: vi.fn(async () => ""),
    });
    expect(result.info).toMatchObject({ attempted: true, fixedCount: 0 });
    expect(result.info.error).toContain("(本地路径)");
    expect(result.info.error ?? "").not.toContain("/Users/someone");
    expect(result.draftBody).toBeUndefined();
  });

  it("改成了 → 交回改后的正文（由出稿流程最后一次换上工作稿）", async () => {
    vi.mocked(runDeAiFlavorBatch).mockResolvedValue({
      ok: true, detected: 1, rewritten: 1, skipped: 0,
      skippedByReason: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 },
      changes: [], updatedContent: "改写后的正文，与原文不同。", summary: "一键全修：1 处 AI 腔，改了 1 处。",
    });
    // 复检那步要的是「违规数组」（引擎真实签名）；本文件的引擎 mock 默认给报告对象，这里按需给一次。
    storyEngineMocks.detectAiFlavorViolations.mockReturnValueOnce([] as never);
    const result = await runAutoDeAiRound({
      draftBody: "主角拿到账册，连夜翻看。", initialHighMedium: 1, targets: [], rules: [], antiRules: [], callModel: vi.fn(async () => ""),
    });
    expect(result.info.fixedCount).toBe(1);
    expect(result.draftBody).toBe("改写后的正文，与原文不同。");
  });
});

describe("runGenerateDraft 先拟章纲（阶段 2「先想后写」）", () => {
  let projectDir: string | undefined;
  const PLAN = {
    version: 1, chapter: 2, source: "model", summary: "林澈去档案室对出缺页",
    beats: ["去档案室", "对出缺页"], newInformation: ["缺页是境外汇款"], scene: { location: "档案室" },
    characters: ["林澈"], entities: ["蓝色账册"], threadsAdvanced: [], avoid: [], createdAt: "2026-10-08T00:00:00.000Z",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-plan-"));
    const draftPath = defaultDraftPath(projectDir, 2);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, DRAFT_TEXT, "utf-8");
    storyEngineMocks.runFastDraft.mockResolvedValue({
      chapter: 2,
      passed: true,
      draftBody: "主角拿到账册，连夜翻看。",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {},
      issues: [],
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("拟成 → 章纲进写手输入、作者没给方向时本章目标用章纲一句话；结果带 chapterPlan、summary 首行交代章纲", async () => {
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({ plan: PLAN, note: "本章章纲：林澈去档案室对出缺页", reused: false });
    const plannerCallModel = vi.fn();
    const result = await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), plannerCallModel,
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(planMocks.resolveChapterPlanForDraft).toHaveBeenCalledWith(expect.objectContaining({ chapter: 2, plannerCallModel }));
    expect(storyEngineMocks.runFastDraft).toHaveBeenCalledWith(expect.objectContaining({ chapterPlan: PLAN, chapterGoal: "林澈去档案室对出缺页" }));
    expect(result.chapterPlan).toEqual({ summary: "林澈去档案室对出缺页", beats: ["去档案室", "对出缺页"], newInformation: ["缺页是境外汇款"], scene: { location: "档案室" }, reused: false });
    expect(result.summary.split("\n")[0]).toBe("本章章纲：林澈去档案室对出缺页");
  });

  it("这一章上一稿核出「确定」对不上、错在本章的 → 交给写手（重写别照章纲再写错）；错在前面那章的、「可能」的不交", async () => {
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({ plan: PLAN, note: "沿用本章已有章纲：林澈去档案室对出缺页", reused: true });
    const issue = { earlierChapter: 1, reason: "楼层对不上", kind: "place" as const };
    // 记忆的前文键得是现在的（前文改过的旧记忆不交给写手，第 7 轮 U4）。
    const { earlierHash } = await readCheckInputs(projectDir!, 2);
    await writeCheckMemory(projectDir!, {
      chapter: 2, bodyHash: "x", body: "", earlierHash: earlierHash!,
      issues: [
        { ...issue, quote: "他上到三楼走廊。", earlierQuote: "档案室的单间在一楼。", confidence: "sure" },
        { ...issue, quote: "第一章那句", earlierQuote: "设定原文", confidence: "sure", fixChapter: 1, againstSetting: { label: "地点" } },
        { ...issue, quote: "可能的那句", earlierQuote: "前文", confidence: "maybe" },
      ],
    });
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), plannerCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(storyEngineMocks.runFastDraft).toHaveBeenCalledWith(expect.objectContaining({
      lastDraftConflicts: [{ wrote: "他上到三楼走廊。", against: "档案室的单间在一楼。", where: "第 1 章", why: "楼层对不上" }],
    }));
  });

  it("作者给了方向 → 方向原话交给拟章纲，本章目标仍用作者原话", async () => {
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({ plan: PLAN, note: "本章章纲：…", reused: false });
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, chapterGoal: "让他去档案室", writerClient: stubWriterClient(), plannerCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(planMocks.resolveChapterPlanForDraft).toHaveBeenCalledWith(expect.objectContaining({ direction: "让他去档案室" }));
    expect(storyEngineMocks.runFastDraft).toHaveBeenCalledWith(expect.objectContaining({ chapterGoal: "让他去档案室", chapterPlan: PLAN }));
  });

  it("拟不成 → 照常出稿（无章纲）、summary 如实说明", async () => {
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({ note: "章纲没拟成（已自动重试一次）：socket；这次按没有章纲出稿。", reused: false });
    const result = await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), plannerCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(result.ok).toBe(true);
    expect(result.chapterPlan).toBeUndefined();
    expect(storyEngineMocks.runFastDraft.mock.calls[0][0]).not.toHaveProperty("chapterPlan");
    expect(result.summary).toContain("这次按没有章纲出稿");
  });

  it("有章纲且要求分段 → 交给引擎按要点分前后两半写；没章纲时不分", async () => {
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({ plan: PLAN, note: "本章章纲：…", reused: false });
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), plannerCallModel: vi.fn(), segmentByPlan: true,
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(storyEngineMocks.runFastDraft).toHaveBeenCalledWith(expect.objectContaining({ chapterPlan: PLAN, segmentByPlan: true }));

    storyEngineMocks.runFastDraft.mockClear();
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({ note: "章纲没拟成…", reused: false });
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), plannerCallModel: vi.fn(), segmentByPlan: true,
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(storyEngineMocks.runFastDraft.mock.calls[0][0]).not.toHaveProperty("segmentByPlan");
  });

  it("不注入拟章纲调用 → 完全旧行为", async () => {
    await runGenerateDraft({ projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), policies: { lengthPolicy: "annotate", aiFlavorRecheck: false } });
    expect(planMocks.resolveChapterPlanForDraft).not.toHaveBeenCalled();
  });
});

describe("runGenerateDraft 出稿后的质量环节（阶段 3：续写够字数 + 前后核对）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-pipeline-"));
    const draftPath = defaultDraftPath(projectDir, 3);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, DRAFT_TEXT, "utf-8");
    storyEngineMocks.runFastDraft.mockResolvedValue({
      chapter: 3, passed: true, draftBody: "主角拿到账册，连夜翻看。", title: "账册",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {}, issues: [],
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("注入了续写/核对调用 → 先补字数、再核账（核的是补完的那版）；真改了正文就以新正文为准、字数重算、最后只写一次工作稿、说明进 summary", async () => {
    pipelineMocks.runDraftQualityPipeline
      .mockResolvedValueOnce({
        draftBody: "主角拿到账册，连夜翻看，又接着写了很多。", changed: true,
        info: { continuation: { before: 12, after: 2500, rounds: 1, failures: [] } },
        notes: ["首稿 12 字低于下限 240，已接着写到 2500 字。"],
      })
      .mockResolvedValueOnce({
        draftBody: "主角拿到账册，连夜翻看，又接着写了很多。", changed: false,
        info: { continuity: { checked: true, sure: [], maybe: [], failures: [] } },
        notes: ["前后核对：对照了 3 条旧设定和前文，没发现冲突。"],
      });
    const continueCallModel = vi.fn();
    const continuityCheckCallModel = vi.fn();
    const result = await runGenerateDraft({
      projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(),
      continueCallModel, continuityCheckCallModel,
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    const calls = pipelineMocks.runDraftQualityPipeline.mock.calls.map(([input]) => input as Record<string, unknown>);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ chapter: 3, continueCallModel });
    expect(calls[0]).not.toHaveProperty("checkCallModel");
    expect(calls[1]).toMatchObject({ draftBody: "主角拿到账册，连夜翻看，又接着写了很多。", checkCallModel: continuityCheckCallModel });
    expect(calls[1]).not.toHaveProperty("continueCallModel");
    expect(result.draftBody).toBe("主角拿到账册，连夜翻看，又接着写了很多。");
    expect(storyEngineMocks.buildDraftLengthReport).toHaveBeenCalledWith(expect.objectContaining({ draftBody: "主角拿到账册，连夜翻看，又接着写了很多。" }));
    expect(result.ok).toBe(true);
    expect(await readFile(defaultDraftPath(projectDir!, 3), "utf-8")).toContain("又接着写了很多");
    expect(result.qualityPipeline).toEqual({
      continuation: { before: 12, after: 2500, rounds: 1, failures: [] },
      continuity: { checked: true, sure: [], maybe: [], failures: [] },
    });
    expect(result.summary).toContain("已接着写到 2500 字");
    expect(result.summary).toContain("没发现冲突");
  });

  it("首稿存好了、后面的环节抛错 → 这版不丢：稿纸提示「写到一半停了」，工作稿没动", async () => {
    storyEngineMocks.runFastDraft.mockResolvedValueOnce({
      chapter: 3, passed: true, draftBody: "主角翻完账册，天亮了。", title: "账册",
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {}, issues: [],
    });
    pipelineMocks.runDraftQualityPipeline.mockRejectedValueOnce(new Error("核账那步崩了"));
    await expect(runGenerateDraft({
      projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(),
      continueCallModel: vi.fn(), policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    })).rejects.toThrow("核账那步崩了");
    expect(await pendingDraftFor(projectDir!, 3)).toMatchObject({ kind: "candidate", reason: "interrupted", body: "主角翻完账册，天亮了。" });
    expect(await readFile(defaultDraftPath(projectDir!, 3), "utf-8")).toBe(DRAFT_TEXT);
  });

  it("没注入 → 不跑（HTTP 路与旧行为不变）", async () => {
    await runGenerateDraft({ projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(), policies: { lengthPolicy: "annotate", aiFlavorRecheck: false } });
    expect(pipelineMocks.runDraftQualityPipeline).not.toHaveBeenCalled();
  });

});


describe("runGenerateDraft 在场检测与目标字数接线（重构 P9：读设定卡）", () => {
  let projectDir: string | undefined;
  const okReport = (chapter: number) => ({
    chapter, passed: true, draftBody: "主角拿到账册，连夜翻看。", title: "账册",
    contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
    promptFingerprint: {}, issues: [],
  });
  const inScene = (selected: string[]): InSceneResult => ({
    selected, reasons: {}, prevChapterFound: true, explicit: false, cappedOutNames: [], summary: `本章相关人物：${selected.join("、")}`,
  });
  async function cards(ops: CardOp[]): Promise<void> {
    const outcome = await runCommand(projectDir!, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-wiring-"));
    storyEngineMocks.runFastDraft.mockResolvedValue(okReport(2));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("作者点名的人（名字）交给在场检测当 explicit；检测选中的名字原样交给写手", async () => {
    vi.mocked(resolveInSceneCharacters).mockResolvedValueOnce(inScene(["林晚", "林远"]));
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, chapterGoal: "林远摊牌。", selectedCharacters: ["林总"], writerClient: stubWriterClient(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(resolveInSceneCharacters).toHaveBeenCalledWith(expect.objectContaining({ projectDir, chapter: 2, chapterGoal: "林远摊牌。", explicit: ["林总"] }));
    expect(storyEngineMocks.runFastDraft).toHaveBeenCalledWith(expect.objectContaining({ selectedCharacters: ["林晚", "林远"] }));
  });

  it("没点名 → 不传 explicit；检测一个都没选中 → 写手入参不带 selectedCharacters", async () => {
    await runGenerateDraft({ projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), policies: { lengthPolicy: "annotate", aiFlavorRecheck: false } });
    expect(vi.mocked(resolveInSceneCharacters).mock.calls[0]![0]).not.toHaveProperty("explicit");
    expect(storyEngineMocks.runFastDraft.mock.calls[0][0]).not.toHaveProperty("selectedCharacters");
  });

  it("有章纲 → 章纲点名的人物和要点也拿去做在场检测", async () => {
    planMocks.resolveChapterPlanForDraft.mockResolvedValue({
      plan: {
        version: 1, chapter: 2, source: "model", summary: "去档案室", beats: ["顾远递来钥匙"], newInformation: [], scene: {},
        characters: ["周宁"], entities: [], threadsAdvanced: [], avoid: [], createdAt: "2026-10-08T00:00:00.000Z",
      },
      note: "本章章纲：去档案室",
      reused: false,
    });
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), plannerCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(resolveInSceneCharacters).toHaveBeenCalledWith(expect.objectContaining({ chapterGoal: "去档案室\n周宁\n顾远递来钥匙" }));
  });

  it("目标字数读设定卡的写作规则（目标 + 下限）", async () => {
    await cards([{ op: "rules.set", field: "targetWords", value: 2400 }, { op: "rules.set", field: "minWords", value: 2000 }]);
    await runGenerateDraft({ projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient(), policies: { lengthPolicy: "annotate", aiFlavorRecheck: false } });
    expect(storyEngineMocks.resolveDraftLengthTarget).toHaveBeenCalledWith(expect.objectContaining({ lengthRules: { targetWords: 2400, minWords: 2000 } }));
  });

  it("resolveProjectDraftLengthTarget：作者点的字数 > 写作规则 > 默认（真算法）", async () => {
    const actual = await vi.importActual<typeof import("../writing/draft-length-control.js")>("../writing/draft-length-control.js");
    storyEngineMocks.resolveDraftLengthTarget.mockImplementation(actual.resolveDraftLengthTarget as never);
    try {
      expect(await resolveProjectDraftLengthTarget(projectDir!, "继续。")).toMatchObject({ source: "default" });
      await cards([{ op: "rules.set", field: "targetWords", value: 2400 }]);
      expect(await resolveProjectDraftLengthTarget(projectDir!, "继续。")).toMatchObject({ requested: 2400, source: "writing_rules" });
      expect(await resolveProjectDraftLengthTarget(projectDir!, "继续。", 3000)).toMatchObject({ requested: 3000, source: "user" });
    } finally {
      storyEngineMocks.resolveDraftLengthTarget.mockImplementation(() => ({ requested: 1800, lowerBound: 200, upperBound: 2000, source: "default" }));
    }
  });
});
