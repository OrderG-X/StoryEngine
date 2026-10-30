/**
 * 账没记全的章（写作版本 P2b；出口复核第 2、4 条）：按账单状态取（天数知道不代表账记上了），读的路径都用这一处如实说缺口。
 */
import type { ChapterView } from "@actalk/story-core";

export interface ShortChapter {
  readonly chapter: number;
  /** pending = 账还没记上；partial = 账没记全。 */
  readonly status: "pending" | "partial";
}

/** 投影里账没记全的章（只看 before 之前的；不给就是全部）。 */
export function shortChapters(chapters: readonly Pick<ChapterView, "chapter" | "ledgerStatus">[], before?: number): ShortChapter[] {
  return chapters.flatMap((view) => (
    view.ledgerStatus !== "ready" && (before === undefined || view.chapter < before) ? [{ chapter: view.chapter, status: view.ledgerStatus }] : []
  ));
}

const list = (chapters: readonly number[], limit: number): string =>
  `${chapters.slice(0, limit).map((chapter) => `第 ${chapter} 章`).join("、")}${chapters.length > limit ? "等" : ""}`;

/** 「第 1 章的账还没记上、第 3 章的账没记全」（limit：每种最多列几章）。 */
export function shortChaptersText(items: readonly ShortChapter[], limit = 5): string {
  const pending = items.filter((item) => item.status === "pending").map((item) => item.chapter);
  const partial = items.filter((item) => item.status === "partial").map((item) => item.chapter);
  return [
    ...(pending.length > 0 ? [`${list(pending, limit)}的账还没记上`] : []),
    ...(partial.length > 0 ? [`${list(partial, limit)}的账没记全`] : []),
  ].join("、");
}

/** 「它」/「它们」：缺账的不止一章就是「它们」。 */
export const itOrThem = (items: readonly ShortChapter[]): string => (items.length > 1 ? "它们" : "它");
