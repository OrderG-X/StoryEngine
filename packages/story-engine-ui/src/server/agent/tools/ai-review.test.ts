// @vitest-environment node
//
// ai_review 纯逻辑单测：薄适配层 + 共享 services/review-service.ts 编排（进程内）。
// checkDraftBeforeCommit → buildDraftAIReviewPrompt → callModel → parseDraftAIReviewReport，
// 模型不可用时走 fallbackDraftAIReviewReport（不抛、诚实标 blocked）。
// 只读：不建快照、不带 snapshotId / refreshScope。callModel 注入 mock，引擎读取走 fixture。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock LLM client（给 execute 层的 chapter 回退测试用；不影响 buildAIReviewToolOutput 用例）
// 审稿走流式 streamChatModelToText（空闲超时、不设总上限），故 mock 它而非旧的一次性 callOpenAICompatibleChatModel。
const { streamChatModelToText, resolveConfiguredChatModel } = vi.hoisted(() => ({
  streamChatModelToText: vi.fn(),
  resolveConfiguredChatModel: vi.fn(),
}));
vi.mock("../../lib/llm-client.js", () => ({ streamChatModelToText, resolveConfiguredChatModel }));

import { defaultDraftPath } from "../../lib/project-io.js";
import { buildProjectRequestContext } from "../request-context.js";
import { aiReviewTool, buildAIReviewToolOutput } from "./ai-review.js";

async function makeProject(title: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "ai-review-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName: "林远",
  });
  return projectDir;
}

function longDraft(chapter: number): string {
  const sentence = "林远在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。";
  return `# 第${chapter}章\n\n${Array.from({ length: 12 }, () => sentence).join("")}\n`;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(defaultDraftPath(projectDir, chapter), content, "utf-8");
}

const VALID_REVIEW_JSON = JSON.stringify({
  passed: true,
  score: 82,
  verdict: "ready_to_commit",
  summary: "整体连贯，可入库。",
  strengths: ["节奏稳"],
  issues: [],
  suggestedRevisions: [],
  continuityNotes: [],
  styleNotes: [],
  characterNotes: [],
  pacingNotes: [],
  readerHookNotes: [],
  shouldCommit: true,
  blockingReasons: [],
});

describe("ai_review 只读审稿工具", () => {
  it("模型返回合规 JSON → 解析成审稿报告，只读不带 snapshotId", async () => {
    const projectDir = await makeProject("审稿");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildAIReviewToolOutput({
      projectDir,
      chapter: 1,
      callModel: async () => VALID_REVIEW_JSON,
    });
    expect(out.review.verdict).toBe("ready_to_commit");
    expect(out.review.shouldCommit).toBe(true);
    expect(out.usedFallback).toBe(false);
    expect(out.ok).toBe(true); // A5：真审成 → ok=true（显绿名副其实）
    expect("snapshotId" in out).toBe(false);
    expect("refreshScope" in out).toBe(false);
    expect(out.summary).toContain("可以定稿");
    expect(out.summary).toMatch(/正文实际 \d+ 字/);
  });

  it("审稿 prompt 注入服务端实测字数，禁止模型瞎估（dogfood 问题 10）", async () => {
    const projectDir = await makeProject("审稿字数");
    const draft = longDraft(1);
    await writeDraft(projectDir, 1, draft);
    let seenPrompt = "";
    await buildAIReviewToolOutput({
      projectDir,
      chapter: 1,
      callModel: async (prompt) => {
        seenPrompt = prompt;
        return VALID_REVIEW_JSON;
      },
    });
    expect(seenPrompt).toContain("【服务端计量·禁止估算】");
    expect(seenPrompt).toContain("正文实际");
    expect(seenPrompt).toContain("禁止自行估计");
  });

  it("模型抛错 → 走 fallback 审稿报告（verdict=blocked），不抛、诚实标 usedFallback", async () => {
    const projectDir = await makeProject("回退");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildAIReviewToolOutput({
      projectDir,
      chapter: 1,
      callModel: async () => {
        throw new Error("模型超时");
      },
    });
    expect(out.review.verdict).toBe("blocked");
    expect(out.usedFallback).toBe(true);
    expect(out.ok).toBe(false); // A5：走回退=没真审成 → ok=false（显红，不再假装绿）
    expect(out.review.shouldCommit).toBe(false);
  });

  it("模型返回非法内容 → 解析失败也走 fallback，不抛", async () => {
    const projectDir = await makeProject("非法");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildAIReviewToolOutput({
      projectDir,
      chapter: 1,
      callModel: async () => "这不是 JSON",
    });
    expect(out.review.verdict).toBe("blocked");
    expect(out.usedFallback).toBe(true);
  });

  // 模型无关·孪生 bug（与 quality_check 同源）：模型多塞 `draftContent:""` 或文件暂空/占位时，
  // 旧 `?? readFile` 会审一份空稿并 ok:true 谎报「审了」。修后：忽略空显式、取盘上真稿；真没稿不审空稿。
  it("模型多塞空 draftContent、但盘上有真稿 → 用盘上真稿审，不审空稿", async () => {
    const projectDir = await makeProject("空显式回落读盘");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildAIReviewToolOutput({
      projectDir,
      chapter: 1,
      draftContent: "", // 模型凭空塞的空串
      callModel: async () => VALID_REVIEW_JSON,
      delayMs: 0,
    });
    expect(out.usedFallback).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.review.verdict).toBe("ready_to_commit");
  });

  it("三处都没真稿 → 诚实回报「还没正文可审」，不审空稿谎报（绝不调模型）", async () => {
    const projectDir = await makeProject("真没草稿");
    await writeDraft(projectDir, 1, ""); // 空文件、workspace 也没真稿
    const callModel = vi.fn(async () => VALID_REVIEW_JSON);
    const out = await buildAIReviewToolOutput({ projectDir, chapter: 1, callModel, delayMs: 0 });
    expect(out.ok).toBe(false);
    expect(out.usedFallback).toBe(true);
    expect(out.summary).toContain("还没");
    expect(out.review.shouldCommit).toBe(false);
    expect(callModel).not.toHaveBeenCalled(); // 没真稿绝不审空稿
  });
});

// --- execute 章号回退测试（H3：LLM 没给章号时用 context.currentChapter）---

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const execute = aiReviewTool.execute as unknown as ToolExec;

function ctx(projectDir: string, currentChapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, currentChapter) } as unknown as ToolExecutionContext;
}

describe("ai_review execute 章号缺省回退（H3）", () => {
  beforeEach(() => {
    resolveConfiguredChatModel.mockResolvedValue({ profile: {} });
    streamChatModelToText.mockResolvedValue({ content: VALID_REVIEW_JSON, thinking: "" });
  });

  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const projectDir = await makeProject("回退章5");
    await writeDraft(projectDir, 5, longDraft(5));

    const out = await execute({}, ctx(projectDir, 5)) as { chapter: number; summary: string };
    expect(out.chapter).toBe(5);
    expect(out.summary).toContain("第 5 章");
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含「缺少章号」", async () => {
    const projectDir = await makeProject("缺章号");
    await expect(execute({}, ctx(projectDir))).rejects.toThrow(/缺少章号/);
  });
});
