import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.queryByText("恢复到「定稿：第9章」之前")).toBeNull();

    vi.mocked(client.fetchSnapshots).mockResolvedValueOnce([
      { id: "b", label: "恢复到「定稿：第9章」之前", timestamp: now, kind: "restore" },
      { id: "a", label: "定稿：第9章", timestamp: now - 60, kind: "commit" },
    ]);
    rerender(<OperationHistoryView projectPath="/b/fog" refreshKey={{ v: 2 }} />);
    expect(await screen.findByText("恢复到「定稿：第9章」之前")).toBeInTheDocument();
    expect(client.fetchSnapshots).toHaveBeenCalledTimes(2);
  });
});
