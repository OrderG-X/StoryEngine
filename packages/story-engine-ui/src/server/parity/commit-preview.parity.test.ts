// @vitest-environment node
//
// 双轨对拍（parity）：routes/commit.ts 的 POST /api/commit/preview ↔ agent/tools/commit-preview.ts 的 commit_preview。
// 只读对拍：预览两侧都不写盘（工具侧只把 previewToken 记进内存 store），故两侧共用同一项目目录，
// 保证引擎读到完全相同的磁盘状态——这是对「同一引擎同一 fixture → 同一计划」的最强锁定。
//
// 双轨合一后：编排已收进 services/commit-service.ts（runCommitPreview），route/tool 均为薄适配。
// 原已知刻意分歧全部落成 service 的显式策略参数或适配层投影（不再是编排漂移）：
//   D6 AI 质检判定 → service 的 judge 注入参数（对齐 quality-service 先例）：HTTP 预览用默认
//      judgeDraftQualityWithModel（草稿+语义各跑一次，本文件 mock 计数锁定 =2）；工具预览注入
//      确定性透传桩、不调判定模型（commit-preview.ts buildCommitPreviewToolOutput 的 judge 实参）。
//   D7 章节语义声明 → service 的 declarationChannel 显式参数：工具路带通道（声明模型经
//      declareChapterDelta 产出声明喂 buildCommitPlanFromProject，声明随 previewToken 缓存进工具
//      store 供 apply 复用——登记在 commit-preview.ts 适配层）；HTTP 预览不传通道=空声明（纯正则计划）。
//      声明模型降级（乱吐→undefined）时两侧计划输入同源，下方照妖镜断言入库计划深相等。
//   D8 缺草稿 → canonical no_draft kind 的适配层渲染：HTTP → 400 formal_commit_preview_missing_workspace_diff；
//      工具 → ok:false + blockingReasons["missing_draft"]。
//   D9 输出面 → canonical result 的适配层投影：HTTP 返回 transaction/formalCommitPreview 强化结构；
//      工具返回 previewToken/summary/modelHint。
//
// 2026-09-11 登记补漏（按分工本文件只补登记注释，行为/断言未动）：
//   - 原 happy path 内联注释声称「route 预览在上文已断言未登记工具 store」——实际并无该断言
//     （SWE 审计核实），内联注释已更正为留档说明。
//   - 本文件未加显式 timeout（同次加固其余 parity 文件已加；本文件按分工只许补注释），留档待补。
import type { CommitQualityReport } from "@actalk/story-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// LLM 边界 mock：声明模型（callOpenAICompatibleChatModel）默认吐非 JSON → 声明降级 undefined，
// 此时工具预览退化为与 HTTP 路完全同源的「引擎正则」计划（两侧计划应当深相等）。
// quality-judge 的 AI 判定层换成确定性透传桩（并记录调用次数，供 D6 锁定）。
// ---------------------------------------------------------------------------
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

import { registerCommitRoutes } from "../routes/commit.js";
import { commitPreviewTool } from "../agent/tools/commit-preview.js";
import { __resetCommitPreviewStore, findCommitPreview } from "../agent/tools/commit-preview-store.js";
import {
  callRoute,
  defaultCommittedChapterPath,
  driveToolExecute,
  fakeResolvedChatModel,
  makeParityProject,
  parityCommitDraft,
  parityDraftFileText,
  PARITY_CLEAN_BODY,
  pathExists,
  writeParityDraft,
} from "./parity-kit.js";

const P1 = "林远在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。";

beforeEach(() => {
  vi.clearAllMocks();
  __resetCommitPreviewStore();
  llmMocks.resolveConfiguredChatModel.mockImplementation(async () => fakeResolvedChatModel());
  // 默认：声明模型吐非 JSON → declareChapterDelta 降级 undefined（等价 HTTP 路的纯正则计划）。
  llmMocks.callOpenAICompatibleChatModel.mockResolvedValue({
    content: "（声明模型乱吐，没有 JSON）",
    raw: "",
    response: { ok: true, status: 200 },
  });
  llmMocks.streamChatModelToText.mockResolvedValue({ content: "", thinking: "" });
  judgeMocks.judgeDraftQualityWithModel.mockImplementation(
    async ({ deterministicQuality }: { readonly deterministicQuality: CommitQualityReport }) => ({
      ...deterministicQuality,
      modelJudge: { used: false, fallbackUsed: false, summary: "parity 桩：跳过 AI 判定。" },
    }),
  );
});

describe("parity: POST /api/commit/preview ↔ commit_preview（共享行为面）", () => {
  it("happy path：同稿同盘 → 两侧计划深相等、质量门禁结论一致；两侧都不写正式状态", async () => {
    const projectDir = await makeParityProject("commit-preview-happy-");
    await writeParityDraft(projectDir, 1, parityCommitDraft(1));

    const route = await callRoute(registerCommitRoutes, "POST", "/api/commit/preview", { projectPath: projectDir, chapter: 1 });
    // D6（judge 策略参数）：HTTP 预览用默认真判定、调了 2 次 AI 判定（草稿 + 语义计划）；此刻工具还没跑，先锁 HTTP 侧。
    expect(judgeMocks.judgeDraftQualityWithModel).toHaveBeenCalledTimes(2);
    // D7（declarationChannel 策略参数）：HTTP 预览不传通道，没有声明模型调用。
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();

    const tool = await driveToolExecute(commitPreviewTool, { chapter: 1 }, { projectDir });
    // D6 另一侧：工具预览注入透传桩，全程不调 AI 判定（仍是 2 次，没有新增）。
    expect(judgeMocks.judgeDraftQualityWithModel).toHaveBeenCalledTimes(2);
    // D7 另一侧：工具预览带声明通道、调了 1 次声明模型（本用例它吐非 JSON → 声明降级 undefined，等价纯正则）。
    expect(llmMocks.callOpenAICompatibleChatModel).toHaveBeenCalledTimes(1);

    // ok 契约与门禁结论
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(tool.canCommit).toBe(true);
    const routePlan = route.payload.commitPlan as { readonly passed: boolean };
    const toolPlan = tool.plan as { readonly passed: boolean };
    expect(routePlan.passed).toBe(true);
    expect(toolPlan.passed).toBe(true);

    // 核心对拍：同一引擎 + 同一磁盘 + 声明降级 → 入库计划逐字段深相等。
    expect(tool.plan).toEqual(route.payload.commitPlan);

    // 质量检查问题清单一致（HTTP 侧是 AI 判定桩透传的确定性报告；工具侧本就只跑确定性）。
    // 形状归一：工具输出把引擎 issue 裁成 {severity,type,message} 三元组（commit-preview.ts 的 map），
    // HTTP 侧是引擎完整 issue（含 userDisplayCategory/judgement 等），对拍按三元组对齐。
    const reduceIssues = (issues: readonly { severity: string; type: string; message: string }[]) =>
      issues.map(({ severity, type, message }) => ({ severity, type, message }));
    const routeDraftQuality = route.payload.draftQuality as { readonly issues: readonly { severity: string; type: string; message: string }[] };
    const routeSemanticQuality = route.payload.semanticQuality as { readonly issues: readonly { severity: string; type: string; message: string }[] };
    expect(tool.draftQualityIssues).toEqual(reduceIssues(routeDraftQuality.issues));
    expect(tool.semanticQualityIssues).toEqual(reduceIssues(routeSemanticQuality.issues));
    expect(tool.blockingReasons).toEqual([]);

    // D9（输出面投影）：canonical result 同一，HTTP 投影 transaction/formalCommitPreview；工具投影 previewToken/summary/modelHint。
    expect(typeof route.payload.transactionId).toBe("string");
    expect(typeof route.payload.previewHash).toBe("string");
    expect(route.payload.transaction).toBeTruthy();
    expect(route.payload.formalCommitPreview).toBeTruthy();
    expect("previewToken" in route.payload).toBe(false);
    expect(typeof tool.previewToken).toBe("string");
    expect(String(tool.summary)).toContain("可以定稿");

    // 预览票据只有工具侧登记（HTTP 预览不写工具 store）；这里锁定工具登记后的状态。
    // （留档：本文件没有「route 预览后 store 为空」的断言——原注释声称上文已断言，2026-09-11 审计
    //   核实为不实，已更正；按分工本文件只补注释、不加断言。）
    expect(findCommitPreview(projectDir, 1)?.token).toBe(tool.previewToken);

    // 只读：两侧都没写正式章节，也没建 git 快照。
    expect(await pathExists(defaultCommittedChapterPath(projectDir, 1))).toBe(false);
    expect(await pathExists(`${projectDir}/.git`)).toBe(false);
  });

  it("D8 缺草稿：两侧都诚实拒绝（HTTP 400 blocked；工具 canCommit:false + missing_draft），都不发凭证", async () => {
    const projectDir = await makeParityProject("commit-preview-nodraft-");

    const route = await callRoute(registerCommitRoutes, "POST", "/api/commit/preview", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(commitPreviewTool, { chapter: 1 }, { projectDir });

    expect(route.statusCode).toBe(400);
    expect(route.payload.ok).toBe(false);
    expect(route.payload.reason).toBe("formal_commit_preview_missing_workspace_diff");
    expect(route.payload.transactionId).toBeUndefined();

    expect(tool.ok).toBe(false);
    expect(tool.canCommit).toBe(false);
    expect(tool.blockingReasons).toContain("missing_draft");
    expect(tool.previewToken).toBeUndefined();
    expect(String(tool.summary)).toContain("还没有草稿");

    expect(findCommitPreview(projectDir, 1)).toBeUndefined();
    expect(await pathExists(defaultCommittedChapterPath(projectDir, 1))).toBe(false);
  });
});

describe("parity: commit_preview 对拍——显式策略分歧（declarationChannel 开/关，断言锁定策略差异存在）", () => {
  it("D7 声明模型出有效声明时：工具计划吃声明（mainEvent 换成声明摘要），HTTP 计划仍纯正则 → 计划不再相等", async () => {
    const projectDir = await makeParityProject("commit-preview-declare-");
    // 正文用不重复句子的稿子，声明 quote 逐字取自正文（引擎 verifyChapterDelta 要逐字证据）。
    await writeParityDraft(projectDir, 1, parityDraftFileText(1, PARITY_CLEAN_BODY));
    llmMocks.callOpenAICompatibleChatModel.mockResolvedValue({
      content: JSON.stringify({ mainEvent: { summary: "林远从老王手里接过账册并决定查下去", quote: P1 } }),
      raw: "",
      response: { ok: true, status: 200 },
    });

    const route = await callRoute(registerCommitRoutes, "POST", "/api/commit/preview", { projectPath: projectDir, chapter: 1 });
    const tool = await driveToolExecute(commitPreviewTool, { chapter: 1 }, { projectDir: projectDir });

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 声明被采信且进了计划：两侧 commitPlan 不再逐字相等（声明摘要进时间线主线事件，正则摘要不是这句）。
    const routePlanText = JSON.stringify((route.payload.commitPlan as Record<string, unknown>).commitPlan);
    const toolPlanText = JSON.stringify((tool.plan as Record<string, unknown>).commitPlan);
    expect(toolPlanText).toContain("林远从老王手里接过账册并决定查下去");
    expect(routePlanText).not.toContain("林远从老王手里接过账册并决定查下去");
    // 票据缓存了声明（供 commit_apply 复用、不重复调模型）。
    expect(findCommitPreview(projectDir, 1)?.declaration?.mainEvent?.summary).toBe("林远从老王手里接过账册并决定查下去");
  });
});
