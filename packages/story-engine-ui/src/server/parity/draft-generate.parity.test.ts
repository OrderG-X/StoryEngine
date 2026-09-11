// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft.ts 的 POST /api/draft/generate（非流式）↔ agent/tools/generate-draft.ts 的 generate_draft。
// 同一真引擎 + 同种子双胞胎 fixture + 同一个 mock writer，分别驱动 route handler 与 tool execute，断言语义等价。
//
// 双轨合一（第二波）：两侧编排已同调 services/draft-service.ts 的 runGenerateDraft / generateDraftCandidate，
// 本对从「两套进程内复刻」收敛为「同一 service + 两侧薄适配」。原漂移清单的处置结论：
//   D1 字数下限【收敛为显式策略参数】：service policies.lengthPolicy——"enforce_or_rollback"（HTTP 按钮路现状：
//      低于下限拒写+回滚旧稿 → 路由投影 422；超上限确定性裁剪落盘并重建 report.draftLength）/"annotate"
//      （工具路现状：一次成稿照写盘 + draftLength 透出 + summary ⚠ 标注）。两侧行为一字未变，分歧从暗差变显式开关。
//   D2 AI 腔簇【收敛为显式开关】：service policies.aiFlavorRecheck（+autoDeAi/deAiCallModel/beatAdjudicationCallModel
//      注入点）——工具路传 true 接全栈（回检规则进引擎 + high/medium 默认一轮 autoDeAi 改写落盘 + beats 裁决）；
//      HTTP 按钮路显式传 false 维持现状（产品未决定给按钮路开回检）。mustHitBeats/candidates/autoDeAi 入参面
//      仍是工具独有（service 能力，路由不传）。
//   D3 护栏簇【留在工具层】：章序护栏/写作意图门/已入库前沿推进是 agent 语义不是编排语义——只在
//      generate-draft.ts execute 内（evaluateChapterSequencingGuard / userTurnAllowsDraftWrite /
//      advancePastCommittedFrontier）；HTTP 按钮路无护栏、直接写。
//   D4 快照时机【刻意收敛，已统一】：两侧适配层同调 snapshotBeforeDraftOverwrite——仅覆盖已有非空草稿前建
//      可撤销快照；首次出稿无旧稿不建空快照。HTTP 路原「每次出稿前无条件 createSnapshot」收敛到该 M6 语义
//      （无旧稿时快照无可保护内容、纯噪音；覆盖写前必有撤销点的安全不变量两侧如一。代价：HTTP 首次出稿不再
//      进操作历史，与工具路自 M6 起的行为一致——视为合理收敛而非能力损失）。
//   D5 输入面【刻意保留】：persist:false 抽卡与 maxOutputTokens 显式覆盖均为 HTTP 路独有入参
//      （抽卡=service generateDraftCandidate 能力，路由继续用，工具 schema 无 persist；maxOutputTokens
//      缺省时两侧同一来源 resolveDraftMaxOutputTokens(lengthTarget)，工具入参面无此项——SWE P1-3 登记补漏）。
//      两侧的回检/裁决输入面差异见 D2。
//
// 2026-09-11 收敛与加固：
//   - 引擎拒稿 ok 契约【已收敛·诚实修复】：runGenerateDraft 返回 ok:false 且无 rejection（引擎校验拒稿
//     passed:false / 全候选失败 / 优胜稿落盘失败）时，HTTP 路从「200 ok:true + 空 draftContent 假成功」
//     收敛为 422 + ok:false + canonical summary（与工具路 ok:false 同向、与 D18 同先例）——SWE P1-3，
//     下方用例锁定。
//   - 意图门真参与对拍：generate_draft 的 driveToolExecute 一律带真实用户原话（userTurnText），写作
//     意图门不再恒 undefined 放行；「本轮原话无写作意图被拦」成为可测分歧（D3 护栏簇的一条腿），下方用例锁定。
//   - writer mock 记录入参（context 段序列 / maxOutputTokens / 渲染 prompt 长度）：上下文装配面漂移会在
//     happy path 红出来，不再被「mock 吞入参」掩盖。
//   - 磁盘 IO 重（真引擎建项目 + 真 git 快照子进程）：全部用例给显式 timeout（CLAUDE.md 纪律）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderFastDraftPromptText, type WriterClient } from "@actalk/story-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// LLM 边界 mock：writer 由每个用例经 draftMocks.writerBody 驱动；引擎包保持真实。
// routes/draft.js 与 agent/tools/generate-draft.js 解析到同一个 llm-client 模块，一次 mock 两侧生效。
// mock writer 记录每次 generateDraft 的入参（context 段序列 / maxOutputTokens / 渲染 prompt 长度），
// 让两侧上下文装配面的漂移在断言里可见（原为「吞入参」黑盒）。
// ---------------------------------------------------------------------------
const draftMocks = vi.hoisted(() => ({
  writerBody: "",
  writerTitle: "夜探",
  writerCalls: [] as {
    readonly maxOutputTokens?: number;
    readonly sectionNames: readonly string[];
    readonly promptLength: number;
  }[],
  createConfiguredWriterClient: vi.fn(),
  createOpenAICompatibleWriterClient: vi.fn(),
  resolveConfiguredChatModel: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));

vi.mock("../lib/llm-client.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/llm-client.js")>("../lib/llm-client.js");
  return { ...actual, ...draftMocks };
});

import { registerDraftRoutes } from "../routes/draft.js";
import { generateDraftTool } from "../agent/tools/generate-draft.js";
import {
  callRoute,
  countParityCjk,
  defaultDraftPath,
  driveToolExecute,
  fakeResolvedChatModel,
  makeParityTwinProjects,
  PARITY_AI_FLAVOR_BODY,
  PARITY_CLEAN_BODY,
  PARITY_DEAI_AFTER,
  PARITY_DEAI_SENTENCE,
  PARITY_MAIN_CHARACTER,
  parityDraftFileText,
  pathExists,
  readTextIfExists,
  stripLeadingMarkdownChapterHeading,
  writeParityDraft,
} from "./parity-kit.js";

const CHAPTER_GOAL = "第 1 章：主角拿到账册。";
/** 写类对拍驱动 generate_draft 时带的用户原话：明确写作意图（意图门放行口径内的canonical句式）。 */
const WRITE_TURN_TEXT = "写第 1 章正文";

/** mock writer：固定正文 + 记录入参（装配面可见性）。 */
function recordingWriterClient(): WriterClient {
  return {
    async generateDraft(input) {
      draftMocks.writerCalls.push({
        maxOutputTokens: input.maxOutputTokens,
        sectionNames: input.context.sections.map((section) => section.name),
        promptLength: renderFastDraftPromptText(input.context).length,
      });
      return { title: draftMocks.writerTitle, content: draftMocks.writerBody };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  draftMocks.writerBody = PARITY_CLEAN_BODY;
  draftMocks.writerTitle = "夜探";
  draftMocks.writerCalls.length = 0;
  draftMocks.createConfiguredWriterClient.mockImplementation(async (): Promise<WriterClient> => recordingWriterClient());
  draftMocks.createOpenAICompatibleWriterClient.mockImplementation((): WriterClient => recordingWriterClient());
  draftMocks.resolveConfiguredChatModel.mockImplementation(async () => fakeResolvedChatModel());
  draftMocks.callOpenAICompatibleChatModel.mockResolvedValue({
    content: "{}",
    raw: "{}",
    response: { ok: true, status: 200 },
  });
  draftMocks.streamChatModelToText.mockResolvedValue({ content: "（模型乱吐，没有 JSON）", thinking: "" });
});

function generateBody(projectDir: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    projectPath: projectDir,
    chapter: 1,
    chapterGoal: CHAPTER_GOAL,
    requestedDraftLength: 300,
    ...extra,
  };
}

describe("parity: POST /api/draft/generate ↔ generate_draft（共享行为面）", () => {
  it("长度窗口假设自证：对拍正文 328 字，落在 requestedDraftLength:300 的 [300,345] 窗口内", { timeout: 30_000 }, () => {
    // 这条不是对拍，是 fixture 自证：正文改动若把字数推出窗口，下面的 happy-path 会假性变红。
    expect(countParityCjk(PARITY_CLEAN_BODY)).toBeGreaterThanOrEqual(300);
    expect(countParityCjk(PARITY_CLEAN_BODY)).toBeLessThanOrEqual(345);
    expect(countParityCjk(PARITY_AI_FLAVOR_BODY)).toBeGreaterThanOrEqual(300);
    expect(countParityCjk(PARITY_AI_FLAVOR_BODY)).toBeLessThanOrEqual(345);
  });

  it("happy path：同一 mock 正文 → 两侧 ok，drafts/fast 落盘字节一致，关键字段等价", { timeout: 30_000 }, async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-happy-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    // ok 契约
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);

    // 上下文装配面锁定（mock writer 记入参）：两侧 generateDraft 吃到的 context 段序列、
    // maxOutputTokens、渲染 prompt 长度完全一致——装配漂移在这里红，不再被 mock 吞掉。
    expect(draftMocks.writerCalls).toHaveLength(2);
    expect(draftMocks.writerCalls[1]).toEqual(draftMocks.writerCalls[0]);
    expect(draftMocks.writerCalls[0]!.promptLength).toBeGreaterThan(0);

    // 落盘状态：两侧工作稿文件字节一致（同一引擎同一写盘通道 persistFastDraftBody）
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(routeDraft).toBe(toolDraft);
    expect(routeDraft).toContain(PARITY_CLEAN_BODY);

    // 关键输出字段：标题 / 正文 / 字数核对
    const routeReport = route.payload.report as { readonly passed: boolean; readonly title?: string; readonly draftLength?: { readonly actualLength: number } };
    expect(routeReport.passed).toBe(true);
    expect(route.payload.draftContent).toBe(routeDraft);
    expect(route.payload.draftTitle).toBe("夜探");
    expect(tool.draftTitle).toBe("夜探");
    expect(tool.draftBody).toBe(stripLeadingMarkdownChapterHeading(routeDraft).trim());
    expect(routeReport.draftLength?.actualLength).toBe(328);
    expect((tool.draftLength as { actualLength: number }).actualLength).toBe(routeReport.draftLength?.actualLength);

    // 两侧都带 overview 供前端刷新；characterSelection 同源（同一 in-scene-detector + 同种子 fixture）
    expect(route.payload.overview).toBeTruthy();
    expect(tool.overview).toBeTruthy();
    const routeSelection = route.payload.characterSelection as { selectedCharacterIds: readonly string[] };
    const toolSelection = tool.characterSelection as { selectedCharacterIds: readonly string[] };
    expect([...toolSelection.selectedCharacterIds]).toEqual([...routeSelection.selectedCharacterIds]);

    // D4（已收敛·快照时机统一）：首次出稿两侧都不建 git 快照（无旧稿可丢）；snapshotId 两侧都不透。
    expect(await pathExists(join(routeDir, ".git"))).toBe(false);
    expect(await pathExists(join(toolDir, ".git"))).toBe(false);
    expect("snapshotId" in route.payload).toBe(false);
    expect("snapshotId" in tool).toBe(false);
  });

  it("覆盖已有草稿再出稿：两侧都先建可撤销快照（D4 收敛后同一语义：仅覆盖才建；工具把 snapshotId 透出给前端）", { timeout: 30_000 }, async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-overwrite-");
    await writeParityDraft(routeDir, 1, parityDraftFileText(1, `${PARITY_CLEAN_BODY.slice(0, 200)}旧版收尾。`));
    await writeParityDraft(toolDir, 1, parityDraftFileText(1, `${PARITY_CLEAN_BODY.slice(0, 200)}旧版收尾。`));

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 两侧都产生了 git 仓库（快照机制落地），但只有工具把 snapshotId 透进输出（HTTP 路靠操作历史面板）。
    expect(await pathExists(join(routeDir, ".git"))).toBe(true);
    expect(await pathExists(join(toolDir, ".git"))).toBe(true);
    expect(typeof tool.snapshotId).toBe("string");
    // 新稿覆盖旧稿，两侧落盘一致
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(routeDraft);
    expect(routeDraft).toContain(PARITY_CLEAN_BODY);
  });

  it("引擎拒稿（passed:false 无 rejection）：HTTP 422+ok:false 如实报失败（不再 200 假 ok），工具 ok:false；两侧都不落盘", { timeout: 30_000 }, async () => {
    // SWE P1-3 收敛锁定：mock writer 吐空正文 → 引擎 validateDraft 拒稿（report.passed:false、无 draftPath）。
    draftMocks.writerBody = "";
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-rejected-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    // 收敛后的 ok 契约：两侧都如实报失败；HTTP 侧 error 借与工具同一 canonical summary（逐字一致）。
    expect(route.statusCode).toBe(422);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("出稿未通过");
    expect(tool.ok).toBe(false);
    expect(route.payload.error).toBe(tool.summary);

    // report 照带（引擎 issues 里有拒稿真相，不藏）；draftContent 不再是「空串假稿」字段。
    const routeReport = route.payload.report as { readonly passed: boolean; readonly issues: readonly string[] };
    expect(routeReport.passed).toBe(false);
    expect(routeReport.issues.join(" ")).toContain("Draft content is required.");
    expect(route.payload.draftContent).toBeUndefined();

    // 两侧都没把工作稿写盘
    expect(await readTextIfExists(defaultDraftPath(routeDir, 1))).toBeUndefined();
    expect(await readTextIfExists(defaultDraftPath(toolDir, 1))).toBeUndefined();
  });

  it("写作意图门真参与对拍（D3 的一条腿）：本轮原话只有审稿意图 → 工具拦下不落盘；HTTP 按钮路无此门照常写", { timeout: 30_000 }, async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-gate-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 },
      { projectDir: toolDir, userTurnText: "审一下这一章" },
    );

    // HTTP 路无意图门（按钮直调语义）：照写
    expect(route.payload.ok).toBe(true);
    expect(await readTextIfExists(defaultDraftPath(routeDir, 1))).toContain(PARITY_MAIN_CHARACTER);

    // 工具路：原话无写作意图 → 拦在建快照/调模型之前，不落盘、不烧 writer
    expect(tool.ok).toBe(false);
    expect(tool.blockedReason).toBe("no_write_intent_this_turn");
    expect(await readTextIfExists(defaultDraftPath(toolDir, 1))).toBeUndefined();
    expect(draftMocks.writerCalls).toHaveLength(1); // 唯一一次是 HTTP 侧
  });
});

describe("parity: draft 对拍——显式策略分歧（两侧同调同一 service，差异只剩 policies/适配层投影，断言锁定现状）", () => {
  it("D1 字数下限（lengthPolicy）：同一份 328 字正文配 2000 字目标 → HTTP 路 422 拒写+不留文件；工具照写盘+⚠标注", { timeout: 30_000 }, async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-short-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir, { requestedDraftLength: 2000 }));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 2000 },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    // HTTP 路：lengthPolicy:"enforce_or_rollback" → 低于下限 → 拒写 + 回滚（无旧稿 → 删除引擎已写的文件）→ 422
    expect(route.statusCode).toBe(422);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("低于目标字数过多");
    expect(await readTextIfExists(defaultDraftPath(routeDir, 1))).toBeUndefined();

    // 工具路：lengthPolicy:"annotate" → 一次成稿不拒绝，draftLength 如实标注 below_lower_bound，summary 打 ⚠
    expect(tool.ok).toBe(true);
    expect((tool.draftLength as { lengthStatus: string }).lengthStatus).toBe("below_lower_bound");
    expect(String(tool.summary)).toContain("低于目标字数下限");
    expect(await readTextIfExists(defaultDraftPath(toolDir, 1))).toContain(PARITY_MAIN_CHARACTER);
  });

  it("D2 AI 腔簇（aiFlavorRecheck 开关）：同一含「殊不知」正文 → HTTP 路（false）无回检无去味（原样落盘）；工具路（true）回检+autoDeAi 真改落盘", { timeout: 30_000 }, async () => {
    draftMocks.writerBody = PARITY_AI_FLAVOR_BODY;
    // 去味改写模型（repair 槽，工具 execute 内经 streamChatModelToText 触达）：逐字原句 → 改写句。
    draftMocks.streamChatModelToText.mockResolvedValue({
      content: JSON.stringify({ rewrites: [{ text: PARITY_DEAI_SENTENCE, afterText: PARITY_DEAI_AFTER }] }),
      thinking: "",
    });
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-deai-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);

    // HTTP 路（aiFlavorRecheck:false）：report 无 aiFlavor 字段（没传规则给引擎），正文原样落盘（违规句还在）
    const routeReport = route.payload.report as Record<string, unknown>;
    expect("aiFlavor" in routeReport).toBe(false);
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    expect(routeDraft).toContain(PARITY_DEAI_SENTENCE);
    expect("autoDeAi" in route.payload).toBe(false);

    // 工具路（aiFlavorRecheck:true）：回检 1 处 high → autoDeAi 修掉、复检干净、落盘为改后稿
    expect(tool.aiFlavor).toEqual({ total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, truncated: false });
    expect(tool.autoDeAi).toMatchObject({ attempted: true, fixedCount: 1, remainingHighMedium: 0 });
    expect(String(tool.summary)).toContain("自动去 AI 味");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(toolDraft).not.toContain("殊不知");
    expect(toolDraft).toContain(PARITY_DEAI_AFTER);
    // 去味覆盖草稿前建了快照（M6 轻量快照），snapshotId 透出
    expect(typeof tool.snapshotId).toBe("string");
  });

  it("D2b autoDeAi 关断：工具传 autoDeAi:false → 只标注不改写，落盘与 HTTP 路一致（同稿同文）", { timeout: 30_000 }, async () => {
    draftMocks.writerBody = PARITY_AI_FLAVOR_BODY;
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-deai-off-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300, autoDeAi: false },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 只检测标注：aiFlavor 有、autoDeAi.attempted=false、原稿未动 → 两侧落盘字节一致
    expect(tool.aiFlavor).toEqual({ total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, truncated: false });
    expect(tool.autoDeAi).toMatchObject({ attempted: false, fixedCount: 0 });
    expect(draftMocks.streamChatModelToText).not.toHaveBeenCalled();
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(await readFile(defaultDraftPath(routeDir, 1), "utf-8"));
  });

  it("D3 章序护栏：写第 2 章而第 1 章未入库 → HTTP 路照写；工具 execute 拦截不入盘", { timeout: 30_000 }, async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-seq-");
    const body = { projectPath: routeDir, chapter: 2, chapterGoal: "第 2 章。", requestedDraftLength: 300 };

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", body);
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 2, chapterGoal: "第 2 章。", requestedDraftLength: 300 },
      // 带写作意图原话：让意图门放行、被测的是章序护栏这条腿（防「门先拦」掩盖护栏行为）。
      { projectDir: toolDir, userTurnText: "写第 2 章正文" },
    );

    // HTTP 路无护栏：第 2 章草稿照写
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(await readTextIfExists(defaultDraftPath(routeDir, 2))).toContain(PARITY_MAIN_CHARACTER);

    // 工具护栏：previous_chapter_not_committed，绝不落盘、不浪费模型
    expect(tool.ok).toBe(false);
    expect(tool.blockedReason).toBe("previous_chapter_not_committed");
    expect(tool.pendingChapterToCommit).toBe(1);
    expect(await readTextIfExists(defaultDraftPath(toolDir, 2))).toBeUndefined();
    // writer 工厂全程只被调了 1 次=HTTP 侧那次；工具侧拦在调模型之前，一次都没建 writer。
    expect(draftMocks.createConfiguredWriterClient).toHaveBeenCalledTimes(1);
  });

  it("D5a mustHitBeats 工具独有：同传漏写要点 → 工具 beatFidelity 如实报漏；HTTP 路直接忽略该字段", { timeout: 30_000 }, async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-beats-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir, { mustHitBeats: ["第三块砖"] }));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300, mustHitBeats: ["第三块砖"] },
      { projectDir: toolDir, userTurnText: WRITE_TURN_TEXT },
    );

    // HTTP 路：不认识 mustHitBeats，引擎无核对 → report 无 beatFidelity
    expect(route.payload.ok).toBe(true);
    expect("beatFidelity" in (route.payload.report as Record<string, unknown>)).toBe(false);

    // 工具路：确定性判漏 → triage 复核（本用例 mock 返回烂 JSON → unavailable，维持确定性结论）→ summary 首稿核对 ⚠
    expect(tool.ok).toBe(true);
    const beatFidelity = tool.beatFidelity as { missingBeats: readonly string[]; adjudication: string };
    expect(beatFidelity.missingBeats).toContain("第三块砖");
    expect(beatFidelity.adjudication).toBe("unavailable");
    expect(String(tool.summary)).toContain("首稿核对");
  });

  it("D5b persist:false 抽卡是 HTTP 路独有：只生成不落盘、不建快照；工具入参面无 persist", { timeout: 30_000 }, async () => {
    const { routeDir } = await makeParityTwinProjects("draft-candidate-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir, { persist: false }));

    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(String(route.payload.draftContent)).toContain(PARITY_CLEAN_BODY);
    // 抽卡候选：不写盘、不快照（ draft.ts 的 persist===false 分支）
    expect(await readTextIfExists(defaultDraftPath(routeDir, 1))).toBeUndefined();
    expect(await pathExists(join(routeDir, ".git"))).toBe(false);
    // 工具侧 inputSchema 无 persist 字段（对照 generate-draft.ts inputSchema）——此处锁定 schema 面而非行为。
    const shape = (generateDraftTool as unknown as { inputSchema?: { shape?: Record<string, unknown> } }).inputSchema?.shape;
    expect(shape).toBeTruthy();
    expect(shape && "persist" in shape).toBe(false);
  });
});
