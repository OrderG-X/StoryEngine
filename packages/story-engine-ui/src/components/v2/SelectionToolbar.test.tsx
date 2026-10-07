import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SelectionToolbar from "./SelectionToolbar.js";

afterEach(() => cleanup());

describe("SelectionToolbar", () => {
  it("renders the six fixed-template buttons", () => {
    render(<SelectionToolbar top={10} left={20} busyKey={null} onPick={vi.fn()} />);
    for (const label of ["润色", "改写", "去AI味", "扩写", "缩写", "续写"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  it("picks a template on mousedown (not click, so the editor selection survives)", () => {
    const onPick = vi.fn();
    render(<SelectionToolbar top={10} left={20} busyKey={null} onPick={onPick} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "去AI味" }));
    expect(onPick).toHaveBeenCalledWith("deai");
  });

  it("disables all buttons and marks the busy one while a rewrite is in flight", () => {
    const onPick = vi.fn();
    render(<SelectionToolbar top={0} left={0} busyKey="polish" onPick={onPick} />);
    const polish = screen.getByRole("button", { name: "…" });
    expect(polish).toHaveAttribute("aria-busy", "true");
    // 忙碌时再点别的按钮不触发
    fireEvent.mouseDown(screen.getByRole("button", { name: "改写" }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("positions itself at the given coordinates", () => {
    const { container } = render(<SelectionToolbar top={42} left={88} busyKey={null} onPick={vi.fn()} />);
    const toolbar = container.querySelector<HTMLElement>(".se-v2-selection-toolbar");
    expect(toolbar?.style.top).toBe("42px");
    expect(toolbar?.style.left).toBe("88px");
  });
});

describe("SelectionToolbar 自己说（自定义改写输入）", () => {
  afterEach(() => cleanup());

  it("默认有「自己说」入口；点它出输入框、输要求、点「改」走 onPickCustom 带要求", () => {
    const onPickCustom = vi.fn();
    render(<SelectionToolbar top={0} left={0} busyKey={null} onPick={vi.fn()} onPickCustom={onPickCustom} />);
    expect(screen.getByRole("button", { name: "自己说" })).toBeDefined();

    fireEvent.mouseDown(screen.getByRole("button", { name: "自己说" }));
    const input = screen.getByLabelText("改写要求") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "写紧张点，删掉心理描写" } });
    fireEvent.mouseDown(screen.getByRole("button", { name: "改" }));

    expect(onPickCustom).toHaveBeenCalledWith("写紧张点，删掉心理描写");
  });

  it("空要求时「改」不触发；「返回」回到预设按钮", () => {
    const onPickCustom = vi.fn();
    render(<SelectionToolbar top={0} left={0} busyKey={null} onPick={vi.fn()} onPickCustom={onPickCustom} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "自己说" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "改" })); // 空
    expect(onPickCustom).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("button", { name: "润色" })).toBeDefined();
    expect(screen.queryByLabelText("改写要求")).toBeNull();
  });
});

describe("SelectionToolbar 问 AI", () => {
  afterEach(() => cleanup());

  it("传了 onAsk 才出「问 AI」，点它调 onAsk、不走改写", () => {
    const onPick = vi.fn();
    const onAsk = vi.fn();
    render(<SelectionToolbar top={0} left={0} busyKey={null} onPick={onPick} onAsk={onAsk} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "问 AI" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("askOnly（定稿章节）只剩「问 AI」，没有改写预设和「自己说」", () => {
    render(<SelectionToolbar top={0} left={0} busyKey={null} askOnly onPick={vi.fn()} onAsk={vi.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["问 AI"]);
  });
});
