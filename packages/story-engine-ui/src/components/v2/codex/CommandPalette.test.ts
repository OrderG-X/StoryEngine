import { describe, expect, it, vi } from "vitest";
import { buildPaletteGroups, parsePaletteCharacters } from "./CommandPalette.js";

const ch = (n: number, title: string, status: "committed" | "draft" | "planned" = "committed") => ({ id: `c${n}`, chapterNumber: n, title, status });

describe("改版 ⌘K 面板：分组与过滤", () => {
  const base = {
    chapters: [ch(1, "第一章 · 梧桐街九号"), ch(19, "看手"), ch(20, "看手"), ch(58, "第58章 · 西侧二层"), ch(59, "下一章", "planned")],
    characters: [{ name: "周屿", role: "主角" }, { name: "沈栀", role: "女主" }],
    librarySources: [{ cat: "places", catLabel: "地点", items: ["梧桐街九号：老洋房改的咖啡馆"] }],
    commands: [{ id: "theme", label: "切换深色 / 纸面主题", hint: "外观", run: vi.fn() }],
    onPickChapter: vi.fn(), onPickCharacter: vi.fn(), onPickSetting: vi.fn(),
  };

  it("空查询：最近章节（新章在上、剥掉重复章号前缀、不含未写的占位章）+ 角色 + 命令", () => {
    const groups = buildPaletteGroups({ ...base, query: "" });
    expect(groups.map((g) => g.title)).toEqual(["章节", "角色", "命令"]);
    expect(groups[0]?.items[0]?.label).toBe("第 58 章 · 西侧二层");
  });

  it("当前章已定稿时标「已定稿」，不误标「工作稿」", () => {
    const groups = buildPaletteGroups({ ...base, query: "58", chapters: [{ id: "c58", chapterNumber: 58, title: "西侧二层", status: "current" as const, hasCommittedChapter: true }] });
    expect(groups[0]?.items[0]?.hint).toBe("已定稿");
  });

  it("按章名或章号搜；未写的占位章不进搜索结果", () => {
    expect(buildPaletteGroups({ ...base, query: "看手" })[0]?.items.map((i) => i.label)).toEqual(["第 20 章 · 看手", "第 19 章 · 看手"]);
    expect(buildPaletteGroups({ ...base, query: "58" })[0]?.items.map((i) => i.label)).toEqual(["第 58 章 · 西侧二层"]);
    expect(buildPaletteGroups({ ...base, query: "下一章" }).find((g) => g.title === "章节")).toBeUndefined();
  });

  it("有查询时出「设定」组，点了跳对应类目", () => {
    const groups = buildPaletteGroups({ ...base, query: "咖啡馆" });
    const setting = groups.find((g) => g.title === "设定");
    expect(setting?.items[0]?.hint).toBe("地点");
    setting?.items[0]?.run();
    expect(base.onPickSetting).toHaveBeenCalledWith("places");
  });

  it("parsePaletteCharacters：只认角色卡 JSON，去重，坏串跳过不露原文", () => {
    expect(parsePaletteCharacters([
      JSON.stringify({ name: "周屿", role: "主角" }),
      JSON.stringify({ name: "周屿", role: "主角" }),
      "不是 JSON",
      JSON.stringify({ role: "无名" }),
    ])).toEqual([{ name: "周屿", role: "主角" }]);
  });
});
