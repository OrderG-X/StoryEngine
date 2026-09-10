// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft.ts 的 POST /api/draft/ai-review ↔ agent/tools/ai-review.ts 的 ai_review。
// 只读对拍：审稿两侧都不写盘，共用同一项目目录。审稿模型（draftReview 槽，流式 streamChatModelToText）
// 换成可编程桩——两侧共用同一个 mock，且两侧组出来的 prompt 应逐字一致（最强输入面锁定）。
//
// 已知刻意分歧（显式豁免清单；每条锁定现状并附代码证据）：
//   D17 无草稿：HTTP 路 readFile 直接抛 → 500；工具路 resolveDraftContentForQualityCheck 三处取稿皆空 →
//       ok:false + 诚实文案（ai-review.ts buildAIReviewToolOutput 的 hasRealDraft 分支）。
//   D18 模型失败/烂输出的 ok 契约：HTTP 路永远 200 ok:true，仅用 usedFallback 标志（draft.ts
//       handleDraftAIReview 的 catch → fallbackDraftAIReviewReport）；工具路 ok:false 显红
//       （ai-review.ts 的 ok:!usedFallback，注释「走回退=没真审成」）。
//   D19 explicit 正文信任度：HTTP 直接信 body.draftContent（draft.ts: readString(body.draftContent) ?? readFile）；
//       工具不信任模型给的正文、盘稿优先（ai-review.ts 复用 resolveDraftContentForQualityCheck 默认不 trust）。
//   D20 输出面：HTTP 多返回 model/profileId；工具多返回用户可见 summary。
import { beforeEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
  createConfiguredWriterClient: vi.fn(),
}));

vi.mock("../lib/llm-client.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/llm-client.js")>("../lib/llm-client.js");
  return { ...actual, ...llmMocks };
});

import { registerDraftRoutes } from "../routes/draft.js";
import { aiReviewTool } from "../agent/tools/ai-review.js";
import {
  callRoute,
  driveToolExecute,
  fakeResolvedChatModel,
  makeParityProject,
  PARITY_CLEAN_BODY,
  parityDraftFileText,
  writeParityDraft,
} from "./parity-kit.js";

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

interface ReviewLike {
  readonly verdict: string;
  readonly score: number;
  readonly summary: string;
  readonly issues: readonly { readonly id: string }[];
}

function lastStreamedPrompt(): string {
  const calls = llmMocks.streamChatModelToText.mock.calls;
  const input = calls[calls.length - 1]![0] as { messages: readonly { content: string }[] };
  return input.messages[0]!.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  llmMocks.resolveConfiguredChatModel.mockImplementation(async () => fakeResolvedChatModel("parity-review-model"));
  llmMocks.streamChatModelToText.mockResolvedValue({ content: VALID_REVIEW_JSON, thinking: "" });
  llmMocks.callOpenAICompatibleChatModel.mockResolvedValue({ content: "{}", raw: "{}", response: { ok: true, status: 200 } });
});

describe("parity: POST /api/draft/ai-review ↔ ai_review（共享行为面）", () => {
  it("happy path：同稿 + 同一 mock 审稿输出 → 报告等价，且两侧送进模型的 prompt 逐字一致", async () => {
    const projectDir = await makeParityProject("ai-review-happy-");
    await writeParityDraft(projectDir, 1, parityDraftFileText(1, PARITY_CLEAN_BODY));

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", { projectPath: projectDir, chapter: 1 });
    const routePrompt = lastStreamedPrompt();
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1 }, { projectDir });
    const toolPrompt = lastStreamedPrompt();

    // 输入面最强锁定：同一引擎/同一盘稿/同一上下文 → 两侧组出的审稿 prompt 逐字一致
    expect(toolPrompt).toBe(routePrompt);

    // ok 契约与审稿报告
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    const routeReview = route.payload.review as ReviewLike;
    const toolReview = tool.review as ReviewLike;
    expect(routeReview.verdict).toBe("ready_to_commit");
    expect(toolReview.verdict).toBe(routeReview.verdict);
    expect(toolReview.score).toBe(routeReview.score);
    expect(toolReview.summary).toBe(routeReview.summary);
    expect(route.payload.usedFallback).toBe(false);
    expect(tool.usedFallback).toBe(false);

    // D20（豁免清单·输出面）：HTTP 带 model/profileId；工具带用户可见 summary（含实测字数）。
    expect(route.payload.model).toBe("parity-review-model");
    expect(typeof route.payload.profileId).toBe("string");
    expect(String(tool.summary)).toContain("可以定稿");
    expect(String(tool.summary)).toMatch(/正文实际 \d+ 字/u);
    expect("model" in tool).toBe(false);

    // 只读：没写任何正式状态
    expect("review" in route.payload).toBe(true);
  });

  it("D18 模型吐烂输出：两侧都走同一 fallback 报告，但 HTTP ok:true（仅 usedFallback 标志）、工具 ok:false", async () => {
    const projectDir = await makeParityProject("ai-review-fallback-");
    await writeParityDraft(projectDir, 1, parityDraftFileText(1, PARITY_CLEAN_BODY));
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "（模型乱吐，没有 JSON）", thinking: "" });

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1 }, { projectDir });

    // 报告面一致：同一份 fallback（blocked + ai-review-format-error）
    const routeReview = route.payload.review as ReviewLike;
    const toolReview = tool.review as ReviewLike;
    expect(routeReview.verdict).toBe("blocked");
    expect(toolReview.verdict).toBe("blocked");
    expect(routeReview.issues[0]?.id).toBe("ai-review-format-error");
    expect(toolReview.issues[0]?.id).toBe("ai-review-format-error");
    expect(route.payload.usedFallback).toBe(true);
    expect(tool.usedFallback).toBe(true);

    // 分歧本身：同一失败，HTTP 200 ok:true；工具 ok:false（诚实显红）
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(false);
    expect(String(tool.summary)).toContain("审稿未完成");
  });

  it("D17 无草稿：HTTP 500（读不到草稿直接抛）；工具 ok:false + 「还没有可审的正文」", async () => {
    const projectDir = await makeParityProject("ai-review-nodraft-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1 }, { projectDir });

    // 共享语义：两侧都没审成
    expect(route.statusCode).toBe(500);
    expect(route.payload.ok).toBe(false);
    expect(tool.ok).toBe(false);
    expect(tool.usedFallback).toBe(true);
    expect(String(tool.summary)).toContain("还没有可审的正文");
    // 分歧：工具侧压根没调模型（诚实短路），HTTP 侧也没调到（抛在读稿）
    expect(llmMocks.streamChatModelToText).not.toHaveBeenCalled();
  });

  it("D19 explicit 正文信任度：同传与盘稿不同的正文 → HTTP 审传参稿；工具审盘稿", async () => {
    const projectDir = await makeParityProject("ai-review-trust-");
    const diskDraft = parityDraftFileText(1, PARITY_CLEAN_BODY);
    const marker = "墙角那台旧钟敲了三下，林远没有回头。";
    const explicitDraft = `${diskDraft}\n${marker}\n`;
    await writeParityDraft(projectDir, 1, diskDraft);

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", {
      projectPath: projectDir,
      chapter: 1,
      draftContent: explicitDraft,
    });
    const routePrompt = lastStreamedPrompt();
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1, draftContent: explicitDraft }, { projectDir });
    const toolPrompt = lastStreamedPrompt();

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // HTTP 信传参稿（含 marker）；工具信盘稿（不含 marker）
    expect(routePrompt).toContain(marker);
    expect(toolPrompt).not.toContain(marker);
    expect(toolPrompt).toContain(PARITY_CLEAN_BODY.slice(0, 30));
  });
});
