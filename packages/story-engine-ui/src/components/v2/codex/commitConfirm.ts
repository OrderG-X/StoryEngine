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

/**
 * 哪些核账卡已经过时（纯函数）：同一章后来又核过，前面那几张就是旧结果。旧卡上的「改这处 / 改掉这 N 处」
 * 还能点就会拿旧理由去改现在的稿（长篇连写 2026-10-24：作者把错位的句子挪回原处再核，上一张卡还挂着
 * 「改这处」，点了会把已经对的那句又改掉）。
 */
export function supersededContinuityMessageIds(messages: readonly ChapterMessage[]): ReadonlySet<string> {
  const seen = new Set<number>();
  const out = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const check = cardOf(message, "continuity")?.check;
    if (!check) continue;
    if (seen.has(check.chapter)) out.add(message.id);
    else seen.add(check.chapter);
  }
  return out;
}
