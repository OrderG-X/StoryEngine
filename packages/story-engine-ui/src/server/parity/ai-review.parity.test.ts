// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft.ts 的 POST /api/draft/ai-review ↔ agent/tools/ai-review.ts 的 ai_review。
// 只读对拍：审稿两侧都不写盘，共用同一项目目录。审稿模型（draftReview 槽，流式 streamChatModelToText）
// 换成可编程桩——两侧共用同一个 mock，且两侧组出来的 prompt 应逐字一致（最强输入面锁定）。
//
// 双轨合一后：编排已收进 services/review-service.ts（runDraftAIReview），route/tool 均为薄适配。
// 已收敛（不再是分歧，见对应用例的共享语义断言）：
//   D17 无草稿：两侧同走 service 的「三处取稿皆空 → no_draft 诚实短路、绝不审空稿」；差异只剩适配层
//       渲染——HTTP 保持 500 状态码兼容 + ok:false + error 文案，工具 ok:false + summary；
//       两侧文案逐字一致（同一 canonical summary）。
//   D18 模型失败/烂输出的 ok 契约：canonical result 一律 ok:!usedFallback（走回退=没真审成）。
//       HTTP 路从「永远 200 ok:true 仅靠 usedFallback 标志」收敛为 200 + ok:false + 诚实 error
//       （刻意修复：前端 reviewDraftWithAI 对 ok:false 走 throw → handleDraftAIReview catch →
//       failAgentFlow 红卡，该失败路径本有测试覆盖；不再渲染「审稿完成：被阻止」的假完成卡，
//       与工具侧治 A5 同方向）。工具侧行为不变：ok:false 显红。
// 剩余已知刻意分歧（显式豁免清单；均为显式策略参数或适配层投影）：
//   D19 explicit 正文信任度 → service 的 trustExplicit 策略参数：HTTP 传 true（信 body.draftContent
//       编辑器实时稿，draft.ts handleDraftAIReview）；工具默认 false（不信模型给的正文、盘稿优先，
//       ai-review.ts buildAIReviewToolOutput 不传即默认）。
//   D20 输出面：HTTP 多返回 model/profileId（canonical result 携带、路由投影）；工具多返回用户可见
//       summary（同一 canonical summary，HTTP 只在 ok:false 时借作 error 文案）。
//   D32 deterministicQuality 预传通道【HTTP 独有入参·登记补漏】：前端可预传确定性质检结果省一轮重算
//       （draft.ts handleDraftAIReview 读 body.deterministicQuality）；工具入参面无此字段，service
//       缺省现跑 checkDraftBeforeCommit（与正确预传同源：同一引擎同一盘稿的确定性结果）。结构性输入面
//       分歧，对拍面不带该参，只登记。
//
// 2026-09-11 收敛与加固：
//   - P1-5 chapterGoal/userDirection 归一【已收敛】：trim + 空白→undefined 收进 review-service 单点，
//     路由侧只做类型守卫透传（原：路由 readString trim / 工具 z.string() 原样，同一输入两侧 prompt
//     真实不同）。下方两个用例锁定（带参对拍 + 空白等价于不传）。
//   - 磁盘 IO 重（真引擎建项目）：全部用例给显式 timeout（CLAUDE.md 纪律）。
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
  it("happy path：同稿 + 同一 mock 审稿输出 → 报告等价，且两侧送进模型的 prompt 逐字一致", { timeout: 30_000 }, async () => {
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

  it("D18 已收敛·模型吐烂输出：两侧同一 fallback、都 ok:false 诚实显红（HTTP 200 + error，工具 summary）", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("ai-review-fallback-");
    await writeParityDraft(projectDir, 1, parityDraftFileText(1, PARITY_CLEAN_BODY));
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "（模型乱吐，没有 JSON）", thinking: "" });

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1 }, { projectDir });

    // 收敛后的共享语义：同一失败 → 两侧都「没真审成」ok:false；fallback 报告（blocked +
    // ai-review-format-error）仍在 canonical result 里（工具侧透出；HTTP 侧不再把它伪装成完成结果返回）。
    const toolReview = tool.review as ReviewLike;
    expect(toolReview.verdict).toBe("blocked");
    expect(toolReview.issues[0]?.id).toBe("ai-review-format-error");
    expect(tool.usedFallback).toBe(true);

    // HTTP 状态码保持 200 兼容，但 ok 字段诚实 false（前端 ok:false → throw → 失败红卡，已有测试覆盖）；
    // 两侧失败文案逐字一致（同一 canonical summary，HTTP 借作 error）。
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("内容审阅未完成");
    expect(route.payload.error).toBe(tool.summary);
    expect(route.payload.review).toBeUndefined();
    expect(tool.ok).toBe(false);
    expect(String(tool.summary)).toContain("内容审阅未完成");
  });

  it("D17 已收敛·无草稿：两侧同一 no_draft 诚实短路（HTTP 保持 500 兼容 + ok:false；工具 ok:false），都不调模型", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("ai-review-nodraft-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1 }, { projectDir });

    // 共享语义：两侧都没审成、文案逐字一致（同一 canonical summary）；差异只剩适配层状态码/字段。
    expect(route.statusCode).toBe(500);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("还没有可审的正文");
    expect(route.payload.error).toBe(tool.summary);
    expect(tool.ok).toBe(false);
    expect(tool.usedFallback).toBe(true);
    expect(String(tool.summary)).toContain("还没有可审的正文");
    // 两侧都没调到模型（service 短路在读稿，绝不审空稿）
    expect(llmMocks.streamChatModelToText).not.toHaveBeenCalled();
  });

  it("D19 explicit 正文信任度：同传与盘稿不同的正文 → HTTP 审传参稿；工具审盘稿", { timeout: 30_000 }, async () => {
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

  it("P1-5 已收敛·chapterGoal/userDirection 归一：两侧同传带空白变体 → prompt 逐字一致、trim 后文本进 prompt", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("ai-review-normalize-");
    await writeParityDraft(projectDir, 1, parityDraftFileText(1, PARITY_CLEAN_BODY));

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "  围绕账册推进  ",
      userDirection: "  加冲突  ",
    });
    const routePrompt = lastStreamedPrompt();
    const tool = await driveToolExecute(
      aiReviewTool,
      { chapter: 1, chapterGoal: "  围绕账册推进  ", userDirection: "  加冲突  " },
      { projectDir },
    );
    const toolPrompt = lastStreamedPrompt();

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 归一收敛点：两侧带空白变体送进模型的 prompt 逐字一致（收敛前：路由 trim、工具原样透传 → 不同）
    expect(toolPrompt).toBe(routePrompt);
    expect(routePrompt).toContain("围绕账册推进");
    expect(routePrompt).toContain("加冲突");
    // 带空白的原始串若原样透传会逐字出现在 prompt 里——两侧都不得出现
    expect(routePrompt).not.toContain("  围绕账册推进  ");
    expect(routePrompt).not.toContain("  加冲突  ");
  });

  it("P1-5 已收敛·空白→undefined：两侧同传纯空白 chapterGoal/userDirection → prompt 与不传逐字一致", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("ai-review-blank-");
    await writeParityDraft(projectDir, 1, parityDraftFileText(1, PARITY_CLEAN_BODY));

    // 基线：两侧都不带这两个参
    const baselineRoute = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", { projectPath: projectDir, chapter: 1 });
    const baselinePrompt = lastStreamedPrompt();
    expect(baselineRoute.payload.ok).toBe(true);

    // 路由带纯空白（原样透传给 service 归一）
    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/ai-review", {
      projectPath: projectDir,
      chapter: 1,
      chapterGoal: "   ",
      userDirection: "  ",
    });
    const routeBlankPrompt = lastStreamedPrompt();
    // 工具带纯空白（z.string() 原样进 service 归一）
    const tool = await driveToolExecute(aiReviewTool, { chapter: 1, chapterGoal: "   ", userDirection: "  " }, { projectDir });
    const toolBlankPrompt = lastStreamedPrompt();

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(routeBlankPrompt).toBe(baselinePrompt);
    expect(toolBlankPrompt).toBe(baselinePrompt);
  });
});
