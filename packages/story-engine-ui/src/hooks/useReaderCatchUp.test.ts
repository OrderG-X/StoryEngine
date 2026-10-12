// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReaderCatchUp, READER_CATCH_UP_POLL_MS } from "./useReaderCatchUp.js";
import { fetchReaderCatchUp } from "../api/client.js";
import type { ReaderCatchUpStatus } from "../api/types.js";

vi.mock("../api/client.js", () => ({ fetchReaderCatchUp: vi.fn() }));

const fetchMock = vi.mocked(fetchReaderCatchUp);

const reading: ReaderCatchUpStatus = {
  reading: true,
  roles: [
    { role: "checker", reading: true, done: 34, total: 58 },
    { role: "ledger", reading: false, done: 0, total: 58 },
    { role: "planner", reading: false, done: 0, total: 58 },
  ],
};

const allDone: ReaderCatchUpStatus = {
  reading: false,
  roles: [
    { role: "checker", reading: false, done: 58, total: 58 },
    { role: "ledger", reading: false, done: 58, total: 58 },
    { role: "planner", reading: false, done: 58, total: 58 },
  ],
};

const advancePoll = async () => {
  // 轮询回调里 setState：包一层 act 让这次渲染落定，再断言结果。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(READER_CATCH_UP_POLL_MS);
  });
};

describe("useReaderCatchUp 在读前文轮询（R4.3）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("没在读（初值 reading:false / 没初值 / 没开书）：不轮询", async () => {
    fetchMock.mockResolvedValue(reading);
    const idle = renderHook(() => useReaderCatchUp("/books/demo", allDone));
    const noInitial = renderHook(() => useReaderCatchUp("/books/demo", undefined));
    const noBook = renderHook(() => useReaderCatchUp(null, reading));
    await advancePoll();
    await advancePoll();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(idle.result.current).toBe(allDone);
    expect(noInitial.result.current).toBeNull();
    expect(noBook.result.current).toBeNull();
  });

  it("在读：每 5 秒轮一次，轮询结果替换显示", async () => {
    fetchMock.mockResolvedValue(reading);
    const { result } = renderHook(() => useReaderCatchUp("/books/demo", reading));
    expect(result.current).toBe(reading); // 第一次显示还没来：先显示开书概况的初值
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const next: ReaderCatchUpStatus = {
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 40, total: 58 },
        { role: "ledger", reading: false, done: 0, total: 58 },
        { role: "planner", reading: false, done: 0, total: 58 },
      ],
    };
    fetchMock.mockResolvedValue(next);
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(next);
  });

  it("全读完（reading:false）：这次结果照收、之后停止轮询", async () => {
    fetchMock.mockResolvedValue(reading);
    const { result } = renderHook(() => useReaderCatchUp("/books/demo", reading));
    await advancePoll();
    fetchMock.mockResolvedValue(allDone);
    await advancePoll();
    expect(result.current).toBe(allDone);
    expect(result.current?.reading).toBe(false); // 界面据此把这行进度收掉
    // reading 已翻成 false：再走 3 个周期也不该再发请求。
    await advancePoll();
    await advancePoll();
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("轮询失败：静默，下一周期接着试", async () => {
    fetchMock.mockRejectedValueOnce(new Error("网络抖了一下")).mockResolvedValue(reading);
    renderHook(() => useReaderCatchUp("/books/demo", reading));
    await advancePoll();
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("换书：旧轮询停、旧结果不闪到新书（先回到新书初值）", async () => {
    fetchMock.mockResolvedValue(reading);
    const { result, rerender } = renderHook(
      ({ path }: { readonly path: string | null }) => useReaderCatchUp(path, path ? reading : undefined),
      { initialProps: { path: "/books/old" as string | null } },
    );
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ path: "/books/new" });
    expect(result.current).toBe(reading); // 新书自己的初值，不是旧书的轮询快照
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/books/new");
    // 卸载（离开这本书）后不再轮询。
    rerender({ path: null });
    await advancePoll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
