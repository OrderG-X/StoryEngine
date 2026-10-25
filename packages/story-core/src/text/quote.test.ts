import { describe, expect, it } from "vitest";
import { nameKey, normalizeForQuote, quoteFromText, quoteInText } from "./quote.js";

const TEXT = "她把钥匙放回铜盒，扣上盖子。\n\n「回来了。」老周说，声音很低。";

describe("原句核对", () => {
  it("空白、换行、全半角、引号都不影响", () => {
    expect(quoteInText("她把钥匙放回铜盒，扣上盖子。", TEXT)).toBe(true);
    expect(quoteInText("“回来了。”老周说", TEXT)).toBe(true);
    expect(quoteInText("回来了。老周说，声音很低", TEXT)).toBe(true);
    expect(quoteInText("她把钥匙 放回 铜盒,扣上盖子", TEXT)).toBe(true);
  });

  it("省略号截掉中间：每段按顺序都在才算", () => {
    expect(quoteInText("她把钥匙……扣上盖子", TEXT)).toBe(true);
    expect(quoteInText("她把钥匙...声音很低", TEXT)).toBe(true);
    expect(quoteInText("扣上盖子……她把钥匙", TEXT)).toBe(false);
  });

  it("不在正文里、太短的都不算", () => {
    expect(quoteInText("她把钥匙放进了口袋", TEXT)).toBe(false);
    expect(quoteInText("钥匙", TEXT)).toBe(false);
    expect(quoteInText("……", TEXT)).toBe(false);
    expect(quoteInText("", TEXT)).toBe(false);
  });

  it("名字键只认写法完全一样", () => {
    expect(nameKey("「老周」")).toBe(nameKey("老周"));
    expect(nameKey("Lu Chuan")).toBe(nameKey("luchuan"));
    expect(nameKey("钟箱钥匙")).not.toBe(nameKey("钥匙"));
    expect(normalizeForQuote("ＡＢＣ　１２３")).toBe("ABC123");
  });
});

describe("原句照正文原样取回", () => {
  const text = "领头的是个黑脸汉子，四十来岁。\n\n“郑伯让你来的？”沈砚问。他点头，点完了腿一软。";
  it("模型多打的空格、少抄的引号都换回正文原字", () => {
    expect(quoteFromText("领头的 是个黑脸汉子", text)).toBe("领头的是个黑脸汉子");
    expect(quoteFromText("郑伯让你来的？”", text)).toBe("郑伯让你来的？");
    expect(quoteFromText("“郑伯让你来的？”沈砚问", text)).toBe("郑伯让你来的？”沈砚问");
  });
  it("跨段的去掉段间换行；几截的用「……」接上", () => {
    expect(quoteFromText("四十来岁。郑伯", text)).toBe("四十来岁。“郑伯");
    expect(quoteFromText("领头的是个……腿一软", text)).toBe("领头的是个……腿一软");
  });
  it("核不上的给 undefined", () => {
    expect(quoteFromText("白脸汉子", text)).toBeUndefined();
  });
});
