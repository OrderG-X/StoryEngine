// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildContinuationMessages, continueDraftToLength, splitForContinuation } from "./continue-draft.js";

const TARGET = { requested: 300, lowerBound: 240, upperBound: 345, source: "writing_rules" as const };
const han = (n: number, ch = "字") => ch.repeat(n);

describe("splitForContinuation", () => {
  it("最后一段交给续写一起重写，前文原样保留", () => {
    expect(splitForContinuation("第一段。\n\n第二段。\n\n收尾一句。")).toEqual({ prefix: "第一段。\n\n第二段。", lastParagraph: "收尾一句。" });
    expect(splitForContinuation("只有一段。")).toEqual({ prefix: "", lastParagraph: "只有一段。" });
  });
});

describe("buildContinuationMessages", () => {
  it("带章纲要点、前文、原最后一段，并给出要写的字数", () => {
    const [system, user] = buildContinuationMessages({
      chapter: 3, prefix: "前文内容。", lastParagraph: "他关了灯。", need: 120, lengthTarget: TARGET,
      chapterPlan: {
        version: 1, chapter: 3, source: "model", summary: "去档案室", beats: ["出门", "对出缺页"], newInformation: ["缺页是汇款"],
        scene: {}, characters: [], entities: [], threadsAdvanced: [], avoid: [], createdAt: "2026-10-08T00:00:00.000Z",
      },
    });
    // 120 + 原最后一段 4 字；上限 = 目标区间上限 345 − 前文 4 个汉字。
    expect(system.content).toContain("写 124–341 个汉字（不少于 124，不要超过 341）");
    expect(user.content).toContain("1. 出门");
    expect(user.content).toContain("本章新信息（必须写明）：缺页是汇款");
    expect(user.content).toContain("【原最后一段】\n他关了灯。");
  });
});

describe("continueDraftToLength", () => {
  it("不够就续写：保留前文、重写最后一段并接上，直到过下限", async () => {
    const draft = `${han(100)}。\n\n${han(50, "末")}。`;
    const callModel = vi.fn(async () => `# 标题\n${han(120, "续")}。\n\n${han(80, "尾")}。`);
    const result = await continueDraftToLength({ chapter: 1, draftBody: draft, lengthTarget: TARGET, callModel });
    expect(result.rounds).toBe(1);
    expect(result.before).toBe(150);
    expect(result.after).toBe(300);
    expect(result.draftBody.startsWith(`${han(100)}。\n\n${han(120, "续")}`)).toBe(true);
    expect(result.draftBody).not.toContain("末"); // 原最后一段由续写重写，不原样残留
    expect(result.draftBody).not.toContain("# 标题");
  });

  it("结尾标记后面的自检、说明不进正文", async () => {
    const draft = `${han(100)}。\n\n${han(50, "末")}。`;
    const callModel = vi.fn(async () => `${han(200, "续")}。\n<<END>>\n检查一遍：字数够了。`);
    const result = await continueDraftToLength({ chapter: 1, draftBody: draft, lengthTarget: TARGET, callModel });
    expect(result.draftBody.endsWith(`${han(200, "续")}。`)).toBe(true);
    expect(result.draftBody).not.toContain("检查一遍");
  });

  it("已经够了 → 不调模型", async () => {
    const callModel = vi.fn();
    const result = await continueDraftToLength({ chapter: 1, draftBody: han(260), lengthTarget: TARGET, callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(result.rounds).toBe(0);
  });

  it("续写挂了 / 结果更短 / 像 JSON → 原稿不动，如实记原因；最多两轮", async () => {
    const draft = `${han(100)}。\n\n${han(50, "末")}。`;
    const callModel = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce("{\"text\":\"不是正文\"}");
    const result = await continueDraftToLength({ chapter: 1, draftBody: draft, lengthTarget: TARGET, callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.draftBody).toBe(draft);
    expect(result.rounds).toBe(0);
    expect(result.failures).toEqual([expect.stringContaining("socket hang up"), expect.stringContaining("不可用")]);
  });
});
