/**
 * 故事地图的数据（GET /api/story-map，重构 P6）。读不到就如实给原因。
 */
import type { StoryMap } from "../server/routes/story-map.js";

export type { PaceChapter, PaceFlag, PaceReport } from "@actalk/story-core";
export type { StoryMap, StoryMapChapter, StoryMapMember } from "../server/routes/story-map.js";

export type StoryMapResult = { readonly ok: true; readonly map: StoryMap } | { readonly ok: false; readonly error: string };

export async function fetchStoryMap(projectPath: string, signal?: AbortSignal): Promise<StoryMapResult> {
  try {
    const res = await fetch(`/api/story-map?project=${encodeURIComponent(projectPath)}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; map?: StoryMap; error?: string };
    if (body.ok === true && body.map && Array.isArray(body.map.chapters) && Array.isArray(body.map.cast)) return { ok: true, map: body.map };
    return { ok: false, error: body.error?.trim() || `读故事地图没成（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `读故事地图没成：${error instanceof Error ? error.message : String(error)}` };
  }
}
