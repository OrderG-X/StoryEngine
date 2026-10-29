import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DraftVersionsCard } from "./DraftVersionsCard.js";
import { useBookStore } from "../../../stores/bookStore.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { useUiStore } from "../../../stores/uiStore.js";

const DATA = { chapter: 7, versions: [{ index: 1, body: "第一版正文。" }, { index: 3, body: "第三版正文，长一些。" }] };

function onChapter(chapter: number): void {
  const book = useBookStore.getState();
  book.updateWorkspace({ currentChapter: { ...book.workspace.currentChapter, chapterNumber: chapter } });
}

describe("另外几版卡", () => {
  beforeEach(() => {
    useNavigationStore.setState({ projectPath: "/books/镖路", toast: null });
    useChatStore.setState({ activeSessionId: "s1" });
    useDraftStore.setState({ chapter: 7, body: "中选那版。", savedBody: "中选那版。", committed: null, streaming: null });
    useUiStore.getState().setDraftCandidates(null);
    onChapter(7);
  });
  afterEach(() => cleanup());

  it("列出几版和字数；点开看＝在稿纸上并排摆出来，只换正文、归属这本书这一章", () => {
    render(<DraftVersionsCard data={DATA} busy={false} />);
    expect(screen.getByText("第 7 章 · 另外 2 版")).toBeTruthy();
    expect(screen.getByText(/^第 3 版 · \d+ 字$/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "点开看" }));
    expect(useUiStore.getState().draftCandidates).toEqual([
      { body: "第一版正文。", version: 1, originTarget: expect.objectContaining({ projectPath: "/books/镖路", chapter: 7, sessionId: "s1" }) },
      { body: "第三版正文，长一些。", version: 3, originTarget: expect.objectContaining({ chapter: 7 }) },
    ]);
  });

  it("不在这一章 / 这章已定稿：不摆，如实说为什么", () => {
    onChapter(8);
    render(<DraftVersionsCard data={DATA} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "点开看" }));
    expect(useUiStore.getState().draftCandidates).toBeNull();
    expect(useNavigationStore.getState().toast).toContain("先打开第 7 章");
    onChapter(7);
    useDraftStore.setState({ committed: { body: "中选那版。" }, body: "中选那版。", savedBody: "中选那版。" });
    fireEvent.click(screen.getByRole("button", { name: "点开看" }));
    expect(useUiStore.getState().draftCandidates).toBeNull();
    expect(useNavigationStore.getState().toast).toContain("已定稿");
  });
});
