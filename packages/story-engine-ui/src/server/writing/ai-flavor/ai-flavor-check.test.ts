// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseAiFlavorReport, runAiFlavorCheck, mergeAiFlavorReports, buildAiFlavorCheckMessages, GENERIC_AI_FLAVOR_CRITERIA } from "./ai-flavor-check.js";
import type { AiFlavorReport, AiFlavorViolation } from "../../../types.js";

const DRAFT = "他握紧拳头。仿佛那一刻，他的心中五味杂陈，所有的情绪如潮水般涌来。窗外下着雨。";

describe("GENERIC_AI_FLAVOR_CRITERIA · 吸收 novel-deslop 检测维度", () => {
  it("兜底判据覆盖：否定对比弱转折 / 情绪直接命名 / 对话同质化 / 结尾升华", () => {
    const joined = GENERIC_AI_FLAVOR_CRITERIA.join("｜");
    expect(joined).toContain("而是");     // 否定对比/弱转折
    expect(joined).toContain("命名");     // 情绪直接命名(没 show)
    expect(joined).toContain("对话");     // 对话同质化/纯台词
    expect(joined).toContain("结尾");     // 结尾升华
  });
});

// Codex 组合复测·P2：第3章体检把「黑色胶带」判成「道具天降/前文毫无铺垫」，但它在第1、2章已建立。
// 根因：体检 prompt 只喂当前章正文，LLM 看不到前文已建立的道具/事实。修后：把「前文已建立要素」喂进 prompt，
// 并明确告诉 LLM 这些再出现属正常承接、不要判天降。
describe("buildAiFlavorCheckMessages · 跨章已建立要素注入（Codex 组合复测 P2：黑色胶带误判道具天降）", () => {
  it("传入已建立要素 → system prompt 含这些要素 + 不要判道具天降的指令", () => {
    const messages = buildAiFlavorCheckMessages(
      "她按了按外套内袋，黑色胶带的一角露出来。",
      [],
      ["许燃在第1章于桥东便利店买了一卷黑色胶带", "编号 X-23 的账册底片"],
    );
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    // 已建立要素逐条进 prompt
    expect(system).toContain("黑色胶带");
    expect(system).toContain("X-23");
    // 明确指令：前文已建立的东西再出现不算天降/无铺垫
    expect(system).toMatch(/已.*建立|前文|往章/u);
    expect(system).toMatch(/天降|铺垫|凭空/u);
  });
  it("无已建立要素（缺省 / 空数组）→ 不注入该段，向后兼容", () => {
    const without = buildAiFlavorCheckMessages("正文。", []);
    const system = without.find((m) => m.role === "system")?.content ?? "";
    expect(system).not.toMatch(/前文已建立|不要把它们判成/u);
    // 与显式传空数组一致
    const emptyArr = buildAiFlavorCheckMessages("正文。", [], []);
    expect(emptyArr.find((m) => m.role === "system")?.content).toBe(system);
  });
});

describe("runAiFlavorCheck · 已建立要素透传进模型 prompt", () => {
  it("establishedElements 出现在喂给 callModel 的 prompt 里", async () => {
    let seenPrompt = "";
    await runAiFlavorCheck({
      draftText: "她按了按外套内袋，胶带的一角露出来。",
      antiRules: [],
      establishedElements: ["许燃在第1章桥东便利店买了黑色胶带"],
      callModel: async (prompt: string) => { seenPrompt = prompt; return "{}"; },
    });
    // 断言用草稿里没有的串（「第1章桥东便利店」），证明确实来自 establishedElements 透传、不是草稿本身
    expect(seenPrompt).toContain("第1章桥东便利店");
  });
});

describe("parseAiFlavorReport", () => {
  it("解析模型 JSON；原句必须是草稿子串，否则丢弃该条", () => {
    const modelJson = JSON.stringify({
      summary: "有两处 AI 腔。",
      violations: [
        { text: "仿佛那一刻，他的心中五味杂陈，所有的情绪如潮水般涌来。", reason: "套路化抒情+滥用『那一刻/五味杂陈』", severity: "high", suggestedFix: "改成具体动作与细节" },
        { text: "这句根本不在草稿里。", reason: "x", severity: "low" },
      ],
    });
    const report = parseAiFlavorReport(modelJson, DRAFT, false);
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(1);                 // 不在草稿的那条被丢弃
    expect(report.violations[0].text).toContain("五味杂陈");
    expect(report.violations[0].id).toBeTruthy();
    expect(report.violations[0].severity).toBe("high");
  });

  it("非 JSON / 空 → ok:false，不编造", () => {
    expect(parseAiFlavorReport("模型挂了不是JSON", DRAFT, true).ok).toBe(false);
    expect(parseAiFlavorReport(JSON.stringify({ summary: "", violations: [] }), DRAFT, false).violations).toHaveLength(0);
  });
});

describe("runAiFlavorCheck", () => {
  it("空稿 → ok:false 诚实回报", async () => {
    const out = await runAiFlavorCheck({ draftText: "   ", antiRules: [], callModel: async () => "{}" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("还没正文");
  });
  it("有稿 → 确定性闸 + LLM 两层都进结果（LLM 命中保留、确定性命中也在）", async () => {
    const out = await runAiFlavorCheck({
      draftText: DRAFT, antiRules: ["禁止套路化抒情"],
      callModel: async () => JSON.stringify({ summary: "一处", violations: [{ text: "窗外下着雨。", reason: "x", severity: "low" }] }),
    });
    expect(out.ok).toBe(true);
    // LLM 那条仍在
    expect(out.violations.some((v) => v.text === "窗外下着雨。")).toBe(true);
    // 确定性闸命中了「仿佛…五味杂陈」那句（DRAFT 里的 AI 腔）
    expect(out.violations.some((v) => v.text.includes("仿佛") && v.id.startsWith("aiflavor-rule-"))).toBe(true);
  });

  it("LLM 挂了也有确定性兜底（谎报-proof）", async () => {
    const out = await runAiFlavorCheck({
      draftText: DRAFT, antiRules: [],
      callModel: async () => { throw new Error("模型超时"); },
    });
    expect(out.ok).toBe(true); // 确定性闸有命中
    expect(out.violations.some((v) => v.id.startsWith("aiflavor-rule-"))).toBe(true);
    expect(out.summary).toContain("确定性闸");
  });
});

describe("mergeAiFlavorReports summary 处数与 violations 强一致（Codex 1-5 章：嘴说6卡片7）", () => {
  const v = (id: string, severity: AiFlavorViolation["severity"]): AiFlavorViolation =>
    ({ id, text: `句子${id}`, reason: "套话", severity });

  it("LLM 自报「6处」但合并确定性命中后真值为 7 → summary 处数取真值 7、不再写「6处」", () => {
    const deterministic: AiFlavorViolation[] = [{ id: "d1", text: "他带着复杂的情绪。", reason: "万能状语", severity: "medium" }];
    const llm: AiFlavorReport = {
      ok: true,
      summary: "6处问题（4处中等、2处轻微），整体文风干练，AI 味较轻。",
      usedFallback: false,
      violations: [v("0", "medium"), v("1", "medium"), v("2", "medium"), v("3", "medium"), v("4", "low"), v("5", "low")],
    };
    const merged = mergeAiFlavorReports(deterministic, llm);
    expect(merged.violations.length).toBe(7);
    expect(merged.summary).not.toMatch(/6\s*处/u);
    expect(merged.summary).toContain("7");
    // LLM 的总评整句不用（重构 P7：不再用正则拆模型的话）
    expect(merged.summary).not.toContain("文风干练");
  });

  it("无违规时 summary 不谎报处数（沿用 LLM 的「读着像人写的」评语）", () => {
    const llm: AiFlavorReport = { ok: true, summary: "这章读着挺像人写的，没挑出明显 AI 腔。", usedFallback: false, violations: [] };
    const merged = mergeAiFlavorReports([], llm);
    expect(merged.violations.length).toBe(0);
    expect(merged.summary).not.toMatch(/\d+\s*处/u);
  });
});
