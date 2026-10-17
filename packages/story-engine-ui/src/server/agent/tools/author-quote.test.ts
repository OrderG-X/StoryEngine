import { describe, expect, it } from "vitest";

import { checkAuthorQuote } from "./author-quote.js";

describe("checkAuthorQuote 找原句", () => {
  it("逐句出自作者的话（标点、空白不同也算）→ 全找到", () => {
    const check = checkAuthorQuote("让林溪回来，和陆沉吵一架", ["写第5章。让林溪回来！然后 和陆沉吵一架"]);
    expect(check.notFound).toEqual([]);
    expect(check.quoted).toEqual(["让林溪回来", "和陆沉吵一架"]);
  });

  it("转述（换了词）→ 找不到", () => {
    const check = checkAuthorQuote("林溪返回老宅后发现信件丢失", ["写第5章，林溪回到老宅，发现信不见了"]);
    expect(check.quoted).toEqual([]);
    expect(check.notFound).toEqual(["林溪返回老宅后发现信件丢失"]);
  });

  it("夹带自己加的句子 → 只有那句找不到", () => {
    const check = checkAuthorQuote("林溪回到老宅；并埋下伏笔", ["林溪回到老宅"]);
    expect(check.quoted).toEqual(["林溪回到老宅"]);
    expect(check.notFound).toEqual(["并埋下伏笔"]);
  });

  it("可以出自更早的一句", () => {
    const check = checkAuthorQuote("林溪回来", ["这章让林溪回来", "好，写吧"]);
    expect(check.notFound).toEqual([]);
  });

  it("没有作者的话 → 一句都找不到", () => {
    expect(checkAuthorQuote("林溪回来", []).notFound).toEqual(["林溪回来"]);
  });
});
