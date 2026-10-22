// @vitest-environment jsdom
/**
 * 保存失败要看得见、要自动退避重试：第 1 次 2s，第 2 次 4s（不是每次都 2s）。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../../stores/draftStore.js";
import { __resetChatSyncForTests } from "../../../sync/chatSync.js";
import { SaveStatusPill } from "./SaveStatusPill.js";

const retry = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../../drafts/draftSync.js", () => ({ scheduleDraftSave: retry.fn }));

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

  it("稿子存失败：常驻提示，退避 2s、4s 重试", async () => {
    retry.fn.mockImplementation(() => {
      useDraftStore.getState().markSaving();
      useDraftStore.getState().markSaveError("仍失败");
    });
    render(<SaveStatusPill />);
    act(() => { useDraftStore.getState().markSaveError("磁盘满了"); });
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
    act(() => { useDraftStore.getState().markSaved("v1", "一。", ""); });
    expect(screen.getByText("已保存")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1900); });
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("存得快：不闪「保存中…」，直接给已保存", async () => {
    render(<SaveStatusPill />);
    act(() => { useDraftStore.getState().markSaving(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(screen.queryByText("保存中…")).toBeNull();
    act(() => { useDraftStore.getState().markSaved("v1", "一。", ""); });
    expect(screen.getByText("已保存")).toBeTruthy();
  });
});
