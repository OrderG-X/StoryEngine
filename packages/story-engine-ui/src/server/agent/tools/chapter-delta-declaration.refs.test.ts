// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildChapterDeltaMessages, declareChapterDeltaWithStatus, parseChapterDeltaDeclaration, resolveThreadRefs } from "./chapter-delta-declaration.js";

// 2026-10-08 十章验收：同一个问题被开成 3 条线索——线索声明只能新建、指不到旧条目。
const DRAFT = "林舟把登记表摊开，又看了一遍送修人那一栏，还是只有一个沈字。";
const OPEN = ["登记表送修人只写了一个沈字", "怀表来历"];

describe("线索编号与推进声明（阶段 4 记账对号）", () => {
  it("提示词里已开着的线索带编号，keyLeads 要求标 progress", () => {
    const [system, user] = buildChapterDeltaMessages({ chapter: 5, draft: DRAFT, openThreadTitles: OPEN });
    expect(user.content).toContain("T1 登记表送修人只写了一个沈字\nT2 怀表来历");
    expect(system.content).toContain("progress：introduced=本章新冒出来的问题；advanced=推进了");
  });

  it("keyLeads 的 progress / 编号宽进：中文说法认、空串当没给，不丢整条", () => {
    const parsed = parseChapterDeltaDeclaration(JSON.stringify({
      mainEvent: { summary: "林舟再看登记表", quote: DRAFT },
      keyLeads: [
        { summary: "送修人只有沈字", quote: "还是只有一个沈字", progress: "推进", targetThreadHint: "T1" },
        { summary: "新问题", quote: "林舟把登记表摊开", progress: "随便写的", targetThreadHint: "" },
      ],
      resolvedForeshadowing: [{ summary: "x", quote: "林舟把登记表摊开", targetThreadHint: "" }],
    }), 5);
    expect(parsed?.keyLeads).toEqual([
      { summary: "送修人只有沈字", quote: "还是只有一个沈字", progress: "advanced", targetThreadHint: "T1" },
      { summary: "新问题", quote: "林舟把登记表摊开" },
    ]);
    expect(parsed?.resolvedForeshadowing).toEqual([{ summary: "x", quote: "林舟把登记表摊开" }]);
  });

  it("编号换回标题原文；越界编号当没给；直接写标题的原样保留", () => {
    const resolved = resolveThreadRefs({
      chapter: 5,
      mainEvent: { summary: "s", quote: DRAFT },
      seededForeshadowing: [],
      resolvedForeshadowing: [{ summary: "a", quote: "q", targetThreadHint: "t2" }],
      resourceDeltas: [],
      keyLeads: [
        { summary: "b", quote: "q", progress: "advanced", targetThreadHint: "T1" },
        { summary: "c", quote: "q", progress: "advanced", targetThreadHint: "T9" },
        { summary: "d", quote: "q", targetThreadHint: "怀表来历" },
      ],
    }, OPEN);
    expect(resolved.resolvedForeshadowing[0].targetThreadHint).toBe("怀表来历");
    expect(resolveThreadRefs({
      chapter: 5, mainEvent: { summary: "s", quote: DRAFT }, seededForeshadowing: [], resolvedForeshadowing: [], resourceDeltas: [], keyLeads: [],
      pendingIntents: [{ summary: "再去查送修人", quote: "q", targetThreadHint: "T1" }],
    }, OPEN).pendingIntents?.[0].targetThreadHint).toBe("登记表送修人只写了一个沈字");
    expect(resolved.keyLeads.map((item) => item.targetThreadHint)).toEqual(["登记表送修人只写了一个沈字", undefined, "怀表来历"]);
  });

  it("declareChapterDeltaWithStatus 产出的声明里编号已换回标题", async () => {
    const callModel = vi.fn(async () => JSON.stringify({
      mainEvent: { summary: "林舟再看登记表", quote: DRAFT },
      keyLeads: [{ summary: "送修人只有沈字", quote: "还是只有一个沈字", progress: "advanced", targetThreadHint: "T1" }],
    }));
    const outcome = await declareChapterDeltaWithStatus({ chapter: 5, draft: DRAFT, callModel, openThreadTitles: OPEN });
    expect(outcome.declaration?.keyLeads[0]?.targetThreadHint).toBe("登记表送修人只写了一个沈字");
  });
});
