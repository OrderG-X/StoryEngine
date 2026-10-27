// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContinuityCheckCard, buildContinuityFixAllIntent, buildContinuityFixIntent } from "./ContinuityCheckCard.js";
import { continuityItemKey, quoteInPaper } from "../../../workspace/chapterProgress.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { useMaybeMarks } from "./maybeMarks.js";

type CardProps = ComponentProps<typeof ContinuityCheckCard>;

/** 「不是问题」记在卡上（P6 起由 store 持有，稿纸划线共用）：测试里用本地 state 充当那份 store。 */
function Controlled({ onDismiss, ...props }: Omit<CardProps, "dismissed">) {
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  return (
    <ContinuityCheckCard
      {...props}
      dismissed={dismissed}
      {...(onDismiss ? {
        onDismiss: (item: Parameters<NonNullable<CardProps["onDismiss"]>>[0], undo: boolean) => {
          const key = continuityItemKey(item);
          setDismissed((list) => (undo ? list.filter((k) => k !== key) : [...list.filter((k) => k !== key), key]));
          return onDismiss(item, undo);
        },
      } : {})}
    />
  );
}

const item = { quote: "她把便签塞进了抽屉。", earlierQuote: "便签一直揣在她兜里。", earlierChapter: 6, reason: "便签位置对不上" };
const check = { chapter: 8, source: "draft" as const, sure: [item], maybe: [] };

describe("旧核账卡（同一章后来又核过）", () => {
  afterEach(() => cleanup());

  it("说一句以最新一张为准；上面没给改的回调就没有「改这处 / 改掉这 N 处」，「不是问题」照留", () => {
    render(<ContinuityCheckCard check={check} superseded onDismiss={vi.fn(async () => true)} />);
    expect(screen.getByText("后来又核过，以最新一张为准。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "改这处" })).toBeNull();
    expect(screen.queryByRole("button", { name: /改掉这/u })).toBeNull();
    expect(screen.getByRole("button", { name: "不是问题" })).toBeTruthy();
  });
});

describe("核账卡「不是问题」", () => {
  afterEach(() => cleanup());

  it("点了就从卡上拿掉、存盘、说下次不再报；撤回放回来并删记录", async () => {
    const onDismiss = vi.fn(async () => true);
    render(<Controlled check={check} onDismiss={onDismiss} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "不是问题" })); });
    expect(onDismiss).toHaveBeenCalledWith(item, false);
    expect(screen.queryByText(/便签位置对不上/)).toBeNull();
    expect(screen.getByText(/以后核账不再报/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "撤回上一处" })); });
    expect(onDismiss).toHaveBeenLastCalledWith(item, true);
    expect(screen.getByText(/便签位置对不上/)).toBeTruthy();
  });

  it("划掉的条目从 dismissed 来（稿纸上点的「不是问题」卡上同步不见）", () => {
    render(<ContinuityCheckCard check={check} dismissed={[continuityItemKey(item)]} onDismiss={vi.fn(async () => true)} />);
    expect(screen.queryByText(/便签位置对不上/)).toBeNull();
    expect(screen.getByText(/标了 1 处不是问题/)).toBeTruthy();
  });

  it("存盘失败如实说没记住", async () => {
    render(<Controlled check={check} onDismiss={async () => false} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "不是问题" })); });
    expect(screen.getByText(/没记住/)).toBeTruthy();
  });
});

describe("核账卡「可能」那段和稿纸划线", () => {
  afterEach(() => { cleanup(); useMaybeMarks.getState().show(null); });

  it("点开才让稿纸划这一章的「可能」，收起、卡片卸掉都撤", async () => {
    const maybeItem = { ...item, quote: "她把便签折成两半。", reason: "折法可能不对" };
    const view = render(<ContinuityCheckCard check={{ ...check, sure: [], maybe: [maybeItem] }} />);
    expect(useMaybeMarks.getState().chapter).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /还有 1 处可能有问题/ })); });
    expect(useMaybeMarks.getState().chapter).toBe(8);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "收起" })); });
    expect(useMaybeMarks.getState().chapter).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /还有 1 处可能有问题/ })); });
    view.unmount();
    expect(useMaybeMarks.getState().chapter).toBeNull();
  });
});

describe("核账卡：上一遍按核账改过、这遍又说不对的", () => {
  afterEach(() => cleanup());

  it("在「可能」里，点开能看到改前那句和「这遍又报了，你定」", async () => {
    const revisited = { ...item, quote: "她把便签放回抽屉。", reason: "便签位置对不上", revisited: { from: "她把便签塞进了抽屉。" } };
    render(<ContinuityCheckCard check={{ ...check, sure: [], maybe: [revisited] }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /还有 1 处可能有问题/ })); });
    expect(screen.getByText("这句上一遍按核账改过（原来是「她把便签塞进了抽屉。」），这遍又报了，你定。")).toBeTruthy();
  });
});

describe("核账卡主按钮「改掉这 N 处」（R4.5：N 随「不是问题」实时变，intent 由卡片现拼）", () => {
  afterEach(() => cleanup());

  // 主按钮只管前文就在本章的（P12：两章打架的要作者定哪边为准，不进主按钮）。
  const items = [
    { quote: "他把钥匙放回了柜台上。", earlierQuote: "钥匙锁在红木抽屉里。", earlierChapter: 9, reason: "钥匙位置对不上" },
    { quote: "外面下着大雨。", earlierQuote: "天上一个星子都没有，干得发裂。", earlierChapter: 9, reason: "天气对不上" },
    { quote: "她管他叫周老师。", earlierQuote: "她一直叫他周伯。", earlierChapter: 9, reason: "称呼对不上" },
    { quote: "怀表停在了三点。", earlierQuote: "怀表走得好好的。", earlierChapter: 9, reason: "怀表状态对不上" },
  ];
  const fourSure = { chapter: 9, source: "draft" as const, sure: items, maybe: [] };
  const first = items[0]!;

  it("4 条划掉 1 条 → 按钮显示「改掉这 3 处」；intent 逐条列剩下 3 处、不含被划掉那条的原句、末尾圈死范围", async () => {
    const onRevise = vi.fn();
    render(<Controlled check={fourSure} onRevise={onRevise} onDismiss={vi.fn(async () => true)} />);
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
    // 句式照单条「改这处」：本章原句 ↔ 前文原句 + 理由。
    expect(intent).toContain(`它和本章前面「${items[1]!.earlierQuote}」对不上（${items[1]!.reason}）`);
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
    render(<Controlled check={oneSure} onRevise={vi.fn()} onDismiss={vi.fn(async () => true)} />);
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
    render(<Controlled check={fourSure} onRevise={onRevise} onDismiss={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "不是问题" })[0]!); });
    expect(screen.getByRole("button", { name: "改掉这 3 处" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "撤回上一处" })); });
    expect(screen.getByRole("button", { name: "改掉这 4 处" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "改掉这 4 处" })); });
    expect(onRevise.mock.calls[0]![0]).toContain(first.quote);
  });
});

describe("核账卡：对设定本的条目（R7.3）", () => {
  afterEach(() => cleanup());

  const setting = {
    quote: "沈师傅走了也有五年了。",
    earlierQuote: "爷爷沈敬山：三年前过世",
    earlierChapter: 3,
    reason: "人物卡写三年前过世，第 3 章说五年",
    againstSetting: { label: "人物卡" },
    fixChapter: 3,
  };

  it("显示「第 3 章」那句，点「对照设定（人物卡）」才出设定原文；按钮写「改第 3 章」", async () => {
    const onRevise = vi.fn();
    const settingCheck = { chapter: 6, sure: [setting], maybe: [] };
    render(<ContinuityCheckCard check={settingCheck} onRevise={onRevise} />);
    expect(screen.getByText(/第 3 章：「沈师傅走了也有五年了。」/)).toBeTruthy();
    expect(screen.queryByText(/设定（人物卡）：「爷爷沈敬山：三年前过世」/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "对照设定（人物卡）" }));
    expect(screen.getByText(/设定（人物卡）：「爷爷沈敬山：三年前过世」/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "改第 3 章" });
    await act(async () => { fireEvent.click(button); });
    expect(onRevise.mock.calls[0]![0]).toContain("把第 3 章里「沈师傅走了也有五年了。」这处改掉");
    expect(onRevise.mock.calls[0]![0]).toContain("设定本人物卡里的「爷爷沈敬山：三年前过世」");
  });

  it("新稿自己错的设定条目：原句不加章号前缀；能直接改时给「以设定为准 / 以本章为准」", () => {
    const selfWrong = { chapter: 6, sure: [{ ...setting, earlierChapter: 6, fixChapter: undefined, quote: "他右手背上有疤。" }], maybe: [] };
    render(<ContinuityCheckCard check={selfWrong} onRevise={vi.fn()} onFixAction={vi.fn()} />);
    expect(screen.getByText("「他右手背上有疤。」")).toBeTruthy();
    expect(screen.getByRole("button", { name: "以设定为准" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "以本章为准" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "改这处" })).toBeNull();
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

  it("R7.3 对设定本的条目：前文那章和人物卡不一致 → 句子指向改那一章，别把对的改成错的", () => {
    const setting = {
      quote: "沈师傅走了也有五年了。",
      earlierQuote: "爷爷沈敬山：三年前过世",
      earlierChapter: 3,
      reason: "人物卡写三年前过世",
      againstSetting: { label: "人物卡" },
      fixChapter: 3,
    };
    expect(buildContinuityFixIntent(6, setting)).toBe(
      "把第 3 章里「沈师傅走了也有五年了。」这处改掉：它和设定本人物卡里的「爷爷沈敬山：三年前过世」对不上（人物卡写三年前过世）。只改这一处，别的不动。",
    );
  });

  it("R7.3 对设定本的条目：新稿自己错 → 照旧改本章", () => {
    const setting = { quote: "他左手背上有疤。", earlierQuote: "左手背上有一道旧疤", earlierChapter: 6, reason: "疤的位置对不上", againstSetting: { label: "人物卡" } };
    expect(buildContinuityFixIntent(6, setting)).toBe(
      "把第 6 章里「他左手背上有疤。」这处改掉：它和设定本人物卡里的「左手背上有一道旧疤」对不上（疤的位置对不上）。只改这一处，别的不动。",
    );
  });
});

describe("核账卡「改这处」按钮直接改（重构 P6：结构化动作，不经模型）", () => {
  afterEach(() => cleanup());

  const a = { quote: "他把钥匙放回了柜台上。", earlierQuote: "钥匙锁在抽屉里。", earlierChapter: 9, reason: "钥匙位置对不上" };
  const b = { quote: "外面下着大雨。", earlierQuote: "干得发裂。", earlierChapter: 9, reason: "天气对不上" };
  const cross = { quote: "杜叔走了五年了。", earlierQuote: "杜叔走了整整十年。", earlierChapter: 3, reason: "去世年份对不上" };
  const earlier = { quote: "她的眼睛是灰的。", earlierQuote: "眼睛：褐色", earlierChapter: 3, reason: "眼睛颜色对不上", againstSetting: { label: "人物卡", kind: "character" as const, card: "许微" }, fixChapter: 3 };

  it("前文就在本章的：单条和「改掉这 N 处」都发结构化动作，不发话给模型", () => {
    const onRevise = vi.fn();
    const onFixAction = vi.fn();
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [a, b], maybe: [] }} onRevise={onRevise} onFixAction={onFixAction} />);
    fireEvent.click(screen.getAllByRole("button", { name: "改这处" })[0]!);
    expect(onFixAction).toHaveBeenLastCalledWith({
      toolName: "revise_draft",
      chapter: 9,
      fixes: [{ targetText: a.quote, revisionGoal: `和本章前面「${a.earlierQuote}」对上（${a.reason}）` }],
    });
    fireEvent.click(screen.getByRole("button", { name: "改掉这 2 处" }));
    expect((onFixAction.mock.lastCall![0] as { fixes: unknown[] }).fixes).toHaveLength(2);
    expect(onRevise).not.toHaveBeenCalled();
  });

  it("两章打架的（P12）：不给「改这处」，给「以第 3 章为准 / 以本章为准」出定论卡；主按钮不算它", () => {
    const onFixAction = vi.fn();
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [a, cross], maybe: [] }} onRevise={vi.fn()} onFixAction={onFixAction} />);
    expect(screen.getAllByRole("button", { name: "改这处" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "以第 3 章为准" }));
    expect(onFixAction).toHaveBeenLastCalledWith({
      toolName: "settle_preview",
      chapter: 9,
      truth: { where: "chapter", chapter: 3, quote: cross.earlierQuote },
      other: { where: "chapter", chapter: 9, quote: cross.quote },
      reason: cross.reason,
    });
    expect(onFixAction.mock.lastCall![0]).not.toHaveProperty("item");
    fireEvent.click(screen.getByRole("button", { name: "以本章为准" }));
    expect(onFixAction).toHaveBeenLastCalledWith(expect.objectContaining({ truth: { where: "chapter", chapter: 9, quote: cross.quote }, item: continuityItemKey(cross) }));
    fireEvent.click(screen.getByRole("button", { name: "改掉本章 1 处" }));
    expect((onFixAction.mock.lastCall![0] as { fixes: { targetText: string }[] }).fixes.map((fix) => fix.targetText)).toEqual([a.quote]);
  });

  it("对设定的（错在前文那章）：「以设定为准 / 以第 3 章为准」，设定那边带卡名；全是这种就不出主按钮", () => {
    const onFixAction = vi.fn();
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [earlier], maybe: [] }} onRevise={vi.fn()} onFixAction={onFixAction} />);
    expect(screen.queryByRole("button", { name: /改掉/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /改设定/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "以设定为准" }));
    expect(onFixAction).toHaveBeenLastCalledWith(expect.objectContaining({
      truth: { where: "setting", quote: earlier.earlierQuote, label: "人物卡", card: "许微" },
      other: { where: "chapter", chapter: 3, quote: earlier.quote },
    }));
    expect(screen.getByRole("button", { name: "以第 3 章为准" })).toBeTruthy();
  });

  it("同一处前文 / 同一栏设定报了几句：「以那边为准」时别几句一起捎上（also），「以本章为准」不捎；对的不是同一句的不捎", () => {
    const onFixAction = vi.fn();
    const ch1 = { quote: "老码头在东边。", earlierQuote: "老码头在镇子西头", earlierChapter: 0, reason: "方位对不上", fixChapter: 1, againstSetting: { label: "位置", card: "老码头" } };
    const ch5 = { quote: "老码头在东头，得坐三站。", earlierQuote: "老码头在镇子西头", earlierChapter: 0, reason: "方位对不上", fixChapter: 5, againstSetting: { label: "位置", card: "老码头" } };
    const otherField = { quote: "码头上全是新船。", earlierQuote: "只剩几条旧渔船", earlierChapter: 0, reason: "船对不上", fixChapter: 6, againstSetting: { label: "现状", card: "老码头" } };
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [ch1], maybe: [], earlierOpen: [ch5, otherField] }} onFixAction={onFixAction} />);
    fireEvent.click(screen.getAllByRole("button", { name: "以设定为准" })[0]!);
    expect(onFixAction).toHaveBeenLastCalledWith(expect.objectContaining({
      other: { where: "chapter", chapter: 1, quote: ch1.quote },
      also: [{ where: "chapter", chapter: 5, quote: ch5.quote }],
    }));
    fireEvent.click(screen.getByRole("button", { name: "以第 1 章为准" }));
    expect(onFixAction.mock.lastCall![0]).not.toHaveProperty("also");
  });

  it("和定论打架的：只给「以定论为准」（按定论查全书），定论要改去设定本改", () => {
    const onFixAction = vi.fn();
    const canon = { quote: "杜叔走了五年了。", earlierQuote: "杜长顺十年前去世", earlierChapter: 9, reason: "和定论对不上", againstSetting: { label: "定论", kind: "canon" as const } };
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [canon], maybe: [] }} onFixAction={onFixAction} />);
    expect(screen.queryByRole("button", { name: "以本章为准" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "以定论为准" }));
    // 核账报的这句一起带上：定论卡一定查到它（换题材长篇实跑 2026-10-27：没带，查全书说「没有要改的」）
    expect(onFixAction).toHaveBeenLastCalledWith({ toolName: "settle_preview", statement: "杜长顺十年前去世", chapter: 9, also: [{ where: "chapter", chapter: 9, quote: "杜叔走了五年了。" }] });
  });

  it("和同一条定论打架的几句：「以定论为准」一起捎上", () => {
    const onFixAction = vi.fn();
    const against = { label: "定论", kind: "canon" as const };
    const first = { quote: "杜叔走了五年了。", earlierQuote: "杜长顺十年前去世", earlierChapter: 9, reason: "和定论对不上", againstSetting: against };
    const second = { quote: "五年前那场丧事。", earlierQuote: "杜长顺十年前去世", earlierChapter: 9, reason: "和定论对不上", againstSetting: against };
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [first, second], maybe: [] }} onFixAction={onFixAction} />);
    fireEvent.click(screen.getAllByRole("button", { name: "以定论为准" })[0]!);
    expect(onFixAction.mock.lastCall![0]).toMatchObject({ also: [{ chapter: 9, quote: "杜叔走了五年了。" }, { chapter: 9, quote: "五年前那场丧事。" }] });
  });
});

describe("核账卡：原句已经改掉的条目", () => {
  afterEach(() => {
    cleanup();
    useDraftStore.getState().reset();
  });

  it("稿纸开着这一章、原句不在稿里了：标「已改掉」、不给按钮，主按钮不算它；别的章的稿子不算数", () => {
    const here = { quote: "他把钥匙放回了柜台上。", earlierQuote: "钥匙锁在抽屉里。", earlierChapter: 9, reason: "钥匙位置对不上" };
    const cross = { quote: "杜叔走了五年了。", earlierQuote: "杜叔走了整整十年。", earlierChapter: 3, reason: "去世年份对不上" };
    // 本章自己前后打架的，前面那句还在稿里（作者没改那边）。
    const other = { quote: "外面下着大雨。", earlierQuote: "杜叔走了十年了。", earlierChapter: 9, reason: "天气对不上" };
    useDraftStore.getState().loadPaper("/book", { chapter: 9, draft: { body: "外面 下着大雨。杜叔走了十年了。他把钥匙锁回抽屉。", version: "v1" }, committed: null } as never);
    const onFixAction = vi.fn();
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [here, cross, other], maybe: [] }} onRevise={vi.fn()} onFixAction={onFixAction} />);
    expect(screen.getAllByText("已改掉")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "以第 3 章为准" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "改这处" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "不是问题" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "改掉这 1 处" }));
    expect((onFixAction.mock.lastCall![0] as { fixes: { targetText: string }[] }).fixes.map((fix) => fix.targetText)).toEqual([other.quote]);
    cleanup();
    useDraftStore.getState().loadPaper("/book", { chapter: 8, draft: { body: "别的章。", version: "v1" }, committed: null } as never);
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [here], maybe: [] }} onRevise={vi.fn()} onFixAction={vi.fn()} />);
    expect(screen.queryByText("已改掉")).toBeNull();
  });

  it("「可能」的也改掉了：卡头不再说「可能 N 处」，点开那行说都改掉了（长篇实跑第 36 章）", () => {
    const fixedSure = { quote: "他把钥匙放回了柜台上。", earlierQuote: "钥匙锁在抽屉里。", earlierChapter: 9, reason: "钥匙位置对不上" };
    const fixedMaybe = { quote: "茶碗边搁着药箱。", earlierQuote: "药箱搁在脚边。", earlierChapter: 9, reason: "药箱位置对不上" };
    const liveMaybe = { quote: "外面下着大雨。", earlierQuote: "干得发裂。", earlierChapter: 8, reason: "天气对不上" };
    useDraftStore.getState().loadPaper("/book", { chapter: 9, draft: { body: "外面下着大雨。他把钥匙锁回抽屉。", version: "v1" }, committed: null } as never);
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [fixedSure], maybe: [fixedMaybe, liveMaybe] }} />);
    expect(screen.getByText("可能 1 处")).toBeTruthy();
    expect(screen.getByRole("button", { name: "还有 1 处可能有问题（点开看）" })).toBeTruthy();
    cleanup();
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [fixedSure], maybe: [fixedMaybe] }} />);
    expect(screen.getByText("改掉了")).toBeTruthy();
    expect(screen.getByRole("button", { name: "可能有问题的 1 处都改掉了（点开看）" })).toBeTruthy();
  });

  it("本章前后打架、作者改的是前面那句：也算改掉了，不再给「改这处 / 改掉这 N 处」（长篇实跑第 37 章）", () => {
    const self = { quote: "药箱还夹在腋下。", earlierQuote: "他把药箱搁在门槛里头。", earlierChapter: 9, reason: "药箱去向对不上" };
    const setting = { quote: "他左手端碗。", earlierQuote: "右臂有旧伤", earlierChapter: 9, reason: "x", againstSetting: { label: "人物卡", kind: "character" as const } };
    useDraftStore.getState().loadPaper("/book", { chapter: 9, draft: { body: "他把药箱夹紧出门。药箱还夹在腋下。他左手端碗。", version: "v1" }, committed: null } as never);
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [self, setting], maybe: [] }} onRevise={vi.fn()} onFixAction={vi.fn()} />);
    expect(screen.getAllByText("已改掉")).toHaveLength(1);
    expect(screen.getByText("确定 1 处")).toBeTruthy(); // 设定那条另一边是设定原文，不在稿里不算改掉
  });

  it("原句两截（A……B）按顺序都在就算还在；空白不计", () => {
    expect(quoteInPaper("她推开门。\n\n屋里 很暗，她没开灯。", "她推开门……她没开灯")).toBe(true);
    expect(quoteInPaper("她没开灯。她推开门。", "她推开门……她没开灯")).toBe(false);
    expect(quoteInPaper("屋里很暗。", "屋里 很暗")).toBe(true);
  });
});

describe("核账卡：前面章节之前报过、还没改的（P7 后）", () => {
  afterEach(() => cleanup());

  const old = { quote: "沈师傅走了也有五年了。", earlierQuote: "三年前过世", earlierChapter: 3, fixChapter: 3, reason: "设定说三年前", againstSetting: { label: "人物卡" } };

  it("不算这一章的问题：状态照这一章算，收成一行，点开能定哪边为准、能标不是问题", async () => {
    const onDismiss = vi.fn(async () => true);
    render(<Controlled check={{ chapter: 8, sure: [], maybe: [], earlierOpen: [old] }} onRevise={vi.fn()} onFixAction={vi.fn()} onDismiss={onDismiss} />);
    expect(screen.getByText("没发现对不上")).toBeTruthy();
    expect(screen.queryByText(/设定说三年前/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "第 3 章还有 1 处之前报过、还没改" })); });
    expect(screen.getByText(/设定说三年前/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "以第 3 章为准" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "不是问题" })); });
    expect(onDismiss).toHaveBeenCalledWith(old, false);
    expect(screen.queryByText(/之前报过/)).toBeNull();
  });
});

describe("核账卡：定论改掉的别章条目", () => {
  afterEach(() => cleanup());

  it("settled 里的条目标「已改掉」、不给按钮，卡头只数还没改的", () => {
    const ch1 = { quote: "老码头在东边。", earlierQuote: "位置：北岸", earlierChapter: 0, reason: "方位", fixChapter: 1, againstSetting: { label: "位置" } };
    const here = { quote: "他把钥匙放回了柜台上。", earlierQuote: "钥匙锁在抽屉里。", earlierChapter: 9, reason: "钥匙位置对不上" };
    render(<ContinuityCheckCard check={{ chapter: 9, sure: [ch1, here], maybe: [] }} settled={[continuityItemKey(ch1)]} onFixAction={vi.fn()} />);
    expect(screen.getByText("已改掉")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "以设定为准" })).toBeNull();
    expect(screen.getByText("确定 1 处")).toBeTruthy();
  });
});
