// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChapterMessage, CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { clearLedgerExclusions } from "../../../utils/ledgerExclusions.js";
import { closeCommitSheet, openCommitSheet, reusableCommitPreviewId } from "../../../workspace/commitSheet.js";
import { CommitSheet, CommitSheetHost } from "./CommitSheet.js";

const preview = (over: Partial<CommitPreviewCardData> = {}): CommitPreviewCardData => ({
  chapter: 7,
  canCommit: true,
  previewToken: `tok-${Math.random()}`,
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
  afterEach(() => { cleanup(); clearLedgerExclusions(7); });

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
    expect(onConfirm).toHaveBeenLastCalledWith(["change_confirm:1"], 5);
  });

  it("关了再开（同一份预览）动过的还在", () => {
    const same = preview({ previewToken: "tok-same" });
    const first = render(<CommitSheet preview={same} busy={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("group", { name: "钟箱门：锁死 → 没锁（和第 6 章对不上）" })).getByRole("button", { name: "不记" }));
    first.unmount();
    const onConfirm = vi.fn();
    render(<CommitSheet preview={same} busy={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "确认定稿（不记 1 条）" }));
    expect(onConfirm).toHaveBeenCalledWith(["0"], undefined);
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
    expect(screen.getByText("没记上 1 条（原句对不上）")).toBeTruthy();
    // 没给 onConfirm（旧预览）＝只看：没有【定稿】、没有选择按钮。
    expect(screen.queryByRole("button", { name: "确认定稿" })).toBeNull();
    expect(screen.queryByRole("button", { name: "不记" })).toBeNull();
  });
});

describe("定稿清单开在哪、什么时候能直接再开", () => {
  const msg = (id: string, card: Partial<{ preview: CommitPreviewCardData; checkedVersion: string | null }>): ChapterMessage => ({
    id, role: "assistant", content: "", cards: [{ type: "commit-preview", preview: card.preview ?? preview(), ...(card.checkedVersion !== undefined ? { checkedVersion: card.checkedVersion } : {}) }],
  });
  const paper = { chapter: 7, baseVersion: "v1", body: "稿", savedBody: "稿", title: "", savedTitle: "" };

  beforeEach(() => { useChatStore.setState({ messages: [] }); closeCommitSheet(); });
  afterEach(() => { cleanup(); closeCommitSheet(); });

  it("预览后稿子没变（版本一样、没有没存的字）才直接再开；否则要重新预览", () => {
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1" })], paper)).toBe("a");
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v0" })], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1" })], { ...paper, body: "稿，又写一句" })).toBeNull();
    expect(reusableCommitPreviewId([msg("a", {})], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1", preview: preview({ chapter: 8 }) })], paper)).toBeNull();
    expect(reusableCommitPreviewId([msg("a", { checkedVersion: "v1", preview: preview({ canCommit: false }) })], paper)).toBeNull();
  });

  it("挂在外层的弹窗：打开那条消息上的预览；只有最新一张能点【定稿】，点了关窗、发确认定稿", () => {
    useChatStore.setState({ messages: [msg("old", { checkedVersion: "v1" }), msg("new", { checkedVersion: "v1" })] });
    useDraftStore.setState(paper);
    const onSuggestedAction = vi.fn();
    render(<CommitSheetHost busy={false} onSuggestedAction={onSuggestedAction} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openCommitSheet("old"));
    expect(screen.queryByRole("button", { name: "确认定稿" })).toBeNull();
    act(() => openCommitSheet("new"));
    fireEvent.click(screen.getByRole("button", { name: "确认定稿" }));
    expect(onSuggestedAction).toHaveBeenCalledWith(expect.objectContaining({ commitTarget: expect.objectContaining({ chapter: 7 }) }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
