import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupSettingsView } from "../../../api/shelfClient.js";
import { BackupSettingsSection } from "./BackupSettingsSection.js";

afterEach(cleanup);

const VIEW: BackupSettingsView = { auto: true, dir: "/Users/x/StoryEngine-NG/备份", isDefaultDir: true, defaultDir: "/Users/x/StoryEngine-NG/备份", keep: 10 };

function api(view: BackupSettingsView = VIEW) {
  return {
    fetchBackupSettings: vi.fn(async () => view),
    saveBackupSettings: vi.fn(async (patch: { auto?: boolean; dir?: string }) => ({ ...view, ...(patch.auto !== undefined ? { auto: patch.auto } : {}), ...(patch.dir ? { dir: patch.dir, isDefaultDir: false } : {}) })),
    openBackupFolder: vi.fn(async () => undefined),
  };
}

describe("设置 · 备份", () => {
  it("开关、文件夹、换文件夹", async () => {
    const calls = api();
    render(<BackupSettingsSection api={calls} />);
    expect(await screen.findByText("每本书留最近 10 份")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关" }));
    expect(calls.saveBackupSettings).toHaveBeenCalledWith({ auto: false });
    expect(await screen.findByRole("button", { name: "关", pressed: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(calls.openBackupFolder).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "换一个" }));
    fireEvent.change(screen.getByLabelText("备份文件夹路径"), { target: { value: "/Users/x/备份盘" } });
    fireEvent.click(screen.getByRole("button", { name: "存" }));
    expect(calls.saveBackupSettings).toHaveBeenLastCalledWith({ dir: "/Users/x/备份盘" });
    expect(await screen.findByText("/Users/x/备份盘")).toBeInTheDocument();
  });

  it("上次自动备份没成：如实显示原因；改文件夹被拒也说原因", async () => {
    const calls = api({ ...VIEW, last: { at: "2026-10-20T02:00:00.000Z", ok: false, title: "雾港来信", error: "磁盘满了" } });
    calls.saveBackupSettings.mockRejectedValueOnce(new Error("没改成：这个文件夹不能用（要在你的用户目录下）。"));
    render(<BackupSettingsSection api={calls} />);
    expect((await screen.findByRole("status")).textContent).toContain("没成功");
    expect(screen.getByRole("status").textContent).toContain("磁盘满了");
    fireEvent.click(screen.getByRole("button", { name: "换一个" }));
    fireEvent.change(screen.getByLabelText("备份文件夹路径"), { target: { value: "/etc" } });
    fireEvent.click(screen.getByRole("button", { name: "存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("不能用");
  });
});
