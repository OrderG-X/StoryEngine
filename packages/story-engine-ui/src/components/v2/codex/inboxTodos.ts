/**
 * AI 栏「待处理」（2026-10-07 改版）：不急但别忘的事，按需点「让 AI …」把一句话放进输入框（不自动发、不直连引擎）。
 * 全部从现有只读数据确定性推出：可清理线索数 / 久未推进的主线目标 / 占位章名 / 重名章节。题材中立。
 */
import type { StateOverview } from "../../../api/types.js";
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { chapterBareTitle, PLACEHOLDER_CHAPTER_TITLE } from "../v2Utils.js";

export interface InboxTodo {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly action: string;
  readonly prefill: string;
}

const PLACEHOLDER_TITLE = PLACEHOLDER_CHAPTER_TITLE;
const ARC_STALE_CHAPTERS = 8;

function chapterList(numbers: readonly number[]): string {
  const shown = numbers.slice(0, 6).join("、");
  return `第 ${shown}${numbers.length > 6 ? " 等" : ""} 章`;
}

export function buildInboxTodos(input: {
  readonly chapters: readonly ChapterNavItem[];
  readonly overview: Pick<StateOverview, "threads" | "arcGoals"> | null | undefined;
  readonly currentChapterNumber: number;
}): InboxTodo[] {
  const todos: InboxTodo[] = [];
  const written = input.chapters.filter((ch) => ch.status !== "planned");
  const latest = Math.max(input.currentChapterNumber, ...written.map((ch) => ch.chapterNumber), 0);

  const cleanup = input.overview?.threads.cleanupVisibleCount ?? 0;
  if (cleanup > 0) {
    todos.push({
      key: "threads-cleanup",
      title: `${cleanup} 条线索可以清理`,
      sub: "过期没推进或意思重复的线索，留着会挤占 AI 的注意力",
      action: "让 AI 清理",
      prefill: "清理过期线索：先列出要清哪些，我确认了再动",
    });
  }

  for (const goal of input.overview?.arcGoals.activeItems ?? []) {
    const last = goal.lastTouchedChapter;
    if (typeof last !== "number" || latest - last < ARC_STALE_CHAPTERS) continue;
    todos.push({
      key: `arc-${goal.id}`,
      title: `主线目标 ${latest - last} 章没推进`,
      sub: `「${goal.title}」`,
      action: "让 AI 安排",
      prefill: `主线「${goal.title}」很久没推进了，帮我想想接下来两三章怎么接上`,
    });
    if (todos.filter((t) => t.key.startsWith("arc-")).length >= 2) break;
  }

  const placeholders = written
    .filter((ch) => PLACEHOLDER_TITLE.test(chapterBareTitle(ch.title ?? "").trim()))
    .map((ch) => ch.chapterNumber)
    .sort((a, b) => a - b);
  if (placeholders.length > 0) {
    todos.push({
      key: "placeholder-titles",
      title: placeholders.length === 1 ? `第 ${placeholders[0]} 章还没起标题` : `${placeholders.length} 章还没起标题`,
      sub: placeholders.length === 1 ? `现在叫「${chapterBareTitle(written.find((c) => c.chapterNumber === placeholders[0])?.title ?? "")}」` : chapterList(placeholders),
      action: "让 AI 起名",
      prefill: placeholders.length === 1
        ? `给第 ${placeholders[0]} 章起个标题，给我三个选项`
        : `${chapterList(placeholders)}还没有像样的标题，帮我各起一个，先给方案`,
    });
  }

  const byTitle = new Map<string, number[]>();
  for (const ch of written) {
    const title = chapterBareTitle(ch.title ?? "").trim();
    if (!title || PLACEHOLDER_TITLE.test(title)) continue;
    byTitle.set(title, [...(byTitle.get(title) ?? []), ch.chapterNumber]);
  }
  const duplicates = [...byTitle.entries()]
    .filter(([, nums]) => nums.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2);
  for (const [title, nums] of duplicates) {
    const sorted = [...nums].sort((a, b) => a - b);
    todos.push({
      key: `dup-${title}`,
      title: `${sorted.length} 章用了同一个标题「${title}」`,
      sub: chapterList(sorted),
      action: "让 AI 改名",
      prefill: `${chapterList(sorted)}都叫「${title}」，帮我各起一个能区分的标题，先给方案`,
    });
  }

  return todos;
}
