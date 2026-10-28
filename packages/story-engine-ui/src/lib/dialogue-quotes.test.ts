import { describe, expect, it } from "vitest";

import { chinesePunctuation, chinesePunctuationLike } from "./dialogue-quotes.js";

describe("chinesePunctuation：英文直引号换成中文引号", () => {
  it("每段按出现顺序一开一合", () => {
    expect(chinesePunctuation("\"东西走程序了。\"孟叔说，\"剩下的不归咱管。\"\n\"杜卫平走了？\"她问。"))
      .toBe("“东西走程序了。”孟叔说，“剩下的不归咱管。”\n“杜卫平走了？”她问。");
  });

  it("一段只有一个（跨段引语）当开引号；下一段重新数", () => {
    expect(chinesePunctuation("\"第一段话说到这里，\n\"第二段接着说。\"")).toBe("“第一段话说到这里，\n“第二段接着说。”");
  });

  it("没有直引号的原样返回；中文引号不动", () => {
    const text = "“我出。”杜卫平说。";
    expect(chinesePunctuation(text)).toBe(text);
  });
});

describe("chinesePunctuation：汉字后面的半角逗号、问号这些换成全角", () => {
  it("汉字、中文标点后面的换；连着的也换", () => {
    expect(chinesePunctuation("上午九点过,许微出来,看见门开着。字条上写着:三号仓;她问:\"谁?!\""))
      .toBe("上午九点过，许微出来，看见门开着。字条上写着：三号仓；她问：“谁？！”");
    expect(chinesePunctuation("“走吧”,他说。")).toBe("“走吧”，他说。");
  });

  it("数字、字母后面的不动", () => {
    const text = "一共3,000块，十点10:30到，他说OK,就走了。";
    expect(chinesePunctuation(text)).toBe(text);
  });
});

describe("chinesePunctuationLike：改稿、接着写换进来的那段跟着原文的写法", () => {
  it("原文用中文标点 → 换进来的那段换成中文的", () => {
    expect(chinesePunctuationLike("他说：“走。”她没动，", "\"等等,\"她说")).toBe("“等等，”她说");
  });

  it("原文整篇用直引号 / 半角逗号 → 跟着原文，不换", () => {
    expect(chinesePunctuationLike("他说:\"走.\"她没动,", "\"等等,\"她说")).toBe("\"等等,\"她说");
    expect(chinesePunctuationLike("他说：“走。”她没动,", "她说,等等")).toBe("她说,等等");
  });

  it("弯引号 / 直角引号跟着原文：换进来的全用了另一种才换；两种都用了的不动（换题材长篇实跑第 23 章）", () => {
    expect(chinesePunctuationLike("他说：“走。”她没动。", "「汤，周伯。」她说『东片』")).toBe("“汤，周伯。”她说‘东片’");
    expect(chinesePunctuationLike("他说：「走。」她没动。", "“汤，周伯。”")).toBe("「汤，周伯。」");
    expect(chinesePunctuationLike("他说：“走。”她没动。", "“汤。”她说「东片」")).toBe("“汤。”她说「东片」");
    expect(chinesePunctuationLike("", "「汤。」")).toBe("「汤。」");
  });
});
