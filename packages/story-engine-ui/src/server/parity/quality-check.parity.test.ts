// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft.ts 的 POST /api/draft/quality ↔ agent/tools/quality-check.ts 的 quality_check。
// 只读对拍：质检两侧都不写盘，共用同一项目目录（同一引擎 + 同一磁盘 → 同一确定性报告）。
// AI 判定层（judgeDraftQualityWithModel）换成确定性透传桩并记录入参——两条路共用同一个 judge 模块。
//
// 已知刻意分歧（显式豁免清单；每条锁定现状并附代码证据）：
//   D14 explicit 正文信任度：HTTP 路 trustExplicit:true（前端传的是编辑器实时正文，顶格优先，
//       draft.ts handleDraftQuality 的注释块）；工具路默认不信任模型给的正文、盘稿优先
//       （quality-check.ts resolveDraftContentForQualityCheck 的 trustExplicit 默认 false）。
//   D15 输出面：工具多一层 refineQualityReport 分层降噪（partialMiss/refined/summary/errorIssueCount）；
//       HTTP 路直接返回质检报告原文。
//   D16 无草稿：HTTP 路照常把空串喂给引擎（200 + 引擎 empty_draft 报告）；工具短路出专门的
//       「还没正文可质检」诚实输出（quality-check.ts buildNoDraftQualityOutput）。
import type { CommitQualityReport } from "@actalk/story-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

const judgeMocks = vi.hoisted(() => ({
  judgeDraftQualityWithModel: vi.fn(),
}));

vi.mock("../lib/quality-judge.js", () => ({
  judgeDraftQualityWithModel: judgeMocks.judgeDraftQualityWithModel,
}));

import { registerDraftRoutes } from "../routes/draft.js";
import { qualityCheckTool } from "../agent/tools/quality-check.js";
import {
  callRoute,
  driveToolExecute,
  makeParityProject,
  PARITY_CLEAN_BODY,
  parityDraftFileText,
  writeParityDraft,
} from "./parity-kit.js";

interface QualityIssueLike {
  readonly severity: string;
  readonly type: string;
}

beforeEach(() => {
  vi.clearAllMocks();
  judgeMocks.judgeDraftQualityWithModel.mockImplementation(
    async ({ deterministicQuality }: { readonly deterministicQuality: CommitQualityReport }) => ({
      ...deterministicQuality,
      modelJudge: { used: false, fallbackUsed: false, summary: "parity 桩：跳过 AI 判定。" },
    }),
  );
});

function issueTypes(payload: { readonly issues: readonly QualityIssueLike[] }): readonly string[] {
  return payload.issues.map((issue) => issue.type);
}

describe("parity: POST /api/draft/quality ↔ quality_check（共享行为面）", () => {
  it("干净稿：两侧 ok/passed 一致、判定层吃到的正文一致、报告一致；工具多 D15 分层输出", async () => {
    const projectDir = await makeParityProject("quality-clean-");
    const draft = parityDraftFileText(1, PARITY_CLEAN_BODY);
    await writeParityDraft(projectDir, 1, draft);

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/quality", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(qualityCheckTool, { chapter: 1 }, { projectDir });

    // ok 契约：质检跑完两侧都 ok:true
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);

    // 同一份盘稿进了同一判定桩（两侧判定层吃到的正文逐字一致）
    expect(judgeMocks.judgeDraftQualityWithModel).toHaveBeenCalledTimes(2);
    const routeJudgeInput = judgeMocks.judgeDraftQualityWithModel.mock.calls[0]![0] as { draftContent: string };
    const toolJudgeInput = judgeMocks.judgeDraftQualityWithModel.mock.calls[1]![0] as { draftContent: string };
    expect(toolJudgeInput.draftContent).toBe(routeJudgeInput.draftContent);
    expect(routeJudgeInput.draftContent).toBe(draft);

    // 报告一致（同一引擎同一盘稿 + 同一判定桩）→ passed 一致、error 数一致
    const routeQuality = route.payload.quality as { readonly passed: boolean; readonly issues: readonly QualityIssueLike[] };
    const toolQuality = tool.quality as { readonly passed: boolean; readonly issues: readonly QualityIssueLike[] };
    expect(toolQuality).toEqual(routeQuality);
    expect(routeQuality.passed).toBe(true);
    expect(tool.passed).toBe(true);
    expect(tool.partialMiss).toBe(false);
    expect(tool.errorIssueCount).toBe(routeQuality.issues.filter((issue) => issue.severity === "error").length);

    // D15（豁免清单）：工具多 refined 分层 + 用户可见 summary；HTTP 只有裸报告。
    expect(tool.refined).toBeTruthy();
    expect(String(tool.summary)).toContain("质检");
    expect("summary" in route.payload).toBe(false);
    expect("refined" in route.payload).toBe(false);
  });

  it("过短稿：确定性 error 两侧一致（都不通过），工具 partialMiss 显琥珀", async () => {
    const projectDir = await makeParityProject("quality-short-");
    await writeParityDraft(projectDir, 1, "# 第1章\n\n林远来了。\n");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/quality", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(qualityCheckTool, { chapter: 1 }, { projectDir });

    const routeQuality = route.payload.quality as { readonly passed: boolean; readonly issues: readonly QualityIssueLike[] };
    const toolQuality = tool.quality as { readonly passed: boolean; readonly issues: readonly QualityIssueLike[] };
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 同一确定性结论：都不通过、error 级问题类型集一致（too_short 命中）
    expect(routeQuality.passed).toBe(false);
    expect(tool.passed).toBe(false);
    expect(tool.partialMiss).toBe(true);
    expect(issueTypes(toolQuality)).toEqual(issueTypes(routeQuality));
    expect(issueTypes(routeQuality)).toContain("too_short");
    expect(tool.errorIssueCount).toBe(routeQuality.issues.filter((issue) => issue.severity === "error").length);
    expect(tool.errorIssueCount).toBeGreaterThan(0);
  });

  it("D16 无草稿：HTTP 把空串喂引擎照常出报告（empty_draft）；工具短路出专门的诚实输出", async () => {
    const projectDir = await makeParityProject("quality-empty-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/quality", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(qualityCheckTool, { chapter: 1 }, { projectDir });

    // 共享语义：两侧都「不通过」
    const routeQuality = route.payload.quality as { readonly passed: boolean; readonly issues: readonly QualityIssueLike[] };
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(routeQuality.passed).toBe(false);
    expect(tool.ok).toBe(true);
    expect(tool.passed).toBe(false);
    expect(tool.partialMiss).toBe(true);

    // 分歧本身：HTTP 的报告是引擎对空稿的 generic 判定；工具是专门的 draft_not_found_for_check + 中文诚实文案
    expect(issueTypes(routeQuality)).toContain("empty_draft");
    expect(issueTypes(tool.quality as { issues: readonly QualityIssueLike[] })).toContain("draft_not_found_for_check");
    expect(String(tool.summary)).toContain("还没有可质检的正文");
  });
});

describe("parity: quality_check 对拍——已知刻意分歧（豁免清单，断言锁定分歧存在）", () => {
  it("D14 explicit 正文信任度：同传与盘稿不同的正文 → HTTP 信传参（审新稿）；工具信盘稿（审旧稿）", async () => {
    const projectDir = await makeParityProject("quality-trust-");
    // 盘稿 A：带标题 + 对话的干净稿。显式正文 B：同正文但去掉标题行 → 触发 missing_chapter_title 警告。
    const draftA = parityDraftFileText(1, PARITY_CLEAN_BODY);
    const explicitB = PARITY_CLEAN_BODY;
    await writeParityDraft(projectDir, 1, draftA);

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/quality", {
      projectPath: projectDir,
      chapter: 1,
      draftContent: explicitB,
    });
    const tool = await driveToolExecute(qualityCheckTool, { chapter: 1, draftContent: explicitB }, { projectDir });

    // 判定桩吃到的正文：HTTP=B（编辑器实时稿可信）；工具=A（模型给的正文不可信、盘稿优先）
    const routeJudgeInput = judgeMocks.judgeDraftQualityWithModel.mock.calls[0]![0] as { draftContent: string };
    const toolJudgeInput = judgeMocks.judgeDraftQualityWithModel.mock.calls[1]![0] as { draftContent: string };
    expect(routeJudgeInput.draftContent).toBe(explicitB);
    expect(toolJudgeInput.draftContent).toBe(draftA);

    // 行为可观察：HTTP 的质检是对无标题的 B 跑的 → 带 missing_chapter_title；工具对 A 跑 → 不带
    const routeQuality = route.payload.quality as { readonly issues: readonly QualityIssueLike[] };
    const toolQuality = tool.quality as { readonly issues: readonly QualityIssueLike[] };
    expect(issueTypes(routeQuality)).toContain("missing_chapter_title");
    expect(issueTypes(toolQuality)).not.toContain("missing_chapter_title");
  });
});
