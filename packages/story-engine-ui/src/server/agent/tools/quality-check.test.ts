// @vitest-environment node
//
// quality_check 纯逻辑单测：薄适配层 + 共享 services/quality-service.ts 编排（进程内）。
// checkDraftBeforeCommit（确定性）+ judgeDraftQualityWithModel（无候选时短路、不调模型）。
// 只读：不建快照、不带 snapshotId / refreshScope。引擎读取走临时项目 fixture。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";

import type { CommitQualityReport } from "@actalk/story-engine";

// mock judgeDraftQualityWithModel so execute() path never touches the network.
vi.mock("../../lib/quality-judge.js", () => ({
  judgeDraftQualityWithModel: vi.fn(async ({ deterministicQuality }: { deterministicQuality: CommitQualityReport }) => ({
    ...deterministicQuality,
    modelJudge: { used: false, fallbackUsed: false, summary: "mock: 跳过 AI 判定。" },
  })),
}));

import { chapterWorkspacePath, defaultDraftPath } from "../../lib/project-io.js";
import { buildProjectRequestContext } from "../request-context.js";
import { buildQualityCheckToolOutput, qualityCheckTool, resolveDraftContentForQualityCheck, type QualityJudge } from "./quality-check.js";

// 确定性 AI 判定桩：不触网，原样返回确定性报告并标 modelJudge.used=false（等价于「无候选短路」）。
const passthroughJudge: QualityJudge = async ({ deterministicQuality }): Promise<CommitQualityReport> => ({
  ...deterministicQuality,
  modelJudge: { used: false, fallbackUsed: false, summary: "测试桩：跳过 AI 判定。" },
});

async function makeProject(title: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "quality-check-test-"));
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

// 写一份 workspace 草稿记录（编辑器/写作区看到的就是它的 draftContent）。
async function writeWorkspaceDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  const path = chapterWorkspacePath(projectDir, chapter);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ chapter, flowStatus: "draft_ready", draftContent: content, messages: [], selectedAdviceCardKeys: [] }),
    "utf-8",
  );
}

// 写作台显示用空草稿占位符（buildStateBackedDraftPlaceholder 同款开头），非用户/AI 写的真正文。
const PLACEHOLDER_DRAFT = "还没有草稿正文。\n\n你可以在右侧章节对话里输入第 1 章方向，先整理本章方案，再生成草稿。\n";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const executeViaContext = qualityCheckTool.execute as unknown as ToolExec;

function ctx(projectDir: string, currentChapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, currentChapter) } as unknown as ToolExecutionContext;
}

describe("quality_check 章号缺省回退（H3）", () => {
  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const projectDir = await makeProject("回退5章");
    await writeDraft(projectDir, 5, longDraft(5));
    const out = await executeViaContext({ draftContent: longDraft(5) }, ctx(projectDir, 5)) as { chapter: number };
    expect(out.chapter).toBe(5);
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含『缺少章号』", async () => {
    const projectDir = await makeProject("无章号");
    await expect(executeViaContext({}, ctx(projectDir))).rejects.toThrow(/缺少章号/);
  });
});

describe("quality_check 只读质检工具", () => {
  it("正文过短 → 确定性质检报 error 级问题（不调模型也能拦），只读不带 snapshotId", async () => {
    const projectDir = await makeProject("过短");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远来了。\n");
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, judge: passthroughJudge });
    expect(out.quality.issues.some((issue) => issue.severity === "error")).toBe(true);
    // A5：质检本身跑成（ok=true），但有阻止级问题 → partialMiss=true（前端显琥珀「部分完成」而非绿「已完成」）。
    expect(out.ok).toBe(true);
    expect(out.partialMiss).toBe(true);
    expect("snapshotId" in out).toBe(false);
    expect("refreshScope" in out).toBe(false);
    expect(out.summary).toBeTruthy();
  });

  it("合格草稿 → passed=true，并经过 AI 判定层（此处用桩，不触网）", async () => {
    const projectDir = await makeProject("合格");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, judge: passthroughJudge });
    expect(out.quality.passed).toBe(true);
    expect(out.quality.modelJudge?.used).toBe(false);
    // A5：合格草稿 → 无阻止级问题 → ok=true 且 partialMiss=false（显绿「已完成」名副其实）。
    expect(out.ok).toBe(true);
    expect(out.partialMiss).toBe(false);
  });

  // 铁律④·绝不静默失败：AI 语义判定层走 fallback（超时/网络失败）时，summary 必须诚实披露「未跑完」，
  // 不能只摊确定性结论让 agent 当成「通过、可入库」转告用户。
  it("AI 语义判定走 fallback（fallbackUsed=true）→ summary 诚实披露未完成，不掩盖", async () => {
    const projectDir = await makeProject("AI判定fallback");
    await writeDraft(projectDir, 1, longDraft(1));
    const fallbackJudge: QualityJudge = async ({ deterministicQuality }): Promise<CommitQualityReport> => ({
      ...deterministicQuality,
      modelJudge: { used: true, fallbackUsed: true, summary: "AI 判定未完成，已保留规则候选与默认风险分类。" },
    });
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, judge: fallbackJudge });
    expect(out.summary).toContain("AI 语义判定本轮未完成");
  });

  it("显式传入 draftContent（盘上无稿）→ 末位兜底仍能质检（FS 抖动安全网）", async () => {
    const projectDir = await makeProject("显式");
    // 盘上没有草稿文件，靠传入正文也能质检
    const out = await buildQualityCheckToolOutput({
      projectDir,
      chapter: 1,
      draftContent: longDraft(1),
      judge: passthroughJudge,
    });
    expect(out.quality.passed).toBe(true);
  });

  it("agent 路：模型传的 draftContent 与盘上真稿不一致 → 以盘上为准（不信模型臆想的正文，afterfix·Codex 真机）", async () => {
    const projectDir = await makeProject("模型臆想正文");
    await writeDraft(projectDir, 1, longDraft(1)); // 磁盘真稿
    const modelImagined = `灯灭前，有人承认自己碰过开关……${"补足长度。".repeat(80)}`; // 模型臆想的"已改好"版（够长算真稿）
    const resolved = await resolveDraftContentForQualityCheck({
      projectDir,
      chapter: 1,
      explicitDraftContent: modelImagined, // 默认 trustExplicit=false（agent 路）
      delayMs: 0,
    });
    expect(resolved.content).toBe(longDraft(1)); // 用磁盘真稿，不用模型臆想的
    expect(resolved.content).not.toContain("灯灭前");
  });

  it("路由路 trustExplicit=true：编辑器实时正文比盘新 → 顶格优先（保住编辑器未存盘的真稿）", async () => {
    const projectDir = await makeProject("编辑器实时稿");
    await writeDraft(projectDir, 1, longDraft(1)); // 盘上旧稿
    const editorLive = `编辑器里刚改的实时正文。${"还没存盘呢。".repeat(80)}`;
    const resolved = await resolveDraftContentForQualityCheck({
      projectDir,
      chapter: 1,
      explicitDraftContent: editorLive,
      trustExplicit: true, // 路由（编辑器）传
      delayMs: 0,
    });
    expect(resolved.content).toBe(editorLive); // 编辑器实时稿优先
  });
});

// 真机 QA bug（2026-06-26）：新书写完第1章「立刻质检」误报「正文为空」拦住入库，但正文在
// 工作区+编辑器+磁盘都有，约2分钟后重跑才正常。根因=质检读裸文件、无重试、不过滤占位符——
// 草稿落盘的时序竞争窗口里读到空/占位符（占位符约50字→误报「正文过短」），把真稿当没写。
// 修后：质检按 真显式正文 → 文件(带重试) → workspace 原始草稿 → 诚实「无草稿」 顺序取真稿，
// 真稿存在任一处就用真稿质检，绝不误报空/短；三处皆无才诚实回报「还没正文可质检」。
describe("quality_check 防误报「正文为空/过短」（草稿落盘时序竞争）", () => {
  it("工作稿文件暂空、但 workspace 有真草稿 → 用 workspace 真稿质检，不误报「正文为空」", async () => {
    const projectDir = await makeProject("文件空回落workspace");
    await writeDraft(projectDir, 1, ""); // 落盘瞬间文件为空
    await writeWorkspaceDraft(projectDir, 1, longDraft(1)); // 编辑器/写作区已有真稿
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, judge: passthroughJudge, delayMs: 0 });
    expect(out.passed).toBe(true);
    expect(out.refined.blocking.some((b) => b.type === "empty_draft")).toBe(false);
  });

  it("工作稿文件是显示用占位符、但 workspace 有真草稿 → 用真稿，不把50字占位符误报成「正文过短」", async () => {
    const projectDir = await makeProject("文件占位回落workspace");
    await writeDraft(projectDir, 1, PLACEHOLDER_DRAFT);
    await writeWorkspaceDraft(projectDir, 1, longDraft(1));
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, judge: passthroughJudge, delayMs: 0 });
    expect(out.passed).toBe(true);
    expect(out.refined.blocking.some((b) => b.type === "too_short" || b.type === "empty_draft")).toBe(false);
  });

  it("显式传入空 draftContent、但盘上有真稿 → 忽略空显式、读盘真稿质检（空串不被当成空稿）", async () => {
    const projectDir = await makeProject("空显式回落读盘");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, draftContent: "", judge: passthroughJudge, delayMs: 0 });
    expect(out.passed).toBe(true);
  });

  // E2E 实锤：模型给 draftContent 传哨兵字面串 "None"（4字）→ 旧码当真稿质检 → 误报「正文过短」造假硬伤。
  // 哨兵串 None/null/undefined 视同缺省、回落读盘。
  it("显式传入哨兵串 'None'、但盘上有真稿 → 忽略哨兵显式、读盘真稿（不造假硬伤）", async () => {
    const projectDir = await makeProject("哨兵显式回落读盘");
    await writeDraft(projectDir, 1, longDraft(1));
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, draftContent: "None", judge: passthroughJudge, delayMs: 0 });
    expect(out.passed).toBe(true);
    expect(out.refined.blocking.some((b) => b.type === "too_short" || b.type === "empty_draft")).toBe(false);
  });

  it("三处都没真草稿 → 诚实回报「还没正文可质检」，不谎报「正文为空」误导用户以为正文被吃了", async () => {
    const projectDir = await makeProject("真没草稿");
    await writeDraft(projectDir, 1, ""); // 空文件、workspace 也没真稿
    const out = await buildQualityCheckToolOutput({ projectDir, chapter: 1, judge: passthroughJudge, delayMs: 0 });
    expect(out.passed).toBe(false);
    expect(out.partialMiss).toBe(true);
    expect(out.refined.blocking.some((b) => b.type === "draft_not_found_for_check")).toBe(true);
    expect(out.refined.blocking.some((b) => b.type === "empty_draft")).toBe(false);
    expect(out.summary).toContain("还没");
  });
});
