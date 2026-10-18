import { describe, expect, it } from "vitest";

import { resolveEntityLabel, resolveEntityLabels, resolveSemanticSummaryLabels } from "./entity-labels.js";

describe("entity-labels（裸 id → 展示名，绝不泄露 char-hash）", () => {
  const nameById = new Map([
    ["char-ffe5af", "顾长风"],
    ["none", "陈雨薇"], // 真书里真有 id 字面量 "none"
  ]);

  it("命中 id → 角色名", () => {
    expect(resolveEntityLabel("char-ffe5af", nameById)).toBe("顾长风");
    expect(resolveEntityLabel("none", nameById)).toBe("陈雨薇");
  });

  it("解析不到的 char-hash id → 中性占位（绝不吐裸 hash）", () => {
    expect(resolveEntityLabel("char-deadbeef", nameById)).toBe("「未知角色」");
    expect(resolveEntityLabel("char-deadbeef", nameById)).not.toContain("char-");
  });

  it("已是名字 / 非 hash 关键词（protagonist）→ 原样保留", () => {
    expect(resolveEntityLabel("顾长风", nameById)).toBe("顾长风");
    expect(resolveEntityLabel("protagonist", nameById)).toBe("protagonist");
    expect(resolveEntityLabel("c-legacy", nameById)).toBe("c-legacy"); // 非 char- 前缀，不当 hash
  });

  it("批量解析（timeline participants）", () => {
    expect(resolveEntityLabels(["char-ffe5af", "none", "char-deadbeef", "protagonist"], nameById))
      .toEqual(["顾长风", "陈雨薇", "「未知角色」", "protagonist"]);
  });

  it("resolveSemanticSummaryLabels：解析 participants/protagonist 里的裸 char-id，其它字段原样", () => {
    const sem = {
      chapter: 1,
      chapterSummary: "正文里出现 char-ffe5af 这种字面不应被改", // 普通文本字段：原样保留
      protagonist: "char-ffe5af",
      participants: ["char-ffe5af", "none", "char-deadbeef"],
    };
    const out = resolveSemanticSummaryLabels(sem, nameById);
    expect(out.protagonist).toBe("顾长风");
    expect(out.participants).toEqual(["顾长风", "陈雨薇", "「未知角色」"]);
    expect(out.chapterSummary).toBe("正文里出现 char-ffe5af 这种字面不应被改"); // 不动普通文本
    expect(out.chapter).toBe(1);
  });

  it("semanticSummary 已是名字（引擎常态）→ 原样不变", () => {
    const out = resolveSemanticSummaryLabels({ protagonist: "顾长风", participants: ["顾长风", "陈雨薇"] }, nameById);
    expect(out.protagonist).toBe("顾长风");
    expect(out.participants).toEqual(["顾长风", "陈雨薇"]);
  });
});
