// @vitest-environment node
//
// commit_preview 纯逻辑单测：缺草稿诚实拒发 token；草稿过短(质量 error)不可入库；
// 合格草稿可入库并签发 previewToken。引擎写入用临时项目 fixture。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 工具 execute 路径会走生产版 declareChapterDelta（真连 LLM 网络）——单测 mock 掉、恒返回 undefined，
// 避免 execute 测试依赖网络变 flaky/超时。纯逻辑测试直接给 buildCommitPreviewToolOutput 传假 declareDelta，不受影响。
vi.mock("./chapter-delta-declaration.js", () => ({
  declareChapterDelta: vi.fn(async () => undefined),
  callConfiguredDeclareModel: vi.fn(async () => "{}"),
}));

import { buildProjectRequestContext } from "../request-context.js";
import { defaultCommittedChapterPath } from "../../lib/project-io.js";
import { __resetCommitPreviewStore, findCommitPreview } from "./commit-preview-store.js";
import { buildCommitPreviewToolOutput, commitPreviewTool } from "./commit-preview.js";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const execute = commitPreviewTool.execute as unknown as ToolExec;

beforeEach(() => {
  __resetCommitPreviewStore();
});

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "commit-preview-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

/** 构造一段够长（>300 中文字）且提到主角的合格草稿正文。 */
function longDraft(chapter: number, mainCharacterName: string): string {
  const sentence = `${mainCharacterName}在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。`;
  const body = Array.from({ length: 12 }, () => sentence).join("");
  return `# 第${chapter}章\n\n${body}\n`;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(
    join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
    content,
    "utf-8",
  );
}

describe("commit_preview", () => {
  it("缺草稿 → canCommit=false，blockingReasons 含 missing_draft，不发 token", async () => {
    const projectDir = await makeProject("缺草稿");
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.ok).toBe(false); // ok=canCommit：不可入库→ok:false（前端时间线置 failed，不绿色谎报）
    expect(out.canCommit).toBe(false);
    expect(out.previewToken).toBeUndefined();
    expect(out.blockingReasons).toContain("missing_draft");
  });

  it("草稿过短 → 质量 error 阻止入库，不发 token", async () => {
    const projectDir = await makeProject("过短", "林远");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远来了。\n");
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.canCommit).toBe(false);
    expect(out.previewToken).toBeUndefined();
    expect(out.draftQualityIssues.some((issue) => issue.severity === "error")).toBe(true);
  });

  it("合格草稿 → canCommit=true 并签发 previewToken", async () => {
    const projectDir = await makeProject("合格草稿", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.blockingReasons).toEqual([]);
    expect(out.ok).toBe(true); // 可入库→ok:true
    expect(out.canCommit).toBe(true);
    expect(typeof out.previewToken).toBe("string");
    expect(out.previewToken).toBeTruthy();
  });

  // 2026-08-11 真机走查回归：summary 会被 UI 实时字幕/步骤卡原样展示——绝不许出现内部工具名或
  // 「请转达」类模型指令（铁律④）；行动指引走 modelHint（仅模型可见）。
  it("summary 是用户可见文案：不含 commit_apply 等内部工具名与模型指令；指引在 modelHint", async () => {
    const projectDir = await makeProject("摘要不泄漏", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.summary).not.toContain("commit_apply");
    expect(out.summary).not.toMatch(/请如实转达|请转达|勿淡化|勿隐去/u);
    expect(out.summary).toContain("可以定稿");
    // 模型侧指引仍在（弱模型接缝防御）：canCommit 时提示等待用户确认后再 commit_apply
    expect(out.modelHint).toContain("commit_apply");
    expect(out.modelHint).toContain("确认");
  });

  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const projectDir = await makeProject("回退到当前章", "林远");
    await writeDraft(projectDir, 5, longDraft(5, "林远"));
    const context = { requestContext: buildProjectRequestContext(projectDir, 5) } as unknown as ToolExecutionContext;
    const out = await execute({}, context) as { chapter: number; canCommit: boolean };
    expect(out.chapter).toBe(5);
    expect(out.canCommit).toBe(true);
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含「缺少章号」", async () => {
    const projectDir = await makeProject("无章号", "林远");
    const context = { requestContext: buildProjectRequestContext(projectDir) } as unknown as ToolExecutionContext;
    await expect(execute({}, context)).rejects.toThrow("缺少章号");
  });

  // 阶段 4：注入 declareDelta（模拟模型声明）→ 声明随 previewToken 缓存，供 apply 复用。
  it("注入 declareDelta → 声明随 previewToken 缓存进 store record", async () => {
    const projectDir = await makeProject("缓存声明", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const declaration = {
      chapter: 1,
      mainEvent: { summary: "林远掂量账册", quote: "林远在会议室外停下脚步" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };
    const out = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => declaration,
    });
    expect(out.canCommit).toBe(true);
    const record = findCommitPreview(projectDir, 1);
    expect(record?.declaration).toEqual(declaration);
  });

  it("第2章起：declareDelta 收到上一章结尾摘录，用于衔接判断", async () => {
    const projectDir = await makeProject("传上一章结尾", "林远");
    await writeFile(
      defaultCommittedChapterPath(projectDir, 1),
      `# 第1章\n\n${Array.from({ length: 10 }, (_, index) => `上一章正式正文第${index}段，林远已经在黑龙潭边等候。`).join("\n")}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 2, longDraft(2, "林远"));

    let seenEnding: string | undefined;
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async ({ previousChapterEnding }) => {
        seenEnding = previousChapterEnding;
        return undefined;
      },
    });

    expect(seenEnding).toContain("黑龙潭边等候");
    expect((seenEnding ?? "").length).toBeLessThanOrEqual(520);
  });

  it("声明 continuityWithPrevious=false → 固定 continuity_break warning + 摘要提醒，且不阻断入库", async () => {
    const projectDir = await makeProject("衔接断裂提醒", "林远");
    await writeFile(defaultCommittedChapterPath(projectDir, 1), "# 第1章\n\n林远已经在黑龙潭边等候。\n", "utf-8");
    await writeDraft(projectDir, 2, longDraft(2, "林远"));

    const out = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async () => ({
        chapter: 2,
        mainEvent: { summary: "林远掂量账册", quote: "林远在会议室外停下脚步" },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
        pendingIntents: [],
        continuityWithPrevious: { connects: false, note: "上一章结尾已在黑龙潭等待，本章开头却回到会议室。" },
      }),
    });

    expect(out.canCommit).toBe(true);
    expect(out.semanticQualityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        type: "continuity_break",
        message: expect.stringContaining("上一章结尾已在黑龙潭等待"),
      }),
    ]));
    expect(out.blockingReasons).not.toContain("semantic_quality_error");
    expect(out.summary).toContain("跨章衔接提醒");
  });

  it("声明 continuityWithPrevious=true 或缺省 → 不产生 continuity_break warning", async () => {
    const projectDir = await makeProject("衔接正常", "林远");
    await writeFile(defaultCommittedChapterPath(projectDir, 1), "# 第1章\n\n林远已经在黑龙潭边等候。\n", "utf-8");
    await writeDraft(projectDir, 2, longDraft(2, "林远"));

    const out = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async () => ({
        chapter: 2,
        mainEvent: { summary: "林远掂量账册", quote: "林远在会议室外停下脚步" },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
        pendingIntents: [],
        continuityWithPrevious: { connects: true },
      }),
    });

    expect(out.semanticQualityIssues.some((issue) => issue.type === "continuity_break")).toBe(false);
    expect(out.summary).not.toContain("跨章衔接提醒");
  });

  it("章节语义声明被拒 → 固定 delta_rejected warning + 摘要提醒，且不阻断入库", async () => {
    const projectDir = await makeProject("声明被拒可见", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));

    const out = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => ({
        chapter: 1,
        mainEvent: { summary: "模型给了不存在的证据", quote: "这句不在草稿里。" },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      }),
    });

    expect(out.canCommit).toBe(true);
    expect(out.semanticQualityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        type: "delta_rejected",
        message: expect.stringContaining("章节语义声明被拒"),
      }),
    ]));
    expect(out.blockingReasons).not.toContain("semantic_quality_error");
    expect(out.summary).toContain("章节语义声明被拒");
  });

  // 阶段 4·降级：declareDelta 抛错 → 预览仍成功（声明 undefined、走引擎正则），不缓存声明。
  it("declareDelta 抛错 → 预览照常可入库，record 无 declaration（非致命降级）", async () => {
    const projectDir = await makeProject("声明失败降级", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => {
        throw new Error("模型超时");
      },
    });
    expect(out.canCommit).toBe(true);
    expect(out.previewToken).toBeTruthy();
    expect(findCommitPreview(projectDir, 1)?.declaration).toBeUndefined();
  });

  // 阶段 4·向后兼容：不传 declareDelta（纯逻辑路径）→ 不调模型、record 无 declaration。
  it("不传 declareDelta → record 无 declaration（旧行为）", async () => {
    const projectDir = await makeProject("无声明通道", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.canCommit).toBe(true);
    expect(findCommitPreview(projectDir, 1)?.declaration).toBeUndefined();
  });

  // 修复①（真机验收发现·治线索堆积）：预览把现有未决线索标题喂给声明模型，让它回收时对号入座、不再每章重埋。
  it("declareDelta 收到现有 open/touched 线索标题（回收对号入座、治堆积）", async () => {
    const projectDir = await makeProject("喂现有线索", "林远");
    await writeDraft(projectDir, 2, longDraft(2, "林远"));
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          { id: "lead-a", type: "lead", title: "师父失踪之谜", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["师父失踪。"] },
          { id: "lead-b", type: "lead", title: "后墙响动", status: "touched", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["响动。"] },
          { id: "lead-c", type: "lead", title: "已结的旧线", status: "done", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["结了。"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    let seenTitles: readonly string[] | undefined;
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async ({ openThreadTitles }) => {
        seenTitles = openThreadTitles;
        return undefined;
      },
    });
    // 只喂未决（open/touched），不喂已结（done）
    expect(seenTitles).toEqual(expect.arrayContaining(["师父失踪之谜", "后墙响动"]));
    expect(seenTitles).not.toContain("已结的旧线");
  });

  // 治伏笔堆积（同源）：未决线索之外，也把【活跃伏笔】(active hook) 的标题喂给声明模型——
  // 让它把本章交代清楚的旧伏笔报进 resolvedForeshadowing、对号入座既有条目，避免伏笔埋了不收、越堆越多。
  it("declareDelta 也收到活跃伏笔(active hook)标题，非活跃(seeded/resolved)不喂", async () => {
    const projectDir = await makeProject("喂活跃伏笔", "林远");
    await writeDraft(projectDir, 2, longDraft(2, "林远"));
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          { id: "lead-a", type: "lead", title: "师父失踪之谜", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["师父失踪。"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
        hooks: [
          { id: "h-active", title: "残玉编号之谜", description: "残玉背面编号来历不明。", status: "active", relatedCharacters: ["林远"], firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["残玉背面刻着编号。"] },
          { id: "h-seeded", title: "尚未登场的伏笔", description: "还没正式埋。", status: "seeded", relatedCharacters: ["林远"], firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["占位。"] },
          { id: "h-resolved", title: "已收口的伏笔", description: "早收了。", status: "resolved", relatedCharacters: ["林远"], firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["收了。"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    let seenTitles: readonly string[] | undefined;
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async ({ openThreadTitles }) => {
        seenTitles = openThreadTitles;
        return undefined;
      },
    });
    // 线索 + 活跃伏笔都要喂给模型（合并成一份「已埋下、未收口」的清单）
    expect(seenTitles).toEqual(expect.arrayContaining(["师父失踪之谜", "残玉编号之谜"]));
    // 非活跃伏笔（seeded 未登场 / resolved 已收口）不喂，避免噪声/误回收
    expect(seenTitles).not.toContain("尚未登场的伏笔");
    expect(seenTitles).not.toContain("已收口的伏笔");
  });

  it("declareDelta 的 openThreadTitles：活跃伏笔全保留在前，thread 按 lastTouched 倒序截取 40 条", async () => {
    const projectDir = await makeProject("喂线索排序截断", "林远");
    await writeDraft(projectDir, 9, longDraft(9, "林远"));
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: Array.from({ length: 45 }, (_, index) => ({
          id: `thread-${index}`,
          type: index % 2 === 0 ? "lead" : "intent",
          title: `线索${String(index).padStart(2, "0")}`,
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: index + 1,
          evidence: [`线索${index}`],
        })),
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
        hooks: [
          { id: "h-a", title: "活跃伏笔A", description: "A", status: "active", relatedCharacters: ["林远"], firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["A"] },
          { id: "h-b", title: "活跃伏笔B", description: "B", status: "active", relatedCharacters: ["林远"], firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["B"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    let seenTitles: readonly string[] | undefined;
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 9,
      declareDelta: async ({ openThreadTitles }) => {
        seenTitles = openThreadTitles;
        return undefined;
      },
    });

    expect(seenTitles?.slice(0, 2)).toEqual(["活跃伏笔A", "活跃伏笔B"]);
    expect(seenTitles).toHaveLength(42);
    expect(seenTitles?.slice(2, 6)).toEqual(["线索44", "线索43", "线索42", "线索41"]);
    expect(seenTitles).toContain("线索05");
    expect(seenTitles).not.toContain("线索04");
  });

  it("端到端：声明把已确立角色名写歪 → 结构化固定提醒 + 语义 warning + 摘要点名，且不阻断入库", async () => {
    const projectDir = await makeProject("名字漂移端到端", "林澈");
    // 已确立名册：主角「林澈」+ prose-only 妹妹「林宁」（跨章确立、未登记进 characters/ 目录）。
    await writeFile(
      join(projectDir, "story", "character-bible.json"),
      `${JSON.stringify({ version: "v0", characters: [{ id: "char-lc", name: "林澈", role: "主角" }, { id: "char-ln", name: "林宁", role: "妹妹" }] }, null, 2)}\n`,
      "utf-8",
    );
    // 正文：主角「林澈」在场（满足「出现已知角色名」检查），但妹妹被写成形近错名「林棠」、正确名「林宁」缺席。
    const sentence = "林澈站在码头，想起妹妹林棠去年在这里失踪，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。";
    const draft = `# 第2章\n\n${Array.from({ length: 12 }, () => sentence).join("")}\n`;
    await writeDraft(projectDir, 2, draft);

    const out = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async () => ({
        chapter: 2,
        mainEvent: { summary: "掂量账册", quote: sentence },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
        charactersPresent: [
          { name: "林澈", quote: sentence, identityHint: "主角" },
          { name: "林棠", quote: sentence, identityHint: "妹妹" },
        ],
      }),
    });

    const planIssues = ((out.plan as { issues?: string[] }).issues ?? []);
    expect(planIssues.some((issue) => issue.includes("人物名疑似写歪") && issue.includes("林棠") && issue.includes("林宁"))).toBe(true);
    // 固定展示（别让模型说软）：结构化 nameConsistencyWarnings + 带类型的 semanticQuality warning + 摘要点名，且不阻断入库。
    expect(out.nameConsistencyWarnings).toHaveLength(1);
    expect(out.nameConsistencyWarnings[0]).toMatchObject({ establishedName: "林宁", driftedVariant: "林棠" });
    expect(out.semanticQualityIssues.some((issue) => issue.type === "character_name_drift" && issue.severity === "warning")).toBe(true);
    expect(out.blockingReasons).not.toContain("semantic_quality_error"); // warning 不升级成阻断
    expect(out.canCommit).toBe(true); // 名字提醒只提示、不阻断
    expect(out.summary).toContain("人物名一致性提醒");
  });

  it("端到端：某线索超 3 章没推进 → 固定「伏笔/线索待收口」提醒 + 语义 warning + 摘要点名，且不阻断入库", async () => {
    const projectDir = await makeProject("线索久未推进", "林远");
    // 第 1 章开的线索，到第 6 章仍 open、且本章草稿不碰它 → 停滞 5 章（>3）应报待收口。
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          { id: "lead-a", type: "lead", title: "师父失踪之谜", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["师父失踪。"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 6, longDraft(6, "林远"));

    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 6 });

    expect(out.staleThreadWarnings.length).toBeGreaterThan(0);
    const lead = out.staleThreadWarnings.find((warning) => warning.title.includes("师父失踪之谜"));
    expect(lead).toMatchObject({ kind: "线索", chaptersSinceTouched: 5, lastTouchedChapter: 1 });
    expect(lead?.message).toContain("没有推进");
    // 带类型的语义 warning（固定展示、供模型忠实转述），但只提示、不阻断入库。
    expect(out.semanticQualityIssues.some((issue) => issue.type === "stale_thread" && issue.severity === "warning")).toBe(true);
    expect(out.blockingReasons).not.toContain("semantic_quality_error");
    expect(out.canCommit).toBe(true);
    expect(out.summary).toContain("伏笔/线索待收口");
  });

  it("r7 里程碑制：结构化提醒截 8 条按停滞降序、摘要列前 5 条 + 全量底数 digest（含清理选项）", async () => {
    const projectDir = await makeProject("线索久未推进截断", "林远");
    const letters = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
    // 10 条 lead 全落在里程碑上（idle=10,20,…,100）：引擎提醒截 8 条，摘要只列前 5，底数 10 条照报。
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: letters.map((letter, index) => ({
          id: `lead-${index}`,
          type: "lead",
          title: `旧线索${letter}号一直没有下文`,
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 101 - (index + 1) * 10,
          evidence: [`旧线索${letter}号`],
        })),
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 101, longDraft(101, "林远"));

    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 101 });

    expect(out.staleThreadWarnings).toHaveLength(8);
    expect(out.staleThreadWarnings[0]).toMatchObject({ chaptersSinceTouched: 100 });
    expect(out.summary).toContain("旧线索癸号"); // 停滞最久（100 章）列在摘要里
    expect(out.summary).toContain("旧线索己号"); // 摘要第 5 条（idle 60）
    expect(out.summary).not.toContain("旧线索戊号"); // 第 6 久（idle 50）不进摘要逐条
    expect(out.summary).toContain("全书共 10 条线索超 3 章未推进");
    expect(out.summary).toContain("最旧已停 100 章");
    expect(out.summary).toContain("清理旧线索");
  });

  it("r7 里程碑安静章：idle 6 的线索本章不逐条提醒，但 digest 仍报全量底数（降噪≠静默）", async () => {
    const projectDir = await makeProject("里程碑安静章", "林远");
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
        threads: [
          { id: "lead-quiet", type: "lead", title: "旧账房暗门的来历", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["暗门。"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 7, longDraft(7, "林远")); // idle 6：不在 (3,5] 窗口、也不是 10 的倍数

    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 7 });

    expect(out.staleThreadWarnings).toEqual([]);
    expect(out.summary).toContain("全书共 1 条线索超 3 章未推进");
    expect(out.summary).not.toContain("本章提醒：");
  });

  it("r7 停滞目标接入预览：主线目标长期停滞 → 结构化提醒（kind=主线目标）+ 升级文案 + 语义 warning", async () => {
    const projectDir = await makeProject("停滞目标提醒", "林远");
    await writeFile(
      join(projectDir, "story", "arc-goals.json"),
      `${JSON.stringify({
        goals: [
          {
            id: "arc-main",
            title: "查明师父闭死关的真相",
            status: "touched",
            scope: "main_arc",
            firstSeenChapter: 1,
            lastTouchedChapter: 1,
            evidence: ["师父闭死关。"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 21, longDraft(21, "林远")); // idle 20：里程碑重提 + 超过升级阈值

    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 21 });

    const goalWarning = out.staleThreadWarnings.find((warning) => warning.kind === "主线目标");
    expect(goalWarning).toMatchObject({ chaptersSinceTouched: 20, lastTouchedChapter: 1 });
    expect(goalWarning?.message).toContain("主线不该长期停摆");
    expect(out.semanticQualityIssues.some((issue) => issue.type === "stale_arc_goal" && issue.severity === "warning")).toBe(true);
    expect(out.canCommit).toBe(true); // 只提示、不阻断
  });

  it("没有久未推进的伏笔/线索 → staleThreadWarnings 为空，摘要不出现待收口提醒（无误报）", async () => {
    const projectDir = await makeProject("无停滞线索", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.staleThreadWarnings).toEqual([]);
    expect(out.summary).not.toContain("伏笔/线索待收口");
  });

  it("declareDelta 收到已确立角色名（登记角色 + 之前各章出现过的名字），供逐字沿用防漂移", async () => {
    const projectDir = await makeProject("喂已确立角色名", "林澈");
    await writeDraft(projectDir, 3, longDraft(3, "林澈"));
    await writeFile(
      join(projectDir, "story", "character-bible.json"),
      `${JSON.stringify({
        version: "v0",
        characters: [{ id: "char-lc", name: "林澈", role: "主角" }],
      }, null, 2)}\n`,
      "utf-8",
    );
    // 之前章节时间线里出现过的名字（跨章累积）
    await writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify([
        { id: "e1", chapter: 1, summary: "第1章", effects: { semanticSummary: { mentionedCharacterNames: ["林澈", "赵叔"] } } },
        { id: "e3", chapter: 3, summary: "第3章", effects: { semanticSummary: { mentionedCharacterNames: ["不该算进来的本章名"] } } },
      ], null, 2)}\n`,
      "utf-8",
    );

    let seenNames: readonly string[] | undefined;
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 3,
      declareDelta: async ({ establishedNames }) => {
        seenNames = establishedNames;
        return undefined;
      },
    });
    expect(seenNames).toEqual(expect.arrayContaining(["林澈", "赵叔"]));
    // 只取「之前章节」的名字，不把当前(第3)章及以后的算进已确立名册
    expect(seenNames).not.toContain("不该算进来的本章名");
  });

  // arc-goal 声明化：预览把现有 active/touched 主线/阶段目标标题喂给声明模型，让它推进/达成时对号入座既有目标、不分裂。
  it("declareDelta 收到现有 active/touched 主线目标标题，completed 不喂（供 targetGoalHint 对号入座）", async () => {
    const projectDir = await makeProject("喂现有目标", "林远");
    await writeDraft(projectDir, 2, longDraft(2, "林远"));
    await writeFile(
      join(projectDir, "story", "arc-goals.json"),
      `${JSON.stringify({
        goals: [
          { id: "arc-a", title: "查清资源账目", status: "active", scope: "main_arc", firstSeenChapter: 1, lastTouchedChapter: 1, targetChapters: 10, evidence: ["账目。"] },
          { id: "arc-b", title: "查明破损信物用途", status: "touched", scope: "mini_arc", firstSeenChapter: 1, lastTouchedChapter: 2, targetChapters: 5, evidence: ["信物。"] },
          { id: "arc-c", title: "早已达成的目标", status: "completed", scope: "mini_arc", firstSeenChapter: 1, lastTouchedChapter: 1, targetChapters: 5, evidence: ["已完成。"] },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    let seenGoals: readonly string[] | undefined;
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 2,
      declareDelta: async ({ openGoalTitles }) => {
        seenGoals = openGoalTitles;
        return undefined;
      },
    });
    expect(seenGoals).toContain("查清资源账目");
    expect(seenGoals).toContain("查明破损信物用途");
    // completed / stale 目标不喂，避免噪声与误推进
    expect(seenGoals ?? []).not.toContain("早已达成的目标");
  });
});

  it("P1-5 消毒：预览不通过时 summary/blockingReasons 不含裸 entity id 与本地绝对路径", async () => {
    const projectDir = await makeProject("消毒", "林远");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远来了。\n"); // 过短 → 走 issues 路径
    const out = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(out.canCommit).toBe(false);

    const BARE_ID = /(?:^|[^\p{L}])(?:hook|char|thread|fact)-[0-9a-f]{4,}/u;
    const ABS_PATH = /\/(?:Users|home|tmp|var|private)\//u;
    const allText = [out.summary, ...out.blockingReasons].join("\n");
    expect(BARE_ID.test(allText), `summary 含裸 id：${allText}`).toBe(false);
    expect(ABS_PATH.test(allText), `summary 含绝对路径：${allText}`).toBe(false);
    // 机器码已换成中文（此前显示 commit_plan_not_passed/draft_quality_error）
    expect(out.blockingReasons).not.toContain("commit_plan_not_passed");
    expect(out.blockingReasons).not.toContain("draft_quality_error");
    expect(out.blockingReasons).not.toContain("semantic_quality_error");
  });
