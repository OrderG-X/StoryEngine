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

describe("navigationStore 设定本小点（P11）", () => {
  it("换书清掉上一本的小点；同一本重设路径不清", () => {
    useNavigationStore.setState({ projectPath: "/books/a", unseenChangesChapter: 3 });
    useNavigationStore.getState().setProjectPath("/books/a");
    expect(useNavigationStore.getState().unseenChangesChapter).toBe(3);
    useNavigationStore.getState().setProjectPath("/books/b");
    expect(useNavigationStore.getState().unseenChangesChapter).toBeNull();
  });
});
