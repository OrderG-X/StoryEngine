/**
 * 操作历史里点的恢复，在对话里记的那一行（纯函数，写入见 workspace/restoreNote.ts）。
 *
 * 桌面包走查 2026-10-25：定稿后在操作历史里恢复到定稿之前，AI 栏还挂着「第 9 章定稿了，接下来？AI 写第 10 章」，
 * 定稿回执上也还能点「撤销这次定稿」——这些都按对话里最后一轮算，而恢复不走对话。往回找「最后一轮」的地方
 * 碰到这一行就停。
 */
import type { ChapterMessage } from "../type-defs/workspace.js";

export function isRestoreNote(message: ChapterMessage): boolean {
  return message.role === "system" && message.kind === "restore";
}

export function restoreNoteMessage(label: string, now: Date = new Date()): ChapterMessage {
  return {
    id: `system-restore-${now.getTime()}`,
    role: "system",
    kind: "restore",
    content: `已恢复到「${label}」之前。`,
    createdAt: now.toISOString(),
  };
}
