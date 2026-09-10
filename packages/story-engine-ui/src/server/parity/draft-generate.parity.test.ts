// @vitest-environment node
//
// 双轨对拍（parity）：routes/draft.ts 的 POST /api/draft/generate（非流式）↔ agent/tools/generate-draft.ts 的 generate_draft。
// 同一真引擎 + 同种子双胞胎 fixture + 同一个 mock writer，分别驱动 route handler 与 tool execute，断言语义等价。
//
// 已知刻意分歧（显式豁免清单；每条锁定现状并附代码证据——分歧被消除时应改这里，新增分歧会直接红）：
//   D1 字数下限：HTTP 路低于下限 → 422 拒写并回滚旧稿（draft.ts enforceDraftLengthTarget + restoreDraftFile）；
//      工具路照写盘、summary 打 ⚠ 标注（generate-draft.ts 头注释 / buildDraftLengthWarning）。
//   D2 AI 腔簇：工具路给引擎传 aiFlavorRules 做回检，且 high/medium 默认接一轮 autoDeAi 改写落盘
//      （generate-draft.ts sharedDraftInput.aiFlavorRules + runAutoDeAiRound）；HTTP 路两者皆无
//      （draft.ts handleGenerateDraft 的 runFastDraft 入参无 aiFlavorRules）。
//   D3 章序护栏：仅工具 execute 有（前一章未入库则拦截，generate-draft.ts execute 内 evaluateChapterSequencingGuard）；
//      HTTP 路无护栏、直接写（draft.ts handleGenerateDraft）。
//   D4 快照时机：HTTP 路每次出稿前无条件 createSnapshot（draft.ts handleGenerateDraft）；
//      工具首次出稿不建、仅覆盖已有非空草稿时 snapshotBeforeDraftOverwrite（snapshot-on-draft-overwrite.ts）。
//   D5 输入面：mustHitBeats/candidates/autoDeAi 是工具独有入参（generate-draft.ts inputSchema）；
//      persist:false 抽卡是 HTTP 路独有入参（draft.ts handleGenerateDraft 的 persist 分支），工具侧无对应模式。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WriterClient } from "@actalk/story-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// LLM 边界 mock：writer 由每个用例经 draftMocks.writerBody 驱动；引擎包保持真实。
// routes/draft.js 与 agent/tools/generate-draft.js 解析到同一个 llm-client 模块，一次 mock 两侧生效。
// ---------------------------------------------------------------------------
const draftMocks = vi.hoisted(() => ({
  writerBody: "",
  writerTitle: "夜探",
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

beforeEach(() => {
  vi.clearAllMocks();
  draftMocks.writerBody = PARITY_CLEAN_BODY;
  draftMocks.writerTitle = "夜探";
  draftMocks.createConfiguredWriterClient.mockImplementation(async (): Promise<WriterClient> => ({
    async generateDraft() {
      return { title: draftMocks.writerTitle, content: draftMocks.writerBody };
    },
  }));
  draftMocks.createOpenAICompatibleWriterClient.mockImplementation((): WriterClient => ({
    async generateDraft() {
      return { title: draftMocks.writerTitle, content: draftMocks.writerBody };
    },
  }));
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
  it("长度窗口假设自证：对拍正文 328 字，落在 requestedDraftLength:300 的 [300,345] 窗口内", () => {
    // 这条不是对拍，是 fixture 自证：正文改动若把字数推出窗口，下面的 happy-path 会假性变红。
    expect(countParityCjk(PARITY_CLEAN_BODY)).toBeGreaterThanOrEqual(300);
    expect(countParityCjk(PARITY_CLEAN_BODY)).toBeLessThanOrEqual(345);
    expect(countParityCjk(PARITY_AI_FLAVOR_BODY)).toBeGreaterThanOrEqual(300);
    expect(countParityCjk(PARITY_AI_FLAVOR_BODY)).toBeLessThanOrEqual(345);
  });

  it("happy path：同一 mock 正文 → 两侧 ok，drafts/fast 落盘字节一致，关键字段等价", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-happy-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(generateDraftTool, { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 }, { projectDir: toolDir });

    // ok 契约
    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);

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

    // D4a（豁免清单·快照时机）：HTTP 路首次出稿也建 git 快照；工具首次出稿无旧稿可丢、不建。
    expect(await pathExists(join(routeDir, ".git"))).toBe(true);
    expect(await pathExists(join(toolDir, ".git"))).toBe(false);
    expect("snapshotId" in route.payload).toBe(false);
    expect("snapshotId" in tool).toBe(false);
  });

  it("覆盖已有草稿再出稿：两侧都先建可撤销快照（D4b：工具仅此时建，且把 snapshotId 透出给前端）", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-overwrite-");
    await writeParityDraft(routeDir, 1, parityDraftFileText(1, `${PARITY_CLEAN_BODY.slice(0, 200)}旧版收尾。`));
    await writeParityDraft(toolDir, 1, parityDraftFileText(1, `${PARITY_CLEAN_BODY.slice(0, 200)}旧版收尾。`));

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(generateDraftTool, { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 }, { projectDir: toolDir });

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
});

describe("parity: draft 对拍——已知刻意分歧（豁免清单，断言锁定分歧存在）", () => {
  it("D1 字数下限：同一份 328 字正文配 2000 字目标 → HTTP 路 422 拒写+不留文件；工具照写盘+⚠标注", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-short-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir, { requestedDraftLength: 2000 }));
    const tool = await driveToolExecute(generateDraftTool, { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 2000 }, { projectDir: toolDir });

    // HTTP 路：enforceDraftLengthTarget 低于下限 → 422 + restoreDraftFile（无旧稿 → 删除引擎已写的文件）
    expect(route.statusCode).toBe(422);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("低于目标字数过多");
    expect(await readTextIfExists(defaultDraftPath(routeDir, 1))).toBeUndefined();

    // 工具路：一次成稿不拒绝，draftLength 如实标注 below_lower_bound，summary 打 ⚠
    expect(tool.ok).toBe(true);
    expect((tool.draftLength as { lengthStatus: string }).lengthStatus).toBe("below_lower_bound");
    expect(String(tool.summary)).toContain("低于目标字数下限");
    expect(await readTextIfExists(defaultDraftPath(toolDir, 1))).toContain(PARITY_MAIN_CHARACTER);
  });

  it("D2 AI 腔簇：同一含「殊不知」正文 → HTTP 路无回检无去味（原样落盘）；工具回检+autoDeAi 真改落盘", async () => {
    draftMocks.writerBody = PARITY_AI_FLAVOR_BODY;
    // 去味改写模型（repair 槽，工具 execute 内经 streamChatModelToText 触达）：逐字原句 → 改写句。
    draftMocks.streamChatModelToText.mockResolvedValue({
      content: JSON.stringify({ rewrites: [{ text: PARITY_DEAI_SENTENCE, afterText: PARITY_DEAI_AFTER }] }),
      thinking: "",
    });
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-deai-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(generateDraftTool, { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300 }, { projectDir: toolDir });

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);

    // HTTP 路：report 无 aiFlavor 字段（没传规则给引擎），正文原样落盘（违规句还在）
    const routeReport = route.payload.report as Record<string, unknown>;
    expect("aiFlavor" in routeReport).toBe(false);
    const routeDraft = await readFile(defaultDraftPath(routeDir, 1), "utf-8");
    expect(routeDraft).toContain(PARITY_DEAI_SENTENCE);
    expect("autoDeAi" in route.payload).toBe(false);

    // 工具路：回检 1 处 high → autoDeAi 修掉、复检干净、落盘为改后稿
    expect(tool.aiFlavor).toEqual({ total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, truncated: false });
    expect(tool.autoDeAi).toMatchObject({ attempted: true, fixedCount: 1, remainingHighMedium: 0 });
    expect(String(tool.summary)).toContain("自动去 AI 味");
    const toolDraft = await readFile(defaultDraftPath(toolDir, 1), "utf-8");
    expect(toolDraft).not.toContain("殊不知");
    expect(toolDraft).toContain(PARITY_DEAI_AFTER);
    // 去味覆盖草稿前建了快照（M6 轻量快照），snapshotId 透出
    expect(typeof tool.snapshotId).toBe("string");
  });

  it("D2b autoDeAi 关断：工具传 autoDeAi:false → 只标注不改写，落盘与 HTTP 路一致（同稿同文）", async () => {
    draftMocks.writerBody = PARITY_AI_FLAVOR_BODY;
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-deai-off-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300, autoDeAi: false },
      { projectDir: toolDir },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 只检测标注：aiFlavor 有、autoDeAi.attempted=false、原稿未动 → 两侧落盘字节一致
    expect(tool.aiFlavor).toEqual({ total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, truncated: false });
    expect(tool.autoDeAi).toMatchObject({ attempted: false, fixedCount: 0 });
    expect(draftMocks.streamChatModelToText).not.toHaveBeenCalled();
    expect(await readFile(defaultDraftPath(toolDir, 1), "utf-8")).toBe(await readFile(defaultDraftPath(routeDir, 1), "utf-8"));
  });

  it("D3 章序护栏：写第 2 章而第 1 章未入库 → HTTP 路照写；工具 execute 拦截不入盘", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-seq-");
    const body = { projectPath: routeDir, chapter: 2, chapterGoal: "第 2 章。", requestedDraftLength: 300 };

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", body);
    const tool = await driveToolExecute(generateDraftTool, { chapter: 2, chapterGoal: "第 2 章。", requestedDraftLength: 300 }, { projectDir: toolDir });

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

  it("D5a mustHitBeats 工具独有：同传漏写要点 → 工具 beatFidelity 如实报漏；HTTP 路直接忽略该字段", async () => {
    const { routeDir, toolDir } = await makeParityTwinProjects("draft-beats-");

    const route = await callRoute(registerDraftRoutes, "POST", "/api/draft/generate", generateBody(routeDir, { mustHitBeats: ["第三块砖"] }));
    const tool = await driveToolExecute(
      generateDraftTool,
      { chapter: 1, chapterGoal: CHAPTER_GOAL, requestedDraftLength: 300, mustHitBeats: ["第三块砖"] },
      { projectDir: toolDir },
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

  it("D5b persist:false 抽卡是 HTTP 路独有：只生成不落盘、不建快照；工具入参面无 persist", async () => {
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
