import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { buildPaletteGroups, markQuery } from "./CommandPalette.js";

const ch = (n: number, title: string, status: "committed" | "draft" | "planned" = "committed") => ({ id: `c${n}`, chapterNumber: n, title, status });

describe("改版 ⌘K 面板：分组与过滤", () => {
  const base = {
    chapters: [ch(1, "第一章 · 梧桐街九号"), ch(19, "看手"), ch(20, "看手"), ch(58, "第58章 · 西侧二层"), ch(59, "下一章", "planned")],
    characters: [{ name: "周屿", role: "主角" }, { name: "沈栀", role: "女主" }],
    librarySources: [{ cat: "places", catLabel: "地点", items: ["梧桐街九号：老洋房改的咖啡馆"] }],
    commands: [{ id: "theme", label: "切换深色 / 纸面主题", hint: "外观", run: vi.fn() }],
    onPickChapter: vi.fn(), onPickCharacter: vi.fn(), onPickSetting: vi.fn(),
  };

  it("空查询：最近章节（新章在上、剥掉重复章号前缀、不含未写的占位章）+ 人物 + 命令", () => {
    const groups = buildPaletteGroups({ ...base, query: "" });
    expect(groups.map((g) => g.title)).toEqual(["章节", "人物", "命令"]);
    expect(groups[0]?.items[0]?.label).toBe("第 58 章 · 西侧二层");
  });

  it("当前章已定稿时标「已定稿」，不误标「工作稿」", () => {
    const groups = buildPaletteGroups({ ...base, query: "58", chapters: [{ id: "c58", chapterNumber: 58, title: "西侧二层", status: "current" as const, hasCommittedChapter: true }] });
    expect(groups[0]?.items[0]?.hint).toBe("已定稿");
  });

  it("按章名或章号搜；未写的占位章不进搜索结果", () => {
    expect(buildPaletteGroups({ ...base, query: "看手" })[0]?.items.map((i) => i.label)).toEqual(["第 20 章 · 看手", "第 19 章 · 看手"]);
    expect(buildPaletteGroups({ ...base, query: "58" })[0]?.items.map((i) => i.label)).toEqual(["第 58 章 · 西侧二层"]);
    // 章号正好对上的排最前，章名里带这个数的排后面
    const numbered = buildPaletteGroups({ ...base, query: "8", chapters: [ch(8, "夜渡"), ch(18, "残局18"), ch(118, "旧信118")] });
    expect(numbered[0]?.items.map((i) => i.label)).toEqual(["第 8 章 · 夜渡", "第 118 章 · 旧信118", "第 18 章 · 残局18"]);
    expect(buildPaletteGroups({ ...base, query: "下一章" }).find((g) => g.title === "章节")).toBeUndefined();
  });

  it("有查询时出「设定」组，点了跳对应类目", () => {
    const groups = buildPaletteGroups({ ...base, query: "咖啡馆" });
    const setting = groups.find((g) => g.title === "设定");
    expect(setting?.items[0]?.hint).toBe("地点");
    setting?.items[0]?.run();
    expect(base.onPickSetting).toHaveBeenCalledWith("places", undefined);
  });

  it("命中某张卡上的字：点了跳过去并展开那张卡", () => {
    const onPickSetting = vi.fn();
    const groups = buildPaletteGroups({
      ...base,
      onPickSetting,
      librarySources: [{ cat: "chars", catLabel: "人物", focus: "沈栀", items: ["沈栀", "身份：咖啡馆老板"] }],
      query: "老板",
    });
    groups.find((g) => g.title === "设定")?.items[0]?.run();
    expect(onPickSetting).toHaveBeenCalledWith("chars", "沈栀");
  });

  it("正文组（对标走查：⌘K 搜不到正文）：每章一条、标几处，点了回那一章的原句；超出只列前几章也如实说", () => {
    const onPickText = vi.fn();
    const text = {
      hits: [
        { chapter: 3, count: 2, snippet: "…三枚铜钱排在桌上…", quote: "三枚铜钱排在桌上" },
        { chapter: 7, count: 1, snippet: "铜钱不见了。", quote: "铜钱不见了。" },
      ],
      chapters: 2,
      occurrences: 3,
    };
    const groups = buildPaletteGroups({ ...base, query: "铜钱", text, onPickText });
    const group = groups.find((g) => g.title.startsWith("正文"));
    expect(group?.title).toBe("正文 · 2 章出现 3 次");
    expect(group?.items.map((i) => [i.label, i.hint])).toEqual([["…三枚铜钱排在桌上…", "第 3 章 · 2 处"], ["铜钱不见了。", "第 7 章"]]);
    group?.items[0]?.run();
    expect(onPickText).toHaveBeenCalledWith(3, "三枚铜钱排在桌上");

    const more = buildPaletteGroups({ ...base, query: "铜钱", text: { ...text, chapters: 60, occurrences: 90 }, onPickText });
    expect(more.find((g) => g.title.startsWith("正文"))?.title).toBe("正文 · 60 章出现 90 次，先列前 2 章");
    expect(buildPaletteGroups({ ...base, query: "", text, onPickText }).some((g) => g.title.startsWith("正文"))).toBe(false);
  });

  it("正文片段把搜的字标出来（英文不分大小写），没搜的字原样", () => {
    const parts = markQuery("…铜钱落地，又一枚铜钱。", "铜钱");
    expect(parts.filter((part) => isValidElement(part))).toHaveLength(2);
    expect(parts.filter((part) => typeof part === "string")).toEqual(["…", "落地，又一枚", "。"]);
    expect(markQuery("Tom came", "tom").filter((part) => isValidElement(part))).toHaveLength(1);
    expect(markQuery("没有", "铜钱")).toEqual(["没有"]);
  });
});
