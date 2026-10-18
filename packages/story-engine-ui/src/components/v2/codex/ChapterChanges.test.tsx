// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterChanges as Changes } from "../../../api/chapterChangesClient.js";
import { ChapterChanges } from "./ChapterChanges.js";

const CHANGES: Changes = {
  chapter: 12,
  chapters: [11, 12],
  summary: "翻出汇款存根",
  day: 13,
  dayEnd: 13,
  present: ["林舟", "林溪"],
  newCast: [{ name: "沈家侄女", quote: "是修表铺的林师傅吧" }],
  threads: [
    { op: "open", title: "半夜的来电", note: "号码又打来" },
    ...Array.from({ length: 7 }, (_, i) => ({ op: "advance" as const, title: `线索${i + 1}`, note: "推进了", quote: `原句${i + 1}` })),
  ],
  facts: [
    { subject: "林溪", text: "林溪退了返程票", quote: "退票的确认弹出来", replaces: "林溪订了周日的返程票", auto: true },
    { text: "汇款每季一张", auto: false, later: "retracted" },
  ],
};

function mockFetch(body: unknown) {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("设定本「这章改了什么」（重构 P6 第 6 步）", () => {
  it("第一次出场 / 线索 / 记下的事分组；顶掉的旧说法、自动记的、后来撤了都标出；线索多了先收起", async () => {
    const fetchMock = mockFetch({ ok: true, changes: CHANGES });
    render(<ChapterChanges projectPath="/book" chapter={12} busy={false} chapterTitles={new Map([[12, "第12章 · 存根"]])} />);
    expect(await screen.findByRole("heading", { name: "第 12 章 · 存根 改了什么" })).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toContain("chapter=12");
    expect(screen.getByText("故事第 13 天 · 翻出汇款存根")).toBeTruthy();
    expect(screen.getByText("沈家侄女")).toBeTruthy();
    expect(screen.getByText("原来：林溪订了周日的返程票")).toBeTruthy();
    expect(screen.getByText("自动记的")).toBeTruthy();
    expect(screen.getByText("后来撤了")).toBeTruthy();
    expect(screen.queryByText("线索7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再看 2 条" }));
    expect(screen.getByText("线索7")).toBeTruthy();
    expect(screen.getByRole("button", { name: "‹ 第 11 章" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /第 13 章/u })).toBeNull();
  });

  it("点原句回稿纸那一章那一句；翻到上一章重新读", async () => {
    const fetchMock = mockFetch({ ok: true, changes: CHANGES });
    const onJump = vi.fn();
    render(<ChapterChanges projectPath="/book" busy={false} chapterTitles={new Map()} onJump={onJump} />);
    fireEvent.click(await screen.findByRole("button", { name: "「退票的确认弹出来」" }));
    expect(onJump).toHaveBeenCalledWith(12, "退票的确认弹出来");
    fireEvent.click(screen.getByRole("button", { name: "‹ 第 11 章" }));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)![0]).toContain("chapter=11"));
  });

  it("读不到如实说原因，能再读一次", async () => {
    mockFetch({ ok: false, error: "还没有定稿的章。" });
    render(<ChapterChanges projectPath="/book" busy={false} chapterTitles={new Map()} />);
    expect(await screen.findByText(/还没有定稿的章。/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "再读一次" })).toBeTruthy();
  });
});
