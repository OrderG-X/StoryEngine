// @vitest-environment node
/**
 * draft-service D1 长度执法回读降级（GLM P3 旧账④）的回归锁：
 * 原实现 `readFile(report.draftPath, "utf-8").catch(() => "")` —— 落盘回读失败得空串 →
 * 整段长度执法静默跳过、响应仍 ok:true，长度不达标/超长的稿子无声流入工作稿。
 * 修复后：回读对齐 L1 口径（readFileContentWithRetry 3×60ms），仍失败则执法跳过在 summary
 * 如实留痕（⚠ 长度执法未执行），绝不静默；ok 仍 true（草稿确已落盘，绝不谎报失败）。
 *
 * 故障注入手法：引擎 mock 的 runFastDraft 报 passed 但不真写盘 → draftPath 不存在 → 回读必失败。
 * （节点内置 fs 在本 vitest 配置下不可跨模块 mock，故障从真实文件系统状态造。）
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WriterClient } from "@actalk/story-engine";
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
  checkDraftBeatFidelity: vi.fn(() => ({ missingBeats: [] })),
  countDraftChineseCharacters: vi.fn(() => 500),
  detectAiFlavorViolations: vi.fn(() => ({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] })),
  persistFastDraftBody: vi.fn(),
  readWritingRules: vi.fn(async () => null),
  resolveDraftLengthTarget: vi.fn(() => ({ requested: 1800, lowerBound: 200, upperBound: 2000, source: "default" })),
  resolveDraftMaxOutputTokens: vi.fn(() => 2048),
  runFastDraft: vi.fn(),
  trimDraftBodyToLengthTarget: vi.fn(),
}));

vi.mock("@actalk/story-engine", () => ({
  ...storyEngineMocks,
}));

vi.mock("../lib/beat-miss-adjudication.js", () => ({
  adjudicateMissingBeats: vi.fn(),
  isAdjudicationQuoteVerbatim: vi.fn(() => true),
}));

vi.mock("../agent/tools/check-ai-flavor.js", () => ({
  readAntiAiPatterns: vi.fn(async () => []),
  readAntiRules: vi.fn(async () => []),
}));

vi.mock("../agent/tools/snapshot-on-draft-overwrite.js", () => ({
  snapshotBeforeDraftOverwrite: vi.fn(async () => undefined),
}));

vi.mock("../agent/context-budget/rank-writer-context.js", () => ({
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

vi.mock("../agent/presence/in-scene-detector.js", () => ({
  resolveSelectedCharacterIds: vi.fn(async () => ({ selectedCharacterIds: [], trace: {}, summary: "在场角色 0 人" })),
}));

vi.mock("../agent/ai-flavor/ai-flavor-rules.js", () => ({
  ALL_BUILTIN_AI_FLAVOR_RULES: [],
  buildUserAntiAiPatternRules: vi.fn(() => []),
}));

vi.mock("../agent/ai-flavor/de-ai-flavor-batch.js", () => ({
  runDeAiFlavorBatch: vi.fn(),
}));

import { defaultDraftPath } from "../lib/project-io.js";
import { readFileContentWithRetry, runGenerateDraft } from "./draft-service.js";

const DRAFT_TEXT = "# 第1章\n\n主角拿到账册，连夜翻看。\n";

function stubWriterClient(): WriterClient {
  return {
    generateDraft: vi.fn(async () => ({ title: "账册", content: DRAFT_TEXT })),
  };
}

describe("readFileContentWithRetry（L1 同口径 3×60ms 的原文回读）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("首次读不到、重试期间文件出现 → 读到原始全文（含标题行）", async () => {
    const path = join(projectDir!, "chapter-0001.md");
    const pending = readFileContentWithRetry(path, { retries: 3, delayMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path, DRAFT_TEXT, "utf-8");
    await expect(pending).resolves.toBe(DRAFT_TEXT);
  });

  it("彻底读不到 → 返回空串（调用方据此如实降级，不静默）", async () => {
    await expect(
      readFileContentWithRetry(join(projectDir!, "missing.md"), { retries: 3, delayMs: 1 }),
    ).resolves.toBe("");
  });
});

describe("runGenerateDraft D1 enforce 路回读降级（GLM P3 旧账④）", () => {
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

  it("落盘回读彻底失败 → ok:true 但执法跳过在 summary 如实留痕，绝不静默", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    // 故障注入：引擎报 passed 并给出 draftPath，但草稿根本没落盘 → 回读重试耗尽仍空。
    storyEngineMocks.runFastDraft.mockResolvedValue({
      chapter: 1,
      passed: true,
      draftPath,
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {},
      issues: [],
    });

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 1,
      writerClient: stubWriterClient(),
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });

    // 草稿「确已落盘」是引擎报告的口径，绝不因此谎报失败——但执法跳过必须留痕。
    expect(result.ok).toBe(true);
    expect(result.rejection).toBeUndefined();
    expect(result.summary).toContain("长度执法未执行");
    // 执法确实没跑（不是跑了但没留痕）。
    expect(storyEngineMocks.countDraftChineseCharacters).not.toHaveBeenCalled();
    // 回读为空沿用 A11 可见性提示（两件事各说各的，不合并、不互相遮盖）。
    expect(result.summary).toContain("正文已写盘，但本次未能载入到写作区显示");
    expect(result.http.draftContent).toBe("");
  }, 10_000);

  it("落盘回读正常 → 执法照常执行，summary 不带降级标注（行为不变）", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    storyEngineMocks.runFastDraft.mockImplementation(async () => {
      await mkdir(dirname(draftPath), { recursive: true });
      await writeFile(draftPath, DRAFT_TEXT, "utf-8");
      return {
        chapter: 1,
        passed: true,
        draftPath,
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: {},
        issues: [],
      };
    });

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 1,
      writerClient: stubWriterClient(),
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });

    expect(result.ok).toBe(true);
    // 执法真跑了（字数核对经 countCjkChars → 引擎 countDraftChineseCharacters）。
    expect(storyEngineMocks.countDraftChineseCharacters).toHaveBeenCalled();
    expect(result.summary).not.toContain("长度执法未执行");
    expect(result.draftBody).toBe("主角拿到账册，连夜翻看。");
    expect(result.http.draftContent).toContain("主角拿到账册");
  }, 10_000);
});
