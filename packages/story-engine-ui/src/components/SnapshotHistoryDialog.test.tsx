import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSnapshots, restoreSnapshotApi } from "../api/client.js";
import type { SnapshotEntryDto } from "../api/types.js";
import SnapshotHistoryDialog from "./SnapshotHistoryDialog.js";

vi.mock("../api/client.js", () => ({
  fetchSnapshots: vi.fn(),
  restoreSnapshotApi: vi.fn(),
}));

const fetchSnapshotsMock = vi.mocked(fetchSnapshots);
const restoreSnapshotApiMock = vi.mocked(restoreSnapshotApi);

afterEach(() => {
  cleanup();
  fetchSnapshotsMock.mockReset();
  restoreSnapshotApiMock.mockReset();
});

const PROJECT_PATH = "/Users/example/story";

function snapshotEntries(): SnapshotEntryDto[] {
  return [
    { id: "snap-2", label: "定稿前快照：第3章", timestamp: 1_765_000_000 },
    { id: "snap-1", label: "工作稿生成前快照：第3章", timestamp: 1_764_900_000 },
  ];
}

function renderDialog(overrides: Partial<{ onClose: () => void; onRestored: () => void }> = {}) {
  return render(
    <SnapshotHistoryDialog
      projectPath={PROJECT_PATH}
      onClose={overrides.onClose ?? vi.fn()}
      onRestored={overrides.onRestored ?? vi.fn()}
    />,
  );
}

describe("SnapshotHistoryDialog", () => {
  it("lists snapshot labels with localized timestamps", async () => {
    fetchSnapshotsMock.mockResolvedValue(snapshotEntries());

    renderDialog();

    expect(await screen.findByText("定稿前快照：第3章")).toBeInTheDocument();
    expect(screen.getByText("工作稿生成前快照：第3章")).toBeInTheDocument();
    expect(fetchSnapshotsMock).toHaveBeenCalledWith(PROJECT_PATH);

    const expectedFirst = new Date(1_765_000_000 * 1000).toLocaleString("zh-CN", { hour12: false });
    const expectedSecond = new Date(1_764_900_000 * 1000).toLocaleString("zh-CN", { hour12: false });
    expect(screen.getByText(expectedFirst)).toBeInTheDocument();
    expect(screen.getByText(expectedSecond)).toBeInTheDocument();
  });

  it("restores the clicked snapshot and fires onRestored on success", async () => {
    fetchSnapshotsMock.mockResolvedValue(snapshotEntries());
    restoreSnapshotApiMock.mockResolvedValue(undefined);
    const onRestored = vi.fn();

    renderDialog({ onRestored });

    const restoreButtons = await screen.findAllByRole("button", { name: "恢复到这里" });
    expect(restoreButtons).toHaveLength(2);
    fireEvent.click(restoreButtons[1]!);

    await waitFor(() => expect(restoreSnapshotApiMock).toHaveBeenCalledWith(PROJECT_PATH, "snap-1"));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("shows the server error message when loading snapshots fails", async () => {
    fetchSnapshotsMock.mockRejectedValue(new Error("快照目录读取失败"));

    renderDialog();

    expect(await screen.findByText(/快照目录读取失败/u)).toBeInTheDocument();
  });
});
