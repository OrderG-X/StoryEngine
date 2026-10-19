import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImportPreview } from "../api/types.js";
import ImportBookDialog, { formatChars } from "./ImportBookDialog.js";

afterEach(() => cleanup());

const PREVIEW: ImportPreview = {
  parts: [
    { kind: "preamble", title: "", chars: 30, file: "雾港来信.txt" },
    { kind: "chapter", title: "雨夜", chars: 3200, file: "雾港来信.txt" },
    { kind: "chapter", title: "来信", chars: 12_400, file: "雾港来信.txt" },
  ],
  totalChars: 15_600,
  emptyDropped: 1,
  volumeLines: 0,
  suggestedTitle: "雾港来信",
};

async function choose(preview = vi.fn(async () => PREVIEW)) {
  const readFile = vi.fn(async () => "第一章 雨夜\n钟停了。");
  const onImport = vi.fn(async () => undefined);
  render(<ImportBookDialog open onCancel={vi.fn()} onImport={onImport} preview={preview} readFile={readFile} />);
  const file = new File(["x"], "雾港来信.txt", { type: "text/plain" });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("选择要导入的文件"), { target: { files: [file] } });
  });
  return { onImport, preview, readFile };
}

describe("导入已写的书弹窗", () => {
  it("字数：过万按万字", () => {
    expect(formatChars(980)).toBe("980 字");
    expect(formatChars(15_600)).toBe("1.6 万字");
  });

  it("选完文件：认出几章、多少字，开头默认不导，书名取文件名", async () => {
    const { preview } = await choose();
    expect(preview).toHaveBeenCalledWith([{ name: "雾港来信.txt", text: "第一章 雨夜\n钟停了。" }]);
    expect(screen.getByRole("status").textContent).toBe("认出 2 章，共 1.6 万字；1 个空章（只有标题）没算");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([false, true, true]);
    expect(screen.getByText("第 1 章 · 雨夜")).toBeInTheDocument();
    expect(screen.getByLabelText("书名")).toHaveValue("雾港来信");
    expect(screen.getByRole("button", { name: "导入 2 章" })).toBeEnabled();
  });

  it("勾掉一章、勾上开头：章号跟着重排，导入时带上勾选", async () => {
    const { onImport } = await choose();
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(screen.getByText("不导 · 雨夜")).toBeInTheDocument();
    expect(screen.getByText("第 2 章 · 来信")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入 2 章" }));
    });
    expect(onImport).toHaveBeenCalledWith({
      title: "雾港来信",
      files: [{ name: "雾港来信.txt", text: "第一章 雨夜\n钟停了。" }],
      include: [true, false, true],
    });
  });

  it("书名清空（几个文件拼的书不替你起名）：导入按钮灰掉", async () => {
    await choose();
    fireEvent.change(screen.getByLabelText("书名"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "导入 2 章" })).toBeDisabled();
  });

  it("一章都不勾：导入按钮灰掉", async () => {
    await choose();
    for (const box of screen.getAllByRole("checkbox").slice(1)) fireEvent.click(box);
    expect(screen.getByRole("button", { name: "导入 0 章" })).toBeDisabled();
  });

  it("预览没成功：如实显示原因", async () => {
    await choose(vi.fn(async () => {
      throw new Error("选的文件是空的");
    }));
    expect(screen.getByRole("alert").textContent).toBe("选的文件是空的");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("导入没成功：弹窗留着、写原因，可以再点", async () => {
    const preview = vi.fn(async () => PREVIEW);
    const onImport = vi.fn().mockRejectedValueOnce(new Error("磁盘满了")).mockResolvedValue(undefined);
    render(<ImportBookDialog open onCancel={vi.fn()} onImport={onImport} preview={preview} readFile={async () => "x"} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("选择要导入的文件"), { target: { files: [new File(["x"], "a.txt")] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入 2 章" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("磁盘满了");
    expect(screen.getByRole("button", { name: "导入 2 章" })).toBeEnabled();
  });
});
