import type { SaveChapterWorkspaceRequest } from "../api/types.js";
import { isRealDraftContent } from "./draftContent.js";

export interface WorkspaceAutosaveRequestInput
  extends Omit<SaveChapterWorkspaceRequest, "draftContent" | "draftTitle" | "writeDraftFile"> {
  readonly content?: string;
  readonly title?: string;
  readonly suppressed?: boolean;
  readonly committed?: boolean;
  /**
   * 最近一次从磁盘载入或写进磁盘的正文（2026-10-10 真机验收）。给了且和 content 一样 = 作者没改过 → 不写工作稿文件。
   * 对话 AI 改稿期间界面每 350 毫秒自动保存一次，原来照写不误，把编辑器里还没刷新的旧正文写回去，覆盖了服务端刚改好的版本。
   */
  readonly savedContent?: string;
}

/** Build an autosave payload that can never persist empty or placeholder editor content. */
export function buildWorkspaceAutosaveRequest(
  input: WorkspaceAutosaveRequestInput,
): SaveChapterWorkspaceRequest {
  const {
    content,
    title,
    suppressed = false,
    committed = false,
    savedContent,
    ...request
  } = input;
  const unchanged = savedContent !== undefined && content === savedContent;
  const canWriteDraft = isRealDraftContent(content) && !suppressed && !committed && !unchanged;

  return {
    ...request,
    ...(canWriteDraft
      ? {
        draftContent: content,
        draftTitle: title,
        writeDraftFile: true,
      }
      : {}),
  };
}
