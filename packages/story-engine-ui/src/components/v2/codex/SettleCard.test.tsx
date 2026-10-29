// @vitest-environment jsdom
// 定论卡（写作版本 P2a 片 3C 起是 canon.propose 停下等作者点时的样子）：划掉记在卡上，「确认」= 接着做这次操作带上划掉的，
// 「不改了」= 停掉这次操作，「重新查」= 按定论新交一次。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationCardData, SettleCardData } from "../../../type-defs/workspace.js";
import { OperationCard } from "./OperationCard.js";

const OP_ID = "op-0123456789abcdef0123";

const data: SettleCardData = {
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

function waiting(card: SettleCardData = data): OperationCardData {
  return {
    opId: OP_ID,
    kind: "canon.propose",
    what: "定论",
    state: "waiting_author",
    stateText: "等你点",
    allowed: ["cancel"],
    summary: "",
    eventSeq: 1,
    pending: { kind: "canon", actionId: "confirm-canon", decisions: ["apply"], card, summary: "查完了。" },
  };
}

const confirmAction = (excluded?: readonly string[]) => ({
  kind: "resume",
  opId: OP_ID,
  answer: { actionId: "confirm-canon", decision: "apply", ...(excluded ? { excluded } : {}) },
});

afterEach(() => cleanup());

describe("定论卡", () => {
  it("按章列原句 → 新句；划掉一句，确认带上划掉的；工作稿那章标出来", async () => {
    const onAction = vi.fn();
    render(<OperationCard op={waiting()} inLiveTurn={false} busy={false} onAction={onAction} />);
    expect(screen.getByText("杜长顺十年前去世")).toBeTruthy();
    expect(screen.getByText("第 2 章")).toBeTruthy();
    expect(screen.getByText("第 4 章（工作稿）")).toBeTruthy();
    expect(screen.getByText("改 2 处，改前存档、能撤销")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "这句不改" })[1]!); });
    expect(screen.getByText("改 1 处，改前存档、能撤销")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onAction).toHaveBeenCalledWith(confirmAction(["e2"]));
  });

  it("划掉了又改回来：确认不带划掉的", async () => {
    const onAction = vi.fn();
    render(<OperationCard op={waiting()} inLiveTurn={false} busy={false} onAction={onAction} />);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "这句不改" })[0]!); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "改回来：这句也改" })); });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onAction).toHaveBeenCalledWith(confirmAction());
  });

  // 长篇实跑：作者发现是自己记错了，说「这张不要了」，卡上「确认」还一直亮着。
  it("「不改了」= 停掉这次操作（书里没动）", () => {
    const onAction = vi.fn();
    render(<OperationCard op={waiting()} inLiveTurn={false} busy={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "不改了" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "cancel", opId: OP_ID });
  });

  it("换掉设定本里原来那条：卡上写出旧的，没句子要改时按钮是「换掉旧的」", () => {
    const onAction = vi.fn();
    render(<OperationCard op={waiting({ ...data, canon: "杜长顺八年前去世", replaces: "杜长顺十年前去世", edits: [], facts: [] })} inLiveTurn={false} busy={false} onAction={onAction} />);
    expect(screen.getByText("换掉设定本里原来那条：杜长顺十年前去世")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "换掉旧的" }));
    expect(onAction).toHaveBeenCalledWith(confirmAction());
  });

  it("账里跟着改的收起，点开才看", async () => {
    render(<OperationCard op={waiting()} inLiveTurn={false} busy={false} onAction={vi.fn()} />);
    expect(screen.queryByText(/杜长顺五年前去世/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "账里跟着改 1 条" })); });
    expect(screen.getByText("第 2 章：杜长顺五年前去世 → 杜长顺十年前去世")).toBeTruthy();
  });

  it("没查出要改的：只「记下定论」；没查全如实说、给「重新查」（按定论新交一次，带上核账报的那几句）", () => {
    const onAction = vi.fn();
    const card: SettleCardData = { ...data, edits: [], facts: [], missed: [{ chapter: 3, quote: "海风很冷" }], failures: ["第 3～5 章这一批没查成（连不上）"] };
    render(<OperationCard op={waiting(card)} inLiveTurn={false} busy={false} onAction={onAction} />);
    expect(screen.getByText(/没查全：第 3～5 章这一批没查成/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新查" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "new",
      type: "canon.propose",
      mode: "statement",
      params: { statement: data.canon, chapter: 4, also: [{ where: "chapter", chapter: 3, quote: "海风很冷" }] },
    }));
    fireEvent.click(screen.getByRole("button", { name: "记下定论" }));
    expect(onAction).toHaveBeenLastCalledWith(confirmAction());
  });

  it("只是那一场的事：标题「改齐」、说不记进设定本", () => {
    render(<OperationCard op={waiting({ ...data, sceneOnly: true })} inLiveTurn={false} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText("改齐")).toBeTruthy();
    expect(screen.getByText("只是那一场的事，改句子，不记进设定本。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  });

  it("忙的时候点不了；没接按钮回调就只摆卡、不出按钮", () => {
    const { rerender } = render(<OperationCard op={waiting()} inLiveTurn={false} busy onAction={vi.fn()} />);
    expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "不改了" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<OperationCard op={waiting()} inLiveTurn={false} busy={false} />);
    expect(screen.getByText("杜长顺十年前去世")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /确认|不改了|这句不改/ })).toBeNull();
  });
});
