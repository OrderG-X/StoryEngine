import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DraftVersionsCard } from "./DraftVersionsCard.js";
import { useBookStore } from "../../../stores/bookStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { useUiStore } from "../../../stores/uiStore.js";

const SHA = "a".repeat(64);
const DATA = { chapter: 7, versions: [{ index: 1, candidateId: "0007-op-1", sha: SHA, body: "第一版正文。" }, { index: 3, candidateId: "0007-op-3", sha: SHA, title: "第7章 · 雨夜", body: "第三版正文，长一些。" }] };

function onChapter(chapter: number): void {
  const book = useBookStore.getState();
  book.updateWorkspace({ currentChapter: { ...book.workspace.currentChapter, chapterNumber: chapter } });
}

describe("另外几版卡", () => {
  beforeEach(() => {
    useNavigationStore.setState({ projectPath: "/books/镖路", toast: null });
    useDraftStore.setState({ chapter: 7, body: "中选那版。", savedBody: "中选那版。", committed: null, streaming: null });
    useUiStore.getState().setDraftCandidates(null);
    onChapter(7);
  });
  afterEach(() => cleanup());

  it("列出几版和字数；点开看＝在稿纸上并排摆出来，带候选号和指纹、归属这本书这一章", () => {
    render(<DraftVersionsCard data={DATA} busy={false} />);
    expect(screen.getByText("第 7 章 · 另外 2 版")).toBeTruthy();
    expect(screen.getByText(/^第 3 版 · \d+ 字$/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "点开看" }));
    expect(useUiStore.getState().draftCandidates).toEqual([
      { index: 1, candidateId: "0007-op-1", sha: SHA, body: "第一版正文。", chapter: 7, projectPath: "/books/镖路" },
      { index: 3, candidateId: "0007-op-3", sha: SHA, title: "第7章 · 雨夜", body: "第三版正文，长一些。", chapter: 7, projectPath: "/books/镖路" },
    ]);
  });

  it("作者要自己挑的几版（一版都没换上）：标题说「挑一版」", () => {
    render(<DraftVersionsCard data={{ ...DATA, pick: true }} busy={false} />);
    expect(screen.getByText("第 7 章 · 写了 2 版，挑一版")).toBeTruthy();
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
