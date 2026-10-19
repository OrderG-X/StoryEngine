import { describe, expect, it } from "vitest";
import { countRealChapters, pickPreferredChapter, workspaceFromStateOverview } from "./stateOverviewAdapter.js";
import type { StateOverview } from "./types.js";
import type { ChapterNavItem } from "../types.js";

describe("countRealChapters（R2#4·章数不计占位「下一章」）", () => {
  const ch = (n: number, extra: Partial<ChapterNavItem> = {}): ChapterNavItem =>
    ({ id: `ch-${n}`, chapterNumber: n, title: `第${n}章`, status: "planned", ...extra });

  it("新书：当前第1章 + 占位下一章 → 只算 1 章（不计占位）", () => {
    expect(countRealChapters([ch(1), ch(2)], 1)).toBe(1);
  });

  it("ch1已入库、正写ch2、尾随ch3占位 → 算 2 章（修「2/3」）", () => {
    const chapters = [ch(1, { hasCommittedChapter: true }), ch(2, { hasDraftFile: true }), ch(3)];
    expect(countRealChapters(chapters, 2)).toBe(2);
  });

  it("有草稿/已入库的章一律计入，哪怕在当前章之后", () => {
    expect(countRealChapters([ch(1, { hasCommittedChapter: true }), ch(2, { hasDraftFile: true })], 1)).toBe(2);
  });
});

describe("pickPreferredChapter", () => {
  it("claims the tool's authoritative chapter over a stale store chapter (fix cross-chapter pollution)", () => {
    // 写第2章：UI 还停在第1章，但工具回了 chapter=2 → 必须认领 2，否则 autosave 把第2章写回 chapter-0001.md。
    expect(pickPreferredChapter(1, 2)).toBe(2);
  });

  it("keeps the store chapter when no tool chapter is given (read-only refresh must not eject the user)", () => {
    expect(pickPreferredChapter(3, undefined)).toBe(3);
  });

  it("ignores a degenerate tool chapter (0 / negative / non-int) and keeps the store chapter", () => {
    expect(pickPreferredChapter(2, 0)).toBe(2);
    expect(pickPreferredChapter(2, -1)).toBe(2);
    expect(pickPreferredChapter(2, 1.5)).toBe(2);
  });

  it("returns undefined when neither is usable (let overview derivation decide)", () => {
    expect(pickPreferredChapter(undefined, undefined)).toBeUndefined();
  });
});

describe("stateOverviewAdapter", () => {
  it("preferredCurrentChapter 优先于 overview 推导（修 applyOverviewToWorkspace 静默重置当前章）", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", logline: "", currentChapter: 1 },
    } satisfies StateOverview;
    // 不传 preferred：退化到 overview.project.currentChapter（旧行为）
    expect(workspaceFromStateOverview(overview).currentChapter.chapterNumber).toBe(1);
    // 传「用户当前停留章 5」：优先用之，不被引擎旧章号(1)覆盖 —— 这正是切第5章不被弹回第1章的修复
    expect(workspaceFromStateOverview(overview, 5).currentChapter.chapterNumber).toBe(5);
    // 非正整数 preferred 安全退化
    expect(workspaceFromStateOverview(overview, 0).currentChapter.chapterNumber).toBe(1);
  });

  it("当前章还没有章名：显示「第N章」，不借上一章的时间线事件当章名", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", logline: "", currentChapter: 11 },
      storyStatus: { currentObjective: "写第十一章", lastTimelineEvent: "林舟拨通纸条上的陌生号码" },
    } satisfies StateOverview;
    expect(workspaceFromStateOverview(overview).currentChapter).toMatchObject({ chapterNumber: 11, title: "第11章" });
  });

  it("treats draft-only chapter files as work drafts instead of committed chapters", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", logline: "", currentChapter: 2 },
      storyStatus: { currentObjective: "写第二章" },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: [
        { chapter: 1, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "雨夜账册" },
      ],
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);
    const chapterOne = workspace.chapters.find((chapter) => chapter.chapterNumber === 1);

    expect(chapterOne).toMatchObject({
      status: "draft",
      hasDraftFile: true,
      hasCommittedChapter: false,
      title: "雨夜账册",
    });
  });

  it("marks chapters committed only when a committed chapter file exists", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", logline: "", currentChapter: 3 },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: [
        { chapter: 1, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "正式一" },
        { chapter: 2, hasDraftFile: true, hasCommittedChapter: true, draftTitle: "工作稿二", committedTitle: "正式二" },
      ],
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);

    expect(workspace.chapters.find((chapter) => chapter.chapterNumber === 1)).toMatchObject({
      status: "committed",
      hasCommittedChapter: true,
      hasDraftFile: false,
    });
    expect(workspace.chapters.find((chapter) => chapter.chapterNumber === 2)).toMatchObject({
      status: "committed",
      hasCommittedChapter: true,
      hasDraftFile: true,
      title: "正式二",
    });
  });

  it("marks draft-only chapters as an uncommitted working draft chain", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", logline: "", currentChapter: 10 },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: Array.from({ length: 10 }, (_, index) => ({
        chapter: index + 1,
        hasDraftFile: true,
        hasCommittedChapter: false,
        draftTitle: `工作稿${index + 1}`,
      })),
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);

    expect(workspace.hasUncommittedDrafts).toBe(true);
    expect(workspace.workingDraftChain).toBe(true);
    expect(workspace.previousUncommittedDraftContext).toBe(true);
    expect(workspace.latestUncommittedDraftChapter).toBe(10);
  });

  it("does not show an uncommitted working chain when all drafts are committed", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", logline: "", currentChapter: 2 },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: [
        { chapter: 1, hasDraftFile: true, hasCommittedChapter: true, draftTitle: "工作稿一", committedTitle: "正式一" },
        { chapter: 2, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "正式二" },
      ],
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);

    expect(workspace.hasUncommittedDrafts).toBe(false);
    expect(workspace.workingDraftChain).toBe(false);
    expect(workspace.previousUncommittedDraftContext).toBe(false);
    expect(workspace.latestUncommittedDraftChapter).toBeUndefined();
  });
});

function createOverview(): StateOverview {
  return {
    project: { title: "测试书", genre: "都市", logline: "", currentChapter: 1 },
    storyStatus: { currentObjective: "进入总部" },
    hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
    threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, cleanupVisibleUnresolvedCount: 0, keyOpenItems: [] },
    arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
    timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
    characters: { protagonist: "林远", knownCharacters: [{ name: "林远", carded: true, protagonist: true }] },
    setting: { cards: { characters: 1, places: 0, items: 0, lore: 0 }, uncarded: 0, storyFields: 1 },
    maintenance: {
      diagnosticsAvailable: true,
      cleanupVisibleCount: 0,
      mergeDisabled: true,
      dropDisabled: true,
      confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
    },
    uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
  };
}
