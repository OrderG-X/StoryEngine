/**
 * 开书概况 → 工作区（章节列表、当前章、流程状态）。设定本不走这里：设定卡走 GET /api/bible（重构 P9）。
 */
import type { StateOverview } from "./types.js";
import type { ChapterNavItem, ChapterWorkspaceData } from "../types.js";

type UiChapterFileState = NonNullable<StateOverview["uiChapterFiles"]>[number];

/**
 * 选定工作区当前章：写类工具（revise_draft/commit_apply）、写稿操作回传的 chapter 是「这次实际操作的章」，
 * 它是权威——必须盖过 store 里用户停留的旧章号，否则 UI 停在旧章、autosave 把新章正文写回旧章草稿文件（跨章污染）。
 * 只读刷新不带 toolChapter → 退回 store 旧章，不把用户从正在看的章弹走。两者都缺/退化值 → undefined 交给 overview 推导。
 * 模型无关：toolChapter 即便被传成 0 / 负数 / 小数等退化值也安全忽略。
 */
export function pickPreferredChapter(storeChapter?: number, toolChapter?: number): number | undefined {
  if (Number.isInteger(toolChapter) && (toolChapter as number) > 0) return toolChapter;
  return storeChapter;
}

/**
 * 真实章数（R2#4）：buildChapters 会无条件多塞一章「当前章+1」的占位『下一章』供导航/续写用，
 * 但它不该计入「共 N 章」。真实章 = 有已入库章 / 有草稿文件 / 章号≤当前章；尾随的纯占位章被排除。
 */
export function countRealChapters(chapters: readonly ChapterNavItem[], currentChapterNumber: number): number {
  return chapters.filter(
    (chapter) =>
      chapter.hasCommittedChapter === true ||
      chapter.hasDraftFile === true ||
      chapter.chapterNumber <= currentChapterNumber,
  ).length;
}

export function workspaceFromStateOverview(
  overview: StateOverview,
  // 调用方可传「用户当前停留章」优先用之，避免 applyOverviewToWorkspace 用引擎旧章号(overview.project.currentChapter
  // 仅在 commit 时推进)把 UI 当前章静默覆盖回去（自我强化错章循环）。缺省/非正整数时退化到 overview 推导。
  preferredCurrentChapter?: number,
): ChapterWorkspaceData {
  const currentChapterNumber = Number.isInteger(preferredCurrentChapter) && (preferredCurrentChapter as number) > 0
    ? (preferredCurrentChapter as number)
    : overview.project.currentChapter ?? lastKnownChapter(overview) ?? 1;
  const chapters = buildChapters(overview, currentChapterNumber);
  const currentChapter = chapters.find((chapter) => chapter.chapterNumber === currentChapterNumber) ?? chapters[0] ?? {
    id: "ch-1",
    chapterNumber: 1,
    title: "第1章",
    status: "current",
  };
  const uncommittedDraftChapters = chapters
    .filter((chapter) => chapter.hasDraftFile === true && chapter.hasCommittedChapter !== true)
    .map((chapter) => chapter.chapterNumber);
  const latestUncommittedDraftChapter = maxNumber(uncommittedDraftChapters);

  return {
    projectName: overview.project.title,
    currentChapter,
    chapters,
    flowStatus: inferFlowStatus(overview),
    hasUncommittedDrafts: uncommittedDraftChapters.length > 0,
    workingDraftChain: uncommittedDraftChapters.length > 0,
    previousUncommittedDraftContext: chapters.some((chapter) => (
      chapter.chapterNumber === currentChapter.chapterNumber - 1
      && chapter.hasDraftFile === true
      && chapter.hasCommittedChapter !== true
    )),
    ...(latestUncommittedDraftChapter !== undefined ? { latestUncommittedDraftChapter } : {}),
  };
}

function inferFlowStatus(overview: StateOverview): ChapterWorkspaceData["flowStatus"] {
  const chapterNumber = overview.project.currentChapter ?? overview.timeline.recentEvents.at(-1)?.chapter ?? 1;
  const hasDraft = overview.timeline.recentEvents.some((event) => event.chapter === chapterNumber);
  return hasDraft ? "draft_ready" : "idle";
}

function buildChapters(overview: StateOverview, currentChapterNumber: number): ChapterNavItem[] {
  const byChapter = new Map<number, ChapterNavItem>();
  const fileStates = new Map((overview.uiChapterFiles ?? []).map((state) => [state.chapter, state]));

  for (const event of overview.timeline.recentEvents) {
    const fileState = fileStates.get(event.chapter);
    byChapter.set(event.chapter, {
      id: `ch-${event.chapter}`,
      chapterNumber: event.chapter,
      title: fileState?.committedTitle ?? fileState?.draftTitle ?? event.title ?? titleFromSummary(event.mainEvent ?? event.summary, event.chapter),
      status: chapterStatusFromFileState(event.chapter, currentChapterNumber, fileState, event.chapter < currentChapterNumber ? "committed" : "planned"),
      ...(fileState ? {
        hasDraftFile: fileState.hasDraftFile,
        hasCommittedChapter: fileState.hasCommittedChapter,
        editedSinceCommit: fileState.editedSinceCommit === true,
      } : {}),
    });
  }

  for (const fileState of fileStates.values()) {
    const existing = byChapter.get(fileState.chapter);
    byChapter.set(fileState.chapter, {
      id: existing?.id ?? `ch-${fileState.chapter}`,
      chapterNumber: fileState.chapter,
      title: fileState.committedTitle ?? fileState.draftTitle ?? existing?.title ?? `第${fileState.chapter}章`,
      status: chapterStatusFromFileState(fileState.chapter, currentChapterNumber, fileState, existing?.status ?? "planned"),
      hasDraftFile: fileState.hasDraftFile,
      hasCommittedChapter: fileState.hasCommittedChapter,
      editedSinceCommit: fileState.editedSinceCommit === true,
    });
  }

  if (!byChapter.has(currentChapterNumber)) {
    const fileState = fileStates.get(currentChapterNumber);
    byChapter.set(currentChapterNumber, {
      id: `ch-${currentChapterNumber}`,
      chapterNumber: currentChapterNumber,
      // 不拿「最近一条时间线事件」当章名：那是上一章发生的事（工具回传的 overview 不带章节文件时就会把上一章的事挂到这一章头上）。
      title: fileState?.committedTitle ?? fileState?.draftTitle ?? `第${currentChapterNumber}章`,
      status: "current",
      ...(fileState ? {
        hasDraftFile: fileState.hasDraftFile,
        hasCommittedChapter: fileState.hasCommittedChapter,
        editedSinceCommit: fileState.editedSinceCommit === true,
      } : {}),
    });
  }

  // 占位「下一章」：当前章的下一章，和最后定稿那章的下一章——翻回前面的章改完，「去第 N 章」「写第 N 章」
  // 要能打开后面那章（2026-10-24 长篇走查：在第 1 章点「去第 10 章」说不在章节列表里）。
  // 定稿到的最后一章：工具回传的概览不带章节文件清单，时间线事件（只记定稿了的章）也算——长篇实跑：已定稿到第 6 章、
  // 回头重定稿第 5 章，回传的概览只认到第 6 章，第 7 章的占位没了，点「去第 7 章」说不在章节列表里。
  const lastCommitted = Math.max(
    0,
    ...[...fileStates.values()].filter((state) => state.hasCommittedChapter).map((state) => state.chapter),
    ...overview.timeline.recentEvents.map((event) => event.chapter),
  );
  for (const placeholder of new Set([currentChapterNumber + 1, lastCommitted + 1])) {
    if (byChapter.has(placeholder)) continue;
    const fileState = fileStates.get(placeholder);
    byChapter.set(placeholder, {
      id: `ch-${placeholder}`,
      chapterNumber: placeholder,
      title: fileState?.committedTitle ?? fileState?.draftTitle ?? "下一章",
      status: chapterStatusFromFileState(placeholder, currentChapterNumber, fileState, "planned"),
      ...(fileState ? {
        hasDraftFile: fileState.hasDraftFile,
        hasCommittedChapter: fileState.hasCommittedChapter,
        editedSinceCommit: fileState.editedSinceCommit === true,
      } : {}),
    });
  }

  return [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function chapterStatusFromFileState(
  chapter: number,
  currentChapterNumber: number,
  fileState: UiChapterFileState | undefined,
  fallback: ChapterNavItem["status"],
): ChapterNavItem["status"] {
  if (chapter === currentChapterNumber) return "current";
  if (fileState?.hasCommittedChapter) return "committed";
  if (fileState?.hasDraftFile) return "draft";
  return fallback === "current" ? "draft" : fallback;
}

function maxNumber(values: readonly number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}

function lastKnownChapter(overview: StateOverview): number | undefined {
  return overview.timeline.recentEvents.at(-1)?.chapter;
}

function titleFromSummary(summary: string, chapter: number): string {
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return `第${chapter}章`;
  return cleaned.length > 12 ? `${cleaned.slice(0, 12)}…` : cleaned;
}
