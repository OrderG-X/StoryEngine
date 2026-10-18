// @vitest-environment node
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { createStoryProject } from "@actalk/story-engine";
import { defaultDraftPath } from "../../lib/project-io.js";
import { buildProjectRequestContext } from "../request-context.js";
import { runCheckAiFlavorToolLogic, checkAiFlavorTool } from "./check-ai-flavor.js";

// Mock LLM client so execute() tests don't require a real model.
// 体检走流式（空闲超时、不设总上限）——故 mock streamChatModelToText，而非旧的阻塞式 callOpenAICompatibleChatModel。
const mockStream = vi.fn();
const mockCallOpenAI = vi.fn();
vi.mock("../../lib/llm-client.js", () => ({
  resolveConfiguredChatModel: vi.fn().mockResolvedValue({
    profile: { temperature: 0.3, maxTokens: 2600, timeoutMs: 30000 },
  }),
  streamChatModelToText: (...args: unknown[]) => mockStream(...args),
  callOpenAICompatibleChatModel: (...args: unknown[]) => mockCallOpenAI(...args),
}));

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "caf-"));
  const { projectDir } = await createStoryProject({ rootDir: root, title: "测试", genre: "都市", premise: "x", mainCharacterName: "林远" });
  await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
  await writeFile(defaultDraftPath(projectDir, 1), "# 第1章\n\n仿佛那一刻，他的心中五味杂陈。窗外下着雨。", "utf-8");
  return projectDir;
}

async function setupChapter5(projectDir: string): Promise<void> {
  await writeFile(defaultDraftPath(projectDir, 5), "# 第5章\n\n他站在窗前，心中涌起一股莫名的感慨。", "utf-8");
}

function ctx(projectDir: string, currentChapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, currentChapter) } as unknown as ToolExecutionContext;
}

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const execute = checkAiFlavorTool.execute as unknown as ToolExec;

describe("runCheckAiFlavorToolLogic", () => {
  it("读草稿+反AI规则→挑AI腔；只读(无 snapshotId/refreshScope)", async () => {
    const projectDir = await setup();
    const out = await runCheckAiFlavorToolLogic({
      projectDir, chapter: 1,
      callModel: async () => JSON.stringify({ summary: "一处", violations: [{ text: "仿佛那一刻，他的心中五味杂陈。", reason: "套路抒情", severity: "high", suggestedFix: "改具体动作" }] }),
    });
    expect(out.ok).toBe(true);
    expect(out.violations[0].text).toContain("五味杂陈");
    expect("snapshotId" in out).toBe(false);
    expect("refreshScope" in out).toBe(false);
  });
});

describe("check_ai_flavor 章号缺省回退", () => {
  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const projectDir = await setup();
    await setupChapter5(projectDir);
    // Mock LLM to return valid JSON referencing chapter 5 content
    mockStream.mockResolvedValue({
      content: JSON.stringify({ summary: "第5章体检完毕", violations: [] }),
    });
    const out = await execute({}, ctx(projectDir, 5)) as { ok: boolean; summary: string };
    // Should succeed (used chapter 5 draft, not chapter 1)
    expect(out.ok).toBe(true);
    expect(JSON.stringify(mockStream.mock.calls.at(-1))).toContain("心中涌起一股莫名的感慨");
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含『缺少章号』", async () => {
    const projectDir = await setup();
    await expect(execute({}, ctx(projectDir))).rejects.toThrow(/缺少章号/);
  });

  // 超时铁律（#1b 修）：体检走流式 streamChatModelToText（空闲超时、不设固定总上限），
  // 不再用阻塞式 callOpenAICompatibleChatModel + 固定 250s——否则代理把整段缓冲到底、SSE 全程静默、UI 冻死 120s+。
  it("execute 走流式、无固定总超时；不用阻塞式 callOpenAICompatibleChatModel", async () => {
    const projectDir = await setup();
    mockStream.mockClear();
    mockCallOpenAI.mockClear();
    mockStream.mockResolvedValue({ content: JSON.stringify({ summary: "ok", violations: [] }) });
    await execute({ chapter: 1 }, ctx(projectDir));
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockCallOpenAI).not.toHaveBeenCalled();
    expect(mockStream.mock.calls[0]?.[0]).not.toHaveProperty("timeoutMs");
  });
});
