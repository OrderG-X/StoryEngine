import { describe, expect, it } from "vitest";
import type { CommitQualityIssue, CommitQualityReport } from "@actalk/story-engine";
import { refineQualityReport } from "./quality-report-refine.js";

const report = (issues: readonly CommitQualityIssue[]): CommitQualityReport => ({
  passed: !issues.some((i) => i.severity === "error"),
  issues,
});

describe("refineQualityReport · 质检分层 + 软误报降级", () => {
  it("分层：error→硬伤、warning→软提示、info→参考；passed=无 error", () => {
    const r = refineQualityReport(report([
      { severity: "error", type: "too_short", message: "x" },
      { severity: "warning", type: "writing_context_location_drift", message: "y" },
      { severity: "info", type: "writing_context_speech_style_risk", message: "z" },
    ]));
    expect(r.passed).toBe(false);
    expect(r.blocking.map((i) => i.type)).toEqual(["too_short"]);
    expect(r.soft.map((i) => i.type)).toEqual(["writing_context_location_drift"]);
    expect(r.reference.map((i) => i.type)).toEqual(["writing_context_speech_style_risk"]);
    expect(r.blocking[0]?.label).toBe("正文过短"); // 规则透明：中文标签
    expect(r.soft[0]?.label).toBe("地点与本章设定漂移"); // 真实 type 名也有标签
  });

  it("AI 判定 confirmed+high 的 warning → 升 severe 档（不混进软提示）、summary 点明严重、passed 仍 true（不硬拦·守可撤销）", () => {
    const r = refineQualityReport(report([
      {
        severity: "warning", type: "writing_context_forbidden_reveal", message: "提前给出核心答案",
        judgement: { candidateId: "c1", verdict: "confirmed", severity: "high", explanation: "x", recommendedAction: "revise" },
        userDisplayCategory: "confirmed",
      },
    ]));
    expect(r.severe.map((i) => i.type)).toEqual(["writing_context_forbidden_reveal"]);
    expect(r.soft).toHaveLength(0); // 不再混进软提示「参考不拦」
    expect(r.passed).toBe(true); // 不硬拦入库（守「直接做+可撤销」）
    expect(r.summary).toContain("严重"); // 措辞点明严重、不再读成「全好了」
    expect(r.summary).not.toContain("没硬伤、可以定稿"); // 不再单说「可以定稿」误导
  });

  it("confirmed+medium 但 AI 建议修改(revise) → 也升 severe（retest：『能力使用违规·建议修改后再入库』不再漏成软提示）", () => {
    const r = refineQualityReport(report([
      {
        severity: "warning", type: "writing_context_knowledge_boundary", message: "能力使用违规",
        judgement: { candidateId: "c9", verdict: "confirmed", severity: "medium", explanation: "建议修改后再入库", recommendedAction: "revise" },
        userDisplayCategory: "confirmed",
      },
    ]));
    expect(r.severe.map((i) => i.type)).toEqual(["writing_context_knowledge_boundary"]);
    expect(r.soft).toHaveLength(0);
    expect(r.summary).not.toContain("没硬伤、可以定稿");
  });

  it("题材中立：任意 warning type 只要 confirmed+high 都升 severe（按 judgement 而非题材词/特定 type）", () => {
    const r = refineQualityReport(report([
      {
        severity: "warning", type: "writing_context_location_drift", message: "x",
        judgement: { candidateId: "c2", verdict: "confirmed", severity: "high", explanation: "y", recommendedAction: "revise" },
      },
    ]));
    expect(r.severe.map((i) => i.type)).toEqual(["writing_context_location_drift"]);
  });

  it("不过度升级：warning 无 judgement、或 judgement 非 confirmed+high → 仍是软提示、不进 severe", () => {
    const r = refineQualityReport(report([
      { severity: "warning", type: "writing_context_location_drift", message: "no judgement" },
      {
        severity: "warning", type: "writing_context_speech_style_risk", message: "uncertain",
        judgement: { candidateId: "c3", verdict: "uncertain", severity: "medium", explanation: "z", recommendedAction: "watch" },
      },
    ]));
    expect(r.severe).toHaveLength(0);
    expect(r.soft).toHaveLength(2);
  });

  it("软误报降级：『没提到近期角色/没接线索』家族(warning)→参考(info)，治子串匹配噪音", () => {
    const r = refineQualityReport(report([
      { severity: "warning", type: "recent_characters_not_referenced", message: "a" },
      { severity: "warning", type: "open_leads_not_referenced", message: "b" },
    ]));
    expect(r.soft).toHaveLength(0); // 这类噪音不再当软提示
    expect(r.reference.map((i) => i.type).sort()).toEqual(["open_leads_not_referenced", "recent_characters_not_referenced"]);
    expect(r.downgraded).toHaveLength(2);
    expect(r.passed).toBe(true);
  });

  it("软误报降级：missing_chapter_title(warning)→参考(info)，留痕透明", () => {
    const r = refineQualityReport(report([
      { severity: "warning", type: "missing_chapter_title", message: "no title" },
    ]));
    expect(r.soft).toHaveLength(0);            // 不再当软提示
    expect(r.reference.map((i) => i.type)).toEqual(["missing_chapter_title"]);
    expect(r.downgraded[0]?.downgradeNote).toContain("自动补");
    expect(r.passed).toBe(true);              // 降级不影响 passed
  });

  it("可能是真问题的 warning（地点/代词漂移、提前泄密）不降，仍当软提示", () => {
    const r = refineQualityReport(report([
      { severity: "warning", type: "writing_context_location_drift", message: "a" },
      { severity: "warning", type: "cross_chapter_pronoun_drift", message: "b" },
      { severity: "warning", type: "writing_context_forbidden_reveal", message: "c" },
    ]));
    expect(r.soft.map((i) => i.type).sort()).toEqual(["cross_chapter_pronoun_drift", "writing_context_forbidden_reveal", "writing_context_location_drift"]);
    expect(r.downgraded).toHaveLength(0);
  });

  it("error 永不被降级（硬伤一律不碰）", () => {
    const r = refineQualityReport(report([
      { severity: "error", type: "missing_chapter_title", message: "即便同名 type 也不降 error" },
    ]));
    expect(r.blocking).toHaveLength(1);
    expect(r.downgraded).toHaveLength(0);
  });

  it("去重 + 跳过 dismissed", () => {
    const r = refineQualityReport(report([
      { severity: "warning", type: "writing_context_location_drift", message: "dup" },
      { severity: "warning", type: "writing_context_location_drift", message: "dup" },
      { severity: "error", type: "too_short", message: "x", userDisplayCategory: "dismissed" },
    ]));
    expect(r.soft).toHaveLength(1);  // 去重
    expect(r.blocking).toHaveLength(0); // dismissed 跳过
    expect(r.passed).toBe(true);
  });

  it("通过且无问题 → 干净 summary", () => {
    const r = refineQualityReport(report([]));
    expect(r.passed).toBe(true);
    expect(r.summary).toBe("没硬伤、可以定稿。");
    expect(r.summary).not.toContain("软提示");
  });

  it("未过 → summary 点名硬伤标签", () => {
    const r = refineQualityReport(report([
      { severity: "error", type: "missing_character_name", message: "x" },
      { severity: "warning", type: "writing_context_location_drift", message: "y" },
    ]));
    expect(r.summary).toContain("硬伤");
    expect(r.summary).toContain("没出现任何已知角色名");
    expect(r.summary).toContain("软提示");
  });
});
