/**
 * 全书搜正文（GET /api/book-search，⌘K 用）。搜不成如实给原因。
 */
import type { BookTextSearch } from "../server/services/book-search.js";

export type { BookTextHit, BookTextSearch } from "../server/services/book-search.js";

export type BookSearchResult = ({ readonly ok: true } & BookTextSearch) | { readonly ok: false; readonly error: string };

export async function fetchBookSearch(projectPath: string, query: string, signal?: AbortSignal): Promise<BookSearchResult> {
  try {
    const res = await fetch(`/api/book-search?${new URLSearchParams({ project: projectPath, q: query }).toString()}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as Partial<BookTextSearch> & { ok?: boolean; error?: string };
    if (body.ok === true && Array.isArray(body.hits)) {
      return { ok: true, hits: body.hits, chapters: body.chapters ?? body.hits.length, occurrences: body.occurrences ?? 0 };
    }
    return { ok: false, error: body.error?.trim() || `正文没搜成（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `正文没搜成：${error instanceof Error ? error.message : String(error)}` };
  }
}
