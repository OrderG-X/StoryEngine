import { describe, expect, it } from "vitest";

import { curlyStraightQuotes } from "./dialogue-quotes.js";

describe("curlyStraightQuotes：英文直引号换成中文引号", () => {
  it("每段按出现顺序一开一合", () => {
    expect(curlyStraightQuotes("\"东西走程序了。\"孟叔说，\"剩下的不归咱管。\"\n\"杜卫平走了？\"她问。"))
      .toBe("“东西走程序了。”孟叔说，“剩下的不归咱管。”\n“杜卫平走了？”她问。");
  });

  it("一段只有一个（跨段引语）当开引号；下一段重新数", () => {
    expect(curlyStraightQuotes("\"第一段话说到这里，\n\"第二段接着说。\"")).toBe("“第一段话说到这里，\n“第二段接着说。”");
  });

  it("没有直引号的原样返回；中文引号不动", () => {
    const text = "“我出。”杜卫平说。";
    expect(curlyStraightQuotes(text)).toBe(text);
  });
});
