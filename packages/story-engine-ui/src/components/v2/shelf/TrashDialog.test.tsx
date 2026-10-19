import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrashDialog, formatDeletedAt } from "./TrashDialog.js";

afterEach(cleanup);

const ITEMS = [
  { id: "a", title: "雾港来信", originalPath: "/b/a", deletedAt: new Date().toISOString(), daysLeft: 30 },
  { id: "b", title: "十章验收书", originalPath: "/b/b", deletedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), daysLeft: 27 },
];

function api(overrides: Partial<Parameters<typeof TrashDialog>[0]["api"] & object> = {}) {
  return {
    fetchTrash: vi.fn(async () => ({ items: ITEMS, keepDays: 30 })),
    restoreTrashItem: vi.fn(async () => ({ projectPath: "/b/a", title: "雾港来信" })),
    purgeTrashItem: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("回收站弹窗", () => {
  it("列出删掉的书和还剩几天；恢复后从列表里拿掉、通知书架加回去", async () => {
    const calls = api();
    const onRestored = vi.fn();
    const onChanged = vi.fn();
    render(<TrashDialog api={calls} onChanged={onChanged} onClose={() => {}} onRestored={onRestored} open />);
    expect(await screen.findByText("雾港来信")).toBeInTheDocument();
    expect(screen.getByText("今天删 · 还剩 30 天")).toBeInTheDocument();
    expect(screen.getByText("3 天前删 · 还剩 27 天")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]!);
    expect(await screen.findByText("《雾港来信》回到书架了。")).toBeInTheDocument();
    expect(calls.restoreTrashItem).toHaveBeenCalledWith("a");
    expect(onRestored).toHaveBeenCalledWith("/b/a", "雾港来信");
    expect(onChanged).toHaveBeenLastCalledWith(1);
    expect(screen.queryByText("今天删 · 还剩 30 天")).toBeNull();
  });

  it("彻底删除要再点一次；点「算了」不删", async () => {
    const calls = api();
    render(<TrashDialog api={calls} onClose={() => {}} onRestored={() => {}} open />);
    await screen.findByText("十章验收书");
    fireEvent.click(screen.getAllByRole("button", { name: "彻底删除" })[1]!);
    expect(screen.getByText("删了就找不回来")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "算了" }));
    expect(calls.purgeTrashItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "彻底删除" })[1]!);
    const confirm = screen.getAllByRole("button", { name: "彻底删除" }).find((b) => b.className.includes("danger"))!;
    fireEvent.click(confirm);
    expect(await screen.findByText("《十章验收书》已彻底删除。")).toBeInTheDocument();
    expect(calls.purgeTrashItem).toHaveBeenCalledWith("b");
  });

  it("空的、读不出来、恢复失败，都如实说", async () => {
    const { unmount } = render(<TrashDialog api={api({ fetchTrash: vi.fn(async () => ({ items: [], keepDays: 30 })) })} onClose={() => {}} onRestored={() => {}} open />);
    expect(await screen.findByText("回收站是空的。")).toBeInTheDocument();
    unmount();
    render(<TrashDialog api={api({ restoreTrashItem: vi.fn(async () => { throw new Error("原处被占"); }) })} onClose={() => {}} onRestored={() => {}} open />);
    await screen.findByText("雾港来信");
    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("没恢复成：原处被占");
  });

  it("删除时间写成人话", () => {
    const now = new Date("2026-10-20T10:00:00");
    expect(formatDeletedAt("2026-10-20T01:00:00", now)).toBe("今天");
    expect(formatDeletedAt("2026-10-19T23:00:00", now)).toBe("昨天");
    expect(formatDeletedAt("2026-10-15T10:00:00", now)).toBe("5 天前");
    expect(formatDeletedAt("2026-10-02T10:00:00", now)).toBe("10 月 2 日");
  });
});
