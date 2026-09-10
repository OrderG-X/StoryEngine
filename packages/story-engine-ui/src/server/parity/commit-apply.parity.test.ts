// @vitest-environment node
//
// 双轨对拍（parity）：routes/commit.ts 的 POST /api/commit/apply ↔ agent/tools/commit-apply.ts 的 commit_apply。
// 写盘对拍：双胞胎 fixture（route/tool 各一个同种子项目），比较落盘结果与关键输出字段。
//
// 两侧的「先预览后入库」门禁机制不同但语义对齐（都是本测试锁定的共享面）：
//   HTTP 路：预览发 transactionId+previewHash，apply 重算比对（validateCommitApplyPreflight），
//            另有幂等键持久回执（.story-engine-ui/commit-idempotency/）。
//   工具路：预览登记内存票据（commit-preview-store），apply 校验同章+草稿哈希未变（verifyCommitPreview）。
//
// 已知刻意分歧（显式豁免清单；每条锁定现状并附代码证据）：
//   D10 重放保护机制不同：HTTP 靠持久回执重放（idempotencyReplayed）；工具靠 A7 已入库幂等探测
//       （commit-apply.ts detectAlreadyCommittedDuplicate）——同一份草稿重复入库，两侧都 ok:true 且不重复写入。
//   D11 入库后搭车：工具 execute 在成功后抽硬事实+新人物提示（commit-apply.ts run 的 extractAndAppendFacts 段，
//       本测试 mock 成空）；HTTP 路无此步骤。
//   D12 失败摘要消毒：工具对引擎 issues 做裸 id/路径消毒（commit-apply.ts scrubBareEntityIdsFromText）；
//       HTTP 路原样返回 report/issues。本文件未触发引擎失败路径，仅在此登记。
//   D13 输出面：HTTP 返回 chapterContent/chapterTitle，不回传 snapshotId；工具返回 draftBody/draftTitle + snapshotId。
import { readFile } from "node:fs/promises";
import type { CommitQualityReport } from "@actalk/story-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));

vi.mock("../lib/llm-client.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/llm-client.js")>("../lib/llm-client.js");
  return { ...actual, ...llmMocks };
});

const judgeMocks = vi.hoisted(() => ({
  judgeDraftQualityWithModel: vi.fn(),
}));

vi.mock("../lib/quality-judge.js", () => ({
  judgeDraftQualityWithModel: judgeMocks.judgeDraftQualityWithModel,
}));

// 入库后抽硬事实是工具路的非致命搭车步骤（会真连 LLM），与 commit-apply.test.ts 同款 mock 掉；
// 被对拍的入库主逻辑不经过它。
vi.mock("../agent/fact-ledger/fact-ledger.js", () => ({
  extractAndAppendFacts: vi.fn(async () => ({ ok: true, added: 0, summary: "", newCharacters: [] })),
}));

import { registerCommitRoutes } from "../routes/commit.js";
import { commitApplyTool } from "../agent/tools/commit-apply.js";
import { commitPreviewTool } from "../agent/tools/commit-preview.js";
import { __resetCommitPreviewStore } from "../agent/tools/commit-preview-store.js";
import {
  callRoute,
  defaultCommittedChapterPath,
  defaultDraftPath,
  driveToolExecute,
  fakeResolvedChatModel,
  makeParityTwinProjects,
  parityCommitDraft,
  pathExists,
  readTextIfExists,
  stripLeadingMarkdownChapterHeading,
  writeParityDraft,
} from "./parity-kit.js";

interface CommitReportLike {
  readonly passed: boolean;
  readonly updatedCharacters: readonly string[];
  readonly timelineEventIds: readonly string[];
  readonly updatedHooks: readonly string[];
  readonly issues: readonly string[];
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCommitPreviewStore();
  llmMocks.resolveConfiguredChatModel.mockImplementation(async () => fakeResolvedChatModel());
  // 声明模型吐非 JSON → 预览声明降级 undefined（两侧同为引擎正则路径，计划同构）。
  llmMocks.callOpenAICompatibleChatModel.mockResolvedValue({
    content: "（声明模型乱吐，没有 JSON）",
    raw: "",
    response: { ok: true, status: 200 },
  });
  llmMocks.streamChatModelToText.mockResolvedValue({ content: "", thinking: "" });
  judgeMocks.judgeDraftQualityWithModel.mockImplementation(
    async ({ deterministicQuality }: { readonly deterministicQuality: CommitQualityReport }) => deterministicQuality,
  );
});

async function seedTwinDrafts(prefix: string, draft: string): Promise<{ readonly routeDir: string; readonly toolDir: string }> {
  const twin = await makeParityTwinProjects(prefix);
  await writeParityDraft(twin.routeDir, 1, draft);
  await writeParityDraft(twin.toolDir, 1, draft);
  return twin;
}

/** HTTP 路完整流：预览拿凭证 → apply。返回 apply 响应。 */
async function routePreviewThenApply(projectDir: string, idempotencyKey: string) {
  const preview = await callRoute(registerCommitRoutes, "POST", "/api/commit/preview", { projectPath: projectDir, chapter: 1 });
  expect(preview.payload.ok).toBe(true);
  return callRoute(registerCommitRoutes, "POST", "/api/commit/apply", {
    projectPath: projectDir,
    chapter: 1,
    transactionId: preview.payload.transactionId,
    previewHash: preview.payload.previewHash,
    idempotencyKey,
  });
}

/** 工具路完整流：预览登记票据 → apply（省略 token，系统用最近预览票据）。 */
async function toolPreviewThenApply(projectDir: string) {
  const preview = await driveToolExecute(commitPreviewTool, { chapter: 1 }, { projectDir });
  expect(preview.ok).toBe(true);
  return driveToolExecute(commitApplyTool, { chapter: 1 }, { projectDir });
}

describe("parity: POST /api/commit/apply ↔ commit_apply（共享行为面）", () => {
  it("happy path：预览→入库 → 两侧 ok/committed，chapters/0001.md 字节一致，引擎报告核心字段一致", async () => {
    const { routeDir, toolDir } = await seedTwinDrafts("commit-apply-happy-", parityCommitDraft(1));

    const route = await routePreviewThenApply(routeDir, "parity-apply-happy-1");
    const tool = await toolPreviewThenApply(toolDir);

    // ok 契约
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(tool.committed).toBe(true);
    expect(tool.refused).toBe(false);

    // 落盘状态：正式章节文件两侧字节一致；草稿去向两侧一致（引擎同一 commitFastDraft）
    const routeChapter = await readFile(defaultCommittedChapterPath(routeDir, 1), "utf-8");
    const toolChapter = await readFile(defaultCommittedChapterPath(toolDir, 1), "utf-8");
    expect(toolChapter).toBe(routeChapter);
    const routeDraftAfter = await readTextIfExists(defaultDraftPath(routeDir, 1));
    const toolDraftAfter = await readTextIfExists(defaultDraftPath(toolDir, 1));
    expect(toolDraftAfter).toBe(routeDraftAfter);

    // 引擎入库报告核心字段一致（chapterPath 是绝对路径、必然不同，不参与对拍）
    const routeReport = route.payload.report as CommitReportLike;
    const toolReport = tool.report as CommitReportLike;
    expect(routeReport.passed).toBe(true);
    expect(toolReport.passed).toBe(true);
    expect(toolReport.updatedCharacters).toEqual(routeReport.updatedCharacters);
    expect(toolReport.timelineEventIds).toEqual(routeReport.timelineEventIds);
    expect(toolReport.updatedHooks).toEqual(routeReport.updatedHooks);
    expect(toolReport.issues).toEqual(routeReport.issues);

    // 关键输出字段：两侧都把入库正文/标题回传给前端（HTTP: chapterContent/chapterTitle；工具: draftBody/draftTitle）
    expect(route.payload.chapterContent).toBe(routeChapter);
    expect(route.payload.chapterTitle).toBe("第1章");
    // 工具回传的是去 Markdown 标题的正文（供前端 committed 态载入）；HTTP 回传章节文件全文。
    expect(tool.draftBody).toBe(stripLeadingMarkdownChapterHeading(routeChapter).trim());
    expect(tool.draftTitle).toBeUndefined(); // 「# 第1章」是通用标题，extractDraftTitle 抽不出 → 省略
    expect(route.payload.overview).toBeTruthy();
    expect(tool.overview).toBeTruthy();

    // D13（豁免清单·快照透出）：工具回传 snapshotId（writeTool 快照包装）；HTTP 路建了快照但不回传 id。
    expect(typeof tool.snapshotId).toBe("string");
    expect("snapshotId" in route.payload).toBe(false);
    expect(await pathExists(`${routeDir}/.git`)).toBe(true);
    expect(await pathExists(`${toolDir}/.git`)).toBe(true);
  });

  it("未预览直接入库：两侧都拒绝且都不落正式章（HTTP 409 缺凭证；工具 refused 无预览票据）", async () => {
    const { routeDir, toolDir } = await seedTwinDrafts("commit-apply-noguard-", parityCommitDraft(1));

    const route = await callRoute(registerCommitRoutes, "POST", "/api/commit/apply", {
      projectPath: routeDir,
      chapter: 1,
      idempotencyKey: "parity-apply-noguard-1",
    });
    const tool = await driveToolExecute(commitApplyTool, { chapter: 1 }, { projectDir: toolDir });

    expect(route.statusCode).toBe(409);
    expect(route.payload.ok).toBe(false);
    expect(route.payload.reason).toBe("formal_commit_apply_transaction_preflight_failed");

    expect(tool.ok).toBe(false);
    expect(tool.committed).toBe(false);
    expect(tool.refused).toBe(true);
    expect(String(tool.refusalReason)).toContain("commit_preview");

    expect(await pathExists(defaultCommittedChapterPath(routeDir, 1))).toBe(false);
    expect(await pathExists(defaultCommittedChapterPath(toolDir, 1))).toBe(false);
  });

  it("预览后草稿被改：两侧都拒绝（HTTP preview_hash_mismatch；工具 draft_changed_since_preview）", async () => {
    const { routeDir, toolDir } = await seedTwinDrafts("commit-apply-stale-", parityCommitDraft(1));

    const routePreview = await callRoute(registerCommitRoutes, "POST", "/api/commit/preview", { projectPath: routeDir, chapter: 1 });
    const toolPreview = await driveToolExecute(commitPreviewTool, { chapter: 1 }, { projectDir: toolDir });
    expect(routePreview.payload.ok).toBe(true);
    expect(toolPreview.ok).toBe(true);

    // 预览之后草稿被改动（两侧改成同一份新稿）
    const changedDraft = parityCommitDraft(1).replaceAll("会议室外", "审计楼外");
    await writeParityDraft(routeDir, 1, changedDraft);
    await writeParityDraft(toolDir, 1, changedDraft);

    const route = await callRoute(registerCommitRoutes, "POST", "/api/commit/apply", {
      projectPath: routeDir,
      chapter: 1,
      transactionId: routePreview.payload.transactionId,
      previewHash: routePreview.payload.previewHash,
      idempotencyKey: "parity-apply-stale-1",
    });
    const tool = await driveToolExecute(commitApplyTool, { chapter: 1 }, { projectDir: toolDir });

    expect(route.statusCode).toBe(409);
    expect(route.payload.ok).toBe(false);
    expect(route.payload.reason).toBe("formal_commit_apply_transaction_preflight_failed");

    expect(tool.ok).toBe(false);
    expect(tool.committed).toBe(false);
    expect(tool.refused).toBe(true);
    expect(String(tool.refusalReason)).toContain("预览之后又改动过");

    expect(await pathExists(defaultCommittedChapterPath(routeDir, 1))).toBe(false);
    expect(await pathExists(defaultCommittedChapterPath(toolDir, 1))).toBe(false);
  });

  it("D10 重复入库：同一预览凭证+同一草稿再 apply → 两侧都幂等回报 ok，不重复写入", async () => {
    const { routeDir, toolDir } = await seedTwinDrafts("commit-apply-replay-", parityCommitDraft(1));

    // HTTP 侧：同 transactionId/previewHash/idempotencyKey 连打两次
    const preview = await callRoute(registerCommitRoutes, "POST", "/api/commit/preview", { projectPath: routeDir, chapter: 1 });
    const applyBody = {
      projectPath: routeDir,
      chapter: 1,
      transactionId: preview.payload.transactionId,
      previewHash: preview.payload.previewHash,
      idempotencyKey: "parity-apply-replay-1",
    };
    const first = await callRoute(registerCommitRoutes, "POST", "/api/commit/apply", applyBody);
    const chapterAfterFirst = await readFile(defaultCommittedChapterPath(routeDir, 1), "utf-8");
    const second = await callRoute(registerCommitRoutes, "POST", "/api/commit/apply", applyBody);
    const chapterAfterSecond = await readFile(defaultCommittedChapterPath(routeDir, 1), "utf-8");

    expect(first.payload.ok).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.payload.ok).toBe(true);
    // HTTP 路的幂等标记：持久回执重放（idempotencyReplayed）
    expect(second.payload.idempotencyReplayed).toBe(true);
    expect(chapterAfterSecond).toBe(chapterAfterFirst);

    // 工具侧：token 已被首次消费，第二次靠 A7 幂等探测（已入库且正文一致）回报「此前已定稿」
    await driveToolExecute(commitPreviewTool, { chapter: 1 }, { projectDir: toolDir });
    const toolFirst = await driveToolExecute(commitApplyTool, { chapter: 1 }, { projectDir: toolDir });
    const toolChapterAfterFirst = await readFile(defaultCommittedChapterPath(toolDir, 1), "utf-8");
    const toolSecond = await driveToolExecute(commitApplyTool, { chapter: 1 }, { projectDir: toolDir });
    const toolChapterAfterSecond = await readFile(defaultCommittedChapterPath(toolDir, 1), "utf-8");

    expect(toolFirst.committed).toBe(true);
    expect(toolSecond.ok).toBe(true);
    expect(toolSecond.committed).toBe(true);
    expect(String(toolSecond.summary)).toContain("重复请求");
    expect(toolChapterAfterSecond).toBe(toolChapterAfterFirst);

    // 两轨入库结果仍一致
    expect(toolChapterAfterFirst).toBe(chapterAfterFirst);
  });
});
