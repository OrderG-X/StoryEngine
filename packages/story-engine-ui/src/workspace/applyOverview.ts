/**
 * 工作区从盘上状态刷新（重构 P5：从 App.tsx 挪出来，任何地方都能直接调，不再层层传参）。
 *
 * 只刷资料、章节列表、流程态；正文不在这里——稿纸只有 draftStore 一个主人，要换正文走 drafts/draftSync。
 */
import type { StateOverview } from "../api/types.js";
import { pickPreferredChapter, sidebarFromStateOverview, workspaceFromStateOverview } from "../api/stateOverviewAdapter.js";
import { paperStage, type DraftStoreState } from "../stores/draftStore.js";
import { useBookStore } from "../stores/bookStore.js";
import type { ChapterNavItem, ChapterWorkflowState } from "../types.js";
import { carryChapterFileFlags, keepUnlistedChapters, updateChapterListTitle } from "../utils/bookUtils.js";

export interface ApplyOverviewOptions {
  /** 不传 = 保持当前流程态。 */
  readonly flowStatus?: ChapterWorkflowState;
  /**
   * 写类工具回传的「这次实际操作的章号」：它是权威，当前章跟着它走。
   * 不传 = 停在作者正在看的那一章，不把人弹走。
   */
  readonly chapter?: number;
  /** 当前章的章名（稿纸上的）。 */
  readonly title?: string;
}

export function applyOverviewToWorkspace(overview: StateOverview, options: ApplyOverviewOptions = {}): void {
  const store = useBookStore.getState();
  const flowStatus = options.flowStatus ?? store.workspace.flowStatus;
  const preferredChapter = pickPreferredChapter(store.workspace.currentChapter?.chapterNumber, options.chapter);
  const nextWorkspace = workspaceFromStateOverview(overview, preferredChapter);
  const activeChapter = nextWorkspace.currentChapter.chapterNumber;
  const title = options.title?.trim() || undefined;
  const titled = title ? updateChapterListTitle(nextWorkspace.chapters, activeChapter, title) : nextWorkspace.chapters;
  const carried = carryChapterFileFlags(titled, store.workspace.chapters, flowStatus === "committed" ? activeChapter : undefined);
  // 概览没带章节文件清单（工具回传的多半不带）：只认得最近几章，别的章照旧留着。
  const chapters = overview.uiChapterFiles ? carried : keepUnlistedChapters(carried, store.workspace.chapters);
  const activeFlags: ChapterNavItem | undefined = chapters.find((chapter) => chapter.chapterNumber === activeChapter);
  store.setWorkspace({
    ...nextWorkspace,
    currentChapter: {
      ...nextWorkspace.currentChapter,
      // 概览没给当前章章名（占位「第N章」）而章节表里沿用了旧章名：顶栏面包屑也用它。
      ...(title ? { title } : activeFlags?.title && activeFlags.title !== nextWorkspace.currentChapter.title ? { title: activeFlags.title } : {}),
      ...(activeFlags?.hasDraftFile !== undefined ? { hasDraftFile: activeFlags.hasDraftFile } : {}),
      ...(activeFlags?.hasCommittedChapter !== undefined ? { hasCommittedChapter: activeFlags.hasCommittedChapter } : {}),
    },
    chapters,
    flowStatus,
  });
  store.setCurrentOverview(overview);
  store.setSidebar(sidebarFromStateOverview(overview));
}

/** 稿纸在哪一步 → 章节流程态（开书、换章、撤销恢复后从盘上算，不另存）。 */
export function flowStatusForPaper(paper: Pick<DraftStoreState, "body" | "committed">): ChapterWorkflowState {
  const stage = paperStage(paper);
  if (stage === "committed") return "committed";
  if (stage === "empty") return "idle";
  return "draft_ready";
}
