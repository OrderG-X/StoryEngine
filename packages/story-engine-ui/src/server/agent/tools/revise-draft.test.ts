// @vitest-environment node
//
// revise_draft 纯逻辑单测：复刻 routes/draft-revision.ts 的 preview→apply 编排（进程内）。
// buildDraftRevisionPrompt → callModel(repair) → parseDraftRevisionPreview →
// applyDraftRevisionToContent（确定性替换，原文须在草稿中唯一出现）→ 写回草稿。
// callModel 注入 mock（返回固定 JSON），引擎应用走临时项目 fixture。草稿类不建 git 快照。
// 同时测试 execute 路径上的章号缺省回退（RequestContext.currentChapter）。
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";

import { defaultDraftPath } from "../../lib/project-io.js";
import { buildProjectRequestContext } from "../request-context.js";
import { locateTargetSpan, runReviseDraftToolLogic } from "./revise-draft.js";

describe("locateTargetSpan B4 改写定位（空白归一兜底）", () => {
  const draft = "第一段在这里。\n\n他缓缓抬起头，看向窗外的雨。\n\n第三段收尾。";

  it("精确唯一命中 → 返回 span", () => {
    const r = locateTargetSpan(draft, "他缓缓抬起头，看向窗外的雨。");
    expect(r).toEqual({ start: draft.indexOf("他缓缓抬起头"), end: draft.indexOf("他缓缓抬起头") + "他缓缓抬起头，看向窗外的雨。".length });
  });

  it("出现多次 → ambiguous", () => {
    expect(locateTargetSpan("重复句。重复句。", "重复句。")).toBe("ambiguous");
  });

  it("引号风格不一致（磁盘 curly “”，目标用 ASCII \"\" 或 「」）→ 引号归一兜底仍定位回真实区间（afterfix·改稿可用性）", () => {
    const d = "前段。\n\n“灯是我亲手关的。”\n\n后段。";
    for (const t of ["\"灯是我亲手关的。\"", "「灯是我亲手关的。」", "灯是我亲手关的。"]) {
      const r = locateTargetSpan(d, t);
      expect(r).not.toBe("not_found");
      expect(r).not.toBe("ambiguous");
    }
  });

  it("B4：模型回吐片段空白不一致（全角空格/多空格）→ 空白归一兜底仍定位回真实原文", () => {
    // 目标里把句中插了半角空格、换行被压成空格，精确 indexOf 必然失败
    const r = locateTargetSpan(draft, "他缓缓抬起头， 看向窗外的雨。");
    expect(r).not.toBe("not_found");
    expect(r).not.toBe("ambiguous");
    const span = r as { start: number; end: number };
    expect(draft.slice(span.start, span.end)).toBe("他缓缓抬起头，看向窗外的雨。"); // 切回的是真实原文
  });

  it("真的不在草稿里 → not_found（诚实拒绝、不乱猜）", () => {
    expect(locateTargetSpan(draft, "这段根本不存在于草稿。")).toBe("not_found");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Mocks for the execute path (LLM + snapshot are not needed in unit tests)
// ──────────────────────────────────────────────────────────────────────────
// 修订模型 2026-10-02 起走 streamChatModelToText（流式空闲超时，不再是非流式 60s 固定死表）。
const { callOpenAICompatibleChatModel, streamChatModelToText, resolveConfiguredChatModel } = vi.hoisted(() => ({
  callOpenAICompatibleChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
  resolveConfiguredChatModel: vi.fn(),
}));
vi.mock("../../lib/llm-client.js", () => ({ callOpenAICompatibleChatModel, streamChatModelToText, resolveConfiguredChatModel }));

const { snapshotBeforeDraftOverwrite } = vi.hoisted(() => ({ snapshotBeforeDraftOverwrite: vi.fn() }));
vi.mock("./snapshot-on-draft-overwrite.js", () => ({ snapshotBeforeDraftOverwrite }));

import { reviseDraftTool } from "./revise-draft.js";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const executeRevise = reviseDraftTool.execute as unknown as ToolExec;

function makeContext(projectDir: string, currentChapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, currentChapter) } as unknown as ToolExecutionContext;
}

/** Fixed model response that passes all guards. */
const MOCK_REVISION_JSON = JSON.stringify({
  beforeText: "林远推开了那扇门",
  afterText: "林远轻轻带上了那扇门",
  changeSummary: "弱化动作幅度。",
});

async function makeProject(title: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "revise-draft-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName: "林远",
  });
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(defaultDraftPath(projectDir, chapter), content, "utf-8");
}

describe("revise_draft 草稿局部修订工具", () => {
  it("命中唯一原文 → 确定性替换并写回草稿，返回 preview 与 refreshScope:full，不带 snapshotId", async () => {
    const projectDir = await makeProject("修订");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远推开了那扇门，门后是空荡的走廊。\n");
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "林远推开了那扇门",
      revisionGoal: "把动作写得更克制一些。",
      callModel: async () =>
        JSON.stringify({
          beforeText: "林远推开了那扇门",
          afterText: "林远轻轻带上了那扇门",
          changeSummary: "弱化动作幅度。",
        }),
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.refreshScope).toBe("full");
    expect("snapshotId" in out).toBe(false);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远轻轻带上了那扇门");
    expect(onDisk).not.toContain("林远推开了那扇门");
    expect(out.preview.afterText).toContain("轻轻带上");
    // 成功修订必须把「修订后的完整草稿正文（去 Markdown 章节标题）」放进 draftBody，
    // 供 agent 路径把真正文载入工作区，避免 read/刷新时被占位覆盖、autosave 抹掉。
    expect(out.draftBody).toContain("林远轻轻带上了那扇门");
    expect(out.draftBody).not.toContain("# 第1章");
  });

  it("模型漂移到别的句子（改了别处、用户点名的目标句仍逐字留稿）→ 诚实 ok:false/applied:false，绝不谎称已改（afterfix·改稿谎报根治）", async () => {
    const projectDir = await makeProject("改稿漂移谎报");
    const draft = "# 第1章\n\n灯是我亲手关的。\n\n他点了点头，没有说话。\n";
    await writeDraft(projectDir, 1, draft);
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "灯是我亲手关的。", // 用户点名要改/删这句
      revisionGoal: "删掉这句。",
      // 模型漂移：beforeText 指向草稿里【另一句】、改了别处，用户的目标句一个字没动
      callModel: async () =>
        JSON.stringify({ beforeText: "他点了点头，没有说话。", afterText: "他缓缓点了下头。", changeSummary: "润色" }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("灯是我亲手关的。"); // 目标句仍在=没被改 → 必须诚实拒、不落盘
    expect(out.summary).not.toMatch(/已.*修订|已完成|改好/u);
  });

  it("给了精确替换文本 → 原样落地、跳过模型改写（afterfix·真机：模型拿到精确文本却自行改写成别的）", async () => {
    const projectDir = await makeProject("精确替换");
    await writeDraft(projectDir, 1, "# 第1章\n\n“灯是我亲手关的。”\n\n他没再说话。\n");
    let modelCalled = false;
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "\"灯是我亲手关的。\"", // ASCII 引号（磁盘 curly），靠引号归一定位
      revisionGoal: "换成我指定的句子。",
      replacementText: "“灯灭前，有人承认自己碰过开关，但声音在关键处被海浪吞掉。”",
      callModel: async () => { modelCalled = true; return "{}"; },
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(modelCalled).toBe(false); // 确定性：没调模型
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("灯灭前，有人承认自己碰过开关，但声音在关键处被海浪吞掉"); // 精确文本原样落地
    expect(onDisk).not.toContain("灯是我亲手关的");
  });

  it("精确替换文本与原句一致 → no-op 诚实拒，不谎称已改", async () => {
    const projectDir = await makeProject("精确替换no-op");
    await writeDraft(projectDir, 1, "# 第1章\n\n原样这句。\n");
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "原样这句。",
      revisionGoal: "换。",
      replacementText: "原样这句。",
      callModel: async () => "{}",
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
  });

  it("对白引号风格不一致也能真改稿：磁盘 curly “”、目标/模型用 ASCII \"\" → 真替换、写回、ok:true（afterfix·改稿可用性）", async () => {
    const projectDir = await makeProject("引号改稿");
    await writeDraft(projectDir, 1, "# 第1章\n\n“灯是我亲手关的。”\n\n他没再说话。\n");
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "\"灯是我亲手关的。\"", // ASCII 引号（磁盘是 curly “”）
      revisionGoal: "改写这句对白。",
      callModel: async () =>
        JSON.stringify({
          beforeText: "\"灯是我亲手关的。\"", // 模型也用 ASCII 引号
          afterText: "“灯灭前，有人碰过开关。”",
          changeSummary: "改写对白",
        }),
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("灯灭前，有人碰过开关");
    expect(onDisk).not.toContain("灯是我亲手关的");
  });

  it("模型把片段原样 echo 回（afterText===beforeText）→ no-op：诚实 applied:false，不谎称已完成修订", async () => {
    const projectDir = await makeProject("echo空操作");
    const draft = "# 第1章\n\n林远推开了那扇门，门后是空荡的走廊。\n";
    await writeDraft(projectDir, 1, draft);
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "林远推开了那扇门",
      revisionGoal: "把动作写得更克制一些。",
      callModel: async () =>
        JSON.stringify({
          beforeText: "林远推开了那扇门",
          afterText: "林远推开了那扇门", // 原样 echo 回 → 等于没改
          changeSummary: "（实际没有改动）",
        }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.summary).not.toContain("完成局部修订"); // 不许谎称已修订
  });

  it("B3：style=deai → 去 AI 味手法注入修订目标、喂进 prompt（agent 能驱动去 AI 味，不退化成普通润色）", async () => {
    const projectDir = await makeProject("去AI味");
    await writeDraft(projectDir, 1, "# 第1章\n\n那一刻，他心中五味杂陈，仿佛整个世界都安静了。\n");
    let capturedPrompt = "";
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "那一刻，他心中五味杂陈，仿佛整个世界都安静了。",
      revisionGoal: "", // 去 AI 味不必额外目标，靠 style 注入手法
      style: "deai",
      callModel: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          beforeText: "那一刻，他心中五味杂陈，仿佛整个世界都安静了。",
          afterText: "他捏紧了杯子，没说话。窗外的车流一辆接一辆。",
          changeSummary: "去掉抒情套路，改成具体动作。",
        });
      },
    });
    expect(out.ok).toBe(true);
    expect(capturedPrompt).toContain("AI 腔");      // 去 AI 味手法确实进了 prompt
    expect(capturedPrompt).toContain("具体的动作");
  });

  it("原文片段在草稿中出现多次 → 诚实拒绝，不写回（applyDraftRevisionToContent 守卫）", async () => {
    const projectDir = await makeProject("多处");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远走进来。后来林远走进来。\n");
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "林远走进来",
      revisionGoal: "改写。",
      callModel: async () =>
        JSON.stringify({ beforeText: "林远走进来", afterText: "林远快步进来", changeSummary: "改" }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.summary).toMatch(/多次|唯一|未/u);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("后来林远走进来");
  });

  it("原文片段不在草稿中 → 诚实拒绝，不写回", async () => {
    const projectDir = await makeProject("缺片段");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远站在窗前。\n");
    const out = await runReviseDraftToolLogic({
      projectDir,
      chapter: 1,
      targetText: "完全不存在的一段话",
      revisionGoal: "改写。",
      callModel: async () => JSON.stringify({ afterText: "随便" }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.summary).toMatch(/找到|不在|没有/u);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// execute 路径：章号缺省回退（RequestContext.currentChapter）
// ──────────────────────────────────────────────────────────────────────────
describe("revise_draft execute 章号缺省回退", () => {
  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const projectDir = await makeProject("回退第5章");
    // 在第5章写入草稿（targetText 必须存在且唯一）
    await writeDraft(projectDir, 5, "# 第5章\n\n林远推开了那扇门，门后是空荡的走廊。\n");

    // 配置 mock
    resolveConfiguredChatModel.mockResolvedValue({
      profile: { temperature: 0.45, maxTokens: 1800 },
    });
    streamChatModelToText.mockResolvedValue({ content: MOCK_REVISION_JSON, thinking: "" });
    snapshotBeforeDraftOverwrite.mockResolvedValue(undefined);

    const context = makeContext(projectDir, 5);
    const out = await executeRevise(
      {
        // 故意不传 chapter
        targetText: "林远推开了那扇门",
        revisionGoal: "把动作写得更克制一些。",
      },
      context,
    ) as { ok: boolean; applied: boolean; summary: string };

    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    // summary 应提及第5章（runReviseDraftToolLogic 拼 summary 时用 resolvedChapter=5）
    expect(out.summary).toContain("第 5 章");
    // 第5章草稿被改写
    const onDisk = await readFile(defaultDraftPath(projectDir, 5), "utf-8");
    expect(onDisk).toContain("林远轻轻带上了那扇门");
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含「缺少章号」", async () => {
    const projectDir = await makeProject("无章号");
    const context = makeContext(projectDir); // 不注入 currentChapter
    await expect(
      executeRevise(
        {
          targetText: "任意文字",
          revisionGoal: "任意目标。",
        },
        context,
      ),
    ).rejects.toThrow(/缺少章号/u);
  });
});
