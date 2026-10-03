/**
 * agent 路 undo_last_change 真撤销后的「磁盘真值接管」（P2·2026-10-02）。
 *
 * 病根：undo_last_change 在服务端 git 回退磁盘（草稿 .md / 工作区 json / 资料），工具回报只带 overview（不含正文）。
 * 前端按「读类 full 刷新」把内存里撤销前的旧草稿回传 applyOverviewToWorkspace；350ms 后 autosave 把这份旧稿连同
 * 过期 revision PUT 回去——此前全靠服务端 409 revision 冲突兜底，再弹一条「检测到另一窗口已保存更新」的误导 toast 后整页重载。
 *
 * 现在显式三步（useChat 调用）：suspendAutosave → drainAutosave → fetchChapterWorkspace 读回退后的磁盘快照，
 * 用本模块的纯函数算出工作区补丁（草稿正文/标题/状态/章节文件标记/revision 全部以磁盘为准），回合收尾后整页重载。
 * 纯函数无副作用，便于单测锁住「内存旧稿绝不留下来」。
 */
import type { ChapterWorkspaceSnapshot } from "../api/types.js";
import type { ChapterWorkspaceData } from "../type-defs/workspace.js";
import type { ChapterWorkflowState } from "../type-defs/workflow.js";
import { countTextWords, extractDraftTitle } from "../utils/textUtils.js";

export interface AgentUndoWorkspacePatch {
  readonly flowStatus: ChapterWorkflowState;
  readonly currentChapter: ChapterWorkspaceData["currentChapter"];
  readonly chapters: ChapterWorkspaceData["chapters"];
  readonly draft: ChapterWorkspaceData["draft"];
  /** 磁盘工作区代次（缺省 0）：调用方据此 recordWorkspaceRevision + setWorkspaceRevision，后续 autosave 的 expectedRevision 才对得上。 */
  readonly revision: number;
}

/** 磁盘快照没带 flowStatus 时按文件标记推断（已定稿 > 有草稿 > 空）。 */
function inferFlowStatus(snap: ChapterWorkspaceSnapshot, hasDraftContent: boolean): ChapterWorkflowState {
  if (snap.flowStatus) return snap.flowStatus;
  if (snap.hasCommittedChapter === true) return "committed";
  if (hasDraftContent || snap.hasDraftFile === true) return "draft_ready";
  return "idle";
}

/**
 * 据回退后的磁盘快照算出工作区补丁。磁盘没有草稿正文（撤销到「还没写过」）→ 正文清空，绝不保留内存旧稿；
 * 标题优先磁盘快照，其次从正文抽，再退回当前标题；章节文件标记按磁盘快照重置。
 */
export function buildWorkspacePatchAfterAgentUndo(
  snap: ChapterWorkspaceSnapshot,
  chapter: number,
  current: ChapterWorkspaceData,
): AgentUndoWorkspacePatch {
  const draftContent = snap.draftContent ?? "";
  const hasDraftContent = draftContent.trim().length > 0;
  const draftTitle = snap.draftTitle ?? extractDraftTitle(draftContent) ?? current.draft.title;
  const flowStatus = inferFlowStatus(snap, hasDraftContent);
  const hasCommittedChapter = snap.hasCommittedChapter === true;
  const hasDraftFile = snap.hasDraftFile === true;
  const draftStatus = flowStatus === "committed" || flowStatus === "ready_for_next" ? "committed" : "draft";
  return {
    flowStatus,
    currentChapter: {
      ...current.currentChapter,
      title: draftTitle,
      hasCommittedChapter,
      hasDraftFile,
      hasWorkspaceSnapshot: true,
    },
    chapters: current.chapters.map((item) => item.chapterNumber === chapter
      ? { ...item, title: draftTitle, hasCommittedChapter, hasDraftFile, hasWorkspaceSnapshot: true }
      : item),
    draft: {
      ...current.draft,
      chapterNumber: chapter,
      title: draftTitle,
      content: draftContent,
      savedContent: draftContent,
      wordCount: hasDraftContent ? countTextWords(draftContent) : undefined,
      status: draftStatus,
    },
    revision: snap.revision ?? 0,
  };
}
