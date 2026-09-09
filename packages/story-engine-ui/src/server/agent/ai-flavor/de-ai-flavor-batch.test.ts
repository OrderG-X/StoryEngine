// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyDeAiBatch,
  parseDeAiBatchRewrites,
  buildDeAiRewriteMessages,
  runDeAiFlavorBatch,
} from "./de-ai-flavor-batch.js";
import type { AiFlavorViolation } from "./ai-flavor-check.js";

const v = (text: string, severity: AiFlavorViolation["severity"] = "medium"): AiFlavorViolation => ({
  id: `x-${text.slice(0, 4)}`, text, reason: "AI 腔", severity, suggestedFix: "改自然",
});

describe("applyDeAiBatch · 多 span 倒序落盘（防漂移）+ 诚实计数", () => {
  it("两处都定位到 → 都替换，整稿正确、变更按原文顺序返回", () => {
    const draft = "他深吸一口气，压下怒火。\n窗外，带着潮湿的风。";
    const r = applyDeAiBatch(draft, [
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下，把火压下去。" },
      { text: "窗外，带着潮湿的风。", afterText: "窗外刮着湿风。" },
    ]);
    expect(r.updatedContent).toBe("他胸口起伏了一下，把火压下去。\n窗外刮着湿风。");
    expect(r.applied.map((a) => a.after)).toEqual(["他胸口起伏了一下，把火压下去。", "窗外刮着湿风。"]);
    expect(r.skipped).toHaveLength(0);
  });

  it("倒序落盘：前一处改成更长文本，后一处仍精确替换（不漂移）", () => {
    const draft = "甲。乙丙丁。";
    const r = applyDeAiBatch(draft, [
      { text: "甲。", afterText: "一二三四五。" },
      { text: "乙丙丁。", afterText: "X。" },
    ]);
    expect(r.updatedContent).toBe("一二三四五。X。");
    expect(r.applied).toHaveLength(2);
  });

  it("定位不到的条目诚实跳过(reason=not_found)，其它照常改", () => {
    const draft = "他深吸一口气。窗外有雨。";
    const r = applyDeAiBatch(draft, [
      { text: "他深吸一口气。", afterText: "他喘了口气。" },
      { text: "这句根本不在草稿里。", afterText: "随便改。" },
    ]);
    expect(r.updatedContent).toBe("他喘了口气。窗外有雨。");
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toEqual([{ text: "这句根本不在草稿里。", reason: "not_found" }]);
  });

  it("改后与原句无异(noop) → 跳过、不计入 applied", () => {
    const draft = "他深吸一口气。";
    const r = applyDeAiBatch(draft, [{ text: "他深吸一口气。", afterText: "他深吸一口气。" }]);
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("noop");
    expect(r.updatedContent).toBe(draft);
  });

  it("同一句在草稿里出现多次(ambiguous) → 跳过，不乱改", () => {
    const draft = "好的。好的。";
    const r = applyDeAiBatch(draft, [{ text: "好的。", afterText: "行。" }]);
    expect(r.applied).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("ambiguous");
  });
});

describe("parseDeAiBatchRewrites · 解析模型批量改写", () => {
  const draft = "他深吸一口气。窗外有雨。";
  it("解析 {rewrites:[{text,afterText}]}，text 必须是草稿子串", () => {
    const json = JSON.stringify({ rewrites: [
      { text: "他深吸一口气。", afterText: "他喘了口气。" },
      { text: "不在草稿里。", afterText: "x" },
    ] });
    const out = parseDeAiBatchRewrites(json, draft);
    expect(out).toEqual([{ text: "他深吸一口气。", afterText: "他喘了口气。" }]);
  });

  it("afterText 为空/与原句相同的条目被丢弃", () => {
    const json = JSON.stringify({ rewrites: [
      { text: "他深吸一口气。", afterText: "" },
      { text: "窗外有雨。", afterText: "窗外有雨。" },
    ] });
    expect(parseDeAiBatchRewrites(json, draft)).toEqual([]);
  });

  it("模型输出不可解析 → 空数组（不抛）", () => {
    expect(parseDeAiBatchRewrites("抱歉我无法完成", draft)).toEqual([]);
  });
});

describe("buildDeAiRewriteMessages · novel-deslop 改写 prompt", () => {
  it("prompt 含 novel-deslop 纪律(改最少/show)、违规句、JSON 输出要求", () => {
    const msgs = buildDeAiRewriteMessages([v("他深吸一口气。")], []);
    const joined = msgs.map((m) => m.content).join("\n");
    expect(joined).toContain("他深吸一口气。"); // 违规原句喂进去
    expect(joined).toContain("最少");           // 改最少字纪律
    expect(joined).toContain("afterText");       // 结构化输出契约
  });
});

describe("runDeAiFlavorBatch · 编排 + 诚实回报", () => {
  const draft = "他深吸一口气，压下怒火。窗外，带着潮湿的风。";
  it("检测有违规 → 批量改 → 诚实回报 detected/rewritten/changes", async () => {
    const callModel = async () => JSON.stringify({ rewrites: [
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" },
      { text: "窗外，带着潮湿的风。", afterText: "窗外刮着湿风。" },
    ] });
    const out = await runDeAiFlavorBatch({ draftText: draft, violations: [v("他深吸一口气，压下怒火。"), v("窗外，带着潮湿的风。")], callModel });
    expect(out.ok).toBe(true);
    expect(out.detected).toBe(2);
    expect(out.rewritten).toBe(2);
    expect(out.skipped).toBe(0);
    expect(out.changes).toHaveLength(2);
    expect(out.updatedContent).toBe("他胸口起伏了一下。窗外刮着湿风。");
  });

  it("没有违规 → ok 但 0 改动，诚实说无需全修", async () => {
    const out = await runDeAiFlavorBatch({ draftText: draft, violations: [], callModel: async () => "{}" });
    expect(out.ok).toBe(true);
    expect(out.rewritten).toBe(0);
    expect(out.updatedContent).toBe(draft);
  });

  it("改写模型挂了 → ok:false 诚实回报、不动原稿", async () => {
    const callModel = async () => { throw new Error("model down"); };
    const out = await runDeAiFlavorBatch({ draftText: draft, violations: [v("他深吸一口气，压下怒火。")], callModel });
    expect(out.ok).toBe(false);
    expect(out.rewritten).toBe(0);
    expect(out.updatedContent).toBe(draft);
  });

  it("部分定位不到 → 诚实计入 skipped、不谎报全改", async () => {
    const callModel = async () => JSON.stringify({ rewrites: [
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" },
    ] });
    const out = await runDeAiFlavorBatch({ draftText: draft, violations: [v("他深吸一口气，压下怒火。"), v("窗外，带着潮湿的风。")], callModel });
    expect(out.detected).toBe(2);
    expect(out.rewritten).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it("skippedByReason：模型没给改写的计 noRewrite、定位失败计 notFound，各键之和=skipped", async () => {
    const callModel = async () => JSON.stringify({ rewrites: [
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" },
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" }, // 重复条目：第二条 overlap
    ] });
    const out = await runDeAiFlavorBatch({
      draftText: draft,
      violations: [v("他深吸一口气，压下怒火。"), v("窗外，带着潮湿的风。"), v("窗外，带着潮湿的风。")],
      callModel,
    });
    expect(out.rewritten).toBe(1);
    expect(out.skippedByReason.noRewrite).toBe(1); // parse 去重后少了 1 条 → 算「没给有效改写」
    expect(out.skippedByReason.overlap).toBe(1);
    const total = out.skippedByReason.notFound + out.skippedByReason.ambiguous + out.skippedByReason.noop
      + out.skippedByReason.overlap + out.skippedByReason.noRewrite;
    expect(total).toBe(out.skipped);
  });

  it("改写模型挂了 → error 字段带原始错误信息，skippedByReason.noRewrite=detected", async () => {
    const callModel = async () => { throw new Error("model down 400"); };
    const out = await runDeAiFlavorBatch({ draftText: draft, violations: [v("他深吸一口气，压下怒火。"), v("窗外，带着潮湿的风。")], callModel });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("model down 400");
    expect(out.skippedByReason).toEqual({ notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 2 });
  });
});
