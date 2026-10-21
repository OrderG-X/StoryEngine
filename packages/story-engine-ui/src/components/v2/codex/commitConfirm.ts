import type { ChapterMessage } from "../../../types.js";
import { cardOf, hasCard } from "../../../utils/messageCards.js";

/**
 * 「确认定稿」按钮挂在哪张定稿预览卡上（纯函数）：只挂最新那张——从后往前扫，先遇到预览卡就是它；
 * 先遇到入库 delta 卡（定稿已成）说明最新预览已经用掉，不再挂按钮，免得旧卡上一排可点的「确认定稿」。
 * 定稿没成功（commit_apply 没挂定稿回执卡）不算用掉：预览卡按钮留着可重试。
 */
export function confirmableCommitPreviewMessageId(messages: readonly ChapterMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (hasCard(message, "commit-report")) return null;
    const preview = cardOf(message, "commit-preview")?.preview;
    if (preview) return preview.canCommit ? message.id : null;
  }
  return null;
}

/**
 * 「撤销这次定稿」按钮挂在哪张定稿回执卡上（P11，纯函数）：只挂最近一次改动就是定稿的那张——
 * 从后往前扫，先遇到的「这轮改过东西」（有存档点）的消息若带定稿回执就是它；之后又改过别的（含 AI 撤销），
 * 旧回执就不再给按钮（要退更早的，用「撤销到此」或操作历史）。
 */
export function undoableCommitReportMessageId(messages: readonly ChapterMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || (message.turnSnapshots?.length ?? 0) === 0) continue;
    return hasCard(message, "commit-report") ? message.id : null;
  }
  return null;
}
