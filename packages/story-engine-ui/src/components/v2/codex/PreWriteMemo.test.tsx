import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PreWriteMemo as Memo } from "../../../api/preWriteMemoClient.js";
import { briefLine, dayText, PreWriteMemo, threadTag } from "./PreWriteMemo.js";

const memo: Memo = {
  chapter: 9,
  previous: {
    chapter: 8,
    summary: "许微夜里回屋，把记录纸塞回床底。",
    present: ["许微", "孟叔"],
    viewpoint: "许微",
    time: { chapter: 8, presentLine: true, start: { lo: 11, hi: 11 }, end: { lo: 11, hi: 11 }, weekdayDerived: true, weekday: 2, timeOfDay: "夜里", basis: "ledger", presumed: false, segments: [], afterUnknown: false },
  },
  days: "第 11 天夜里",
  threads: [
    { id: "t-1", title: "零三号仓是谁", weight: "normal", reason: "previous", previousOp: "advance", idle: 0, last: { chapter: 8, note: "推出是零三号仓", quote: "她推出来了，零三号仓" } },
    { id: "t-2", title: "父亲怎么失踪的", weight: "major", reason: "stale", idle: 21, last: { chapter: 1, note: "开" } },
  ],
  moreThreads: 2,
  changes: [{ subject: "记录纸", attribute: "在哪", value: "床底木箱", chapter: 8, quote: "塞回床板底下" }],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, memo }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("写前备忘", () => {
  it("收起时一行：接第几章、停在哪天、谁在场、几条线索该接", () => {
    expect(briefLine({ ...memo, previous: memo.previous! })).toBe("接第 8 章 · 第 11 天夜里 · 许微、孟叔 · 2 条线索该接");
    const crowd = { ...memo.previous!, present: ["甲", "乙", "丙", "丁", "戊"] };
    expect(briefLine({ ...memo, previous: crowd, threads: [] })).toBe("接第 8 章 · 第 11 天夜里 · 甲、乙、丙等 5 人");
  });

  it("天数照服务端出好的写；没给就说哪天不知道", () => {
    expect(dayText({ days: "第 3 天到第 5 天" })).toBe("第 3 天到第 5 天");
    expect(dayText({})).toBe("哪天不知道");
  });

  it("线索为什么提：上章埋下 / 上章推进 / 停了几章 / 大伏笔", () => {
    expect(threadTag(memo.threads[0]!)).toBe("上章推进");
    expect(threadTag({ ...memo.threads[0]!, previousOp: "open" })).toBe("上章埋下");
    expect(threadTag(memo.threads[1]!)).toBe("停了 21 章");
    expect(threadTag({ ...memo.threads[1]!, reason: "major", idle: 3 })).toBe("大伏笔");
  });

  it("点开列全；线索、状态点了回原句，没原句的点不了", async () => {
    const onJump = vi.fn();
    render(<PreWriteMemo projectPath="/books/a" chapter={9} refreshKey={1} busy={false} onJump={onJump} />);
    const head = await screen.findByRole("button", { name: /写前备忘/u });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("chapter=9");
    fireEvent.click(head);
    expect(screen.getByText("在场：许微（视角）、孟叔")).toBeTruthy();
    expect(screen.getByText("第 8 章 · 第 11 天夜里 · 周三")).toBeTruthy();
    expect(screen.getByText("另有 2 条开着")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /零三号仓是谁/u }));
    expect(onJump).toHaveBeenCalledWith(8, "她推出来了，零三号仓");
    expect((screen.getByRole("button", { name: /父亲怎么失踪的/u }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /记录纸 · 在哪：床底木箱/u }));
    expect(onJump).toHaveBeenLastCalledWith(8, "塞回床板底下");
  });

  it("前面一章都没定稿：什么都不显示；第 1 章不去读", async () => {
    fetchMock.mockImplementation(async () => ({ status: 200, json: async () => ({ ok: true, memo: { chapter: 3, threads: [], moreThreads: 0, changes: [] } }) }));
    const { container, rerender } = render(<PreWriteMemo projectPath="/books/a" chapter={3} refreshKey={1} busy={false} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe("");
    rerender(<PreWriteMemo projectPath="/books/a" chapter={1} refreshKey={1} busy={false} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe("");
  });

  it("读不出来如实说，不装作没什么要接的；写作操作进行中不重读", async () => {
    fetchMock.mockImplementation(async () => ({ status: 200, json: async () => ({ ok: false, error: "这本书的账还没接到新格式上：缺章" }) }));
    const { rerender } = render(<PreWriteMemo projectPath="/books/a" chapter={9} refreshKey={1} busy={false} />);
    expect(await screen.findByText("这本书的账还没接到新格式上：缺章")).toBeTruthy();
    rerender(<PreWriteMemo projectPath="/books/a" chapter={9} refreshKey={2} busy />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
