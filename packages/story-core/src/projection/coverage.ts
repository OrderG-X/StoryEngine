/**
 * 账没记全的章怎么读（P2b 出口复核第 2、3 条）：线索那类没记全的章不知道动没动线索，「多少章没动」不数它们。
 * 投影、写前备忘、写手上下文、概况都用这一处，别再各自按章号相减。
 */
import type { EntryKind } from "../schema/ledger.js";

/** 线索那类没记全的章号（账待记、没记全且线索没记上的）。 */
export function threadUnknownChapters(chapters: readonly { readonly chapter: number; readonly missingKinds?: readonly EntryKind[] }[]): readonly number[] {
  return chapters.flatMap((view) => (view.missingKinds?.includes("thread") ? [view.chapter] : []));
}

/** 从 since 那章之后到 at（含）有几章没动：不数线索没记全的章。 */
export function idleChaptersBetween(since: number, at: number, unknown: readonly number[]): number {
  return Math.max(0, at - since - unknown.filter((chapter) => chapter > since && chapter <= at).length);
}
