// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadBoard as Board, ThreadBoardItem } from "../../../api/storyThreadsClient.js";
import { ThreadBoard } from "./ThreadBoard.js";

const item = (over: Partial<ThreadBoardItem> & Pick<ThreadBoardItem, "id" | "title" | "status">): ThreadBoardItem => ({
  type: "question",
  weight: "normal",
  openedAt: 3,
  lastTouchedAt: 3,
  idle: 0,
  touches: [{ chapter: 3, op: "open", note: "埋下钥匙", quote: "一把铜钥匙" }],
  ...over,
});

const BOARD: Board = {
  upTo: 10,
  threads: [
    item({ id: "t-key", title: "钥匙开什么", status: "stale", idle: 7, weight: "major" }),
    item({ id: "t-shen", title: "沈同志是谁", status: "active", lastTouchedAt: 9, touches: [
      { chapter: 3, op: "open", note: "提到沈同志", quote: "姓沈的女同志" },
      { chapter: 9, op: "advance", note: "知道了全名" },
    ] }),
    item({ id: "t-new", title: "外乡人", status: "open", openedAt: 10, lastTouchedAt: 10 }),
    item({ id: "t-done", title: "表为什么停", status: "closed", closedAt: 8, closedBy: "author" }),
  ],
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("伏笔看板（重构 P6，草图 ④）", () => {
  it("四列照状态分；头上一句总数；停太久写停了几章", async () => {
    mockFetch({ ok: true, board: BOARD });
    render(<ThreadBoard projectPath="/book" busy={false} />);
    await screen.findByText("钥匙开什么");
    expect(screen.getByText("开着 3 条（停太久 1 条） · 已收 1 条 · 算到第 10 章。点一条看经过，点原句回稿纸。")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "停太久 1 条" })).getByText("停了 7 章没动")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "在推进 1 条" })).getByText("沈同志是谁")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "刚埋下 1 条" })).getByText("外乡人")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "已收口 1 条" })).getByText("第 3 章埋 · 第 8 章收（你收的）")).toBeTruthy();
    expect(screen.getByText("大伏笔")).toBeTruthy();
  });

  it("点卡看经过；点原句回稿纸（带章号和原句）；没原句的那笔不能点", async () => {
    mockFetch({ ok: true, board: BOARD });
    const onJump = vi.fn();
    render(<ThreadBoard projectPath="/book" busy={false} onJump={onJump} />);
    fireEvent.click(await screen.findByRole("button", { name: /沈同志是谁/u }));
    expect(screen.getByText("第 9 章 · 推进")).toBeTruthy();
    expect(screen.getByText("知道了全名")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "「姓沈的女同志」" }));
    expect(onJump).toHaveBeenCalledWith(3, "姓沈的女同志");
    expect(screen.getAllByRole("button", { name: /^「/u })).toHaveLength(1);
  });

  it("【这条收了】【分量】发「确认改账」结构化动作（线索编号只在动作里）；收了的没有这两个；有动作在跑不让点", async () => {
    mockFetch({ ok: true, board: BOARD });
    const onAction = vi.fn();
    const { rerender } = render(<ThreadBoard projectPath="/book" busy={false} onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: /钥匙开什么/u }));
    fireEvent.click(screen.getByRole("button", { name: "这条收了" }));
    expect(onAction).toHaveBeenLastCalledWith({
      toolName: "ledger_decision",
      key: "board-close-t-key-10",
      decisions: [{ type: "thread.close", thread: "t-key", chapter: 10 }],
      label: "收掉线索「钥匙开什么」",
    });
    fireEvent.click(within(screen.getByRole("group", { name: "分量" })).getByRole("button", { name: "小线索" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({
      decisions: [{ type: "thread.weight", thread: "t-key", weight: "minor" }],
      label: "线索「钥匙开什么」定为小线索",
    }));
    // 当前分量那个按钮按下、点不了。
    expect((within(screen.getByRole("group", { name: "分量" })).getByRole("button", { name: "大伏笔" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<ThreadBoard projectPath="/book" busy onAction={onAction} />);
    expect((screen.getByRole("button", { name: "这条收了" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<ThreadBoard projectPath="/book" busy={false} onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: /表为什么停/u }));
    expect(screen.queryByRole("button", { name: "这条收了" })).toBeNull();
  });

  it("读不到如实说原因，可以再读；没有线索说清楚", async () => {
    const fetchMock = mockFetch({ ok: false, error: "这本书的账还没接到新格式上：坏了" });
    render(<ThreadBoard projectPath="/book-new" busy={false} />);
    expect(await screen.findByText(/这本书的账还没接到新格式上：坏了/u)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, board: { upTo: 0, threads: [] } })));
    fireEvent.click(screen.getByRole("button", { name: "再读一次" }));
    await waitFor(() => expect(screen.getByText("还没有线索：定稿时记账员会把埋下的伏笔记在这里。")).toBeTruthy());
  });
});
