// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChapterMessage, CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { clearLedgerExclusions } from "../../../utils/ledgerExclusions.js";
import { closeCommitSheet, openCommitSheet, reusableCommitPreviewId } from "../../../workspace/commitSheet.js";
import { CommitSheet, CommitSheetHost } from "./CommitSheet.js";

const OP = "op-0123456789abcdef0123";
const OP2 = "op-0123456789abcdef0124";
const preview = (over: Partial<CommitPreviewCardData> = {}): CommitPreviewCardData => ({
  chapter: 7,
  canCommit: true,
  ledgerChecklist: [
    { id: "day", kind: "time", label: "这一章记为故事第 3 天（正文明写）", detail: "三天后的上午", removable: false, editableDay: 3 },
    { id: "0", kind: "fact", label: "钟箱门：锁死 → 没锁（和第 6 章对不上）", detail: "钟箱门一推就开了。", removable: true, needsConfirm: true },
    { id: "change_confirm:1", kind: "change", label: "改记：茶馆在斜对面 → 竹桌收进墙根", removable: true, needsConfirm: true, defaultUnchecked: true },
    { id: "2", kind: "fact", label: "楼门钥匙放回茶馆柜台底下", removable: true },
    { id: "3", kind: "thread", label: "新线索：外乡人是谁", removable: true },
  ],
  ...over,
});

describe("定稿清单弹窗（重构 P6，草图 ②）", () => {
  afterEach(() => { cleanup(); clearLedgerExclusions(OP); });

  it("分三份：天数在头上、要你看的逐条两个按钮、其余收在「另外自动记下 N 条」", () => {
    render(<CommitSheet preview={preview()} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "定稿第 7 章" })).toBeTruthy();
    expect(screen.getByText("这一章记为故事第 3 天（正文明写）")).toBeTruthy();
    expect(screen.getByText("要你看的 2 条")).toBeTruthy();
    expect(screen.getByRole("group", { name: "钟箱门：锁死 → 没锁（和第 6 章对不上）" })).toBeTruthy();
    // 要确认的改记：【改记】【不改】、默认不改。
    const change = screen.getByRole("group", { name: "改记：茶馆在斜对面 → 竹桌收进墙根" });
    expect(within(change).getByRole("button", { name: "不改" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("楼门钥匙放回茶馆柜台底下")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "另外自动记下 2 条（不对的点开去掉）" }));
    expect(screen.getByText("楼门钥匙放回茶馆柜台底下")).toBeTruthy();
  });

  it("只有天数要你看：说「除了天数，没有要你特别看的」（和对话里「要你看 1 条」对得上）", () => {
    render(<CommitSheet preview={preview({ ledgerChecklist: [
      { id: "day", kind: "time", label: "这一章记为故事第 11 天（先按上一章往后推，不对就改）", removable: false, editableDay: 11, needsConfirm: true },
      { id: "2", kind: "fact", label: "楼门钥匙放回茶馆柜台底下", removable: true },
    ] })} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("除了天数，没有要你特别看的，下面这些自动记下。")).toBeTruthy();
  });

  it("重定稿天数和上次不一样：天数那行说清两边；作者改了天数就不再说", () => {
    const why = "记账员这次看成第 5 天到第 6 天，和上次定稿不一样；先照上次的记，不对就改天数";
    render(<CommitSheet preview={preview({ ledgerChecklist: [
      { id: "day", kind: "time", label: "这一章记为故事第 6 天到第 7 天（清晨到夜里）（照上次定稿）", reason: why, removable: false, editableDay: 6, editableDayEnd: 7, needsConfirm: true },
      { id: "2", kind: "fact", label: "楼门钥匙放回茶馆柜台底下", removable: true },
    ] })} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(why)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "5" } });
    expect(screen.queryByText(why)).toBeNull();
  });

  it("这本书头一回定稿：头上一句说定稿是干什么的；之后、只看的旧预览都不说", () => {
    const intro = /定稿就是把这章记进账/u;
    const { rerender } = render(<CommitSheet preview={preview()} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} firstCommit />);
    expect(screen.getByText(intro)).toBeTruthy();
    rerender(<CommitSheet preview={preview()} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText(intro)).toBeNull();
    rerender(<CommitSheet preview={preview()} busy={false} onClose={vi.fn()} firstCommit />);
    expect(screen.queryByText(intro)).toBeNull();
  });

  it("不记 / 改记 / 改天数随【定稿】带上；什么都不动就是空的", () => {
    const onConfirm = vi.fn();
    render(<CommitSheet preview={preview()} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "确认定稿" }));
    expect(onConfirm).toHaveBeenLastCalledWith([], undefined);

    const fact = screen.getByRole("group", { name: "钟箱门：锁死 → 没锁（和第 6 章对不上）" });
    fireEvent.click(within(fact).getByRole("button", { name: "不记" }));
    fireEvent.click(screen.getByRole("button", { name: "确认定稿（不记 1 条）" }));
    expect(onConfirm).toHaveBeenLastCalledWith(["0"], undefined);

    fireEvent.click(within(fact).getByRole("button", { name: "记下" }));
    const change = screen.getByRole("group", { name: "改记：茶馆在斜对面 → 竹桌收进墙根" });
    fireEvent.click(within(change).getByRole("button", { name: "改记" }));
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "确认定稿（改记 1 条）" }));
    expect(onConfirm).toHaveBeenLastCalledWith(["change_confirm:1"], { day: 5, dayEnd: 5 });
  });

  const spanning = () => {
    const base = preview();
    return { ...base, ledgerChecklist: base.ledgerChecklist!.map((item) => (item.id === "day" ? { ...item, label: "这一章记为故事第 3 天到第 4 天（按前后文判断）", editableDayEnd: 4 } : item)) };
  };

  it("记账员记成跨两天、其实没跨：「到第几天」也填成同一天（按这一天记）", () => {
    const onConfirm = vi.fn();
    render(<CommitSheet preview={spanning()} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    // 删空再重打：删空时框里先空着（不弹回 4），再打 3。
    const end = screen.getByRole("spinbutton", { name: "这一章到故事第几天" }) as HTMLInputElement;
    expect(end.value).toBe("4");
    fireEvent.change(end, { target: { value: "" } });
    expect(end.value).toBe("");
    fireEvent.change(end, { target: { value: "3" } });
    expect(screen.getByText("这一章改记为故事第 3 天")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认定稿" }));
    expect(onConfirm).toHaveBeenLastCalledWith([], { day: 3, dayEnd: 3 });
  });

  // 长篇实跑：第 24 章记账员记成第 20～21 天，其实是第 21～22 天；改头一天只能记成一天，章里第二天那段丢了。
  it("跨天的章改头一天：跨的天数跟着挪", () => {
    const onConfirm = vi.fn();
    render(<CommitSheet preview={spanning()} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "4" } });
    expect((screen.getByRole("spinbutton", { name: "这一章到故事第几天" }) as HTMLInputElement).value).toBe("5");
    expect(screen.getByText("这一章改记为故事第 4 天到第 5 天")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认定稿" }));
    expect(onConfirm).toHaveBeenLastCalledWith([], { day: 4, dayEnd: 5 });
  });

  it("先填「到第几天」再改头一天：到第几天按填的不动，框里和上面那行说的一样", () => {
    const onConfirm = vi.fn();
    render(<CommitSheet preview={spanning()} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    const end = screen.getByRole("spinbutton", { name: "这一章到故事第几天" }) as HTMLInputElement;
    fireEvent.change(end, { target: { value: "5" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "4" } });
    expect(end.value).toBe("5");
    expect(screen.getByText("这一章改记为故事第 4 天到第 5 天")).toBeTruthy();
    // 头一天改到比填的还晚：到第几天跟上来，框里也跟着显示。
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "6" } });
    expect(end.value).toBe("6");
    expect(screen.getByText("这一章改记为故事第 6 天")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认定稿" }));
    expect(onConfirm).toHaveBeenLastCalledWith([], { day: 6, dayEnd: 6 });
  });

  it("关了再开（同一次定稿）动过的条目和天数还在；别的一次不带", () => {
    const same = preview();
    const first = render(<CommitSheet preview={same} opId={OP} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("group", { name: "钟箱门：锁死 → 没锁（和第 6 章对不上）" })).getByRole("button", { name: "不记" }));
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "5" } });
    first.unmount();
    const onConfirm = vi.fn();
    const second = render(<CommitSheet preview={same} opId={OP} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "确认定稿（不记 1 条）" }));
    expect(onConfirm).toHaveBeenCalledWith(["0"], { day: 5, dayEnd: 5 });
    second.unmount();
    render(<CommitSheet preview={same} opId={OP2} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "确认定稿" }));
    expect(onConfirm).toHaveBeenLastCalledWith([], undefined);
  });

  it("定不了：照实列原因，只有【知道了】；有动作在跑时【定稿】不让点", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <CommitSheet preview={preview({ canCommit: false, blockingReasons: ["正文 800 字，低于下限 2000 字"] })} busy={false} onConfirm={vi.fn()} onClose={onClose} />,
    );
    expect(screen.getByText("现在还定不了")).toBeTruthy();
    expect(screen.getByText("正文 800 字，低于下限 2000 字")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认定稿" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    render(<CommitSheet preview={preview()} busy onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByRole("button", { name: "确认定稿" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Esc 和点遮罩都关；【先不定】也只是关", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<CommitSheet preview={preview()} busy={false} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "先不定" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("要你看的按原因归组：同一原因只在组头说一遍；没带原因的旧条目各自成行", () => {
    render(<CommitSheet preview={preview({ ledgerChecklist: [
      { id: "a", kind: "cast", label: "出场：吴师傅", reason: "第一次出场的人物", removable: true, needsConfirm: true },
      { id: "b", kind: "thread", label: "收口「钥匙」", reason: "收掉后不再提醒", removable: true, needsConfirm: true },
      { id: "c", kind: "cast", label: "出场：中年男人", reason: "第一次出场的人物", removable: true, needsConfirm: true },
      { id: "d", kind: "fact", label: "钟箱门：锁死 → 没锁（和第 6 章对不上）", removable: true, needsConfirm: true },
    ] })} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText("第一次出场的人物")).toHaveLength(1);
    const groups = [...document.querySelectorAll(".se-cs-group")].map((group) => group.textContent ?? "");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toContain("出场：吴师傅");
    expect(groups[0]).toContain("出场：中年男人");
    expect(groups[1]).toContain("收口「钥匙」");
    expect(groups[2]).toContain("钟箱门");
  });

  it("记账员的提醒和没记上的照实列", () => {
    render(<CommitSheet preview={preview({ notes: ["记账员还在读前文（笔记到第 3 章）"], notRecorded: ["新人物：原句对不上"] })} busy={false} onClose={vi.fn()} />);
    expect(screen.getByText("记账员还在读前文（笔记到第 3 章）")).toBeTruthy();
    expect(screen.getByText("没记上 1 条")).toBeTruthy();
    // 没给 onConfirm（旧预览）＝只看：没有【定稿】、没有选择按钮。
    expect(screen.queryByRole("button", { name: "确认定稿" })).toBeNull();
    expect(screen.queryByRole("button", { name: "不记" })).toBeNull();
  });
});

describe("定稿清单开在哪、什么时候能直接再开", () => {
  /** 一条出了定稿清单的消息：在等作者点（op 在等、等的是这张清单）；opId 为空＝只有清单（定不了、用掉了的）。 */
  const msg = (id: string, card: Partial<{ preview: CommitPreviewCardData; checkedVersion: string | null; opId: string; state: "waiting_author" | "succeeded" }>): ChapterMessage => {
    const shown = card.preview ?? preview();
    const opId = card.opId;
    const state = card.state ?? "waiting_author";
    return {
      id, role: "assistant", content: "",
      cards: [
        ...(opId ? [{ type: "operation" as const, op: { opId, kind: "commit.prepare", what: "定稿", state, stateText: "", allowed: [], summary: "", eventSeq: 1, ...(state === "waiting_author" ? { pending: { kind: "commit" as const, actionId: "confirm-commit", decisions: ["commit"], preview: shown } } : {}) } }] : []),
        { type: "commit-preview", preview: shown, ...(opId ? { opId } : {}), ...(card.checkedVersion !== undefined ? { checkedVersion: card.checkedVersion } : {}) },
      ],
    };
  };
  const paper = { chapter: 7, baseVersion: "v1", body: "稿", savedBody: "稿", title: "", savedTitle: "" };

  beforeEach(() => { useChatStore.setState({ messages: [] }); closeCommitSheet(); });
  afterEach(() => { cleanup(); closeCommitSheet(); clearLedgerExclusions(OP); clearLedgerExclusions(OP2); });

  it("清单还在等作者点、出完稿子没变（版本一样、没有没存的字）才直接再开；否则要重新出一张", () => {
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1", opId: OP })], paper)).toBe("a");
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v0", opId: OP })], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1", opId: OP })], { ...paper, body: "稿，又写一句" })).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { opId: OP })], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1", opId: OP, preview: preview({ chapter: 8 }) })], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1", opId: OP, state: "succeeded" })], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1" })], paper)).toBeNull();
  });

  it("只差字数下限：【知道了】旁边给【就这么短，照样定稿】，点了关窗、交一次这一章照样定稿；别的挡住的原因不给", () => {
    const short = preview({ canCommit: false, ledgerChecklist: undefined, shortOnly: true, blockingReasons: ["正文 1137 字，低于写作规则要求的下限 2000 字"] });
    useChatStore.setState({ messages: [msg("short", { preview: short })] });
    const onSendUserAction = vi.fn();
    render(<CommitSheetHost busy={false} onSendUserAction={onSendUserAction} />);
    act(() => openCommitSheet("short"));
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "就这么短，照样定稿" }));
    expect(onSendUserAction).toHaveBeenCalledWith({ kind: "new", type: "commit.prepare", params: { chapter: 7, allowShort: true }, requestKey: expect.any(String), issuedAt: expect.any(String) });
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    useChatStore.setState({ messages: [msg("other", { preview: { ...short, shortOnly: undefined } })] });
    render(<CommitSheetHost busy={false} onSendUserAction={onSendUserAction} />);
    act(() => openCommitSheet("other"));
    expect(screen.queryByRole("button", { name: "就这么短，照样定稿" })).toBeNull();
  });

  it("挂在外层的弹窗：打开那条消息上的清单；只有这一章最新、还在等的那张能点【定稿】，点了关窗、接着那次定稿（带上动过的、回显一句）", () => {
    useChatStore.setState({ messages: [msg("old", { checkedVersion: "v1", opId: OP }), msg("new", { checkedVersion: "v1", opId: OP2 })] });
    useDraftStore.setState(paper);
    const onSendUserAction = vi.fn();
    render(<CommitSheetHost busy={false} onSendUserAction={onSendUserAction} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openCommitSheet("old"));
    expect(screen.queryByRole("button", { name: "确认定稿" })).toBeNull();
    act(() => openCommitSheet("new"));
    fireEvent.click(within(screen.getByRole("group", { name: "钟箱门：锁死 → 没锁（和第 6 章对不上）" })).getByRole("button", { name: "不记" }));
    fireEvent.click(screen.getByRole("button", { name: "改天数" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "这一章是故事第几天" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "确认定稿（不记 1 条）" }));
    expect(onSendUserAction).toHaveBeenCalledWith(
      { kind: "resume", opId: OP2, answer: { actionId: "confirm-commit", decision: "commit", excluded: ["0"], values: { day: 4, dayEnd: 4 } } },
      { echo: "确认定稿第 7 章（账本清单去掉了 1 条，这一章改记为故事第 4 天）" },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("那次定稿已经用掉了：清单只看，没有【定稿】", () => {
    useChatStore.setState({ messages: [msg("done", { checkedVersion: "v1", opId: OP, state: "succeeded" })] });
    render(<CommitSheetHost busy={false} onSendUserAction={vi.fn()} />);
    act(() => openCommitSheet("done"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认定稿" })).toBeNull();
  });
});
