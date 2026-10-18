// @vitest-environment node
/**
 * draft-service 出稿主编排的回归锁：执法在写盘前（拒稿不碰盘上旧稿）、自动去味、章纲、质量环节。
 * 重构 P7 起引擎不写盘、出稿只写一次（走 draft.write），原来「先写后回读、不合格再回滚」那套连测试一起删了。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  readWritingRules: vi.fn(async () => null),
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
vi.mock("../book/project-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWritingRules: storyEngineMocks.readWritingRules,
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

vi.mock("../lib/snapshot-on-draft-overwrite.js", () => ({
  snapshotBeforeDraftOverwrite: vi.fn(async () => undefined),
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
  resolveSelectedCharacterIds: vi.fn(async () => ({ selectedCharacterIds: [], trace: {}, summary: "在场角色 0 人" })),
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
import { snapshotBeforeDraftOverwrite } from "../lib/snapshot-on-draft-overwrite.js";
import { resolveSelectedCharacterIds, type CharacterPresenceResult } from "../writing/presence/in-scene-detector.js";
import { runAutoDeAiRound, runGenerateDraft } from "./draft-service.js";

const DRAFT_TEXT = "# 第1章\n\n主角拿到账册，连夜翻看。\n";

function stubWriterClient(): WriterClient {
  return {
    generateDraft: vi.fn(async () => ({ title: "账册", content: DRAFT_TEXT })),
  };
}

// 编辑部 R5.4·新发现 4：占位名册的两句选角回执（in-scene-detector.ts:247/252）自带句号，
// 出稿回执在拼接处再补「。」曾拼出「把关。。」。修复在拼接处去重：末尾句号归一成恰好一个。
describe("runGenerateDraft 出稿回执句号去重（R5.4·新发现 4）", () => {
  let projectDir: string | undefined;
  // 原句照抄 in-scene-detector.ts:252（占位名册、无出场记账那支）——带句号收尾。
  const presenceWithPeriod = (): CharacterPresenceResult => ({
    selectedCharacterIds: [],
    trace: { selectedCharacterIds: [], selectedNames: [], byId: {}, prevChapterFound: false },
    summary: "本章相关角色：名册只有开书占位「主角」，最近定稿章也没有出场记账，本次没拿占位名把关。",
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
    vi.mocked(resolveSelectedCharacterIds).mockResolvedValueOnce(presenceWithPeriod());
    storyEngineMocks.runFastDraft.mockResolvedValueOnce({
      chapter: 2,
      passed: false,
      issues: ["正文为空"],
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {},
    });

    const result = await runGenerateDraft({ projectDir: projectDir!, chapter: 2, writerClient: stubWriterClient() });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("没拿占位名把关。请重试或调整本章方向");
    expect(result.summary).not.toContain("。。");
  }, 10_000);

  it("出稿成功 → 回执不出现「。。」，选角句照常收尾接下一句", async () => {
    const draftPath = defaultDraftPath(projectDir!, 2);
    vi.mocked(resolveSelectedCharacterIds).mockResolvedValueOnce(presenceWithPeriod());
    storyEngineMocks.runFastDraft.mockImplementationOnce(async () => {
      await mkdir(dirname(draftPath), { recursive: true });
      await writeFile(draftPath, DRAFT_TEXT, "utf-8");
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
    expect(result.summary).toContain("没拿占位名把关。工作稿尚未定稿");
    expect(result.summary).not.toContain("。。");
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

describe("runAutoDeAiRound 快照失败降级（P2-5·铁律④ 路径消毒）", () => {
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

  it("快照读稿 fail-closed 抛错带绝对路径 → info.error 如实降级但路径已消毒，原稿不动", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, DRAFT_TEXT, "utf-8");
    vi.mocked(runDeAiFlavorBatch).mockResolvedValue({
      ok: true,
      detected: 1,
      rewritten: 1,
      skipped: 0,
      skippedByReason: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 },
      changes: [],
      updatedContent: "# 第1章\n\n改写后的正文，与原文不同。\n",
      summary: "一键全修：1 处 AI 腔，改了 1 处。",
    });
    // 快照 fail-closed 的 errno 原文内嵌绝对路径（真实形态见 snapshot-on-draft-overwrite）。
    vi.mocked(snapshotBeforeDraftOverwrite).mockRejectedValueOnce(
      new Error(`第1章工作稿读取失败（EACCES: permission denied, open '${draftPath}'），已中止`),
    );

    const result = await runAutoDeAiRound({
      projectDir: projectDir!,
      chapter: 1,
      draftPath,
      initialHighMedium: 1,
      targets: [],
      rules: [],
      antiRules: [],
      callModel: vi.fn(async () => ""),
    });

    // 降级如实报：本轮没跑成（改写放弃），error 直达用户前路径已洗。
    expect(result.info.attempted).toBe(true);
    expect(result.info.fixedCount).toBe(0);
    expect(result.info.error).toContain("(本地路径)");
    expect(result.info.error ?? "").not.toContain(projectDir!);
    expect(result.draftBody).toBeUndefined();
    expect(result.snapshotId).toBeUndefined();
    // 原稿分毫不动（降级承诺）。
    expect(await readFile(draftPath, "utf-8")).toBe(DRAFT_TEXT);
  });

  // R4.2（验收 3.2）：出稿流程内已有「写盘前」存档点，去味覆盖不再另建——一次出稿=操作历史里的一步。
  it("skipOverwriteSnapshot → 覆盖前不再另建快照（撤销点由流程级存档点兜着），改写照落", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, DRAFT_TEXT, "utf-8");
    vi.mocked(runDeAiFlavorBatch).mockResolvedValue({
      ok: true, detected: 1, rewritten: 1, skipped: 0,
      skippedByReason: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 },
      changes: [], updatedContent: "# 第1章\n\n改写后的正文，与原文不同。\n", summary: "一键全修：1 处 AI 腔，改了 1 处。",
    });
    // 复检那步要的是「违规数组」（引擎真实签名）；本文件的引擎 mock 默认给报告对象，这里按需给一次。
    storyEngineMocks.detectAiFlavorViolations.mockReturnValueOnce([] as never);
    const result = await runAutoDeAiRound({
      projectDir: projectDir!, chapter: 1, draftPath, initialHighMedium: 1, targets: [], rules: [], antiRules: [],
      callModel: vi.fn(async () => ""), skipOverwriteSnapshot: true,
    });
    expect(snapshotBeforeDraftOverwrite).not.toHaveBeenCalled();
    expect(result.snapshotId).toBeUndefined();
    expect(result.info.fixedCount).toBe(1);
    expect(await readFile(draftPath, "utf-8")).toContain("改写后的正文");
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

  it("注入了续写/核对调用 → 跑质量环节；真改了正文就以新正文为准、字数重算、撤销点用它的快照、说明进 summary", async () => {
    pipelineMocks.runDraftQualityPipeline.mockResolvedValue({
      draftBody: "主角拿到账册，连夜翻看，又接着写了很多。", changed: true, snapshotId: "snap-pipeline",
      info: { continuation: { before: 12, after: 2500, rounds: 1, failures: [] } },
      notes: ["首稿 12 字低于下限 240，已接着写到 2500 字。", "前后核对：对照了 3 条旧设定和前文，没发现冲突。"],
    });
    const continueCallModel = vi.fn();
    const result = await runGenerateDraft({
      projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(),
      continueCallModel, continuityCheckCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(pipelineMocks.runDraftQualityPipeline).toHaveBeenCalledWith(expect.objectContaining({ chapter: 3, title: "账册", continueCallModel }));
    expect(result.draftBody).toBe("主角拿到账册，连夜翻看，又接着写了很多。");
    expect(storyEngineMocks.buildDraftLengthReport).toHaveBeenCalledWith(expect.objectContaining({ draftBody: "主角拿到账册，连夜翻看，又接着写了很多。" }));
    expect(result.snapshotId).toBe("snap-pipeline");
    expect(result.qualityPipeline).toEqual({ continuation: { before: 12, after: 2500, rounds: 1, failures: [] } });
    expect(result.summary).toContain("已接着写到 2500 字");
    expect(result.summary).toContain("没发现冲突");
  });

  it("没注入 → 不跑（HTTP 路与旧行为不变）", async () => {
    await runGenerateDraft({ projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(), policies: { lengthPolicy: "annotate", aiFlavorRecheck: false } });
    expect(pipelineMocks.runDraftQualityPipeline).not.toHaveBeenCalled();
  });

  // R4.2（验收 3.2）：适配层建好本步存档点（首稿「出稿：第N章」/覆盖「再次出稿前」）后，
  // 内部第二次落盘不再各建快照——一次出稿=操作历史里的一步，撤销一键退回这步之前。
  it("preWriteSnapshotId → 质量环节带 skipOverwriteSnapshot、输出撤销点用它", async () => {
    pipelineMocks.runDraftQualityPipeline.mockResolvedValue({
      draftBody: "主角拿到账册，连夜翻看，又接着写了很多。", changed: true,
      info: {}, notes: [],
    });
    const result = await runGenerateDraft({
      projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(),
      continueCallModel: vi.fn(), continuityCheckCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
      preWriteSnapshotId: "snap-flow",
    });
    expect(pipelineMocks.runDraftQualityPipeline).toHaveBeenCalledWith(expect.objectContaining({ skipOverwriteSnapshot: true }));
    expect(result.snapshotId).toBe("snap-flow");
  });

  it("不传 preWriteSnapshotId → 质量环节照旧自建覆盖前快照（独立调用方行为不变）", async () => {
    pipelineMocks.runDraftQualityPipeline.mockResolvedValue({ draftBody: DRAFT_TEXT, changed: false, info: {}, notes: [] });
    await runGenerateDraft({
      projectDir: projectDir!, chapter: 3, writerClient: stubWriterClient(),
      continueCallModel: vi.fn(), continuityCheckCallModel: vi.fn(),
      policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    });
    expect(pipelineMocks.runDraftQualityPipeline).toHaveBeenCalled();
    expect(pipelineMocks.runDraftQualityPipeline.mock.calls[0][0]).not.toHaveProperty("skipOverwriteSnapshot");
  });
});

