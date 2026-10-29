/**
 * 写作区固定按钮（重构 P4）：每个按钮直接对应一个结构化动作，点了就发 body.action，不经模型、不靠文案。
 *
 * 以前按钮发一句固定中文，前端再拿「输入框文字 === 按钮文案」认回动作（matchDeterministicChapterAction）——
 * 作者自己打出同样的字也会被当成按钮。现在按钮带的是动作本身；输入框的字一律交给 AI。
 */
import { newInspectAction, type AgentUserAction } from "../api/agentChatClient.js";
import type { ChapterNavItem } from "../types.js";

export type ChapterButton =
  | "write"
  | "write_next"
  | "continuity"
  | "review"
  | "quality"
  | "commit_preview"
  | "undo";

/** 当前章之后第一个没定稿的章（写下一章用）；章表里没有就是当前章 + 1。纯函数。 */
export function nextUncommittedChapter(current: number, chapters: readonly ChapterNavItem[]): number {
  const committed = new Set(
    chapters.filter((item) => item.status === "committed" || item.hasCommittedChapter === true).map((item) => item.chapterNumber),
  );
  let next = Math.max(1, Math.trunc(current)) + 1;
  while (committed.has(next)) next += 1;
  return next;
}

/**
 * 按钮 → 结构化动作。要章号的按钮在没选章时返回 undefined（调用方如实提示「先选一章」）。
 * write 带作者在方向框里写的方向（没写就不带，章纲按故事现状往下推）。核账 / 审阅 / 硬伤检查交一次新检查（写作版本 P2a），
 * 请求号这时候给（点下去就是这一次）。
 */
export function chapterButtonAction(
  button: ChapterButton,
  input: { readonly chapter?: number; readonly chapters: readonly ChapterNavItem[]; readonly direction?: string },
): AgentUserAction | undefined {
  if (button === "undo") return { toolName: "undo" };
  const chapter = input.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return undefined;
  switch (button) {
    case "write": {
      const chapterGoal = input.direction?.trim();
      return { toolName: "generate_draft", chapter, ...(chapterGoal ? { chapterGoal } : {}) };
    }
    case "write_next":
      return { toolName: "generate_draft", chapter: nextUncommittedChapter(chapter, input.chapters) };
    case "continuity":
    case "review":
    case "quality":
      return newInspectAction(button, chapter);
    case "commit_preview":
      return { toolName: "commit_preview", chapter };
  }
}

/** 没选章时点了要章号的按钮，给作者看的一句话。 */
export const NO_CHAPTER_HINT = "先在左边选一章再点。";
