import { describe, expect, it } from "vitest";
import { verifyChapterDelta, type ChapterDeltaDeclaration } from "../chapter-delta.js";
import { buildThreadTrackingPlan } from "../lead-intent-tracking.js";
import type { ChapterSemanticSummary } from "../commit-plan-builder.js";
import type { NarrativeThread, ThreadPool } from "../types.js";

// 2026-10-08 十章验收：同一个问题被开成 3 条线索、「N 章没推进」一半是误报——线索声明只能新建、指不到旧条目。
const DRAFT = "林舟把登记表摊开，又看了一遍送修人那一栏，还是只有一个沈字。他把怀表翻过来，表盖内侧的日期在灯下发亮。";

function thread(id: string, title: string): NarrativeThread {
  return { id, type: "lead", title, status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [title] };
}

const POOL: ThreadPool = {
  threads: [
    thread("lead-a", "登记表送修人只写了一个沈字"),
    thread("lead-b", "陌生中年男人送来的怀表为何刻着祖父…"),
  ],
};

function plan(declaration: Partial<ChapterDeltaDeclaration>) {
  const verified = verifyChapterDelta({
    chapter: 5,
    mainEvent: { summary: "林舟再看登记表", quote: "林舟把登记表摊开，又看了一遍送修人那一栏，还是只有一个沈字。" },
    seededForeshadowing: [],
    resolvedForeshadowing: [],
    resourceDeltas: [],
    keyLeads: [],
    ...declaration,
  }, DRAFT);
  return buildThreadTrackingPlan({
    chapter: 5,
    draft: DRAFT,
    semanticSummary: {
      chapter: 5, chapterTitle: "第5章", mainEvent: "林舟再看登记表",
      mentionedHooks: [], mentionedCharacters: [], mentionedCharacterNames: [], locations: [],
    } satisfies ChapterSemanticSummary,
    threadPool: POOL,
    verifiedDelta: verified,
  });
}

describe("线索声明推进旧线索（阶段 4 记账对号）", () => {
  it("progress=advanced + 标题逐字 → 推进那一条（touched），不新建", () => {
    const result = plan({
      keyLeads: [{ summary: "送修人只有沈字", quote: "还是只有一个沈字", progress: "advanced", targetThreadHint: "登记表送修人只写了一个沈字" }],
    });
    expect(result.introducedThreads).toEqual([]);
    expect(result.updates).toEqual([expect.objectContaining({ id: "lead-a", status: "touched", lastTouchedChapter: 5 })]);
  });

  it("提示给的是完整说法、库里标题被截成「…」 → 也认得是同一条", () => {
    const result = plan({
      keyLeads: [{
        summary: "怀表来历", quote: "表盖内侧的日期在灯下发亮", progress: "advanced",
        targetThreadHint: "陌生中年男人送来的怀表为何刻着祖父的名字和日期",
      }],
    });
    expect(result.introducedThreads).toEqual([]);
    expect(result.updates.map((update) => update.id)).toEqual(["lead-b"]);
  });

  it("指不到任何开着的线索 → 当新线索建（宁可多一条也不丢）", () => {
    const result = plan({
      keyLeads: [{ summary: "表盖日期在灯下发亮的缘由", quote: "表盖内侧的日期在灯下发亮", progress: "advanced", targetThreadHint: "完全对不上的标题" }],
    });
    expect(result.introducedThreads).toHaveLength(1);
  });

  it("同一批里 seeded 与 keyLeads 说的是同一件事 → 只新建一条", () => {
    const result = plan({
      seededForeshadowing: [{ summary: "表盖内侧日期的来历", quote: "表盖内侧的日期在灯下发亮" }],
      keyLeads: [{ summary: "表盖内侧日期的来历成谜", quote: "表盖内侧的日期在灯下发亮" }],
    });
    expect(result.introducedThreads).toHaveLength(1);
  });

  it("标题说法差得远、但引的是同一句原文 → 还是同一件事，只新建一条", () => {
    const result = plan({
      seededForeshadowing: [{ summary: "怀表日期是谁刻的", quote: "表盖内侧的日期在灯下发亮" }],
      keyLeads: [{ summary: "林舟能否查清这块表的来路", quote: "表盖内侧的日期在灯下发亮。" }],
    });
    expect(result.introducedThreads).toHaveLength(1);
  });

  it("收口引的原句和线索不沾边 → 只算推进、不关（防拿无关句子关掉核心谜题）", () => {
    const result = plan({
      resolvedForeshadowing: [{ summary: "揭晓了送修人", quote: "他把怀表翻过来", targetThreadHint: "登记表送修人只写了一个沈字" }],
    });
    expect(result.updates).toEqual([expect.objectContaining({ id: "lead-a", status: "touched" })]);
  });

  it("收口原句真在说这条线索 → 关掉", () => {
    const result = plan({
      resolvedForeshadowing: [{ summary: "送修人就是沈家", quote: "还是只有一个沈字", targetThreadHint: "登记表送修人只写了一个沈字" }],
    });
    expect(result.updates).toEqual([expect.objectContaining({ id: "lead-a", status: "done" })]);
  });
});

describe("待办声明对号（第十四轮：同一件「补继承材料」立了 6 条待办）", () => {
  it("待办给了已开着的编号对应标题 → 触碰那一条，不另立", () => {
    const result = plan({
      pendingIntents: [{ summary: "再去查送修人", quote: "还是只有一个沈字", targetThreadHint: "登记表送修人只写了一个沈字" }],
    });
    expect(result.introducedThreads).toEqual([]);
    expect(result.updates).toEqual([expect.objectContaining({ id: "lead-a", status: "touched" })]);
  });

  it("对不上任何已开着的 → 照常新立一条待办", () => {
    const result = plan({
      pendingIntents: [{ summary: "明天去档案馆调底册", quote: "表盖内侧的日期在灯下发亮" }],
    });
    expect(result.introducedThreads).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ type: "intent", title: "明天去档案馆调底册" });
  });
});
