// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainstormCardData } from "../../../type-defs/workspace.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { BrainstormPanel, DirectionsCard, advancesText } from "./Brainstorm.js";

const DATA: BrainstormCardData = {
  chapter: 12,
  idea: "让老周开口",
  checked: true,
  options: [
    { title: "老周开口", steps: ["外乡人第二次上门", "老周说出钟停那天的事"], recommended: true, threads: [{ title: "老周回避", idle: 6, stale: true }, { title: "外乡人是谁", idle: 1, stale: false }], problems: [] },
    { title: "夜里上楼", steps: ["钟楼有响动", "钟箱门被人动过"], threads: [], problems: [{ step: 2, earlierChapter: 10, earlierQuote: "钥匙在她包里", reason: "别人开不了钟箱" }] },
    { title: "陆川的难处", steps: ["镇里开会要拆钟楼"], threads: [], problems: [] },
  ],
};

const seed = (picked?: number) => {
  act(() => {
    useChatStore.getState().setMessages([
      { id: "u1", role: "user", content: "想想第 12 章往哪走" },
      { id: "m1", role: "assistant", content: "第 12 章想了 3 种走法，在稿纸上挑。", cards: [{ type: "directions", brainstorm: DATA, ...(picked !== undefined ? { picked } : {}) }] },
    ]);
  });
};

beforeEach(() => { act(() => useChatStore.getState().setMessages([])); });
afterEach(cleanup);

describe("头脑风暴面板（稿纸上方，重构 P6 草图 ⑤）", () => {
  it("空章没走法：问往哪走；填想法点【给我几种走法】发结构化动作；有稿就不出这块", () => {
    const onAction = vi.fn();
    const { rerender } = render(<BrainstormPanel chapter={12} draftEmpty hidden={false} busy={false} onAction={onAction} />);
    expect(screen.getByRole("heading", { name: "第 12 章往哪走？" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("你的想法"), { target: { value: " 让老周开口 " } });
    fireEvent.click(screen.getByRole("button", { name: "给我几种走法" }));
    expect(onAction).toHaveBeenCalledWith({ toolName: "brainstorm_chapter", chapter: 12, idea: "让老周开口" });
    rerender(<BrainstormPanel chapter={12} draftEmpty hidden={false} busy onAction={onAction} />);
    expect(screen.getByText(/AI 在想几种走法/u)).toBeTruthy();
    rerender(<BrainstormPanel chapter={12} draftEmpty={false} hidden={false} busy={false} onAction={onAction} />);
    expect(screen.queryByRole("region", { name: "往哪走" })).toBeNull();
  });

  it("有走法卡：并排几种（推荐、几步、推进的线索、对不上的地方）；【再来几种】带上已给过的名字", () => {
    seed();
    const onAction = vi.fn();
    render(<BrainstormPanel chapter={12} draftEmpty={false} hidden={false} busy={false} onAction={onAction} />);
    const first = screen.getByRole("article", { name: "甲 · 老周开口" });
    expect(within(first).getByText("推荐")).toBeTruthy();
    expect(within(first).getByText("推进：老周回避（停了 6 章）、外乡人是谁")).toBeTruthy();
    expect(within(first).getByText("核过前文：对得上")).toBeTruthy();
    const second = screen.getByRole("article", { name: "乙 · 夜里上楼" });
    expect(within(second).getByText("第 2 步和第 10 章对不上：别人开不了钟箱")).toBeTruthy();
    expect(within(second).getByText("钥匙在她包里")).toBeTruthy();
    expect((screen.getByLabelText("你的想法") as HTMLInputElement).value).toBe("让老周开口");
    fireEvent.click(screen.getByRole("button", { name: "再来几种" }));
    expect(onAction).toHaveBeenCalledWith({ toolName: "brainstorm_chapter", chapter: 12, idea: "让老周开口", avoid: ["老周开口", "夜里上楼", "陆川的难处"] });
  });

  it("【用这个】只记在卡上（picked），收成「这章打算」；空章可【让 AI 照这个起草】；【换一种】撤回", () => {
    seed();
    const onAction = vi.fn();
    render(<BrainstormPanel chapter={12} draftEmpty hidden={false} busy={false} onAction={onAction} />);
    fireEvent.click(within(screen.getByRole("article", { name: "乙 · 夜里上楼" })).getByRole("button", { name: "用这个" }));
    expect(useChatStore.getState().messages[1]!.cards).toEqual([{ type: "directions", brainstorm: DATA, picked: 1 }]);
    expect(onAction).not.toHaveBeenCalled();
    const plan = screen.getByRole("region", { name: "这章打算" });
    expect(within(plan).getByText("乙 · 夜里上楼")).toBeTruthy();
    expect(within(plan).getByText("钟楼有响动")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "让 AI 照这个起草" }));
    expect(onAction).toHaveBeenCalledWith({ toolName: "generate_draft", chapter: 12, chapterGoal: "夜里上楼：1. 钟楼有响动 2. 钟箱门被人动过" });
    fireEvent.click(screen.getByRole("button", { name: "换一种" }));
    expect(useChatStore.getState().messages[1]!.cards).toEqual([{ type: "directions", brainstorm: DATA }]);
    expect(screen.getByRole("article", { name: "甲 · 老周开口" })).toBeTruthy();
  });

  it("写了稿之后「这章打算」只留一行，点开看几步；没有起草按钮；已定稿 / 出稿中整块不出", () => {
    seed(0);
    const { rerender } = render(<BrainstormPanel chapter={12} draftEmpty={false} hidden={false} busy={false} onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "让 AI 照这个起草" })).toBeNull();
    expect(screen.queryByText("外乡人第二次上门")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /这章打算/u }));
    expect(screen.getByText("外乡人第二次上门")).toBeTruthy();
    rerender(<BrainstormPanel chapter={12} draftEmpty={false} hidden busy={false} onAction={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "这章打算" })).toBeNull();
  });

  it("别的章的走法不出在这一章；收起后一行「有 N 种走法」点开", () => {
    seed();
    const { rerender } = render(<BrainstormPanel chapter={13} draftEmpty={false} hidden={false} busy={false} onAction={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "往哪走" })).toBeNull();
    rerender(<BrainstormPanel chapter={12} draftEmpty={false} hidden={false} busy={false} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    fireEvent.click(screen.getByRole("button", { name: /有 3 种走法/u }));
    expect(screen.getByRole("article", { name: "丙 · 陆川的难处" })).toBeTruthy();
  });
});

describe("对话里的走法小卡", () => {
  it("只列名字；挑过的标「用了这个」，没挑中的变淡", () => {
    const { rerender } = render(<DirectionsCard data={DATA} />);
    expect(screen.getByText("第 12 章 · 3 种走法")).toBeTruthy();
    expect(screen.getByText("推荐")).toBeTruthy();
    expect(screen.getByText("和前文对不上 1 处")).toBeTruthy();
    expect(screen.getByText("在稿纸上方挑。")).toBeTruthy();
    rerender(<DirectionsCard data={DATA} picked={2} />);
    expect(screen.getByText("用了这个")).toBeTruthy();
    expect(screen.getByText("没挑中的不会记进账里。")).toBeTruthy();
    expect(screen.getByText("甲 · 老周开口").closest("li")!.className).toBe("is-dim");
  });

  it("被新一批换掉的旧卡：标「后来换过一批了」，不再叫人去稿纸上方挑", () => {
    act(() => {
      useChatStore.getState().setMessages([
        { id: "m1", role: "assistant", content: "", cards: [{ type: "directions", brainstorm: DATA }] },
        { id: "m2", role: "assistant", content: "", cards: [{ type: "directions", brainstorm: DATA }] },
      ]);
    });
    const { rerender } = render(<DirectionsCard messageId="m1" data={DATA} />);
    expect(screen.getByText("后来换过一批了。")).toBeTruthy();
    rerender(<DirectionsCard messageId="m2" data={DATA} />);
    expect(screen.getByText("在稿纸上方挑。")).toBeTruthy();
  });

  it("推进那行：停太久的标停了几章", () => {
    expect(advancesText(DATA.options[0]!)).toBe("老周回避（停了 6 章）、外乡人是谁");
  });
});
