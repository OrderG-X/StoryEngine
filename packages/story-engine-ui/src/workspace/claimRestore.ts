/**
 * 整本书恢复到一个存档点（撤销到此、操作历史里恢复）的那段时间占住工作区：这期间开不了新的一轮对话、换不了章和书。
 * 第 6 轮复核 T10：恢复途中作者发了一句新话，恢复回来按那时的全部消息截对话，把新话和它的回复一起截掉。
 * 占不上（别的操作在跑）返回 null，调用方如实说。用完 finishWorkspaceOperation。
 */
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { beginWorkspaceOperation, type WorkspaceOperationToken } from "../utils/workspaceOperation.js";

export function claimWorkspaceForRestore(projectPath: string): WorkspaceOperationToken | null {
  return beginWorkspaceOperation("snapshot-restore", {
    projectPath,
    chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
    sessionId: useChatStore.getState().activeSessionId,
  });
}
