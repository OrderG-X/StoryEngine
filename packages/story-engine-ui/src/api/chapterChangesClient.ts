/**
 * 这一章定稿记下了什么（GET /api/chapter-changes，重构 P6 第 6 步）。读不到就如实给原因。
 */

import type { ChapterChanges } from "../server/routes/chapter-changes.js";

export type { ChapterChangeFact, ChapterChanges, ChapterChangeThread } from "../server/routes/chapter-changes.js";

export type ChapterChangesResult = { readonly ok: true; readonly changes: ChapterChanges } | { readonly ok: false; readonly error: string };

export async function fetchChapterChanges(projectPath: string, chapter: number | undefined, signal?: AbortSignal): Promise<ChapterChangesResult> {
  try {
    const query = new URLSearchParams({ project: projectPath, ...(chapter ? { chapter: String(chapter) } : {}) });
    const res = await fetch(`/api/chapter-changes?${query.toString()}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; changes?: ChapterChanges; error?: string };
    if (body.ok === true && body.changes && Array.isArray(body.changes.facts) && Array.isArray(body.changes.threads)) {
      return { ok: true, changes: body.changes };
    }
    return { ok: false, error: body.error?.trim() || `读这章的改动没成（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `读这章的改动没成：${error instanceof Error ? error.message : String(error)}` };
  }
}
