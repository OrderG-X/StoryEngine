import { describe, expect, it } from "vitest";
import { applyUnitEdits, fitQuotes, numberedText, splitUnits } from "./units.js";

const texts = (text: string) => splitUnits(text).map((unit) => unit.text);

describe("splitUnits", () => {
  it("按句末标点切，收引号归前一句，不跨段，章名行不切", () => {
    const text = "# 第1章 · 死信\n\n　　灯管闪了一下，又稳住。许微说：“我出。”他点头！\n“走吧……”她说。";
    expect(texts(text)).toEqual(["灯管闪了一下，又稳住。", "许微说：“我出。”", "他点头！", "“走吧……”她说。"]);
    const units = splitUnits(text);
    for (const unit of units) expect(text.slice(unit.start, unit.end)).toBe(unit.text);
    expect(units.map((unit) => unit.id)).toEqual([1, 2, 3, 4]);
  });

  it("连着的句末标点算一个；没有句末标点的一段整段一句", () => {
    expect(texts("真的吗？！不会吧\n他……他走了")).toEqual(["真的吗？！", "不会吧", "他……他走了"]);
  });

  it("引号里几句话各算一句，开引号跟第一句、收引号跟最后一句", () => {
    expect(texts("“先别动。再等等。”他说。")).toEqual(["“先别动。", "再等等。”", "他说。"]);
  });

  it("英文直引号按先后一开一合", () => {
    expect(texts("\"我出。\"他说。她问：\"真的？\"")).toEqual(["\"我出。\"", "他说。", "她问：\"真的？\""]);
  });

  it("编号文本一段一行", () => {
    expect(numberedText(splitUnits("甲。乙。\n丙。"))).toBe("[1]甲。[2]乙。\n[3]丙。");
  });
});

describe("fitQuotes", () => {
  it("模型多包一层引号：去掉", () => {
    expect(fitQuotes("“先别动。", "““先别动，等我。")).toBe("“先别动，等我。");
  });
  it("模型把半段话提前收了引号：去掉", () => {
    expect(fitQuotes("“先别动。", "“先别动，等我。”")).toBe("“先别动，等我。");
  });
  it("模型漏了开引号：补上", () => {
    expect(fitQuotes("“先别动。", "先别动，等我。")).toBe("“先别动，等我。");
  });
  it("句号挪到引号外也认（开合差一样）", () => {
    expect(fitQuotes("他说：“走吧。”", "他低声说：“走吧”。")).toBe("他低声说：“走吧”。");
  });
  it("删句时留下头尾的引号", () => {
    expect(fitQuotes("“先别动。", "")).toBe("“");
    expect(fitQuotes("灯亮了。", "")).toBe("");
  });
  it("新句忘了收引号：按原句收上", () => {
    expect(fitQuotes("他说：“走吧。”", "他说：“走吧。”她说：“好")).toBe("他说：“走吧。”她说：“好”");
  });
  it("理不平就不换", () => {
    expect(fitQuotes("他说：“走吧。”", "他说：““走吧。”")).toBeUndefined();
  });
});

describe("applyUnitEdits", () => {
  const text = "# 第3章\n\n杜叔走了整整五年。屋里没人住过。\n“钥匙在抽屉里。”她说。";

  it("按编号整句换，别的字一个不动", () => {
    const result = applyUnitEdits(text, [{ id: 1, from: "杜叔走了整整五年。", to: "杜叔走了整整十年。" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("# 第3章\n\n杜叔走了整整十年。屋里没人住过。\n“钥匙在抽屉里。”她说。");
  });

  it("编号对不上按原文唯一找；模型带回的编号和换行去掉", () => {
    const result = applyUnitEdits(text, [{ id: 9, from: "“钥匙在抽屉里。”", to: "[3]“钥匙在\n兜里。”" }]);
    expect(result.ok && result.text.endsWith("“钥匙在兜里。”她说。")).toBe(true);
  });

  it("原文找不到如实失败，整批不换", () => {
    const result = applyUnitEdits(text, [
      { id: 1, from: "杜叔走了整整五年。", to: "杜叔走了整整十年。" },
      { id: 2, from: "没有这句。", to: "随便。" },
    ]);
    expect(result).toMatchObject({ ok: false, code: "unit_moved" });
  });

  it("同一句两种改法失败；改了和没改一样的跳过", () => {
    expect(applyUnitEdits(text, [
      { id: 1, from: "杜叔走了整整五年。", to: "甲。" },
      { id: 1, from: "杜叔走了整整五年。", to: "乙。" },
    ])).toMatchObject({ ok: false, code: "duplicate_unit" });
    const same = applyUnitEdits(text, [{ id: 2, from: "屋里没人住过。", to: "屋里没人住过。" }]);
    expect(same.ok && same.applied.length === 0 && same.text === text).toBe(true);
  });

  it("引号理不平失败", () => {
    expect(applyUnitEdits(text, [{ id: 3, from: "“钥匙在抽屉里。”", to: "“钥匙在““兜里。”" }])).toMatchObject({ ok: false, code: "quotes_unbalanced" });
  });
});
