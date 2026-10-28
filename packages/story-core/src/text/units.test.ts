import { describe, expect, it } from "vitest";
import { applyUnitEdits, dropNeighborEcho, fitQuotes, numberedText, prepareUnitReplacement, splitNumberedReply, splitUnits } from "./units.js";

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

describe("新句抄了邻句（dropNeighborEcho）", () => {
  const prev = "“许微，那都是多少年前的事了。";
  const unit = "你爸没了十五年了，你翻这些有什么用。”";
  const next = "她没接话，低头把信折好。";

  it("头上抄了上一句、尾上抄了下一句：去掉抄的那截（不计引号空白）", () => {
    expect(dropNeighborEcho(unit, "许微，那都是多少年前的事了。你爸失踪十五年了，你翻这些有什么用。”", prev)).toBe("你爸失踪十五年了，你翻这些有什么用。”");
    expect(dropNeighborEcho(unit, "“许微，那都是多少年前的事了。” 你爸失踪十五年了，你翻这些有什么用。”", prev)).toBe("你爸失踪十五年了，你翻这些有什么用。”");
    expect(dropNeighborEcho(unit, "你爸失踪十五年了，你翻这些有什么用。”她没接话，低头把信折好。", prev, next)).toBe("你爸失踪十五年了，你翻这些有什么用。”");
  });

  it("没抄、邻句太短、原句自己就这么开头的：原样；只剩抄的那截：不要", () => {
    expect(dropNeighborEcho(unit, "你爸失踪十五年了，你翻这些有什么用。”", prev, next)).toBe("你爸失踪十五年了，你翻这些有什么用。”");
    expect(dropNeighborEcho("嗯。他说。", "嗯。他低声说。", "嗯。")).toBe("嗯。他低声说。");
    expect(dropNeighborEcho("许微，那都是多少年前的事了。真的。", "许微，那都是多少年前的事了。是真的。", prev)).toBe("许微，那都是多少年前的事了。是真的。");
    expect(dropNeighborEcho(unit, "“许微，那都是多少年前的事了。", prev)).toBeUndefined();
  });
});

describe("模型给的新句 → 能换上去的字（prepareUnitReplacement）", () => {
  const units = splitUnits("“许微，那都是多少年前的事了。你爸没了十五年了，你翻这些有什么用。”\n她没接话。");

  it("去编号、去抄进来的邻句、引号对齐；空串＝删句留引号；编号不存在 / 只剩邻句 → undefined", () => {
    expect(prepareUnitReplacement(units, 2, "[2]许微，那都是多少年前的事了。你爸失踪十五年了，你翻这些有什么用。")).toBe("你爸失踪十五年了，你翻这些有什么用。”");
    expect(prepareUnitReplacement(units, 2, "")).toBe("”");
    expect(prepareUnitReplacement(units, 9, "随便")).toBeUndefined();
    expect(prepareUnitReplacement(units, 2, "“许微，那都是多少年前的事了。")).toBeUndefined();
  });

  // 长篇实跑：定论改法回成「[97]上一句[98]这一句」，去掉抄的上一句后「[98]」留在了要换上的句子里。
  it("抄回上一句时连两句的编号一起抄：都去掉", () => {
    expect(prepareUnitReplacement(units, 2, "[1]“许微，那都是多少年前的事了。[2]你爸失踪十五年了，你翻这些有什么用。”")).toBe("你爸失踪十五年了，你翻这些有什么用。”");
  });

  it("一句改成了几句（添了原文没有的话）→ undefined；改完还是一句的照收", () => {
    const talk = splitUnits("“我退休那年交出去了。”\n她没接话。");
    expect(prepareUnitReplacement(talk, 1, "“前些年交出去过一把。”他说，“交给邮局一个姓孟的。钥匙的事，你问他去。”")).toBeUndefined();
    expect(prepareUnitReplacement(talk, 1, "“我前些年交出去了。”")).toBe("“我前些年交出去了。”");
  });
});

// 换题材长篇实跑 2026-10-28：定论改法回成「“你知道就好。[98]你的活儿…[99]审计这行…[100]你位置空一个星期了…”」，整条被当成一句改成了几句丢掉。
describe("新写法里带着别的编号（splitNumberedReply）", () => {
  it("按编号拆开：头一截归点名的那句，「[n]」后那截归第 n 句；没编号原样", () => {
    expect(splitNumberedReply(97, "“你知道就好。[98]活儿摊给了三个人。[100]你位置空一个星期了。”")).toEqual([
      { id: 97, to: "“你知道就好。" },
      { id: 98, to: "活儿摊给了三个人。" },
      { id: 100, to: "你位置空一个星期了。”" },
    ]);
    expect(splitNumberedReply(2, "[2]你爸失踪十五年了。")).toEqual([{ id: 2, to: "你爸失踪十五年了。" }]);
    expect(splitNumberedReply(2, "你爸失踪十五年了。")).toEqual([{ id: 2, to: "你爸失踪十五年了。" }]);
  });
});
