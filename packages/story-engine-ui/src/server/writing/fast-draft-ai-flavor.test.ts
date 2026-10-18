// @vitest-environment node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AiFlavorFrequencyGateRule, AiFlavorPatternRule } from "@actalk/story-core";
import { runFastDraft, type WriterClient } from "./fast-draft-writer.js";
import { createStoryProject } from "../book/project-store.js";

// 出稿回检挂接：规则数据由调用方传入，检测机器在核心 text/ai-flavor-detection（那边测机器本身）。
function patternRule(overrides: Partial<AiFlavorPatternRule> = {}): AiFlavorPatternRule {
  return {
    kind: "pattern",
    id: "shell-pattern",
    label: "壳句式",
    severity: "high",
    pattern: /不是[^，。！？\n]{1,12}，?而是/gu,
    reason: "测试用壳句式",
    suggestedFix: "拆成直述句",
    ...overrides,
  };
}

function gateRule(overrides: Partial<AiFlavorFrequencyGateRule> = {}): AiFlavorFrequencyGateRule {
  return {
    kind: "frequency_gate",
    id: "filler-flood",
    label: "弱化词扎堆",
    severity: "low",
    words: ["忽忽", "悠悠"],
    maxPerThousandChars: 3,
    minOccurrences: 4,
    reason: "测试用弱化词密度过高",
    suggestedFix: "删掉大部分弱化词",
    ...overrides,
  };
}

describe("runFastDraft · aiFlavorRules 回检挂接（warning-only）", () => {
  it("不传 aiFlavorRules → 报告无 aiFlavor 字段（旧调用方零行为变化）", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "无回检",
        content: "顾言不是在逃跑，而是在找一条出路。风很大。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试不传规则的向后兼容。",
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.aiFlavor).toBeUndefined();
    expect("aiFlavor" in report).toBe(false);
  });

  it("空规则数组 → 等同不传，报告无 aiFlavor 字段", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "空规则",
        content: "顾言起身走到窗边，外面下着雨。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试空规则数组。",
      writerClient,
      aiFlavorRules: [],
    });

    expect(report.passed).toBe(true);
    expect(report.aiFlavor).toBeUndefined();
  });

  it("传规则且命中 → aiFlavor diagnostics 出现，passed 不受影响、草稿照写（warning-only）", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "回检命中",
        content: "顾言不是在逃跑，而是在找一条出路。风很大。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试 AI 腔回检。",
      writerClient,
      aiFlavorRules: [patternRule()],
    });

    expect(report.passed).toBe(true); // high severity 命中也不拦稿、不进 issues、不触发重试
    expect(report.issues).toEqual([]);
    expect(report.draftBody).toBeDefined();
    expect(report.aiFlavor).toBeDefined();
    expect(report.aiFlavor?.total).toBe(1);
    expect(report.aiFlavor?.bySeverity).toEqual({ high: 1, medium: 0, low: 0 });
    expect(report.aiFlavor?.violations).toHaveLength(1);
    expect(report.aiFlavor?.violations[0]?.text).toBe("顾言不是在逃跑，而是在找一条出路。");
    expect(report.aiFlavor?.violations[0]?.ruleId).toBe("shell-pattern");
  });

  it("传规则但正文干净 → aiFlavor 出现、total 0（如实回报无命中）", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "干净稿",
        content: "顾言翻身下床，光脚踩在地板上走了两步，腰背有点酸。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试干净正文。",
      writerClient,
      aiFlavorRules: [patternRule()],
    });

    expect(report.passed).toBe(true);
    expect(report.aiFlavor).toEqual({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] });
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ai-flavor-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "回检测试书",
    genre: "悬疑",
    premise: "测试 AI 腔回检挂接。",
    mainCharacterName: "顾言",
  });
  return projectDir;
}
