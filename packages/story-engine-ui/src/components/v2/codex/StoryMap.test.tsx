// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryMap as MapData, StoryMapMember, PaceReport } from "../../../api/storyMapClient.js";
import { StoryMap, dayDetail, daysPassed, paceBarWidth, paceCellTitle } from "./StoryMap.js";

const who = (name: string, chapters: readonly number[], over: Partial<StoryMapMember> = {}): StoryMapMember => ({
  name,
  aliases: [],
  viewpointChapters: [],
  appearances: chapters.map((chapter) => ({ chapter, quote: `${name}在第${chapter}章` })),
  ...over,
});

const MAP: MapData = {
  upTo: 3,
  chapters: [
    { chapter: 1, day: 1, dayEnd: 1, weekday: 0, weekdayDerived: false, timeOfDay: "傍晚", basis: "text", summary: "周守义到了九号院", present: ["周守义", "老板娘"], viewpoint: "周守义" },
    { chapter: 2, day: 2, dayEnd: 2, weekday: 1, weekdayDerived: true, basis: "estimated", present: ["周守义"] },
    { chapter: 3, day: 6, dayEnd: 7, basis: "missing", weekdayDerived: false, present: ["周守义", "沈同志"] },
  ],
  cast: [
    who("周守义", [1, 2, 3], { aliases: ["老周"], viewpointChapters: [1] }),
    who("老板娘", [1]),
    who("沈同志", [3]),
  ],
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("故事地图（重构 P6，草图 ③）", () => {
  it("一行一章带故事日（星期·时段、推出来的标「推」、估的标「估」）；隔了好几天标出来；章名从章节列表来", async () => {
    mockFetch({ ok: true, map: MAP });
    render(<StoryMap projectPath="/book" busy={false} chapterTitles={new Map([[1, "九号院"]])} />);
    expect(await screen.findByText("一行一章，一列一人。点圆点回到他出场那句。")).toBeTruthy();
    expect(screen.getByText("人出场").closest("dl")?.textContent).toBe("章3故事日7人出场3");
    expect(screen.getByText("九号院")).toBeTruthy();
    expect(screen.getByText("周一 · 傍晚")).toBeTruthy();
    expect(screen.getByText("周二（推）")).toBeTruthy();
    expect(screen.getByText("第 6～7 天")).toBeTruthy();
    expect(screen.getAllByText("估")).toHaveLength(2);
    expect(screen.getByText("过了 4 天")).toBeTruthy();
    expect(screen.getByText("周守义到了九号院")).toBeTruthy();
  });

  it("出场画点、视角画圈；点圆点回稿纸（带章号和原句）；点章号打开那一章", async () => {
    mockFetch({ ok: true, map: MAP });
    const onJump = vi.fn();
    const onOpenChapter = vi.fn();
    render(<StoryMap projectPath="/book" busy={false} chapterTitles={new Map()} onJump={onJump} onOpenChapter={onOpenChapter} />);
    const pov = await screen.findByRole("button", { name: "周守义，第 1 章（视角）出场" });
    expect(pov.className).toContain("is-pov");
    expect(screen.getByRole("button", { name: "周守义，第 2 章出场" }).className).not.toContain("is-pov");
    expect(screen.queryByRole("button", { name: "老板娘，第 2 章出场" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "沈同志，第 3 章出场" }));
    expect(onJump).toHaveBeenCalledWith(3, "沈同志在第3章");
    fireEvent.click(screen.getByRole("button", { name: "第 2 章" }));
    expect(onOpenChapter).toHaveBeenCalledWith(2);
    expect(screen.getByText("周守义").closest("th")?.getAttribute("title")).toBe("也叫：老周");
  });

  it("出场了但没记原句（老书导入的章）：照样画点，点了只打开那一章", async () => {
    mockFetch({ ok: true, map: { ...MAP, cast: [who("周守义", [2]), who("老板娘", [])] } });
    const onJump = vi.fn();
    const onOpenChapter = vi.fn();
    render(<StoryMap projectPath="/book-old" busy={false} chapterTitles={new Map()} onJump={onJump} onOpenChapter={onOpenChapter} />);
    const dot = await screen.findByRole("button", { name: "老板娘，第 1 章出场" });
    expect(dot.getAttribute("title")).toBe("这章没记他出场那句，点开看这一章");
    fireEvent.click(dot);
    expect(onOpenChapter).toHaveBeenCalledWith(1);
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "周守义，第 2 章出场" }));
    expect(onJump).toHaveBeenCalledWith(2, "周守义在第2章");
  });

  it("人多先露 8 个，点「全部 N 人」展开", async () => {
    const cast = Array.from({ length: 10 }, (_, index) => who(`人${index + 1}`, [1]));
    mockFetch({ ok: true, map: { ...MAP, chapters: MAP.chapters.slice(0, 1), cast } });
    render(<StoryMap projectPath="/book-many" busy={false} chapterTitles={new Map()} />);
    await screen.findByText("人8");
    expect(screen.queryByText("人9")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部 10 人" }));
    expect(screen.getByText("人10")).toBeTruthy();
  });

  it("读不到如实说原因，可以再读；没有定稿的章说清楚", async () => {
    const fetchMock = mockFetch({ ok: false, error: "这本书的账还没接到新格式上：坏了" });
    render(<StoryMap projectPath="/book-new" busy={false} chapterTitles={new Map()} />);
    expect(await screen.findByText(/这本书的账还没接到新格式上：坏了/u)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, map: { upTo: 0, chapters: [], cast: [] } })));
    fireEvent.click(screen.getByRole("button", { name: "再读一次" }));
    await waitFor(() => expect(screen.getByText("还没有定稿的章：定稿时记账员会把每章第几天、谁出场记在这里。")).toBeTruthy());
  });

  it("小函数：同一天、隔天不标；星期和时段都没有就空", () => {
    const base = MAP.chapters[1]!;
    expect(daysPassed(undefined, base)).toBe(0);
    expect(daysPassed(MAP.chapters[0], base)).toBe(0);
    expect(daysPassed(base, MAP.chapters[2]!)).toBe(4);
    expect(dayDetail(MAP.chapters[2]!)).toBe("");
  });

  it("节奏：每章一根条、可能拖 / 赶打记号；上面列原因，点了滚到那一行亮一下", async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    const pace: PaceReport = {
      typical: { density: 1, words: 2000 },
      chapters: [
        { chapter: 1, words: 2000, opened: 2, advanced: 0, closed: 0, span: 0, storyDays: 0, timeSure: true },
        { chapter: 2, words: 2000, opened: 0, advanced: 0, closed: 0, density: 0, span: 0, storyDays: 1, timeSure: false, pace: "slow" },
        { chapter: 3, words: 900, opened: 0, advanced: 3, closed: 1, density: 5.6, span: 1, storyDays: 5, timeSure: false, pace: "fast" },
      ],
      flags: [
        { kind: "drag", reason: "slow", from: 2, to: 2, words: 2000, advanced: 0, closed: 0 },
        { kind: "rush", reason: "dense", from: 3, to: 3, words: 900, advanced: 3, closed: 1 },
      ],
    };
    mockFetch({ ok: true, map: { ...MAP, pace } });
    render(<StoryMap projectPath="/book-pace" busy={false} chapterTitles={new Map()} />);
    const notes = await screen.findByRole("list");
    expect(notes.textContent).toBe("拖第 2 章2,000 字没推进线索赶第 3 章900 字里推进 3 条、收了 1 条线索");
    expect(screen.getByText("节奏", { selector: "th" }).getAttribute("title")).toContain("竖线是全书平常");
    const row3 = document.querySelector('tr[data-chapter="3"]')!;
    expect(row3.querySelector(".se-sm-pacetag")?.textContent).toBe("赶");
    expect(row3.querySelector(".se-sm-pace")?.getAttribute("title")).toBe("900 字 · 推进 3 · 收 1\n可能赶：900 字里推进 3 条、收了 1 条线索");
    expect(document.querySelector('tr[data-chapter="1"] .se-sm-pacebar')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /第 2 章2,000 字没推进线索/u }));
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.querySelector('tr[data-chapter="2"]')?.className).toBe("is-flash");
    Element.prototype.scrollIntoView = original;
  });

  it("节奏下不了结论、或没看出问题：一句话说清，不硬标", async () => {
    mockFetch({ ok: true, map: { ...MAP, pace: { chapters: [], flags: [] } } });
    const { unmount } = render(<StoryMap projectPath="/book-pace-few" busy={false} chapterTitles={new Map()} />);
    expect(await screen.findByText("节奏：能比较的定稿章还少（或账里记的线索推进太少），先不下结论。")).toBeTruthy();
    unmount();
    mockFetch({ ok: true, map: { ...MAP, pace: { typical: { density: 1, words: 2000 }, chapters: [], flags: [] } } });
    render(<StoryMap projectPath="/book-pace-fine" busy={false} chapterTitles={new Map()} />);
    expect(await screen.findByText("节奏：没看出明显拖或赶的章。")).toBeTruthy();
  });

  it("节奏条按全书平常量，最长画到三倍；没密度的不画", () => {
    const report: PaceReport = { typical: { density: 2, words: 2000 }, chapters: [], flags: [] };
    const row = { chapter: 1, words: 2000, opened: 0, advanced: 2, closed: 0, span: 0, storyDays: 1, timeSure: true };
    expect(paceBarWidth({ ...row, density: 2 }, report)).toBe(33);
    expect(paceBarWidth({ ...row, density: 20 }, report)).toBe(100);
    expect(paceBarWidth(row, report)).toBe(0);
    expect(paceCellTitle({ ...row, opened: 1 }, [])).toBe("2,000 字 · 推进 2 · 收 0 · 新开 1\n字太少、或前面还没有线索可推，不算");
  });
});
