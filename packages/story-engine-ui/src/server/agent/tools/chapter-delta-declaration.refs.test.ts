// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildChapterDeltaContextSections, buildChapterDeltaSystemSpec, parseChapterDeltaDeclaration, resolveThreadRefs } from "./chapter-delta-declaration.js";

// 2026-10-08 十章验收：同一个问题被开成 3 条线索——线索声明只能新建、指不到旧条目。
const DRAFT = "林舟把登记表摊开，又看了一遍送修人那一栏，还是只有一个沈字。";
const OPEN = ["登记表送修人只写了一个沈字", "怀表来历"];

describe("线索编号与推进声明（阶段 4 记账对号）", () => {
  it("上下文段里已开着的线索带编号，字段说明要求 keyLeads 标 progress", () => {
    const context = buildChapterDeltaContextSections({ openThreadTitles: OPEN });
    expect(context).toContain("T1 登记表送修人只写了一个沈字\nT2 怀表来历");
    expect(buildChapterDeltaSystemSpec()).toContain("progress：introduced=本章新冒出来的问题；advanced=推进了");
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

  // R7.8 线索降噪：同一谜团拆成的多条，推进/回收要把相关编号都挂上——
  // targetThreadHint 写多个编号（字符串「T1、T2」或数组）时展开成多条声明，每条各挂一个；
  // 单个编号、直接写标题、编号越界（拼不出第二个有效标题）行为都不变。
  it("targetThreadHint 多编号展开：一条推进拆成多条、各挂一个编号；数组写法也收", () => {
    const resolved = resolveThreadRefs({
      chapter: 5,
      mainEvent: { summary: "s", quote: DRAFT },
      seededForeshadowing: [],
      resolvedForeshadowing: [{ summary: "揭晓", quote: "q", targetThreadHint: "T1、T2" }],
      resourceDeltas: [],
      keyLeads: [{ summary: "推进", quote: "q", progress: "advanced", targetThreadHint: "T2、T9" }],
      pendingIntents: [{ summary: "待办", quote: "q", targetThreadHint: "T1" }],
    }, OPEN);
    expect(resolved.resolvedForeshadowing.map((item) => item.targetThreadHint))
      .toEqual(["登记表送修人只写了一个沈字", "怀表来历"]);
    // T9 越界：只剩一个有效标题 → 不拆，按单编号换算。
    expect(resolved.keyLeads.map((item) => item.targetThreadHint)).toEqual(["怀表来历"]);
    expect(resolved.pendingIntents?.[0].targetThreadHint).toBe("登记表送修人只写了一个沈字");

    const asArray = parseChapterDeltaDeclaration(JSON.stringify({
      mainEvent: { summary: "s", quote: DRAFT },
      keyLeads: [{ summary: "推进", quote: "q", progress: "advanced", targetThreadHint: ["T1", "T2"] }],
      pendingIntents: [{ summary: "p", quote: "q", targetThreadHint: [] }],
    }), 5);
    expect(asArray?.keyLeads[0].targetThreadHint).toBe("T1、T2");
    expect(asArray?.pendingIntents?.[0].targetThreadHint).toBeUndefined();
    const expanded = resolveThreadRefs(asArray!, OPEN);
    expect(expanded.keyLeads.map((item) => item.targetThreadHint))
      .toEqual(["登记表送修人只写了一个沈字", "怀表来历"]);
  });

  it("多编号里只有一个有效标题（其余越界）→ 不拆条；纯文本混着编号的 hint 不当多编号", () => {
    const resolved = resolveThreadRefs({
      chapter: 5,
      mainEvent: { summary: "s", quote: DRAFT },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [
        { summary: "b", quote: "q", progress: "advanced", targetThreadHint: "T2、T9" },
        { summary: "c", quote: "q", progress: "advanced", targetThreadHint: "查T1这条线" },
      ],
    }, OPEN);
    expect(resolved.keyLeads[0].targetThreadHint).toBe("怀表来历");
    expect(resolved.keyLeads[1].targetThreadHint).toBe("查T1这条线");
  });
});
