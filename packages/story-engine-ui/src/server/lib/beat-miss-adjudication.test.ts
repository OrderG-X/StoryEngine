// @vitest-environment node
//
// beat-miss-adjudication 单测：beats 判漏的 AI 复核裁决（降噪器，不是闸门）。
// 核心断言：带逐字引证才摘除、quote 非草稿子串维持漏报、模型挂/烂 JSON → 原结论 + unavailable、
// 只能把「漏」改成「已覆盖」（绝不新增漏报）、零判漏零调用。
import { describe, expect, it, vi } from "vitest";

import {
  adjudicateMissingBeats,
  BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS,
  BEAT_ADJUDICATION_MIN_QUOTE_CHARS,
  buildBeatMissAdjudicationPrompt,
  isAdjudicationQuoteVerbatim,
  normalizeAdjudicationWhitespace,
} from "./beat-miss-adjudication.js";

const DRAFT = "桂英老太太颤巍巍地递过一块海鸥表，表背刻着一行小字。\n\n林远接过来，认出那是师傅当年的旧物。";
const BEATS = ["老街坊拿表来修", "表背牵出往事"];

function judgementsPayload(judgements: readonly unknown[]): string {
  return JSON.stringify({ judgements });
}

describe("isAdjudicationQuoteVerbatim · 诚实校验（归一化空白后是草稿逐字子串才采信）", () => {
  it("逐字子串 → true；空白形态不同（换行/空格）也认；不是子串/太短 → false", () => {
    expect(isAdjudicationQuoteVerbatim("桂英老太太颤巍巍地递过一块海鸥表", DRAFT)).toBe(true);
    // 归一化空白：跨行引用、模型加的空格不影响判定
    expect(isAdjudicationQuoteVerbatim("表背刻着一行小字。\n林远接过来", DRAFT)).toBe(true);
    expect(isAdjudicationQuoteVerbatim("桂英老太太 颤巍巍 地递过一块海鸥表", DRAFT)).toBe(true);
    expect(normalizeAdjudicationWhitespace(" 表背\n刻着　")).toBe("表背刻着");
    // 不是草稿原文 → 不采信
    expect(isAdjudicationQuoteVerbatim("这句话根本不在草稿里", DRAFT)).toBe(false);
    expect(isAdjudicationQuoteVerbatim("桂英老太太递过一块浪琴表", DRAFT)).toBe(false);
    // 太短没有证明力（低于最短引证长度）→ 不采信
    expect(BEAT_ADJUDICATION_MIN_QUOTE_CHARS).toBe(4);
    expect(isAdjudicationQuoteVerbatim("海鸥表", DRAFT)).toBe(false);
    expect(isAdjudicationQuoteVerbatim("  ", DRAFT)).toBe(false);
  });
});

describe("buildBeatMissAdjudicationPrompt", () => {
  it("包含草稿全文 + 逐条编号的判漏要点 + JSON 输出契约 + 逐字引证要求", () => {
    const prompt = buildBeatMissAdjudicationPrompt({ draftContent: DRAFT, missingBeats: BEATS });
    expect(prompt).toContain(DRAFT);
    expect(prompt).toContain("1. 老街坊拿表来修");
    expect(prompt).toContain("2. 表背牵出往事");
    expect(prompt).toContain("judgements");
    expect(prompt).toContain("逐字引用");
    expect(prompt).toContain("拿不准一律 covered=false");
  });

  it("草稿超长 → 截断进 prompt 并如实标注（看不到的内容视为未写进=安全方向）", () => {
    const longDraft = "甲".repeat(BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS + 10);
    const prompt = buildBeatMissAdjudicationPrompt({ draftContent: longDraft, missingBeats: BEATS });
    expect(prompt).toContain("甲".repeat(BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS));
    expect(prompt).not.toContain("甲".repeat(BEAT_ADJUDICATION_DRAFT_EXCERPT_CHARS + 1));
    expect(prompt).toContain("看不到的内容视为未写进");
  });
});

describe("adjudicateMissingBeats · 判漏复核裁决", () => {
  it("判漏 2 条、模型引证正文原句摘 1 条 → 只剩 1 条漏报 + adjudicatedCovered 含被摘条目（带引证）", async () => {
    const callModel = vi.fn(async () => judgementsPayload([
      { index: 1, covered: true, quote: "桂英老太太颤巍巍地递过一块海鸥表", reason: "老街坊=桂英老太太，表=海鸥表" },
      { index: 2, covered: false, reason: "没写往事" },
    ]));
    const result = await adjudicateMissingBeats({ draftContent: DRAFT, missingBeats: BEATS, callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.adjudication).toBe("applied");
    expect(result.missingBeats).toEqual(["表背牵出往事"]);
    expect(result.adjudicatedCovered).toEqual([
      { beat: "老街坊拿表来修", quote: "桂英老太太颤巍巍地递过一块海鸥表" },
    ]);
    expect("error" in result).toBe(false);
  });

  it("quote 不是草稿逐字子串 → 维持漏报（模型空口说覆盖不算数）", async () => {
    const result = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => judgementsPayload([
        { index: 1, covered: true, quote: "王大爷拿来一块上海表让他修", reason: "幻觉引证" },
        { index: 2, covered: true, quote: "表背刻着一行小字", reason: "这句真在" },
      ]),
    });
    expect(result.adjudication).toBe("applied");
    expect(result.missingBeats).toEqual(["老街坊拿表来修"]);
    expect(result.adjudicatedCovered).toEqual([{ beat: "表背牵出往事", quote: "表背刻着一行小字" }]);
  });

  it("covered:true 但没带 quote / quote 太短 → 维持漏报", async () => {
    const result = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => judgementsPayload([
        { index: 1, covered: true, reason: "光说不引证" },
        { index: 2, covered: true, quote: "海鸥表", reason: "太短没有证明力" },
      ]),
    });
    expect(result.adjudication).toBe("applied");
    expect(result.missingBeats).toEqual(BEATS);
    expect(result.adjudicatedCovered).toEqual([]);
  });

  it("模型抛错（挂/超时）→ 维持确定性结论 + unavailable + error 如实记录，绝不反向谎报", async () => {
    const result = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => { throw new Error("模型请求失败：500"); },
    });
    expect(result.adjudication).toBe("unavailable");
    expect(result.error).toContain("500");
    expect(result.missingBeats).toEqual(BEATS);
    expect(result.adjudicatedCovered).toEqual([]);
  });

  it("烂 JSON / 缺 judgements 数组 → 维持确定性结论 + unavailable", async () => {
    const badJson = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => "抱歉，我看不懂（不是 JSON）",
    });
    expect(badJson.adjudication).toBe("unavailable");
    expect(badJson.error).toContain("不是有效 JSON");
    expect(badJson.missingBeats).toEqual(BEATS);

    const noJudgements = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => JSON.stringify({ summary: "都写了" }),
    });
    expect(noJudgements.adjudication).toBe("unavailable");
    expect(noJudgements.missingBeats).toEqual(BEATS);
  });

  it("模型漏判某条 / 条目烂 / index 越界 → 该条维持漏报（安全方向），不拖死其他条（applied）", async () => {
    const result = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => judgementsPayload([
        { index: 1, covered: true, quote: "桂英老太太颤巍巍地递过一块海鸥表" },
        { index: 99, covered: true, quote: "表背刻着一行小字" }, // 越界 → 忽略
        " junk ",
        { covered: true, quote: "表背刻着一行小字" }, // 缺 index → 忽略
      ]),
    });
    expect(result.adjudication).toBe("applied");
    expect(result.missingBeats).toEqual(["表背牵出往事"]); // 第 2 条模型没给有效判定 → 维持漏报
    expect(result.adjudicatedCovered).toHaveLength(1);
  });

  it("降噪器不是闸门：模型无法新增漏报（输出集合 ⊆ 输入判漏集），也不能碰不在判漏集的 beat", async () => {
    const result = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: [BEATS[0]],
      callModel: async () => judgementsPayload([
        { index: 1, covered: true, quote: "桂英老太太颤巍巍地递过一块海鸥表" },
        { index: 2, covered: false }, // 输入只有 1 条，index 2 越界 → 忽略
      ]),
    });
    expect(result.missingBeats).toEqual([]);
    expect(result.adjudicatedCovered).toHaveLength(1);
  });

  it("草稿为空 → 不调模型，直接 unavailable（无从复核，别花 token）", async () => {
    const callModel = vi.fn(async () => judgementsPayload([]));
    const result = await adjudicateMissingBeats({ draftContent: "  \n ", missingBeats: BEATS, callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(result.adjudication).toBe("unavailable");
    expect(result.missingBeats).toEqual(BEATS);
  });

  it("零判漏 → 不调模型，applied 空结果（零判漏零成本）", async () => {
    const callModel = vi.fn(async () => judgementsPayload([]));
    const result = await adjudicateMissingBeats({ draftContent: DRAFT, missingBeats: [], callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toEqual({ adjudication: "applied", missingBeats: [], adjudicatedCovered: [] });
  });

  it("模型回复裹在 markdown 代码围栏里也能解析（extractJsonObject 兜底）", async () => {
    const result = await adjudicateMissingBeats({
      draftContent: DRAFT,
      missingBeats: BEATS,
      callModel: async () => `好的，结果如下：\n\`\`\`json\n${judgementsPayload([
        { index: 1, covered: true, quote: "桂英老太太颤巍巍地递过一块海鸥表" },
        { index: 2, covered: true, quote: "表背刻着一行小字" },
      ])}\n\`\`\``,
    });
    expect(result.adjudication).toBe("applied");
    expect(result.missingBeats).toEqual([]);
    expect(result.adjudicatedCovered).toHaveLength(2);
  });
});
