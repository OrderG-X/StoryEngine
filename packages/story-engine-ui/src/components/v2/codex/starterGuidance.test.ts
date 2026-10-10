import { describe, expect, it } from "vitest";
import {
  STARTER_INTENTS,
  defaultCenterViewForWorkspace,
  isStarterEmptyWorkspace,
} from "./starterGuidance.js";

describe("starterGuidance", () => {
  it("三意图文案与唯一控制面 intent 齐全", () => {
    expect(STARTER_INTENTS).toHaveLength(3);
    expect(STARTER_INTENTS.map((i) => i.label)).toEqual([
      "我有一个点子",
      "帮我理主角",
      "直接写开头",
    ]);
    for (const intent of STARTER_INTENTS) {
      expect(intent.intent.trim().length).toBeGreaterThan(4);
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
    expect(
      defaultCenterViewForWorkspace({
        draft: { content: "", wordCount: 0 },
        chapters: [],
      }),
    ).toBe("desk");
    expect(
      defaultCenterViewForWorkspace({
        draft: { content: "有字真正文", wordCount: 4 },
        chapters: [],
      }),
    ).toBe("desk");
  });
});
