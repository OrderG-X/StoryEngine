// @vitest-environment node
//
// generate_draft × beats 判漏 AI 复核（误报降噪）接线测试：
//   确定性判漏 → AI 复核（带逐字引证才摘除）→ 输出/评分吃裁决后结果。
// 覆盖：摘 1 留 1、quote 非子串维持漏报、模型挂/烂 JSON → unavailable、零漏报零调用、
// 多候选评分吃裁决后计数（冤枉扣分回归）、execute 的 triage 槽接线与惰性解析。
// （既有 generate-draft.test.ts 的 68 个测试不注入 beatAdjudicationCallModel → 走 not_run/不裁决路径，零改动零红。）
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject, countDraftChineseCharacters, type WriterClient } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";

import { defaultDraftPath } from "../../lib/project-io.js";
import { buildProjectRequestContext } from "../request-context.js";
import { generateDraftTool, runGenerateDraftToolLogic } from "./generate-draft.js";

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "gen-draft-adjud-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

function mockWriterClient(body: string): WriterClient {
  return {
    async generateDraft({ context }) {
      return { title: `第${context.chapter}章`, content: body };
    },
  };
}

/** 够长且提及主角的正文，确保通过引擎长度/有效性门槛（与既有测试同构造）。 */
function longBody(mainCharacterName: string): string {
  const para = `${mainCharacterName}在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。`;
  return [para, para, para, para].join("\n\n");
}

/** 落进新项目写作规则目标区间（1530–2070 字）的正文（与多候选集成测试同构造）。 */
function inRangeBody(mainCharacterName: string): string {
  const para = `${mainCharacterName}在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。`;
  const repeats = Math.ceil(1700 / countDraftChineseCharacters(para));
  return Array.from({ length: repeats }, () => para).join("\n\n");
}

// 「殊不知」high +「深吸一口气」medium 的确定性硬命中句（与既有回检测试同稿）。
const FLAVOR_TAIL = "林远深吸一口气，压下怒火。殊不知，门后的真相正在等他。";

// 真机误报场景的复刻：beat 有锚点但正文换了措辞——「第三块砖」→「第三层杂志架」、「债权池A-17」→「债权池17号」。
// 确定性核对两条都判漏（既有 generate-draft.test.ts 已锁定此行为）。
const REWORDED_BODY = [longBody("林远"), "林远撬开第三层杂志架后面的暗格，取出薄铁盒，收据背面写着债权池17号。"].join("\n\n");
const REWORDED_BEATS = ["第三块砖", "债权池A-17"];

describe("generate_draft × beats 判漏 AI 复核（单候选）", () => {
  it("判漏 2 条、模型引证正文原句摘 1 条 → 输出只剩 1 条漏报 + adjudicatedCovered 含被摘条目，summary 用裁决后结果", async () => {
    const projectDir = await makeProject("复核摘一留一", "林远");
    const callModel = vi.fn(async () => JSON.stringify({ judgements: [
      { index: 1, covered: true, quote: "林远撬开第三层杂志架后面的暗格", reason: "换了措辞但写到了" },
      { index: 2, covered: false, reason: "债权池编号确实没写" },
    ] }));
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: REWORDED_BEATS,
      writerClient: mockWriterClient(REWORDED_BODY),
      beatAdjudicationCallModel: callModel,
    });
    expect(out.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(out.beatFidelity).toEqual({
      missingBeats: ["债权池A-17"],
      adjudicatedCovered: [{ beat: "第三块砖", quote: "林远撬开第三层杂志架后面的暗格" }],
      adjudication: "applied",
    });
    // 警告只列裁决后仍漏的；被摘的进复核交代（可追溯），不静默消失
    expect(out.summary).toContain("可能漏写或被改写了——债权池A-17。要不要我改稿补回？");
    expect(out.summary).toContain("首稿复核：初判漏写的 1 条要点（第三块砖）经 AI 复核确认已写入正文");
    expect(out.summary).toContain("beatFidelity.adjudicatedCovered");
  });

  it("模型报覆盖但 quote 不是草稿逐字子串 → 维持漏报（幻觉引证不采信）", async () => {
    const projectDir = await makeProject("复核幻觉引证", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: REWORDED_BEATS,
      writerClient: mockWriterClient(REWORDED_BODY),
      beatAdjudicationCallModel: async () => JSON.stringify({ judgements: [
        { index: 1, covered: true, quote: "林远撬开第三块砖后面的暗格", reason: "这句不在草稿里——草稿写的是杂志架" },
        { index: 2, covered: true, quote: "收据背面写着债权池A-17", reason: "也不在——草稿是 17号" },
      ] }),
    });
    expect(out.ok).toBe(true);
    expect(out.beatFidelity?.adjudication).toBe("applied"); // 复核真跑了，只是一条没摘
    expect(out.beatFidelity?.missingBeats).toEqual(REWORDED_BEATS);
    expect(out.beatFidelity?.adjudicatedCovered).toEqual([]);
    expect(out.summary).toContain("⚠ 首稿核对");
    expect(out.summary).toContain("第三块砖");
    expect(out.summary).toContain("债权池A-17");
  });

  it("模型抛错 → 维持确定性结论 + adjudication:unavailable + error 如实记录，出稿 ok 不受影响", async () => {
    const projectDir = await makeProject("复核模型挂", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: REWORDED_BEATS,
      writerClient: mockWriterClient(REWORDED_BODY),
      beatAdjudicationCallModel: async () => { throw new Error("模型请求失败：503"); },
    });
    expect(out.ok).toBe(true);
    expect(out.beatFidelity?.adjudication).toBe("unavailable");
    expect(out.beatFidelity?.error).toContain("503");
    expect(out.beatFidelity?.missingBeats).toEqual(REWORDED_BEATS);
    expect(out.beatFidelity?.adjudicatedCovered).toEqual([]);
    expect(out.summary).toContain("⚠ 首稿核对");
    expect(out.summary).toContain("AI 复核没跑成，按确定性核对结果如实保留");
  });

  it("模型返回烂 JSON → 维持确定性结论 + unavailable", async () => {
    const projectDir = await makeProject("复核烂JSON", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: REWORDED_BEATS,
      writerClient: mockWriterClient(REWORDED_BODY),
      beatAdjudicationCallModel: async () => "这段我说不好（不是 JSON）",
    });
    expect(out.ok).toBe(true);
    expect(out.beatFidelity?.adjudication).toBe("unavailable");
    expect(out.beatFidelity?.missingBeats).toEqual(REWORDED_BEATS);
    expect(out.summary).toContain("⚠ 首稿核对");
  });

  it("零判漏零调用：要点都写到 → 裁决模型一次不调、beatFidelity 字段不出现、summary 无核对/复核噪音", async () => {
    const projectDir = await makeProject("复核零成本", "林远");
    const callModel = vi.fn(async () => "{}");
    const body = [longBody("林远"), "林远撬开第三块砖后面的暗格，取出薄铁盒，收据背面写着债权池A-17。"].join("\n\n");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: REWORDED_BEATS,
      writerClient: mockWriterClient(body),
      beatAdjudicationCallModel: callModel,
    });
    expect(out.ok).toBe(true);
    expect(callModel).not.toHaveBeenCalled();
    expect("beatFidelity" in out).toBe(false);
    expect(out.summary).not.toContain("首稿核对");
    expect(out.summary).not.toContain("首稿复核");
  });

  it("全部判漏被摘除 → 无 ⚠ 警告，只有复核交代行（降噪生效的可追溯形态）", async () => {
    const projectDir = await makeProject("复核全摘", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: REWORDED_BEATS,
      writerClient: mockWriterClient(REWORDED_BODY),
      beatAdjudicationCallModel: async () => JSON.stringify({ judgements: [
        { index: 1, covered: true, quote: "林远撬开第三层杂志架后面的暗格" },
        { index: 2, covered: true, quote: "收据背面写着债权池17号" },
      ] }),
    });
    expect(out.ok).toBe(true);
    expect(out.beatFidelity?.missingBeats).toEqual([]);
    expect(out.beatFidelity?.adjudicatedCovered).toHaveLength(2);
    expect(out.summary).not.toContain("⚠ 首稿核对");
    expect(out.summary).toContain("首稿复核：初判漏写的 2 条要点");
  });
});

describe("generate_draft × beats 判漏 AI 复核（多候选：评分吃裁决后计数）", () => {
  it("冤枉扣分回归：干净候选被词面核对误判漏要点 → 复核摘除后 100 分中选（旧行为 50 分落选）", async () => {
    const projectDir = await makeProject("复核冤枉扣分", "林远");
    const cleanReworded = inRangeBody("林远"); // 干净达标但不含「砖」→ 确定性判漏「第三块砖」（误报）
    const flavoredHitsBeat = `${inRangeBody("林远")}\n\n林远撬开第三块砖后面的暗格。${FLAVOR_TAIL}`; // 命中但带 AI 腔 → 60 分
    const callModel = vi.fn(async () => JSON.stringify({ judgements: [
      { index: 1, covered: true, quote: "林远在走廊尽头停下脚步，反复掂量手里这份账册的分量" },
    ] }));

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖"],
      writerClient: mockWriterClient(cleanReworded),
      candidates: 2,
      candidateWriterClients: [mockWriterClient(cleanReworded), mockWriterClient(flavoredHitsBeat)],
      beatAdjudicationCallModel: callModel,
      autoDeAi: false, // 聚焦选优断言（且优胜稿干净，本来也不会触发去味）
    });

    expect(out.ok).toBe(true);
    // 只有判漏的第 1 个候选花了复核 token；第 2 个要点全中 → 零调用（零判漏零成本）
    expect(callModel).toHaveBeenCalledTimes(1);
    // 评分吃裁决后计数：误报摘除 → 第 1 个候选 100 分（旧行为被冤枉扣到 50 分落选）
    expect(out.candidatesReport?.[0]).toMatchObject({ index: 1, chosen: true, score: 100 });
    expect(out.candidatesReport?.[1]).toMatchObject({
      index: 2, chosen: false, score: 60,
      reason: "AI 腔 2 处 > 优胜者 0 处",
    });
    // 优胜者=干净稿并落盘；summary 如实说「要点全中」
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toBe(`# 第1章\n\n${cleanReworded}\n`);
    expect(out.summary).toContain("已生成 2 个候选并选出第 1 个（要点全中、字数达标、无 AI 腔命中）");
    // 输出 beatFidelity 也是裁决后结果：无残留漏报 + 被摘条目可追溯
    expect(out.beatFidelity).toEqual({
      missingBeats: [],
      adjudicatedCovered: [{ beat: "第三块砖", quote: "林远在走廊尽头停下脚步，反复掂量手里这份账册的分量" }],
      adjudication: "applied",
    });
  });

  it("复核 unavailable 时评分退回确定性计数（安全方向）：干净误判候选仍 50 分落选，如实标注", async () => {
    const projectDir = await makeProject("复核不可用评分", "林远");
    const cleanReworded = inRangeBody("林远");
    const flavoredHitsBeat = `${inRangeBody("林远")}\n\n林远撬开第三块砖后面的暗格。${FLAVOR_TAIL}`;

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖"],
      writerClient: mockWriterClient(cleanReworded),
      candidates: 2,
      candidateWriterClients: [mockWriterClient(cleanReworded), mockWriterClient(flavoredHitsBeat)],
      beatAdjudicationCallModel: async () => { throw new Error("模型请求超时"); },
      autoDeAi: false,
    });

    expect(out.ok).toBe(true);
    // 复核没跑成 → 不冤枉放也不冤枉摘：按确定性计数评（第 1 个 50 分 < 第 2 个 60 分）
    expect(out.candidatesReport?.[0]).toMatchObject({
      index: 1, chosen: false, score: 50,
      reason: "必命中要点漏 1 条 > 优胜者 0 条",
    });
    expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: true, score: 60 });
    // 优胜者（第 2 个）要点全中无判漏 → 输出无 beatFidelity 字段
    expect("beatFidelity" in out).toBe(false);
  });
});

describe("generate_draft × beats 判漏 AI 复核（execute 接线：triage 任务槽）", () => {
  function mockLlmClientConfig() {
    return {
      provider: { id: "p", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "TEST_KEY" },
      profile: { id: "prof", provider: "p", model: "test-model" },
      apiKey: "k",
      thinking: false,
      thinkingDialect: "none",
    };
  }

  it("有判漏 → 惰性解析 triage 槽 + 流式要 JSON，裁决结果进 beatFidelity 输出", async () => {
    const projectDir = await makeProject("复核接线", "林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spyWriter = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockWriterClient(REWORDED_BODY));
    const spyResolve = vi.spyOn(llmClientModule, "resolveConfiguredChatModel").mockResolvedValue(
      mockLlmClientConfig() as unknown as Awaited<ReturnType<typeof llmClientModule.resolveConfiguredChatModel>>,
    );
    const spyStream = vi.spyOn(llmClientModule, "streamChatModelToText").mockResolvedValue({
      content: JSON.stringify({ judgements: [
        { index: 1, covered: true, quote: "林远撬开第三层杂志架后面的暗格" },
        { index: 2, covered: true, quote: "收据背面写着债权池17号" },
      ] }),
      thinking: "",
    });

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "写第1章正文。"),
      } as unknown as ToolExecutionContext;
      const execute = generateDraftTool.execute as unknown as (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<{
        ok: boolean;
        summary: string;
        beatFidelity?: { missingBeats: readonly string[]; adjudicatedCovered: readonly { beat: string }[]; adjudication: string };
      }>;
      const out = await execute({ mustHitBeats: REWORDED_BEATS }, context);

      expect(out.ok).toBe(true);
      expect(spyResolve).toHaveBeenCalledWith("triage"); // 复核走 triage 任务槽
      expect(spyStream).toHaveBeenCalledTimes(1); // 正文干净无 AI 腔 → 唯一的流式调用就是复核
      expect(out.beatFidelity).toMatchObject({ adjudication: "applied", missingBeats: [] });
      expect(out.beatFidelity?.adjudicatedCovered).toHaveLength(2);
      expect(out.summary).not.toContain("⚠ 首稿核对");
      expect(out.summary).toContain("首稿复核");
    } finally {
      spyWriter.mockRestore();
      spyResolve.mockRestore();
      spyStream.mockRestore();
    }
  });

  it("零判漏 → triage 槽都不解析（连配置读取都不花，零成本到底）", async () => {
    const projectDir = await makeProject("复核接线零成本", "林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const hitBody = [longBody("林远"), "林远撬开第三块砖后面的暗格，收据背面写着债权池A-17。"].join("\n\n");
    const spyWriter = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockWriterClient(hitBody));
    const spyResolve = vi.spyOn(llmClientModule, "resolveConfiguredChatModel");
    const spyStream = vi.spyOn(llmClientModule, "streamChatModelToText");

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "写第1章正文。"),
      } as unknown as ToolExecutionContext;
      const execute = generateDraftTool.execute as unknown as (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<{
        ok: boolean; summary: string; beatFidelity?: unknown;
      }>;
      const out = await execute({ mustHitBeats: REWORDED_BEATS, autoDeAi: false }, context);

      expect(out.ok).toBe(true);
      expect(spyResolve).not.toHaveBeenCalled(); // 无判漏 + autoDeAi:false → triage/repair 都不解析
      expect(spyStream).not.toHaveBeenCalled();
      expect(out.beatFidelity).toBeUndefined();
      expect(out.summary).not.toContain("首稿核对");
    } finally {
      spyWriter.mockRestore();
      spyResolve.mockRestore();
      spyStream.mockRestore();
    }
  });
});

describe("去味后 beats 复核的基准集与引证时效（Fable 复审 P2-新 回归）", () => {
  // 复现链：要点换措辞 → 确定性判漏 → AI 复核确认覆盖（摘除）→ 自动去味改了别的 AI 腔句 →
  // 去味后确定性复核照样判漏该要点（它本就词面无锚点）——不得误报成「去味吃掉了锚点」。
  const REWORDED_QUOTE = "林远翻开那本编号一七的债权台账，指尖停在最后一页。";
  const FLAVOR_SENTENCE = "林远深吸一口气，推开了办公室的门。";
  const DEAI_REPRO_BODY = [longBody("林远"), REWORDED_QUOTE, FLAVOR_SENTENCE].join("\n\n");

  it("裁决已覆盖 + 去味只改 AI 腔句 → 不误报「去味后新漏」、adjudicatedCovered 保留（基准集=裁决前判漏）", async () => {
    const projectDir = await makeProject("去味复核不误报", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["债权池A-17"],
      writerClient: mockWriterClient(DEAI_REPRO_BODY),
      beatAdjudicationCallModel: async () => JSON.stringify({ judgements: [
        { index: 1, covered: true, quote: REWORDED_QUOTE },
      ] }),
      deAiCallModel: async () => JSON.stringify({ rewrites: [
        { text: FLAVOR_SENTENCE, afterText: "林远推开办公室的门。" },
      ] }),
    });
    expect(out.ok).toBe(true);
    // 去味真落改动（引证句没动）
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远推开办公室的门。");
    expect(onDisk).toContain(REWORDED_QUOTE);
    // 关键断言：裁决后照样判漏的要点不得进 postDeAiNewMisses（旧行为会误报且与复核交代自相矛盾）
    expect(out.beatFidelity?.postDeAiNewMisses).toBeUndefined();
    expect(out.beatFidelity?.staleAdjudications).toBeUndefined();
    expect(out.beatFidelity?.adjudicatedCovered).toEqual([{ beat: "债权池A-17", quote: REWORDED_QUOTE }]);
    expect(out.summary).toContain("复检干净");
    expect(out.summary).toContain("经 AI 复核确认已写入正文");
    expect(out.summary).not.toContain("去味后新漏");
  });

  it("去味恰好改写了复核引证句 → 该条目移出 adjudicatedCovered、进 staleAdjudications 并如实标注", async () => {
    const projectDir = await makeProject("去味吃掉引证句", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["债权池A-17"],
      writerClient: mockWriterClient(DEAI_REPRO_BODY),
      beatAdjudicationCallModel: async () => JSON.stringify({ judgements: [
        { index: 1, covered: true, quote: REWORDED_QUOTE },
      ] }),
      deAiCallModel: async () => JSON.stringify({ rewrites: [
        { text: FLAVOR_SENTENCE, afterText: "林远推开办公室的门。" },
        { text: REWORDED_QUOTE, afterText: "林远翻开债权台账，停在末页。" },
      ] }),
    });
    expect(out.ok).toBe(true);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远翻开债权台账，停在末页。");
    // 引证句被改写 → 覆盖结论过期：移出 covered、单列 stale；仍不得进 postDeAiNewMisses（去味前后都判漏，非新漏）
    expect(out.beatFidelity?.adjudicatedCovered).toEqual([]);
    expect(out.beatFidelity?.staleAdjudications).toEqual([{ beat: "债权池A-17", quote: REWORDED_QUOTE }]);
    expect(out.beatFidelity?.postDeAiNewMisses).toBeUndefined();
    expect(out.summary).toContain("去味改写了 1 条要点的复核引证句");
    expect(out.summary).toContain("债权池A-17");
    expect(out.summary).not.toContain("去味后新漏");
  });
});
