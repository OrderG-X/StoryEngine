import { describe, expect, it } from "vitest";
import type { CommitQualityIssue, CommitQualityReport } from "./commit-quality-check.js";
import { refineQualityReport } from "./quality-report-refine.js";

const report = (issues: readonly CommitQualityIssue[]): CommitQualityReport => ({
  passed: !issues.some((i) => i.severity === "error"),
  issues,
});

describe("refineQualityReport · 质检分层 + 软误报降级", () => {
  it("分层：error→硬伤、warning→软提示、info→参考；passed=无 error", () => {
    const r = refineQualityReport(report([
      { severity: "error", type: "too_short", message: "x" },
      { severity: "warning", type: "missing_character_name", message: "y" },
      { severity: "info", type: "no_dialogue", message: "z" },
    ]));
    expect(r.passed).toBe(false);
    expect(r.blocking.map((i) => i.type)).toEqual(["too_short"]);
    expect(r.soft.map((i) => i.type)).toEqual(["missing_character_name"]);
    expect(r.reference.map((i) => i.type)).toEqual(["no_dialogue"]);
    expect(r.blocking[0]?.label).toBe("正文过短"); // 规则透明：中文标签
    expect(r.soft[0]?.label).toBe("没出现任何已知角色名"); // 真实 type 名也有标签
  });

  it("给人看的说法是中文：字数不足用结构化字数，不把引擎英文原话摆给作者；没收录的 type 用原话", () => {
    const r = refineQualityReport(report([
      {
        severity: "error", type: "too_short",
        message: "Draft body is shorter than 2500 Chinese characters (current: 1628).",
        length: { min: 2500, current: 1628 },
      },
      { severity: "warning", type: "missing_character_name", message: "Draft does not mention any known character name." },
      { severity: "warning", type: "character_names_degraded", message: "人物卡读不出来：坏了" },
    ]));
    expect(r.blocking[0]?.message).toBe("正文 1628 字，低于写作规则要求的下限 2500 字（只数汉字，不含标点和标题）");
    expect(r.soft.map((i) => i.message)).toEqual(["没提到设定本里任何一个人物的名字", "人物卡读不出来：坏了"]);
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
