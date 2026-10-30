import type { ChapterMessage } from "../../../types.js";
import { cardOf, hasCard } from "../../../utils/messageCards.js";
import { isRestoreNote } from "../../../utils/restoreNote.js";

/**
 * 哪几张定稿清单还能点「确认定稿」（纯函数）：出它的那次定稿还在等作者点（消息上的操作卡就是它、在等、等的是这张清单），
 * 而且是这一章最新的那张（同一章后来又出了一张，服务端已经把旧的作废了）。之后在操作历史里恢复过的，前面的清单都不算。
 */
export function confirmableCommitPreviewIds(messages: readonly ChapterMessage[]): ReadonlySet<string> {
  const seen = new Set<number>();
  const out = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (isRestoreNote(message)) break;
    const card = cardOf(message, "commit-preview");
    if (!card || seen.has(card.preview.chapter)) continue;
    seen.add(card.preview.chapter);
    const op = cardOf(message, "operation")?.op;
    if (card.opId && op?.opId === card.opId && op.state === "waiting_author" && op.pending?.kind === "commit") out.add(message.id);
  }
  return out;
}

/**
 * 「撤销这次定稿」按钮挂在哪张定稿回执卡上（P11，纯函数）：只挂最近一次改动就是定稿的那张——
 * 从后往前扫，先遇到的「这轮改过东西」（有存档点）的消息若带定稿回执就是它；之后又改过别的（含 AI 撤销），
 * 旧回执就不再给按钮（要退更早的，用「撤销到此」或操作历史）。
 */
export function undoableCommitReportMessageId(messages: readonly ChapterMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // 之后在操作历史里恢复过：盘上已经不是定稿后的样子，旧回执不再给「撤销这次定稿」。
    if (isRestoreNote(message)) return null;
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
