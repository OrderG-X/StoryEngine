import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filenameFromDisposition } from "../../../api/shelfClient.js";
import { ExportDialog } from "./ExportDialog.js";

afterEach(cleanup);

const BOOK = { title: "雾港来信", projectPath: "/b/fog" };

function api(overrides: Partial<NonNullable<Parameters<typeof ExportDialog>[0]["api"]>> = {}) {
  return {
    exportBookFile: vi.fn(async () => ({ blob: new Blob(["x"]), filename: "雾港来信.docx", chapters: 8 })),
    saveBlob: vi.fn(),
    ...overrides,
  };
}

describe("导出弹窗", () => {
  it("默认 txt、全部；换成 Word、圈范围、带工作稿后导出，存下文件并说导了几章", async () => {
    const calls = api();
    render(<ExportDialog api={calls} book={BOOK} onClose={() => {}} />);
    expect(screen.getByRole("radio", { name: "txt" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Word" }));
    fireEvent.change(screen.getByLabelText("从第几章"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("到第几章"), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText("带上还没定稿的工作稿"));
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(await screen.findByText("导出了 8 章：雾港来信.docx")).toBeInTheDocument();
    expect(calls.exportBookFile).toHaveBeenCalledWith({ projectPath: "/b/fog", format: "docx", from: 2, to: 5, includeDrafts: true });
    expect(calls.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "雾港来信.docx");
  });

  it("范围倒着填不让点；导出失败如实显示原因、不存文件", async () => {
    const calls = api({ exportBookFile: vi.fn(async () => { throw new Error("没导出：这个范围里没有定稿的章（要带上工作稿可以勾上）。"); }) });
    render(<ExportDialog api={calls} book={BOOK} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("从第几章"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("到第几章"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("到第几章"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect((await screen.findByRole("alert")).textContent).toContain("没有定稿的章");
    expect(calls.saveBlob).not.toHaveBeenCalled();
  });

  it("附件头取文件名：优先 UTF-8 编码的那个", () => {
    expect(filenameFromDisposition(`attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent("雾港.txt")}`, "x")).toBe("雾港.txt");
    expect(filenameFromDisposition(`attachment; filename="a.txt"`, "x")).toBe("a.txt");
    expect(filenameFromDisposition(null, "x")).toBe("x");
  });
});
