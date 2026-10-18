// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterTitle } from "./ChapterTitle.js";

afterEach(cleanup);

describe("写作台章名：点一下改（重构 P6 第 7 步）", () => {
  it("点章名就地改，回车存；只传章名本身", () => {
    const onRename = vi.fn();
    render(<ChapterTitle chapterNumber={14} title="" editable onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: "第14章" }));
    const input = screen.getByRole("textbox", { name: "章名" });
    fireEvent.change(input, { target: { value: "  出远门 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("出远门");
    expect(screen.queryByRole("textbox", { name: "章名" })).toBeNull();
  });

  it("带「第N章 ·」前缀的旧章名只露名字来改；Esc、没改、清空都不存", () => {
    const onRename = vi.fn();
    render(<ChapterTitle chapterNumber={13} title="第13章 · 七天" editable onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: "第13章 · 七天" }));
    const input = screen.getByRole("textbox", { name: "章名" }) as HTMLInputElement;
    expect(input.value).toBe("七天");
    fireEvent.change(input, { target: { value: "八天" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "第13章 · 七天" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "章名" }));
    fireEvent.click(screen.getByRole("button", { name: "第13章 · 七天" }));
    fireEvent.change(screen.getByRole("textbox", { name: "章名" }), { target: { value: " " } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "章名" }), { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("不能改（出稿中 / 看定稿）就是普通标题", () => {
    render(<ChapterTitle chapterNumber={13} title="七天" editable={false} onRename={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("第13章 · 七天")).toBeTruthy();
  });
});
