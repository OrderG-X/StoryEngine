import { describe, expect, it } from "vitest";
import {
  STARTER_INTENTS,
  defaultCenterViewForWorkspace,
  isStarterEmptyWorkspace,
  starterSteps,
} from "./starterGuidance.js";

describe("starterGuidance", () => {
  it("三个起步按钮都是填半句话、留给作者接着写", () => {
    expect(STARTER_INTENTS).toHaveLength(3);
    expect(STARTER_INTENTS.map((i) => i.label)).toEqual([
      "我有一个点子",
      "帮我理主角",
      "直接写开头",
    ]);
    for (const item of STARTER_INTENTS) {
      expect(item.prefill.endsWith("：")).toBe(true);
    }
  });

  it("无草稿无正式章 → 空书", () => {
    expect(
      isStarterEmptyWorkspace({
        draft: { content: "", wordCount: 0 },
        chapters: [{ hasDraftFile: false, hasCommittedChapter: false }],
      }),
    ).toBe(true);
  });

  it("占位引导稿不算真正文 → 仍空书", () => {
    expect(
      isStarterEmptyWorkspace({
        draft: {
          content: "还没有草稿正文。\n\n你可以在右侧章节对话里输入第 1 章方向。",
          wordCount: 83,
        },
        chapters: [{ hasDraftFile: false, hasCommittedChapter: false }],
      }),
    ).toBe(true);
  });

  it("当前稿有真正文 → 非空书", () => {
    expect(
      isStarterEmptyWorkspace({
        draft: { content: "开头一段真正文", wordCount: 6 },
        chapters: [],
      }),
    ).toBe(false);
  });

  it("任一章有真草稿文件 → 非空书", () => {
    expect(
      isStarterEmptyWorkspace({
        draft: { content: "", wordCount: 0 },
        chapters: [{ hasDraftFile: true, hasCommittedChapter: false }],
      }),
    ).toBe(false);
  });

  it("任一章已定稿 → 非空书", () => {
    expect(
      isStarterEmptyWorkspace({
        draft: { content: "  ", wordCount: 0 },
        chapters: [{ hasDraftFile: false, hasCommittedChapter: true }],
      }),
    ).toBe(false);
  });

  it("列表只带 status、没带文件标记（刷新后点「下一章」）：前面有已定稿章 → 非空书，不弹新书引导", () => {
    expect(
      isStarterEmptyWorkspace({
        draft: { content: "", wordCount: 0 },
        chapters: [{ status: "committed" }, { status: "committed" }, { status: "current", hasDraftFile: false, hasCommittedChapter: false }],
      }),
    ).toBe(false);
    expect(isStarterEmptyWorkspace({ draft: { content: "" }, chapters: [{ status: "current" }, { status: "planned" }] })).toBe(true);
  });

  it("空书、非空书打开都落写作台（书架点的是「继续写」）", () => {
    expect(defaultCenterViewForWorkspace()).toBe("desk");
  });

  it("开书三步：设定本还空着第一步不打勾；有卡就打勾、列名字，多的说等几个", () => {
    const empty = starterSteps({ chapter: 1, cardNames: [], storyFilled: false });
    expect(empty.map((step) => step.label)).toEqual(["说说故事", "第一章往哪走", "写"]);
    expect(empty[0]).toMatchObject({ done: false, hint: "跟 AI 聊聊点子，它把人物、世界记进设定本" });
    expect(starterSteps({ chapter: 1, cardNames: ["沈延"], storyFilled: false })[0]).toMatchObject({ done: true, hint: "设定本里有了：沈延" });
    expect(starterSteps({ chapter: 1, cardNames: ["甲", "乙", "丙", "丁", " "], storyFilled: true })[0]!.hint).toBe("设定本里有了：甲、乙、丙 等 4 个");
    expect(starterSteps({ chapter: 1, cardNames: [], storyFilled: true })[0]).toMatchObject({ done: true, hint: "设定本里有了故事设定" });
    expect(starterSteps({ chapter: 1, cardNames: ["沈延"], storyFilled: true }).slice(1).every((step) => !step.done)).toBe(true);
    expect(starterSteps({ chapter: 3, cardNames: [], storyFilled: false })[1]!.label).toBe("第 3 章往哪走");
  });
});
