// @vitest-environment node
/**
 * draft-service 出稿小件的回归锁：自动去味一轮只在内存里改（写作版本 P1b），由出稿操作最后一次换上工作稿。
 * 出稿主流程是 draft.change 操作，测试在 operations/recipes/draft-change.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storyEngineMocks = vi.hoisted(() => ({
  detectAiFlavorViolations: vi.fn(() => ({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] })),
}));
vi.mock("@actalk/story-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectAiFlavorViolations: storyEngineMocks.detectAiFlavorViolations,
}));
vi.mock("./de-ai-flavor-batch.js", () => ({
  runDeAiFlavorBatch: vi.fn(),
}));

import { runDeAiFlavorBatch } from "./de-ai-flavor-batch.js";
import { runAutoDeAiRound } from "./draft-service.js";

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
