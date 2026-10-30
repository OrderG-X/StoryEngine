import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChapterSynopsis, synopsisAction } from "./ChapterSynopsis.js";

describe("本章梗概", () => {
  afterEach(() => cleanup());

  // 长篇实跑：第 41 章梗概记成「离云州北上」（其实往南），定稿后作者没处改。
  it("点开看全；展开后点「改」就地改写，存＝作者档改账动作（不经模型）", () => {
    const onAction = vi.fn();
    render(<ChapterSynopsis chapter={41} text="离云州北上。" busy={false} onAction={onAction} />);
    expect(screen.queryByRole("button", { name: "改" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /本章梗概/u }));
    fireEvent.click(screen.getByRole("button", { name: "改" }));
    const box = screen.getByLabelText("改本章梗概");
    fireEvent.change(box, { target: { value: "离云州南下。" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: "new",
      type: "ledger.change",
      mode: "author",
      params: { changes: [{ op: "summary", chapter: 41, text: "离云州南下。" }] },
    }));
    expect(screen.queryByLabelText("改本章梗概")).toBeNull();
  });

  it("每点一次是新的一次（请求号点的时候给；改的和现在一样服务端如实说不用改）", () => {
    const first = synopsisAction(3, "甲");
    const second = synopsisAction(3, "甲");
    expect("kind" in first && "kind" in second && first.kind === "new" && second.kind === "new" && first.requestKey !== second.requestKey).toBe(true);
  });

  it("没改就存＝算了；没有动作通道时不给「改」", () => {
    const onAction = vi.fn();
    const { unmount } = render(<ChapterSynopsis chapter={2} text="原样。" busy={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /本章梗概/u }));
    fireEvent.click(screen.getByRole("button", { name: "改" }));
    fireEvent.keyDown(screen.getByLabelText("改本章梗概"), { key: "Enter" });
    expect(onAction).not.toHaveBeenCalled();
    unmount();

    render(<ChapterSynopsis chapter={2} text="原样。" busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /本章梗概/u }));
    expect(screen.queryByRole("button", { name: "改" })).toBeNull();
  });
});
