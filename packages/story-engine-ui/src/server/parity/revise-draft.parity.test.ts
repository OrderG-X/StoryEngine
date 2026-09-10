// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft-revision.ts 的 preview→apply 两步 ↔ agent/tools/revise-draft.ts 的 revise_draft 一步到位。
// 写盘对拍：双胞胎 fixture。HTTP 预览路的模型调用是【裸 fetch】（draft-revision.ts callDraftRevisionModel），
// 工具路是 callOpenAICompatibleChatModel（llm-client）——两个边界分别 mock，喂同一份修订预览 JSON。
//
// 已知刻意分歧（显式豁免清单；每条锁定现状并附代码证据）：
//   D21 定位宽容度：工具对原文/回吐句做「空白+引号归一」兜底定位（revise-draft.ts locateTargetSpan）；
//       HTTP 路只有精确 indexOf（draft-revision.ts preview 校验 + 引擎 applyDraftRevisionToContent）。
//   D22 漂移守卫：模型回吐的 beforeText 必须落在用户点名区间，否则工具诚实拒（revise-draft.ts 的 overlap 判定）；
//       HTTP 路无此守卫——预览校验的是 task.targetText，apply 替换的是模型 preview.beforeText，模型说改哪就改哪。
//   D23 精确替换快路：工具入参 replacementText 给了就原样落地、不调模型（revise-draft.ts 的 exactReplacement 分支）；
//       HTTP 路无此字段（readDraftRevisionTask 丢弃未知字段，仍走模型）。
//   D24 流程形态：HTTP 是 preview/apply 两步 + apply 必须 confirm:true；工具 preview+apply 合一、一次调用落盘。
//   D25 no-op 诚实：模型回「改了等于没改」时，工具 no-op 守卫拒报成功（revise-draft.ts updatedContent===draftContent
//       分支）；HTTP apply 会把原样内容再写一遍并回报 applied:true。
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

/** 组一份模型修订预览 JSON（两轨共用：HTTP 走裸 fetch 的 choices[0].message.content；工具走 callModel content）。 */
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

function mockBothModelChannels(content: string): void {
  // 工具路（llm-client）
  llmMocks.callOpenAICompatibleChatModel.mockResolvedValue({
    content,
    raw: content,
    response: { ok: true, status: 200 },
  });
  // HTTP 预览路（裸 fetch → OpenAI 兼容响应壳）
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  llmMocks.resolveConfiguredChatModel.mockImplementation(async () => fakeResolvedChatModel("parity-repair-model"));
  mockBothModelChannels(previewJson(REVISE_SENTENCE_B, REVISE_REPLACEMENT_B));
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
    expect(fetch).not.toHaveBeenCalled();
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

describe("parity: revise_draft 对拍——已知刻意分歧（豁免清单，断言锁定分歧存在）", () => {
  it("D22 漂移守卫：模型回吐的 beforeText 去了别处 → HTTP 照改别处（目标句原样残留）；工具诚实拒、不动稿", async () => {
    // 用户点名改 B，模型却回了 A 的改写——典型的「模型去动了别处」漂移。
    mockBothModelChannels(previewJson(REVISE_SENTENCE_A, "林远合上账册，直接去了审计楼。"));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-drift-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B),
    });
    expect(preview.payload.ok).toBe(true); // HTTP 预览校验的是 targetText（在稿中），不看模型 beforeText
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

    // HTTP 路：引擎把 A 句换掉 → ok:true applied:true；用户点名的 B 句原样残留（漂移成功落地）
    expect(apply.statusCode).toBe(200);
    expect(apply.payload.ok).toBe(true);
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    expect(routeDraft).toContain("林远合上账册，直接去了审计楼。");
    expect(routeDraft).not.toContain(REVISE_SENTENCE_A);
    expect(routeDraft).toContain(REVISE_SENTENCE_B); // 目标句没动

    // 工具路：overlap 守卫拦下 → ok:false applied:false，整稿逐字未动
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("不是你指定的那段");
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(parityReviseDraft(1));
  });

  it("D25 no-op 诚实：模型回「改后==改前」 → HTTP 照写原样内容并回报 applied:true；工具拒报成功", async () => {
    mockBothModelChannels(previewJson(REVISE_SENTENCE_B, REVISE_SENTENCE_B));
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

    // HTTP 路：内容没变也回报 applied:true（改稿谎报面，锁定现状）
    expect(apply.statusCode).toBe(200);
    expect(apply.payload.ok).toBe(true);
    expect((apply.payload.result as { applied: boolean }).applied).toBe(true);
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(parityReviseDraft(1));

    // 工具路：no-op 守卫 → 诚实拒、不写盘
    expect(tool.ok).toBe(false);
    expect(tool.applied).toBe(false);
    expect(String(tool.summary)).toContain("等于没有任何修改");
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(parityReviseDraft(1));
  });

  it("D23 精确替换快路：工具带 replacementText 不调模型原样落地；HTTP 忽略该字段照走模型", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-exact-");
    await writeParityDraft(routeDir, 1, parityReviseDraft(1));
    await writeParityDraft(toolDir, 1, parityReviseDraft(1));

    // HTTP 路：task 里塞 replacementText（readDraftRevisionTask 不收这个字段）→ 仍调模型出预览
    const preview = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(REVISE_SENTENCE_B, { replacementText: "用户指定的精确替换句。" }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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

    // HTTP 落的是模型 afterText；工具落的是用户精确文本且一次模型都没调
    expect(apply.payload.ok).toBe(true);
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toContain(REVISE_REPLACEMENT_B);
    expect(tool.ok).toBe(true);
    expect(tool.applied).toBe(true);
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toContain("用户指定的精确替换句。");
  });

  it("D21 定位宽容度：目标带 ASCII 引号/盘稿是中文引号时……工具归一兜底能改，HTTP 精确匹配直接 400", async () => {
    // 盘稿用中文引号对白；工具/HTTP 收到的 targetText 是 ASCII 引号变体（模型常见回吐风格）。
    const dialogueCurly = "老王低声说：「账册先放我这，你回去等信。」";
    const dialogueAscii = '老王低声说："账册先放我这，你回去等信。"';
    const draft = `# 第1章\n\n${REVISE_SENTENCE_A}\n\n${dialogueCurly}\n\n${REVISE_SENTENCE_C}\n`;
    mockBothModelChannels(previewJson(dialogueCurly, "老王把账册收进抽屉，让他回去等信。"));
    const { routeDir, toolDir } = await makeParityTwinProjects("revise-quotes-");
    await writeParityDraft(routeDir, 1, draft);
    await writeParityDraft(toolDir, 1, draft);

    const route = await callRoute(registerDraftRevisionRoutes, "POST", "/api/draft/revision/preview", {
      projectPath: routeDir,
      chapter: 1,
      task: revisionTask(dialogueAscii),
    });
    const tool = await driveToolExecute(reviseDraftTool, {
      chapter: 1,
      targetText: dialogueAscii,
      revisionGoal: "润色这句对白。",
    }, { projectDir: toolDir });

    // HTTP 精确 indexOf：ASCII 引号目标在中文引号盘稿里找不到 → 400
    expect(route.statusCode).toBe(400);
    expect(route.payload.ok).toBe(false);
    // 工具空白+引号归一兜底：命中真实区间、用盘稿原文重建任务 → 正常修订落盘
    expect(tool.ok).toBe(true);
    expect(tool.applied).toBe(true);
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(toolDraft).toContain("老王把账册收进抽屉，让他回去等信。");
    expect(toolDraft).not.toContain(dialogueCurly);
    expect(await readFile(defaultDraftPath(routeDir, 1), "utf-8")).toBe(draft);
  });
});
