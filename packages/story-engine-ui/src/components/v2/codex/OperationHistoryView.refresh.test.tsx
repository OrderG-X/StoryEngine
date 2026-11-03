import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as client from "../../../api/client.js";
import OperationHistoryView from "./OperationHistoryView.js";

vi.mock("../../../api/client.js", () => ({
  fetchSnapshots: vi.fn(),
  restoreSnapshotApi: vi.fn(),
}));

afterEach(cleanup);

const now = Math.floor(Date.now() / 1000);

describe("操作历史开着时跟着开书概况重读", () => {
  it("refreshKey 换了（聊天里撤销 / 定稿后概况刷新）就重读列表，不用切走再切回来", async () => {
    vi.mocked(client.fetchSnapshots).mockResolvedValueOnce([
      { id: "a", label: "定稿：第9章", timestamp: now - 60, kind: "commit" },
    ]);
    const { rerender } = render(<OperationHistoryView projectPath="/b/fog" refreshKey={{ v: 1 }} />);
    expect(await screen.findByText("定稿：第9章")).toBeInTheDocument();
    expect(screen.queryByText("AI 写稿：第10章")).toBeNull();

    vi.mocked(client.fetchSnapshots).mockResolvedValueOnce([
      { id: "b", label: "AI 写稿：第10章", timestamp: now, kind: "draft" },
      { id: "a", label: "定稿：第9章", timestamp: now - 60, kind: "commit" },
    ]);
    rerender(<OperationHistoryView projectPath="/b/fog" refreshKey={{ v: 2 }} />);
    expect(await screen.findByText("AI 写稿：第10章")).toBeInTheDocument();
    expect(client.fetchSnapshots).toHaveBeenCalledTimes(2);
  });
});

describe("操作历史只列章的改动（安静账房）", () => {
  it("定稿、正文改动照列；设定、恢复每天收成一行，点开才看；没有统计和筛选", async () => {
    vi.mocked(client.fetchSnapshots).mockResolvedValueOnce([
      { id: "c", label: "改设定：林舟", timestamp: now, kind: "bible" },
      { id: "b", label: "恢复到「定稿：第9章」之前", timestamp: now - 30, kind: "restore" },
      { id: "a", label: "定稿：第9章", timestamp: now - 60, kind: "commit" },
    ]);
    render(<OperationHistoryView projectPath="/b/fog" />);
    expect(await screen.findByText("定稿：第9章")).toBeInTheDocument();
    expect(screen.queryByText("改设定：林舟")).toBeNull();
    expect(screen.queryByRole("group", { name: "按类型筛选" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "还有 2 条设定、恢复的改动" }));
    expect(screen.getByText("改设定：林舟")).toBeInTheDocument();
    expect(screen.getByText("恢复到「定稿：第9章」之前")).toBeInTheDocument();
  });
});
