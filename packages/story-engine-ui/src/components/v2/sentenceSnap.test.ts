import { describe, expect, it } from "vitest";
import { sentenceSpan } from "./sentenceSnap.js";

const pick = (text: string, a: string, b: string) => {
  const start = text.indexOf(a);
  const end = text.indexOf(b) + b.length;
  const span = sentenceSpan(text, start, end);
  return text.slice(span.start, span.end);
};

describe("sentenceSpan 选区对齐到整句", () => {
  const para = "青溪镇的早晨从邮局开始。乔远到得比谁都早。三十岁的人，骑一辆二八大杠，推起来没声。他先把报刊点数。";
  it("选了半句 → 扩到这一句的句首句尾", () => {
    expect(pick(para, "三十岁", "骑")).toBe("三十岁的人，骑一辆二八大杠，推起来没声。");
  });
  it("已经是整句不动；跨两句扩到两句", () => {
    expect(pick(para, "乔远", "早。")).toBe("乔远到得比谁都早。");
    expect(pick(para, "早晨", "到得")).toBe("青溪镇的早晨从邮局开始。乔远到得比谁都早。");
  });
  it("句末引号跟着带上；没有句号时到段尾", () => {
    const quote = "老周喊：“远子，今天有雨。”他抬头。";
    expect(pick(quote, "远子", "今天")).toBe("老周喊：“远子，今天有雨。”");
    expect(pick("没有句号的一段话", "句号", "一段")).toBe("没有句号的一段话");
  });
});
