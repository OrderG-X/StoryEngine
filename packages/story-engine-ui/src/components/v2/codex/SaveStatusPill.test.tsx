// @vitest-environment jsdom
/**
 * 对话没存上要看得见、要自动退避重试：第 1 次 2s，第 2 次 4s（不是每次都 2s）。
 * 稿子没存上由稿纸上方的提示条说，这里不重复。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../../stores/draftStore.js";
import { __resetChatSyncForTests, useChatSaveStore } from "../../../sync/chatSync.js";
import { SaveStatusPill } from "./SaveStatusPill.js";

const retry = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../../sync/chatSync.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../../../sync/chatSync.js")>(), saveChatNow: retry.fn }));

describe("SaveStatusPill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDraftStore.getState().reset();
    __resetChatSyncForTests();
  });
  afterEach(() => {
    cleanup();
    retry.fn.mockReset();
    vi.useRealTimers();
  });

  it("稿子存失败：角上不重复说（稿纸上方的提示条说、稿纸自己再试）", async () => {
    render(<SaveStatusPill />);
    act(() => { useDraftStore.getState().markSaveError("磁盘满了"); });
    expect(screen.queryByText("保存失败")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(retry.fn).not.toHaveBeenCalled();
  });

  it("对话存失败：常驻提示，退避 2s、4s 重试", async () => {
    retry.fn.mockImplementation(async () => {
      useChatSaveStore.setState({ status: "saving", error: null });
      useChatSaveStore.setState({ status: "error", error: "仍失败" });
      return { ok: false, error: "仍失败" };
    });
    render(<SaveStatusPill />);
    act(() => { useChatSaveStore.setState({ status: "error", error: "磁盘满了" }); });
    expect(screen.getByText("保存失败")).toBeTruthy();
    expect(screen.getByText("磁盘满了")).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(retry.fn).toHaveBeenCalledTimes(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(retry.fn).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(retry.fn).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(retry.fn).toHaveBeenCalledTimes(2);
  });

  it("存成功：短暂显示已保存后消失", async () => {
    render(<SaveStatusPill />);
    act(() => { useDraftStore.getState().markSaving(); });
    // 存得慢才亮「保存中…」。
    expect(screen.queryByText("保存中…")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByText("保存中…")).toBeTruthy();
    act(() => { useDraftStore.getState().markSaved("v1", "一。", "", useDraftStore.getState().rev); });
    expect(screen.getByText("已保存")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1900); });
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("存得快：不闪「保存中…」，直接给已保存", async () => {
    render(<SaveStatusPill />);
    act(() => { useDraftStore.getState().markSaving(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(screen.queryByText("保存中…")).toBeNull();
    act(() => { useDraftStore.getState().markSaved("v1", "一。", "", useDraftStore.getState().rev); });
    expect(screen.getByText("已保存")).toBeTruthy();
  });
});
