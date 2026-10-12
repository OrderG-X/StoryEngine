// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContinuityCheckCard, buildContinuityFixAllIntent, buildContinuityFixIntent } from "./ContinuityCheckCard.js";

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

describe("核账卡主按钮「改掉这 N 处」（R4.5：N 随「不是问题」实时变，intent 由卡片现拼）", () => {
  afterEach(() => cleanup());

  const items = [
    { quote: "他把钥匙放回了柜台上。", earlierQuote: "钥匙锁在红木抽屉里。", earlierChapter: 3, reason: "钥匙位置对不上" },
    { quote: "外面下着大雨。", earlierQuote: "天上一个星子都没有，干得发裂。", earlierChapter: 2, reason: "天气对不上" },
    { quote: "她管他叫周老师。", earlierQuote: "她一直叫他周伯。", earlierChapter: 1, reason: "称呼对不上" },
    { quote: "怀表停在了三点。", earlierQuote: "怀表走得好好的。", earlierChapter: 4, reason: "怀表状态对不上" },
  ];
  const fourSure = { chapter: 9, source: "draft" as const, sure: items, maybe: [] };
  const first = items[0]!;

  it("4 条划掉 1 条 → 按钮显示「改掉这 3 处」；intent 逐条列剩下 3 处、不含被划掉那条的原句、末尾圈死范围", async () => {
    const onRevise = vi.fn();
    render(<ContinuityCheckCard check={fourSure} onRevise={onRevise} onDismiss={vi.fn(async () => true)} />);
    expect(screen.getByRole("button", { name: "改掉这 4 处" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "不是问题" })[0]!); });
    expect(screen.getByRole("button", { name: "改掉这 3 处" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "改掉这 3 处" })); });
    expect(onRevise).toHaveBeenCalledTimes(1);
    const intent = onRevise.mock.calls[0]![0] as string;
    expect(intent).not.toContain(first.quote);
    for (const kept of items.slice(1)) expect(intent).toContain(kept.quote);
    expect(intent).toContain("作者标过不是问题的 1 处别动");
    expect(intent).toContain("只改这几处");
    // 句式照单条「改这处」：本章原句 ↔ 前文原句（标第几章）+ 理由。
    expect(intent).toContain(`它和第 2 章「${items[1]!.earlierQuote}」对不上（${items[1]!.reason}）`);
  });

  it("一处没划 → intent 逐条列全部，末尾仍圈「只改这几处」但不提「不是问题」", () => {
    const onRevise = vi.fn();
    render(<ContinuityCheckCard check={fourSure} onRevise={onRevise} />);
    act(() => { fireEvent.click(screen.getByRole("button", { name: "改掉这 4 处" })); });
    const intent = onRevise.mock.calls[0]![0] as string;
    for (const kept of items) expect(intent).toContain(kept.quote);
    expect(intent).toContain("只改这几处，别的不动。");
    expect(intent).not.toContain("不是问题");
  });

  it("确定的都划掉 → 主按钮消失（只剩「可能」档时也不出）", async () => {
    const oneSure = { chapter: 9, source: "draft" as const, sure: [first], maybe: [items[1]!] };
    render(<ContinuityCheckCard check={oneSure} onRevise={vi.fn()} onDismiss={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "不是问题" })); });
    expect(screen.queryByRole("button", { name: /改掉这/ })).toBeNull();
  });

  it("没给 onRevise（onSendMessage 缺席）→ 不出主按钮，单条「改这处」同样不出", () => {
    render(<ContinuityCheckCard check={fourSure} />);
    expect(screen.queryByRole("button", { name: /改掉这/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "改这处" })).toBeNull();
  });

  it("撤回划掉 → N 涨回来，intent 重新含那条原句", async () => {
    const onRevise = vi.fn();
    render(<ContinuityCheckCard check={fourSure} onRevise={onRevise} onDismiss={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "不是问题" })[0]!); });
    expect(screen.getByRole("button", { name: "改掉这 3 处" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "撤回上一处" })); });
    expect(screen.getByRole("button", { name: "改掉这 4 处" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "改掉这 4 处" })); });
    expect(onRevise.mock.calls[0]![0]).toContain(first.quote);
  });
});

describe("intent 现拼的纯函数", () => {
  it("buildContinuityFixAllIntent：前文在同章标「本章前面」、理由缺省不出空括号", () => {
    const intent = buildContinuityFixAllIntent(7, [{ quote: "q", earlierQuote: "e", earlierChapter: 7, reason: "" }], 0);
    expect(intent).toBe("把第 7 章里「q」这处改掉：它和本章前面「e」对不上。只改这几处，别的不动。");
  });

  it("buildContinuityFixIntent：单条句式不变（只改这一处，别的不动）", () => {
    expect(buildContinuityFixIntent(8, item)).toBe(
      "把第 8 章里「她把便签塞进了抽屉。」这处改掉：它和第 6 章「便签一直揣在她兜里。」对不上（便签位置对不上）。只改这一处，别的不动。",
    );
  });
});
