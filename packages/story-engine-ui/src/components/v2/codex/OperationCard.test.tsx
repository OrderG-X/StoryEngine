// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkedBeforeEdit, OperationCard, runningOperationCaption } from "./OperationCard.js";
import type { OperationCardData } from "../../../type-defs/workspace.js";

const OP_ID = "op-0123456789abcdef0123";

function op(overrides: Partial<OperationCardData> = {}): OperationCardData {
  return { opId: OP_ID, kind: "inspect.run", what: "核账·第 3 章", state: "running", stateText: "在做", allowed: ["cancel"], summary: "", eventSeq: 1, ...overrides };
}

afterEach(() => cleanup());

describe("OperationCard", () => {
  it("在做：最新一句进度；不是这一轮交的才给「不要了」", () => {
    const onAction = vi.fn();
    const { rerender } = render(<OperationCard op={op({ progress: "核账员在读第 3 章" })} inLiveTurn={false} busy={false} onAction={onAction} />);
    expect(screen.getByText("核账·第 3 章：核账员在读第 3 章")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "不要了" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "cancel", opId: OP_ID });
    rerender(<OperationCard op={op()} inLiveTurn busy={false} onAction={onAction} />);
    expect(screen.getByText("核账·第 3 章：在做")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "不要了" })).toBeNull();
  });

  it("停着：为什么停 +「接着做」「不要了」；忙的时候点不了", () => {
    const onAction = vi.fn();
    render(<OperationCard op={op({ state: "paused", stateText: "停着：模型连不上", allowed: ["resume", "cancel"] })} inLiveTurn={false} busy onAction={onAction} />);
    expect(screen.getByText("核账·第 3 章：停着：模型连不上")).toBeTruthy();
    const resume = screen.getByRole("button", { name: "接着做" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "不要了" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("结束了：这一轮说过就不显示；后台做完的照服务端那句结论写，不再拿「做的什么」拼（不重复章号）", () => {
    const done = { state: "succeeded" as const, allowed: [], summary: "核了第 3 章，没发现对不上的", conclusion: "核了第 3 章，没发现对不上的" };
    const { container, rerender } = render(<OperationCard op={op({ ...done, announced: true })} inLiveTurn={false} busy={false} />);
    expect(container.textContent).toBe("");
    rerender(<OperationCard op={op(done)} inLiveTurn={false} busy={false} />);
    expect(container.textContent).toBe("核了第 3 章，没发现对不上的");
    rerender(<OperationCard op={op({ state: "failed", allowed: [], summary: "", stateText: "没做成" })} inLiveTurn={false} busy={false} />);
    expect(screen.getByText("核账·第 3 章：没做成")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("没接按钮回调：不出按钮", () => {
    render(<OperationCard op={op({ state: "paused", allowed: ["resume", "cancel"] })} inLiveTurn={false} busy={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("OperationCard：改写停着等作者（片 2C）", () => {
  const pending = {
    kind: "revise" as const,
    actionId: "confirm:1",
    decisions: ["apply", "again"],
    revise: { round: 1, changes: [{ from: "他慢慢地走了过去。", to: "他走过去。" }], failed: [{ target: "那句", why: "稿里找不到" }], brief: "删了拖沓的副词" },
  };
  const waiting = (overrides: Partial<OperationCardData> = {}) =>
    op({ kind: "draft.change", mode: "revise", what: "改稿·第 3 章", state: "waiting_author", stateText: "等你定", pending, ...overrides });

  it("改前划掉、改后照摆 + 没改成的一句；「换上」「再改一版」交回点的哪个，「不要了」停掉；这一轮在跑也给「不要了」", () => {
    const onAction = vi.fn();
    render(<OperationCard op={waiting()} inLiveTurn busy={false} onAction={onAction} />);
    expect(screen.getByText("他慢慢地走了过去。")).toBeTruthy();
    expect(screen.getByText("他走过去。")).toBeTruthy();
    expect(screen.getByText("删了拖沓的副词")).toBeTruthy();
    expect(screen.getByText("这一段没改成：稿里找不到")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "换上" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "resume", opId: OP_ID, answer: { actionId: "confirm:1", decision: "apply" } });
    fireEvent.click(screen.getByRole("button", { name: "再改一版" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "resume", opId: OP_ID, answer: { actionId: "confirm:1", decision: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "不要了" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "cancel", opId: OP_ID });
  });

  it("最后一轮只给「换上」；忙的时候点不了；没有改法（不是 owner 那条）就照常一行", () => {
    const { rerender } = render(<OperationCard op={waiting({ pending: { ...pending, decisions: ["apply"] } })} inLiveTurn={false} busy onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "再改一版" })).toBeNull();
    expect((screen.getByRole("button", { name: "换上" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<OperationCard op={waiting({ pending: undefined })} inLiveTurn={false} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText("改稿·第 3 章：等你定")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "换上" })).toBeNull();
  });
});

describe("OperationCard：改设定碰了作者写的，等作者点（片 3）", () => {
  const waiting = (overrides: Partial<OperationCardData> = {}) => op({
    kind: "settings.change",
    mode: "ai",
    what: "改设定",
    state: "waiting_author",
    stateText: "等你定",
    allowed: ["cancel"],
    pending: { kind: "settings", actionId: "confirm-settings", decisions: ["apply"], settings: { lines: ["「林远」的「身份」改了", "建了物品卡「蓝色账册」"], notDone: ["没有叫「不存在的人」的卡"] } },
    ...overrides,
  });

  it("整批每一处照摆 + 没改成的一句；「确认改设定」交回 apply，「不要了」停掉；忙的时候点不了", () => {
    const onAction = vi.fn();
    const { rerender } = render(<OperationCard op={waiting()} inLiveTurn={false} busy={false} onAction={onAction} />);
    expect(screen.getByText("「林远」的「身份」改了")).toBeTruthy();
    expect(screen.getByText("建了物品卡「蓝色账册」")).toBeTruthy();
    expect(screen.getByText("没改成：没有叫「不存在的人」的卡")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认改设定" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "resume", opId: OP_ID, answer: { actionId: "confirm-settings", decision: "apply" } });
    fireEvent.click(screen.getByRole("button", { name: "不要了" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "cancel", opId: OP_ID });
    rerender(<OperationCard op={waiting()} inLiveTurn={false} busy onAction={onAction} />);
    expect((screen.getByRole("button", { name: "确认改设定" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("runningOperationCaption", () => {
  it("排着、在做才有字幕", () => {
    expect(runningOperationCaption(op({ state: "queued" }))).toBe("正在核账·第 3 章…");
    expect(runningOperationCaption(op())).toBe("正在核账·第 3 章…");
    expect(runningOperationCaption(op({ state: "paused" }))).toBeNull();
    expect(runningOperationCaption(undefined)).toBeNull();
  });
});

describe("checkedBeforeEdit", () => {
  const paper = { chapter: 3, baseVersion: "v1", dirty: false };
  it("同一章：盘上换了版、或有没存的字，就是查完之后改过了", () => {
    expect(checkedBeforeEdit("v1", 3, paper)).toBe(false);
    expect(checkedBeforeEdit("v1", 3, { ...paper, baseVersion: "v2" })).toBe(true);
    expect(checkedBeforeEdit("v1", 3, { ...paper, dirty: true })).toBe(true);
    expect(checkedBeforeEdit("v1", 3, { ...paper, baseVersion: null, dirty: true })).toBe(true);
  });
  it("没对着工作稿查、不是眼前这一章、眼前没稿：不算", () => {
    expect(checkedBeforeEdit(undefined, 3, { ...paper, baseVersion: "v2" })).toBe(false);
    expect(checkedBeforeEdit(null, 3, { ...paper, baseVersion: "v2" })).toBe(false);
    expect(checkedBeforeEdit("v1", 4, { ...paper, baseVersion: "v2" })).toBe(false);
    expect(checkedBeforeEdit("v1", undefined, { ...paper, baseVersion: "v2" })).toBe(false);
    expect(checkedBeforeEdit("v1", 3, { ...paper, baseVersion: null })).toBe(false);
  });
});
