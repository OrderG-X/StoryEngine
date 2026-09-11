// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft-revision.ts 的 preview→apply 两步 ↔ agent/tools/revise-draft.ts 的 revise_draft 一步到位。
// 写盘对拍：双胞胎 fixture。两轨编排已收编进 services/revision-service.ts（双轨合一）：
// 模型调用统一走 llm-client（callOpenAICompatibleChatModel），两侧同一个 mock 边界、喂同一份修订预览 JSON。
//
// 原漂移清单处置（收编结论；代码证据在 services/revision-service.ts）：
//   D21 定位宽容度【已收敛】：空白+引号归一兜底收进 service（locateRevisionSpan），两轨共用；
//       HTTP 路纯 indexOf 直接 400 成为历史（刻意修复：ASCII 引号目标也能命中中文引号盘稿）。
//   D22 漂移守卫【已收敛·刻意修复】：模型回吐 beforeText 必须落在用户点名区间——收进 service；
//       HTTP 路由 preview 步获得守卫（漂移预览直接 400 诚实拒），不再「模型改了别处照改还报 ok:true」。
//   D23 精确替换快路【已收敛】：replacementText 给了就跳过模型原样落地——收进 service；
//       HTTP preview 步从 task.replacementText 获得同一能力（readDraftRevisionTask 不收，路由直读原始 body）。
//   D24 流程形态【仍是显式分歧】：HTTP 两步（preview→apply，apply 必须 confirm:true）；工具一步落盘。
//       service 同时支撑两种形态（preview 产物即 apply 入参），本文件锁定的是形态分歧下的语义等价。
//   D25 no-op 诚实【已收敛·刻意修复】：改后==改前拒绝报成功——收进 service；
//       HTTP 路由 apply 步获得守卫（400 诚实拒），不再「照写原样内容还报 applied:true」。
//   目标级诚实守卫【已收敛·2026-09-11 补】：改后用户点名句仍原样在稿（空白+引号归一比对）= 没真改到 → 拒。
//       原是工具路独有、且未登记进漂移清单的盲区（HTTP 曾对「大区间 beforeText 保留目标句原样」报 applied:true）；
//       收编后 preview 响应带 revisionContext（resolvedTarget+mode），apply 回传即同口径拒（400），见下方用例。
//
//   显式策略参数（收编后两侧刻意保留的分歧，service policies 参数化，不再是暗漂移；下方「显式策略分歧」组锁定）：
//   - modelErrorFallback：HTTP preview 模型调用失败回 200 + 安全兜底预览（前端 A.5 契约）；工具路诚实拒。
//   - deterministicPreview：HTTP preview 对代词修复任务用引擎确定性预览覆盖模型 echo；工具路无此 overlay。
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
  createConfiguredWriterClient: vi.fn(),
}));

vi.mock("../lib/llm-client.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/llm-client.js")>("../lib/llm-client.js");
  return { ...actual, ...llmMocks };
});

import { registerDraftRevisionRoutes } from "../routes/draft-revision.js";
import { reviseDraftTool } from "../agent/tools/revise-draft.js";
import {
  callRoute,
  defaultDraftPath,
  driveToolExecute,
  fakeResolvedChatModel,
  makeParityTwinProjects,
  parityReviseDraft,
  REVISE_REPLACEMENT_B,
  REVISE_SENTENCE_A,
  REVISE_SENTENCE_B,
  REVISE_SENTENCE_C,
  writeParityDraft,
} from "./parity-kit.js";

/** 组一份模型修订预览 JSON（两轨共用：统一走 llm-client 的 callOpenAICompatibleChatModel content）。 */
function previewJson(beforeText: string, afterText: string): string {
  return JSON.stringify({
    taskId: "parity-rev-1",
    beforeText,
    afterText,
    changeSummary: "把窗边的沉默改成具体动作。",
    rationale: "按修订目标改写。",
    riskNotes: [],
    preservedFacts: [],
    warnings: [],
  });
}

function mockRevisionModel(content: string): void {
  llmMocks.callOpenAICompatibleChatModel.mockResolvedValue({
    content,
    raw: content,
    response: { ok: true, status: 200 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  llmMocks.resolveConfiguredChatModel.mockImplementation(async () => fakeResolvedChatModel("parity-repair-model"));
  mockRevisionModel(previewJson(REVISE_SENTENCE_B, REVISE_REPLACEMENT_B));
  llmMocks.streamChatModelToText.mockResolvedValue({ content: "", thinking: "" });
});

function revisionTask(targetText: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    targetType: "paragraph",
    targetText,
    revisionGoal: "润色这段，让节奏更稳。",
    problemSummary: "节奏偏平。",
    ...extra,
  };
}

describe("parity: /api/draft/revision/* ↔ revise_draft（共享行为面）", () => {
  it("happy path：同稿同预览 → 两侧落盘字节一致；HTTP 两步、工具一步（D24 形态分歧下的语义等价）", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-happy-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    // HTTP 路：preview → apply(confirm:true)
    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    const apply = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/apply", {
      projectPath: routeDir,
      chapter: 1,
      confirm: true,
      preview: preview.payload.preview,
    });

    // 工具路：一次调用
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "润色这段，让节奏更稳。",
      problemSummary: "节奏偏平。",
    }, { projectDir: toolDir });

    // ok 契约
    expect(apply.statusCode).toBe(200);
    expect(apply.payload.ok).toBe(true);
    expect((apply.payload.result as { applied: boolean }).applied).toBe(true);
    expect(tool.ok).toBe(true);
    expect(tool.applied).toBe(true);

    // 落盘状态：两侧草稿文件字节一致（同稿 + 同 before/after → 同一替换结果）
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(toolDraft).toBe(routeDraft);
    expect(routeDraft).toContain(REVISE_REPLACEMENT_B);
    expect(routeDraft).not.toContain(REVISE_SENTENCE_B);

    // 关键输出字段：HTTP 回写后全文；工具回 draftBody（去标题正文）
    expect(String(apply.payload.draftContent)).toBe(routeDraft);
    expect(tool.draftBody).toBe(routeDraft.replace(/^# 第1章\n\n/u, "").trim());
    // 两侧都建了覆盖前快照（HTTP createSnapshot / 工具 snapshotBeforeDraftOverwrite）
    expect(typeof tool.snapshotId).toBe("string");
  });

  it("原文缺失：两侧都拒绝、都不动稿（HTTP 400；工具 ok:false applied:false）", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-missing-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    const route = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask("这句话根本不在草稿里，纯属杜撰。"),
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: "这句话根本不在草稿里，纯属杜撰。",
      revisionGoal: "润色这段。",
    }, { projectDir: toolDir });

    expect(route.statusCode).toBe(400);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("未在当前草稿中找到");
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("未在当前草稿中找到");
    // 都没动稿、都没调模型（守卫在调模型之前）
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(parityReviseDraft(1));
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(parityReviseDraft(1));
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
  });

  it("原文出现多次：两侧都拒绝（HTTP 400「出现多次」；工具 ambiguous 拒）", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-ambiguous-");
    const doubled = `# 第1章\n\n${REVISE_SENTENCE_A}\n\n${REVISE_SENTENCE_B}\n\n${REVISE_SENTENCE_B}\n`;
    await writeParityDraft(routeDir, 1, doubled);
    await writeParityDraft(toolDir, 1, doubled);

    const route = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "润色这段。",
    }, { projectDir: toolDir });

    expect(route.statusCode).toBe(400);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("出现多次");
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("出现多次");
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(doubled);
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(doubled);
  });
});

describe("parity: revise_draft 对拍——收编后的共享守卫（原 D21/D22/D23/D25 豁免项已收敛）", () => {
  it("D22 收敛：模型回吐的 beforeText 去了别处 → 两侧都诚实拒、都不动稿（HTTP preview 400；工具 ok:false）", async () => {
    // 用户点名改 B，模型却回了 A 的改写——典型的「模型去动了别处」漂移。
    mockRevisionModel(previewJson(REVISE_SENTENCE_A, "林远合上账册，直接去了审计楼。"));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-drift-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "润色这段，让节奏更稳。",
    }, { projectDir: toolDir });

    // HTTP 路：preview 步漂移守卫拦下 → 400 诚实拒（不再有可确认的漂移预览，apply 不会发生）
    expect(preview.statusCode).toBe(400);
    expect(preview.payload.ok).toBe(false);
    expect(String(preview.payload.error)).toContain("不是你选择的片段");

    // 工具路：overlap 守卫拦下 → ok:false applied:false
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("不是你指定的那段");

    // 两侧整稿逐字未动、字节一致
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(routeDraft).toBe(parityReviseDraft(1));
    expect(toolDraft).toBe(parityReviseDraft(1));
  });

  it("D25 收敛：模型回「改后==改前」 → HTTP apply 拒（400）、工具拒；两侧草稿逐字未动", async () => {
    mockRevisionModel(previewJson(REVISE_SENTENCE_B, REVISE_SENTENCE_B));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-noop-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    const apply = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/apply", {
      projectPath: routeDir,
      chapter: 1,
      confirm: true,
      preview: preview.payload.preview,
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "润色这段，让节奏更稳。",
    }, { projectDir: toolDir });

    // HTTP 路：预览步仍回 200 + no-op 预览（A.5 契约不变）；no-op 守卫收在 apply 步 → 400 诚实拒
    expect(preview.statusCode).toBe(200);
    expect(apply.statusCode).toBe(400);
    expect(apply.payload.ok).toBe(false);
    expect(String(apply.payload.error)).toContain("等于没有任何修改");

    // 工具路：no-op 守卫 → 诚实拒、不写盘
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("等于没有任何修改");

    // 两侧草稿逐字未动、字节一致
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(parityReviseDraft(1));
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(parityReviseDraft(1));
  });

  it("D23 收敛：replacementText 给了就跳过模型原样落地——HTTP 两步与工具一步落盘字节一致", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-exact-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    // HTTP 路：task 里塞 replacementText（收编后路由直读）→ 不调模型出确定性预览
    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B, { replacementText: "用户指定的精确替换句。" }),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    expect((preview.payload.preview as { afterText: string }).afterText).toBe("用户指定的精确替换句。");
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
    const apply = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/apply", {
      projectPath: routeDir,
      chapter: 1,
      confirm: true,
      preview: preview.payload.preview,
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "把这句换成我给的文本。",
      replacementText: "用户指定的精确替换句。",
    }, { projectDir: toolDir });

    // 两侧都落用户精确文本、全程没调模型、落盘字节一致
    expect(apply.statusCode).toBe(200);
    expect(apply.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(tool.applied).toBe(true);
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(routeDraft).toContain("用户指定的精确替换句。");
    expect(toolDraft).toBe(routeDraft);
  });

  it("D21 收敛：目标带 ASCII 引号/盘稿是中文引号 → 两侧归一兜底都能改，落盘字节一致", async () => {
    // 盘稿用中文引号对白；两轨收到的 targetText 是 ASCII 引号变体（模型常见回吐风格）。
    const dialogueCurly = "老王低声说：「账册先放我这，你回去等信。」";
    const dialogueAscii = '老王低声说："账册先放我这，你回去等信。"';
    const draft = `# 第1章\n\n${REVISE_SENTENCE_A}\n\n${dialogueCurly}\n\n${REVISE_SENTENCE_C}\n`;
    mockRevisionModel(previewJson(dialogueCurly, "老王把账册收进抽屉，让他回去等信。"));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-quotes-");
    await writeParityDraft(routeDir, 1, draft);
    await writeParityDraft(toolDir, 1, draft);

    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(dialogueAscii),
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: dialogueAscii,
      revisionGoal: "润色这句对白。",
    }, { projectDir: toolDir });

    // HTTP 路：归一兜底命中真实区间（收编后不再 400），任务 targetText 回写成盘稿原文
    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    expect((preview.payload.task as { targetText: string }).targetText).toBe(dialogueCurly);
    const apply = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/apply", {
      projectPath: routeDir,
      chapter: 1,
      confirm: true,
      preview: preview.payload.preview,
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.payload.ok).toBe(true);

    // 工具路：同样的归一兜底 → 正常修订落盘
    expect(tool.ok).toBe(true);
    expect(tool.applied).toBe(true);

    // 两侧落盘字节一致，旧句真被替换
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(toolDraft).toBe(routeDraft);
    expect(routeDraft).toContain("老王把账册收进抽屉，让他回去等信。");
    expect(routeDraft).not.toContain(dialogueCurly);
  });

  it("目标级守卫收敛：模型回吐大区间 beforeText 覆盖目标句、afterText 保留目标句原样 → HTTP apply 400、工具 target_unchanged，两侧草稿逐字未动", async () => {
    // 用户点名改 B；模型回「A+B」大区间、只改写 A、B 一字未动——改后点名句仍原样在稿。
    const wideBefore = `${REVISE_SENTENCE_A}\n\n${REVISE_SENTENCE_B}`;
    const wideAfter = `林远把账册收进抽屉，吹熄了灯。\n\n${REVISE_SENTENCE_B}`;
    mockRevisionModel(previewJson(wideBefore, wideAfter));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-target-unchanged-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    // HTTP 路：preview 步落点重叠检查通过（大区间合法覆盖目标区间）→ 200，产物带 revisionContext
    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    expect(preview.payload.revisionContext).toEqual({ resolvedTarget: REVISE_SENTENCE_B, mode: "model" });
    // apply 步回传 revisionContext → 目标级守卫拦下（400 诚实拒），不再「applied:true 而点名句一字未动」
    const apply = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/apply", {
      projectPath: routeDir,
      chapter: 1,
      confirm: true,
      preview: preview.payload.preview,
      revisionContext: preview.payload.revisionContext,
    });
    expect(apply.statusCode).toBe(400);
    expect(apply.payload.ok).toBe(false);
    expect(String(apply.payload.error)).toContain("仍原样留在草稿里");

    // 工具路：同一模型回吐 → target_unchanged 诚实拒（原行为，现两侧同口径）
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "润色这段，让节奏更稳。",
    }, { projectDir: toolDir });
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("仍原样留在草稿里");

    // 两侧整稿逐字未动、字节一致
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(routeDraft).toBe(parityReviseDraft(1));
    expect(toolDraft).toBe(parityReviseDraft(1));
  });
});

describe("parity: revise_draft 对拍——显式策略分歧（modelErrorFallback / deterministicPreview，刻意保留、本组锁定）", () => {
  it("modelErrorFallback：mock 模型 reject → HTTP preview 200 + 兜底预览（no-op 标志不丢）、工具 ok:false，两侧草稿都不动", async () => {
    llmMocks.callOpenAICompatibleChatModel.mockRejectedValue(new Error("网络连接被重置"));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-model-down-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    // HTTP 路：A.5 契约——模型失败回 200 + 安全兜底预览（afterText===beforeText 的 no-op + 警告标志），
    // 前端据标志诚实报失败；诊断文案进 riskNotes。
    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    const fallback = preview.payload.preview as { beforeText: string; afterText: string; warnings: string[]; riskNotes: string[] };
    expect(fallback.beforeText).toBe(REVISE_SENTENCE_B);
    expect(fallback.afterText).toBe(REVISE_SENTENCE_B);
    expect(fallback.warnings).toContain("未应用任何修改。");
    expect(fallback.riskNotes[0]).toContain("网络连接被重置");
    expect(preview.payload.usedFallback).toBe(true);

    // 工具路：模型失败诚实拒（model_output_unusable），不带兜底预览遮羞
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: REVISE_SENTENCE_B,
      revisionGoal: "润色这段，让节奏更稳。",
    }, { projectDir: toolDir });
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("修订模型输出不可用");
    expect(String(tool.summary)).toContain("网络连接被重置");

    // 模型真被调过（失败来自模型调用而非前置守卫）；两侧草稿逐字未动、字节一致
    expect(llmMocks.callOpenAICompatibleChatModel).toHaveBeenCalled();
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(parityReviseDraft(1));
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(parityReviseDraft(1));
  });

  it("deterministicPreview：代词修复任务模型回 echo no-op → HTTP preview 改用引擎确定性预览（真改动）、工具 no-op 诚实拒，两侧草稿都不动", async () => {
    const pronounTarget = "他站起身，把账册递给林远。";
    const draft = `# 第1章\n\n${REVISE_SENTENCE_A}\n\n${pronounTarget}\n\n${REVISE_SENTENCE_C}\n`;
    // 模型把目标句原样 echo 回（afterText===beforeText 的 echo no-op）
    mockRevisionModel(previewJson(pronounTarget, pronounTarget));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-echo-noop-");
    await writeParityDraft(routeDir, 1, draft);
    await writeParityDraft(toolDir, 1, draft);

    // HTTP 路：代词修复任务（统一为她）+ echo no-op → 引擎确定性预览覆盖（beforeText=目标句、afterText=代词真改）
    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(pronounTarget, { revisionGoal: "统一为她。", problemSummary: "代词性别漂移。" }),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    const deterministic = preview.payload.preview as { beforeText: string; afterText: string; changeSummary: string };
    expect(deterministic.beforeText).toBe(pronounTarget);
    expect(deterministic.afterText).toBe("她站起身，把账册递给林远。");
    expect(deterministic.changeSummary).toContain("统一角色称谓");
    expect(preview.payload.usedFallback).toBe(false);

    // 工具路：无此 overlay——echo no-op 直接诚实拒（改了等于没改不许报成功）
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: pronounTarget,
      revisionGoal: "统一为她。",
      problemSummary: "代词性别漂移。",
    }, { projectDir: toolDir });
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("等于没有任何修改");

    // 两侧都只到预览/拒绝为止：草稿逐字未动、字节一致
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(draft);
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(draft);
  });
});
