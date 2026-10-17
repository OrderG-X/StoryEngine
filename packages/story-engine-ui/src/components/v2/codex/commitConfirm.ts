import type { ChapterMessage } from "../../../types.js";

/**
 * 「确认定稿」按钮挂在哪张定稿预览卡上（纯函数）：只挂最新那张——从后往前扫，先遇到预览卡就是它；
 * 先遇到入库 delta 卡（定稿已成）说明最新预览已经用掉，不再挂按钮，免得旧卡上一排可点的「确认定稿」。
 * 定稿没成功（commit_apply 无 commitReport）不算用掉：预览卡按钮留着可重试。
 */
export function confirmableCommitPreviewMessageId(messages: readonly ChapterMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (message.commitReport) return null;
    if (message.commitPreview) return message.commitPreview.canCommit ? message.id : null;
  }
  return null;
}
