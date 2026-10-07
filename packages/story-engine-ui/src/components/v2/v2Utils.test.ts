import { describe, expect, it } from "vitest";

import { chapterHeading, cleanProseForDisplay, flowHint, flowLabel, uiText } from "./v2Utils.js";

describe("uiText", () => {
  it("does not translate story inside filesystem paths", () => {
    expect(uiText("正式章节：已写入 /Users/author/story-engine/story-123/chapters/0001.md")).toBe(
      "正式章节：已写入 /Users/author/story-engine/story-123/chapters/0001.md",
    );
  });
});

describe("chapterHeading", () => {
  it("strips a Chinese-numeral 第X章 prefix the model embeds in the title", () => {
    // 模型给的标题自带「第二章」章号标记 → 必须归一成 canonical「第2章」，不能叠出「第2章 · 第二章 · …」
    expect(chapterHeading(2, "第二章 · 灰烬之下")).toBe("第2章 · 灰烬之下");
  });

  it("strips a cross-numbering duplicated prefix (Arabic + Chinese)", () => {
    // Bug 现场：UI 停在第1章却拼了模型的「第二章」标题 → 「第1章 · 第二章 · 灰烬之下」。前缀须全部剥掉。
    expect(chapterHeading(2, "第1章 · 第二章 · 灰烬之下")).toBe("第2章 · 灰烬之下");
  });

  it("normalizes a bare Chinese-numeral chapter title to the canonical number", () => {
    expect(chapterHeading(3, "第三章")).toBe("第3章");
  });

  it("keeps an ordinary title and prepends the canonical chapter", () => {
    expect(chapterHeading(2, "灰烬之下")).toBe("第2章 · 灰烬之下");
  });

  it("does not strip a title that merely starts with 第X (no 章)", () => {
    expect(chapterHeading(2, "第七封印")).toBe("第2章 · 第七封印");
    expect(chapterHeading(49, "第49章 · 待补")).toBe("第49章");
  });
});

describe("flow copy", () => {
  it("uses author-facing idle wording", () => {
    expect(flowLabel("idle")).toBe("待开始");
    expect(flowHint("idle")).toContain("当前章节已就绪");
  });

  it("未知/空 flowStatus 回退为「工作稿中」，绝不空渲染（dogfood 徽标·）", () => {
    expect(flowLabel(undefined)).toBe("工作稿中");
    expect(flowLabel(null)).toBe("工作稿中");
    expect(flowLabel("" as never)).toBe("工作稿中");
  });
});

describe("cleanProseForDisplay：定稿只读视图去掉标题行与粗体记号", () => {
  it("去开头 # 第N章 标题行、去成对 **", () => {
    expect(cleanProseForDisplay("# 第34章 · 看手\n\n他说：**九号，西侧。**\n\n完。")).toBe("他说：九号，西侧。\n\n完。");
  });
  it("正文中间的 # 行与单星号不动", () => {
    expect(cleanProseForDisplay("开头。\n# 不是标题\n* * *")).toBe("开头。\n# 不是标题\n* * *");
  });
});
