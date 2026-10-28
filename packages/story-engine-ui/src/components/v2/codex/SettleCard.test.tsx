// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMessage, SettleCardData } from "../../../type-defs/workspace.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { cardOf } from "../../../utils/messageCards.js";
import { SettleCard } from "./SettleCard.js";

const data: SettleCardData = {
  token: "0123456789abcdef",
  canon: "杜长顺十年前去世",
  canonExists: false,
  chapter: 4,
  edits: [
    { key: "e1", chapter: 2, draft: false, from: "“杜叔走了五年了。”", to: "“杜叔走了十年了。”", why: "五年对不上十年" },
    { key: "e2", chapter: 4, draft: true, from: "说他五年前就没了。", to: "说他十年前就没了。" },
  ],
  facts: [{ chapter: 2, before: "杜长顺五年前去世", after: "杜长顺十年前去世" }],
  fields: [],
  searched: [1, 2, 4],
  missed: [],
  failures: [],
};

/** 卡从 store 里读（划掉记在卡上）：测试里挂一条消息，渲染时从 store 取。 */
function Live({ onAction, busy = false }: { readonly onAction?: (action: unknown) => void; readonly busy?: boolean }) {
  const message = useChatStore((s) => s.messages[0]!);
  const card = cardOf(message, "settle")!;
  return <SettleCard messageId={message.id} data={card.settle} {...(card.excluded ? { excluded: card.excluded } : {})} {...(card.applied ? { applied: card.applied } : {})} {...(card.dropped ? { dropped: true } : {})} busy={busy} {...(onAction ? { onAction } : {})} />;
}

beforeEach(() => {
  const message: ChapterMessage = { id: "m1", role: "assistant", content: "", createdAt: 0, cards: [{ type: "settle", settle: data }] } as unknown as ChapterMessage;
  useChatStore.getState().setMessages([message]);
});
afterEach(() => cleanup());

describe("定论卡", () => {
  // 长篇实跑：作者发现是自己记错了，说「这张不要了」，卡上「确认」还一直亮着。
  it("「不改了」：整张收起、不再能确认，书里没动；能撤回", () => {
    const onAction = vi.fn();
    render(<Live onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "不改了" }));
    expect(cardOf(useChatStore.getState().messages[0]!, "settle")?.dropped).toBe(true);
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "这句不改" })).toBeNull();
    expect(screen.getByText(/不改了，书里没动/u)).toBeTruthy();
    expect(screen.queryByText("“杜叔走了五年了。”")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤回" }));
    expect(cardOf(useChatStore.getState().messages[0]!, "settle")?.dropped).toBeUndefined();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("换掉设定本里原来那条：卡上写出旧的，没句子要改时按钮是「换掉旧的」", () => {
    const onAction = vi.fn();
    const replacing: SettleCardData = { ...data, canon: "杜长顺八年前去世", replaces: "杜长顺十年前去世", edits: [], facts: [] };
    useChatStore.getState().setMessages([{ id: "m1", role: "assistant", content: "", createdAt: 0, cards: [{ type: "settle", settle: replacing }] } as unknown as ChapterMessage]);
    render(<Live onAction={onAction} />);
    expect(screen.getByText("换掉设定本里原来那条：杜长顺十年前去世")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "换掉旧的" }));
    expect(onAction).toHaveBeenCalledWith({ toolName: "settle_apply", token: data.token, excluded: [] });
  });

  it("按章列原句 → 新句；划掉一句，确认带上划掉的；工作稿那章标出来", async () => {
    const onAction = vi.fn();
    render(<Live onAction={onAction} />);
    expect(screen.getByText("杜长顺十年前去世")).toBeTruthy();
    expect(screen.getByText("第 2 章")).toBeTruthy();
    expect(screen.getByText("第 4 章（工作稿）")).toBeTruthy();
    expect(screen.getByText("改 2 处，改前存档、能撤销")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "这句不改" })[1]!); });
    expect(screen.getByText("改 1 处，改前存档、能撤销")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onAction).toHaveBeenCalledWith({ toolName: "settle_apply", token: data.token, excluded: ["e2"] });
  });

  it("账里跟着改的收起，点开才看；改齐了按钮收起，结果那句只在对话里说一遍", async () => {
    render(<Live onAction={vi.fn()} />);
    expect(screen.queryByText(/杜长顺五年前去世/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "账里跟着改 1 条" })); });
    expect(screen.getByText("第 2 章：杜长顺五年前去世 → 杜长顺十年前去世")).toBeTruthy();
    await act(async () => { useChatStore.getState().markSettleApplied(data.token, "改齐了。改了第 2 章 1 句。"); });
    expect(screen.getByText("改齐了")).toBeTruthy();
    expect(screen.queryByText("改齐了。改了第 2 章 1 句。")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "这句不改" })).toBeNull();
  });

  it("没查出要改的：只「记下定论」；没查全如实说、给「重新查」（按定论查）", () => {
    useChatStore.getState().setMessages([{ id: "m1", role: "assistant", content: "", createdAt: 0, cards: [{ type: "settle", settle: { ...data, edits: [], facts: [], failures: ["第 3～5 章这一批没查成（连不上）"] } }] } as unknown as ChapterMessage]);
    const onAction = vi.fn();
    render(<Live onAction={onAction} />);
    expect(screen.getByText(/没查全：第 3～5 章这一批没查成/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新查" }));
    expect(onAction).toHaveBeenLastCalledWith({ toolName: "settle_preview", statement: data.canon, chapter: 4 });
    fireEvent.click(screen.getByRole("button", { name: "记下定论" }));
    expect(onAction).toHaveBeenLastCalledWith({ toolName: "settle_apply", token: data.token, excluded: [] });
    act(() => { useChatStore.getState().markSettleApplied(data.token, "改齐了。设定本：定论记下一条。"); });
    expect(screen.getByText("记下了")).toBeTruthy();
    expect(screen.queryByText("改齐了")).toBeNull();
  });

  it("只是那一场的事：标题「改齐」、说不记进设定本；没要改的不给按钮", () => {
    useChatStore.getState().setMessages([{ id: "m1", role: "assistant", content: "", createdAt: 0, cards: [{ type: "settle", settle: { ...data, sceneOnly: true } }] } as unknown as ChapterMessage]);
    const { unmount } = render(<Live onAction={vi.fn()} />);
    expect(screen.getByText("改齐")).toBeTruthy();
    expect(screen.getByText("只是那一场的事，改句子，不记进设定本。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
    unmount();
    useChatStore.getState().setMessages([{ id: "m1", role: "assistant", content: "", createdAt: 0, cards: [{ type: "settle", settle: { ...data, sceneOnly: true, edits: [], facts: [] } }] } as unknown as ChapterMessage]);
    render(<Live onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /确认|记下定论/ })).toBeNull();
  });

  it("设定本里已经有这条、也没要改的：不给按钮", () => {
    useChatStore.getState().setMessages([{ id: "m1", role: "assistant", content: "", createdAt: 0, cards: [{ type: "settle", settle: { ...data, canonExists: true, edits: [], facts: [] } }] } as unknown as ChapterMessage]);
    render(<Live onAction={vi.fn()} />);
    expect(screen.getByText("设定本里已经记着这条。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /确认|记下定论/ })).toBeNull();
  });
});
