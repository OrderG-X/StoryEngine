// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContinuityCheckCard } from "./ContinuityCheckCard.js";

const item = { quote: "她把便签塞进了抽屉。", earlierQuote: "便签一直揣在她兜里。", earlierChapter: 6, reason: "便签位置对不上" };
const check = { chapter: 8, source: "draft" as const, sure: [item], maybe: [] };

describe("核账卡「不是问题」", () => {
  afterEach(() => cleanup());

  it("点了就从卡上拿掉、存盘、说下次不再报；撤回放回来并删记录", async () => {
    const onDismiss = vi.fn(async () => true);
    render(<ContinuityCheckCard check={check} onDismiss={onDismiss} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "不是问题" })); });
    expect(onDismiss).toHaveBeenCalledWith(item, false);
    expect(screen.queryByText(/便签位置对不上/)).toBeNull();
    expect(screen.getByText(/下次核这一章不再报/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "撤回上一处" })); });
    expect(onDismiss).toHaveBeenLastCalledWith(item, true);
    expect(screen.getByText(/便签位置对不上/)).toBeTruthy();
  });

  it("存盘失败如实说没记住", async () => {
    render(<ContinuityCheckCard check={check} onDismiss={async () => false} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "不是问题" })); });
    expect(screen.getByText(/没记住/)).toBeTruthy();
  });
});
