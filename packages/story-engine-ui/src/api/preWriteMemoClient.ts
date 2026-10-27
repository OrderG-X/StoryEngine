/**
 * 写前备忘（GET /api/pre-write-memo）：动笔写第 N 章前看一眼。读不到如实给原因，不装作「没什么要接的」。
 */
import type { PreWriteMemo } from "@actalk/story-core";

export type { PreWriteChange, PreWriteMemo, PreWritePrevious, PreWriteThread } from "@actalk/story-core";

export type PreWriteMemoResult = { readonly ok: true; readonly memo: PreWriteMemo } | { readonly ok: false; readonly error: string };

export async function fetchPreWriteMemo(projectPath: string, chapter: number, signal?: AbortSignal): Promise<PreWriteMemoResult> {
  try {
    const query = new URLSearchParams({ project: projectPath, chapter: String(chapter) }).toString();
    const res = await fetch(`/api/pre-write-memo?${query}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; memo?: PreWriteMemo; error?: string };
    if (body.ok === true && body.memo && Array.isArray(body.memo.threads) && Array.isArray(body.memo.changes)) return { ok: true, memo: body.memo };
    return { ok: false, error: body.error?.trim() || `写前备忘没读出来（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `写前备忘没读出来：${error instanceof Error ? error.message : String(error)}` };
  }
}
