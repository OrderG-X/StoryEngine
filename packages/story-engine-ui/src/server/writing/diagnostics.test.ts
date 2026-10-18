// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { recordContextStats, recordRuntimeLatency, recordTokenUsage, startRuntimeLatency, writeDiagnostics } from "./diagnostics.js";
import { runFastDraft, type WriterClient } from "./fast-draft-writer.js";
import { createStoryProject } from "../book/project-store.js";

describe("StoryEngine-NG Diagnostics", () => {
  it("records token usage without mutating the source object", () => {
    const source = { promptTokens: 120, completionTokens: 80, totalTokens: 200 };

    const usage = recordTokenUsage(source);

    expect(usage).toEqual({
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
    });
    expect(usage).not.toBe(source);
  });

  it("records runtime latency", () => {
    const timer = startRuntimeLatency(new Date("2026-05-14T00:00:00.000Z"));

    const latency = recordRuntimeLatency(timer, new Date("2026-05-14T00:00:01.250Z"));

    expect(latency).toEqual({
      startedAt: "2026-05-14T00:00:00.000Z",
      finishedAt: "2026-05-14T00:00:01.250Z",
      elapsedMs: 1250,
    });
  });

  it("records context stats with an isolated section list", () => {
    const source = {
      totalTokenEstimate: 300,
      stableTokenEstimate: 120,
      dynamicTokenEstimate: 180,
      contextSections: ["story_core", "chapter_goal"],
    };

    const stats = recordContextStats(source);

    expect(stats).toEqual(source);
    expect(stats.contextSections).not.toBe(source.contextSections);
  });

  it("writes diagnostics under the project diagnostics directory", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-diagnostics-"));

    const diagnostics = await writeDiagnostics(projectDir, {
      stage: "fast-draft",
      chapter: 9,
      generatedAt: "2026-05-14T00:00:00.000Z",
      runtimeLatency: {
        startedAt: "2026-05-14T00:00:00.000Z",
        finishedAt: "2026-05-14T00:00:00.010Z",
        elapsedMs: 10,
      },
    });

    expect(diagnostics.diagnosticsPath).toBe(join(projectDir, "diagnostics", "fast-draft-chapter-0009.json"));
    await expect(readFile(diagnostics.diagnosticsPath!, "utf-8")).resolves.toContain("\"stage\": \"fast-draft\"");
  });

  it("adds diagnostics to FastDraft reports and persists them", async () => {
    const projectDir = await createFixtureProject("story-engine-diagnostics-fast-");
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "开局",
        content: "Guo Xu 收起账册，决定先查矿藏库房。",
        tokenUsage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角决定查账。",
      writerClient,
    });

    const diagnostics = report.diagnostics;
    expect(diagnostics).toBeDefined();
    expect(diagnostics).toMatchObject({
      stage: "fast-draft",
      chapter: 1,
      tokenUsage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      contextStats: report.contextStats,
    });
    expect(diagnostics!.runtimeLatency.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics!.diagnosticsPath).toBe(join(projectDir, "diagnostics", "fast-draft-chapter-0001.json"));
    await expect(readFile(diagnostics!.diagnosticsPath!, "utf-8")).resolves.toContain("\"stage\": \"fast-draft\"");
  });

});

async function createFixtureProject(prefix: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "我的修仙副本",
    genre: "xianxia",
    premise: "用户自己当主角，从杂役弟子开始逆袭。",
    mainCharacterName: "Guo Xu / 主角",
  });
  return projectDir;
}
