import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "../../../api/client.js";
import * as chatSync from "../../../sync/chatSync.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import OperationHistoryView from "./OperationHistoryView.js";

vi.mock("../../../api/client.js", () => ({
  fetchSnapshots: vi.fn(),
  restoreSnapshotApi: vi.fn(),
}));
vi.mock("../../../sync/saveAll.js", () => ({ flushAllSaves: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../../workspace/syncAfterRestore.js", () => ({ syncWorkspaceAfterRestore: vi.fn(async () => undefined) }));
vi.mock("../../../sync/chatSync.js", () => ({ saveChatNow: vi.fn(async () => ({ ok: true })) }));

const now = Math.floor(Date.now() / 1000);

beforeEach(() => {
  useNavigationStore.getState().setProjectPath("/b/fog");
  useChatStore.getState().setMessages([{ id: "a1", role: "assistant", content: "第 9 章已定稿。" }]);
  useChatStore.getState().setChatLoading(false);
  vi.mocked(client.fetchSnapshots).mockResolvedValue([{ id: "s1", label: "定稿：第9章", timestamp: now - 60, kind: "commit" }]);
  vi.mocked(client.restoreSnapshotApi).mockResolvedValue(undefined as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function restoreFirst(): Promise<void> {
  render(<OperationHistoryView projectPath="/b/fog" />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复到这之前" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "恢复" }));
  await waitFor(() => expect(client.restoreSnapshotApi).toHaveBeenCalledWith("/b/fog", "s1"));
}

describe("操作历史里恢复后在对话里记一行（2026-10-25 桌面包走查）", () => {
  it("恢复成功 → 对话末尾多一行「已恢复到「定稿：第9章」之前。」并存盘", async () => {
    await restoreFirst();
    await waitFor(() => expect(chatSync.saveChatNow).toHaveBeenCalled());
    const last = useChatStore.getState().messages.at(-1);
    expect(last).toMatchObject({ role: "system", kind: "restore", content: "已恢复到「定稿：第9章」之前。" });
  });

  it("对话正在跑 → 不往里插（那一轮跑完自己报盘上的真相）", async () => {
    useChatStore.getState().setChatLoading(true);
    await restoreFirst();
    await screen.findByRole("button", { name: "恢复到这之前" });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["a1"]);
    expect(chatSync.saveChatNow).not.toHaveBeenCalled();
  });
});
