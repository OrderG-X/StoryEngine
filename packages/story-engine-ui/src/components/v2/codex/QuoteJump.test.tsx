// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { QuoteJumpMarker, requestQuoteJump, useQuoteJump } from "./QuoteJump.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";

function Stage({ text, chapter, showingCommitted = false, canShowCommitted = false, onShowCommitted = () => undefined }: {
  readonly text: string;
  readonly chapter: number;
  readonly showingCommitted?: boolean;
  readonly canShowCommitted?: boolean;
  readonly onShowCommitted?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={ref}>
      <p>{text}</p>
      <QuoteJumpMarker
        stageRef={ref}
        chapter={chapter}
        contentKey={`${chapter}:${showingCommitted}:${text.length}`}
        showingCommitted={showingCommitted}
        canShowCommitted={canShowCommitted}
        onShowCommitted={onShowCommitted}
      />
    </div>
  );
}

describe("回原句（重构 P6）", () => {
  beforeEach(() => { vi.useFakeTimers(); useQuoteJump.getState().clear(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("就是这一章、稿里有这句：滚过去，用掉这次请求", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Stage chapter={3} text="他从柜子底下拖出一把铜钥匙，擦了擦。" />);
    act(() => requestQuoteJump(3, "一把铜钥匙"));
    act(() => { vi.advanceTimersByTime(150); });
    expect(scroll).toHaveBeenCalled();
    expect(useQuoteJump.getState().target).toBeNull();
  });

  it("别的章的请求不动（等那章打开再找）", () => {
    render(<Stage chapter={3} text="一把铜钥匙" />);
    act(() => requestQuoteJump(5, "一把铜钥匙"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(useQuoteJump.getState().target).toMatchObject({ chapter: 5 });
  });

  it("工作稿里没有、这章有定稿：切到定稿再找；都没有就如实说没找到", () => {
    const onShowCommitted = vi.fn();
    const showToast = vi.spyOn(useNavigationStore.getState(), "showToast");
    const { rerender } = render(<Stage chapter={3} text="改过的稿" canShowCommitted onShowCommitted={onShowCommitted} />);
    act(() => requestQuoteJump(3, "一把铜钥匙"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onShowCommitted).toHaveBeenCalledTimes(1);
    rerender(<Stage chapter={3} text="定稿里也改了" showingCommitted canShowCommitted onShowCommitted={onShowCommitted} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(showToast).toHaveBeenCalledWith("第 3 章稿里没找到这句（可能改过稿）。", 4200);
    expect(useQuoteJump.getState().target).toBeNull();
  });
});
