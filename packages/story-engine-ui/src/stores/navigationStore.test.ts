import { describe, expect, it } from "vitest";

import { useNavigationStore } from "./navigationStore.js";

describe("navigationStore 中间区跳转信号（出稿自动跳写作台）", () => {
  it("requestCenterView 置 pendingCenterView，clearPendingCenterView 清空（一次性消费）", () => {
    useNavigationStore.setState({ pendingCenterView: null });
    useNavigationStore.getState().requestCenterView("desk");
    expect(useNavigationStore.getState().pendingCenterView).toBe("desk");
    useNavigationStore.getState().clearPendingCenterView();
    expect(useNavigationStore.getState().pendingCenterView).toBeNull();
  });
});
