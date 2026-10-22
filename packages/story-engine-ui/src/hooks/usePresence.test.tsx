// @vitest-environment jsdom
/**
 * 退场：关上时先挂 data-closing 播完退场再卸；元素上没动画（测试环境、减少动效）就立刻卸；中途又打开就停在场上。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./usePresence.js";

function Box({ open }: { readonly open: boolean }) {
  const p = usePresence<HTMLDivElement>(open);
  if (!p.mounted) return null;
  return <div ref={p.ref} data-testid="box" data-closing={p.closing || undefined} />;
}

/** 假装元素上挂着一段 200ms 的退场动画。 */
function fakeAnimation(): void {
  const real = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const cs = real(el, pseudo);
    return { ...cs, animationName: "se-pop-out", animationDuration: "0.2s", animationDelay: "0s" } as CSSStyleDeclaration;
  });
}

describe("usePresence", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("没动画：关上立刻卸", () => {
    const { rerender } = render(<Box open />);
    expect(screen.getByTestId("box")).toBeTruthy();
    rerender(<Box open={false} />);
    expect(screen.queryByTestId("box")).toBeNull();
  });

  it("有动画：先挂 data-closing，animationend 后才卸", () => {
    fakeAnimation();
    const { rerender } = render(<Box open />);
    rerender(<Box open={false} />);
    const box = screen.getByTestId("box");
    expect(box.getAttribute("data-closing")).toBe("true");
    fireEvent.animationEnd(box);
    expect(screen.queryByTestId("box")).toBeNull();
  });

  it("animationend 丢了：兜底计时器照样卸", () => {
    vi.useFakeTimers();
    fakeAnimation();
    const { rerender } = render(<Box open />);
    rerender(<Box open={false} />);
    expect(screen.getByTestId("box")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId("box")).toBeNull();
  });

  it("退场途中又打开：留在场上、去掉 data-closing", () => {
    fakeAnimation();
    const { rerender } = render(<Box open />);
    rerender(<Box open={false} />);
    rerender(<Box open />);
    const box = screen.getByTestId("box");
    expect(box.getAttribute("data-closing")).toBeNull();
    fireEvent.animationEnd(box);
    expect(screen.getByTestId("box")).toBeTruthy();
  });
});
