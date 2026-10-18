// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryMap as MapData, StoryMapMember } from "../../../api/storyMapClient.js";
import { StoryMap, dayDetail, daysPassed } from "./StoryMap.js";

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
    expect(await screen.findByText("3 章，故事走到第 7 天，出场 3 人。点圆点回到他出场那句。")).toBeTruthy();
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
    expect(screen.getByText("周守义").getAttribute("title")).toBe("也叫：老周");
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
});
